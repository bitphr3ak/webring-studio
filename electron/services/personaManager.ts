import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { KeyCipher } from '../security/keyVault';
import { StudioDatabase } from '../db/database';
import { MediaLibrary, optimizeLegacyPhotos } from './mediaLibrary';
import { StaticSiteGenerator } from './siteGenerator';
import { SitePublisher } from './publisher';
import { RingCrawler } from './ringCrawler';
import { RingService } from './ringService';
import { CreatePersonaInput, PersonaSummary } from '../../src/shared/schema';

interface StoredPersonaRecord {
  id: string;
  label: string;
  dbFileName: string;
  mediaDirName: string;
  createdAt: string;
}

interface StoredPersonaRegistry {
  activePersonaId: string;
  personas: StoredPersonaRecord[];
}

export interface ActivePersonaContext {
  persona: PersonaSummary;
  db: StudioDatabase;
  mediaLibrary: MediaLibrary;
  siteGenerator: StaticSiteGenerator;
  sitePublisher: SitePublisher;
  ringCrawler: RingCrawler;
  ringService: RingService;
}

/**
 * Manages strictly compartmentalized online personas.
 * Each persona has its own isolated SQLite file, independent Ed25519 keypair,
 * dedicated media-store folder, and independent static-site export settings.
 */
export class PersonaManager {
  private registryPath: string;
  private registry: StoredPersonaRegistry;
  private activeContext: ActivePersonaContext | null = null;

  constructor(
    private userDataDir: string,
    private options: { keyCipher?: KeyCipher } = {}
  ) {
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }
    this.registryPath = path.join(userDataDir, 'personas.json');
    this.registry = this.loadOrInitRegistry();
    this.activatePersona(this.registry.activePersonaId);
  }

  private loadOrInitRegistry(): StoredPersonaRegistry {
    if (fs.existsSync(this.registryPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.registryPath, 'utf8')) as StoredPersonaRegistry;
        if (Array.isArray(parsed.personas) && parsed.personas.length > 0) {
          const validActive = parsed.personas.some((p) => p.id === parsed.activePersonaId)
            ? parsed.activePersonaId
            : parsed.personas[0].id;
          return {
            activePersonaId: validActive,
            personas: parsed.personas,
          };
        }
      } catch {
        // Fallback to default registry if corrupted
      }
    }

    const initial: StoredPersonaRegistry = {
      activePersonaId: 'default',
      personas: [
        {
          id: 'default',
          label: 'Primary Persona',
          dbFileName: 'webring-studio.sqlite',
          mediaDirName: 'media-store',
          createdAt: new Date().toISOString(),
        },
      ],
    };
    this.saveRegistry(initial);
    return initial;
  }

  private saveRegistry(reg: StoredPersonaRegistry = this.registry): void {
    fs.writeFileSync(this.registryPath, JSON.stringify(reg, null, 2), 'utf8');
  }

  private hydratePersonaSummary(record: StoredPersonaRecord, openDb?: StudioDatabase): PersonaSummary {
    const computeSummary = (db: StudioDatabase): PersonaSummary => {
      const p = db.getProfile();
      const albums = db.getAlbums();
      const photoCount = albums.reduce((sum, a) => sum + a.photos.length, 0);
      const itemCount = db.getItems().length;
      const friendCount = db.getFriends().length;
      return {
        id: record.id,
        label: record.label,
        displayName: p.displayName,
        handle: p.handle,
        siteUrl: p.siteUrl,
        did: p.did,
        avatarUrl: p.avatarUrl,
        theme: p.theme,
        dbFileName: record.dbFileName,
        mediaDirName: record.mediaDirName,
        createdAt: record.createdAt,
        stats: {
          photoCount,
          itemCount,
          friendCount,
        },
      };
    };

    if (openDb) {
      return computeSummary(openDb);
    }

    const tempDb = new StudioDatabase(this.userDataDir, record.dbFileName, {
      keyCipher: this.options.keyCipher,
    });
    const summary = computeSummary(tempDb);
    tempDb.close();
    return summary;
  }

  private activatePersona(personaId: string): ActivePersonaContext {
    const record =
      this.registry.personas.find((p) => p.id === personaId) || this.registry.personas[0];

    if (this.activeContext && this.activeContext.persona.id === record.id) {
      this.activeContext.persona = this.hydratePersonaSummary(record, this.activeContext.db);
      return this.activeContext;
    }

    if (this.activeContext) {
      this.activeContext.db.close();
      this.activeContext = null;
    }

    this.registry.activePersonaId = record.id;
    this.saveRegistry();
    this.activeContext = this.buildContext(record);
    return this.activeContext;
  }

  /**
   * Opens a persona's own database, media folder and services. Used for the active persona and
   * for background jobs on other personas, so both see exactly the same setup.
   */
  private buildContext(record: StoredPersonaRecord): ActivePersonaContext {
    const mediaStoreDir = path.join(this.userDataDir, record.mediaDirName);
    const defaultExportPath =
      record.id === 'default'
        ? path.join(this.userDataDir, 'exported-profile-site')
        : path.join(this.userDataDir, `exported-profile-site-${record.id}`);

    const db = new StudioDatabase(this.userDataDir, record.dbFileName, {
      defaultExportPath,
      keyCipher: this.options.keyCipher,
    });
    const siteGenerator = new StaticSiteGenerator(db, mediaStoreDir);
    const mediaLibrary = new MediaLibrary(mediaStoreDir);
    try {
      // One-time upgrade of photos imported before the Media Library (no-op afterwards)
      optimizeLegacyPhotos(db, mediaLibrary);
    } catch {
      // Never block opening a persona over a photo
    }
    return {
      persona: this.hydratePersonaSummary(record, db),
      db,
      mediaLibrary,
      siteGenerator,
      sitePublisher: new SitePublisher(siteGenerator),
      ringCrawler: new RingCrawler(db),
      ringService: new RingService(db),
    };
  }

  /**
   * Runs `fn` with its own short-lived context for a persona (its own database connection and
   * key), closed afterwards. Background jobs use this even for the active persona, so switching
   * personas mid-job can't close the database out from under them, and personas never share data.
   */
  public async withPersonaContext<T>(
    personaId: string,
    fn: (ctx: ActivePersonaContext) => Promise<T>
  ): Promise<T> {
    const record = this.registry.personas.find((p) => p.id === personaId);
    if (!record) {
      throw new Error(`Persona "${personaId}" not found`);
    }
    const ctx = this.buildContext(record);
    try {
      return await fn(ctx);
    } finally {
      ctx.db.close();
    }
  }

  /** Persona ids and labels without opening any database. */
  public listPersonaRecords(): Array<{ id: string; label: string }> {
    return this.registry.personas.map((p) => ({ id: p.id, label: p.label }));
  }

  public getActiveContext(): ActivePersonaContext {
    if (!this.activeContext) {
      return this.activatePersona(this.registry.activePersonaId);
    }
    const record =
      this.registry.personas.find((p) => p.id === this.activeContext!.persona.id) ||
      this.registry.personas[0];
    this.activeContext.persona = this.hydratePersonaSummary(record, this.activeContext.db);
    return this.activeContext;
  }

  public getActivePersonaId(): string {
    return this.getActiveContext().persona.id;
  }

  public listPersonas(): { activePersonaId: string; personas: PersonaSummary[] } {
    const active = this.getActiveContext();
    const summaries = this.registry.personas.map((rec) =>
      rec.id === active.persona.id
        ? this.hydratePersonaSummary(rec, active.db)
        : this.hydratePersonaSummary(rec)
    );
    return {
      activePersonaId: active.persona.id,
      personas: summaries,
    };
  }

  public switchPersona(personaId: string): { activePersonaId: string; personas: PersonaSummary[] } {
    const target = this.registry.personas.find((p) => p.id === personaId);
    if (!target) {
      throw new Error(`Persona "${personaId}" not found`);
    }
    this.activatePersona(target.id);
    return this.listPersonas();
  }

  public createPersona(input: CreatePersonaInput): {
    created: PersonaSummary;
    activePersonaId: string;
    personas: PersonaSummary[];
  } {
    const suffix = crypto.randomBytes(4).toString('hex');
    const id = `persona-${suffix}`;
    const dbFileName = `${id}.sqlite`;
    const mediaDirName = `media-store-${id}`;
    const createdAt = new Date().toISOString();
    const defaultExportPath = path.join(this.userDataDir, `exported-profile-site-${id}`);

    const record: StoredPersonaRecord = {
      id,
      label: input.label.trim() || input.displayName.trim() || 'Secondary Persona',
      dbFileName,
      mediaDirName,
      createdAt,
    };

    // Initialize isolated SQLite DB with a fresh Ed25519 keypair and clean slate
    const newDb = new StudioDatabase(this.userDataDir, dbFileName, {
      defaultExportPath,
      keyCipher: this.options.keyCipher,
      initialProfile: {
        siteUrl: input.siteUrl,
        handle: input.handle,
        displayName: input.displayName,
        tagline: input.tagline,
        bio: input.bio,
        avatarUrl: input.avatarUrl,
        theme: input.theme || 'neo-webring',
      },
    });
    newDb.close();

    this.registry.personas.push(record);
    this.registry.activePersonaId = id;
    this.saveRegistry();

    const active = this.activatePersona(id);
    const list = this.listPersonas();
    return {
      created: active.persona,
      activePersonaId: list.activePersonaId,
      personas: list.personas,
    };
  }

  public updatePersonaLabel(
    personaId: string,
    label: string
  ): { activePersonaId: string; personas: PersonaSummary[] } {
    const rec = this.registry.personas.find((p) => p.id === personaId);
    if (rec && label.trim()) {
      rec.label = label.trim();
      this.saveRegistry();
    }
    return this.listPersonas();
  }

  public deletePersona(personaId: string): { activePersonaId: string; personas: PersonaSummary[] } {
    if (personaId === 'default' || this.registry.personas.length <= 1) {
      throw new Error('Cannot delete the primary or only remaining persona.');
    }
    const idx = this.registry.personas.findIndex((p) => p.id === personaId);
    if (idx === -1) {
      throw new Error(`Persona "${personaId}" not found.`);
    }

    const [removed] = this.registry.personas.splice(idx, 1);

    if (this.activeContext && this.activeContext.persona.id === personaId) {
      this.activeContext.db.close();
      this.activeContext = null;
    }

    // Delete isolated SQLite database files and media directory
    for (const ext of ['', '-wal', '-shm']) {
      const dbFile = path.join(this.userDataDir, `${removed.dbFileName}${ext}`);
      if (fs.existsSync(dbFile)) {
        try {
          fs.rmSync(dbFile, { force: true });
        } catch {
          // Ignore file lock races
        }
      }
    }

    const mediaDir = path.join(this.userDataDir, removed.mediaDirName);
    if (fs.existsSync(mediaDir)) {
      try {
        fs.rmSync(mediaDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    const nextActiveId =
      this.registry.activePersonaId === personaId
        ? this.registry.personas[0].id
        : this.registry.activePersonaId;

    this.registry.activePersonaId = nextActiveId;
    this.saveRegistry();
    this.activatePersona(nextActiveId);

    return this.listPersonas();
  }

  public close(): void {
    if (this.activeContext) {
      this.activeContext.db.close();
      this.activeContext = null;
    }
  }

  public closeAll(): void {
    this.close();
  }
}

