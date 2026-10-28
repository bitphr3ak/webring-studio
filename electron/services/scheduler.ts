import * as fs from 'fs';
import * as path from 'path';

/**
 * Scheduled Sync All and publishing, per persona, while the app runs (window open or in the
 * tray). Lives in the Electron main process because publishing needs the OS keychain to sign.
 * Config is a small JSON file of persona ids and schedules (no profile data), re-read on every
 * tick so edits from the MCP CLI are picked up.
 */

export type SchedulePreset =
  | { kind: 'interval'; minutes: 15 | 60 | 360 | 720 }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekday: number; time: string };

export type PublishDestination = 'local' | 'remote' | 'github';
export type ScheduledJobKind = 'sync' | 'publish';

export interface JobResult {
  at: string;
  status: 'ok' | 'skipped' | 'failed';
  message: string;
}

export interface JobSchedule {
  enabled: boolean;
  preset: SchedulePreset;
  /** When the schedule was turned on or changed; the anchor before the first run. */
  since: string;
  lastRunAt?: string;
  lastResult?: JobResult;
}

export interface PersonaSchedule {
  sync: JobSchedule;
  publish: JobSchedule & { destination: PublishDestination; syncFirst: boolean };
}

export interface SchedulerConfig {
  runInBackground: boolean;
  startAtLogin: boolean;
  paused: boolean;
  notifyOnFailure: boolean;
  personas: Record<string, PersonaSchedule>;
  history: Array<JobResult & { personaId: string; job: ScheduledJobKind }>;
}

const HISTORY_LIMIT = 50;
const TICK_MS = 60 * 1000;

export function defaultPersonaSchedule(now = new Date()): PersonaSchedule {
  const since = now.toISOString();
  return {
    sync: { enabled: false, preset: { kind: 'interval', minutes: 60 }, since },
    publish: {
      enabled: false,
      preset: { kind: 'daily', time: '09:00' },
      since,
      destination: 'local',
      syncFirst: true,
    },
  };
}

export function defaultSchedulerConfig(): SchedulerConfig {
  return {
    runInBackground: true,
    startAtLogin: false,
    paused: false,
    notifyOnFailure: true,
    personas: {},
    history: [],
  };
}

function parseTime(time: string): { hours: number; minutes: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const hours = match ? Math.min(23, Number(match[1])) : 9;
  const minutes = match ? Math.min(59, Number(match[2])) : 0;
  return { hours, minutes };
}

/**
 * The first scheduled moment strictly after `anchor` (the last run, or when the schedule was
 * set). If it's already in the past the job is due; running it moves the anchor to "now", so a
 * long gap (sleep, app closed) catches up with one run, not one per missed slot. Daily and
 * weekly slots use local wall-clock time, so they follow daylight-saving changes.
 */
export function nextRunAt(preset: SchedulePreset, anchor: Date): Date {
  if (preset.kind === 'interval') {
    return new Date(anchor.getTime() + preset.minutes * 60 * 1000);
  }
  const { hours, minutes } = parseTime(preset.time);
  const candidate = new Date(anchor);
  candidate.setHours(hours, minutes, 0, 0);
  if (preset.kind === 'daily') {
    if (candidate <= anchor) candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hours, minutes, 0, 0);
    return candidate;
  }
  const weekday = ((Math.round(preset.weekday) % 7) + 7) % 7;
  let daysAhead = (weekday - candidate.getDay() + 7) % 7;
  if (daysAhead === 0 && candidate <= anchor) daysAhead = 7;
  candidate.setDate(candidate.getDate() + daysAhead);
  candidate.setHours(hours, minutes, 0, 0);
  return candidate;
}

export function jobNextRunAt(job: JobSchedule): Date {
  return nextRunAt(job.preset, new Date(job.lastRunAt || job.since));
}

export function describePreset(preset: SchedulePreset): string {
  if (preset.kind === 'interval') {
    return preset.minutes < 60 ? `every ${preset.minutes} min` : `every ${preset.minutes / 60} h`;
  }
  if (preset.kind === 'daily') return `daily at ${preset.time}`;
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `${days[((preset.weekday % 7) + 7) % 7]}s at ${preset.time}`;
}

export interface SchedulerJobRunner {
  sync(personaId: string): Promise<JobResult>;
  publish(personaId: string, destination: PublishDestination, syncFirst: boolean): Promise<JobResult>;
}

export interface SchedulerOptions {
  configPath: string;
  runner: SchedulerJobRunner;
  /** Persona ids that still exist; schedules for anything else are dropped. */
  listPersonaIds: () => string[];
  now?: () => Date;
  onJobFinished?: (personaId: string, job: ScheduledJobKind, result: JobResult) => void;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private queue: Array<{ personaId: string; job: ScheduledJobKind }> = [];
  private draining: Promise<void> | null = null;
  private locks = new Map<string, Promise<unknown>>();
  private running: { personaId: string; job: ScheduledJobKind } | null = null;

  constructor(private options: SchedulerOptions) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  // ---------------------------------------------------------------------------
  // Config

  public loadConfig(): SchedulerConfig {
    let config = defaultSchedulerConfig();
    try {
      if (fs.existsSync(this.options.configPath)) {
        config = { ...config, ...JSON.parse(fs.readFileSync(this.options.configPath, 'utf8')) };
      }
    } catch {
      // A damaged file falls back to defaults rather than stopping the app
    }
    const known = new Set(this.options.listPersonaIds());
    for (const id of Object.keys(config.personas)) {
      if (!known.has(id)) delete config.personas[id];
    }
    return config;
  }

  public saveConfig(config: SchedulerConfig): void {
    const dir = path.dirname(this.options.configPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.options.configPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmp, this.options.configPath);
  }

  public getPersonaSchedule(personaId: string): PersonaSchedule {
    return this.loadConfig().personas[personaId] || defaultPersonaSchedule(this.now());
  }

  /**
   * Updates one persona's schedules. Changing a job's preset or turning it on resets its anchor,
   * so it doesn't fire immediately for slots that passed before it was set.
   */
  public setPersonaSchedule(
    personaId: string,
    patch: {
      sync?: Partial<Pick<JobSchedule, 'enabled' | 'preset'>>;
      publish?: Partial<Pick<PersonaSchedule['publish'], 'enabled' | 'preset' | 'destination' | 'syncFirst'>>;
    }
  ): PersonaSchedule {
    const config = this.loadConfig();
    const current = config.personas[personaId] || defaultPersonaSchedule(this.now());
    const since = this.now().toISOString();
    const apply = <T extends JobSchedule>(job: T, change?: Partial<T>): T => {
      if (!change) return job;
      const resetsAnchor =
        (change.enabled === true && !job.enabled) ||
        (change.preset !== undefined && JSON.stringify(change.preset) !== JSON.stringify(job.preset));
      return { ...job, ...change, ...(resetsAnchor ? { since, lastRunAt: undefined } : {}) };
    };
    config.personas[personaId] = {
      sync: apply<JobSchedule>(current.sync, patch.sync),
      publish: apply<PersonaSchedule['publish']>(current.publish, patch.publish),
    };
    this.saveConfig(config);
    return config.personas[personaId];
  }

  public setAppSettings(
    patch: Partial<Pick<SchedulerConfig, 'runInBackground' | 'startAtLogin' | 'paused' | 'notifyOnFailure'>>
  ): SchedulerConfig {
    const config = { ...this.loadConfig(), ...patch };
    this.saveConfig(config);
    return config;
  }

  // ---------------------------------------------------------------------------
  // Running

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public isRunning(): { personaId: string; job: ScheduledJobKind } | null {
    return this.running;
  }

  /**
   * Runs `fn` while holding the persona's lock, after any job already holding it. Scheduled jobs
   * and manual Sync All / Publish share this, so they never overlap for the same persona.
   */
  public runExclusive<T>(personaId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(personaId) || Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(personaId, tail);
    void tail.then(() => {
      if (this.locks.get(personaId) === tail) this.locks.delete(personaId);
    });
    return run;
  }

  /** Queues every due job (sync before publish for each persona) and processes them one at a time. */
  public async tick(): Promise<void> {
    const config = this.loadConfig();
    if (!config.paused) {
      const now = this.now();
      for (const [personaId, schedule] of Object.entries(config.personas)) {
        for (const job of ['sync', 'publish'] as const) {
          const entry = schedule[job];
          if (!entry.enabled || jobNextRunAt(entry) > now) continue;
          const queued = this.queue.some((q) => q.personaId === personaId && q.job === job);
          const active = this.running?.personaId === personaId && this.running.job === job;
          if (!queued && !active) this.queue.push({ personaId, job });
        }
      }
    }
    await this.drain();
  }

  /** Runs one job now, outside its schedule (the "Run now" button), and records the result. */
  public async runNow(personaId: string, job: ScheduledJobKind): Promise<JobResult> {
    return this.execute(personaId, job);
  }

  private drain(): Promise<void> {
    if (!this.draining) {
      this.draining = (async () => {
        while (this.queue.length > 0) {
          const next = this.queue.shift()!;
          await this.execute(next.personaId, next.job);
        }
      })().finally(() => {
        this.draining = null;
      });
    }
    return this.draining;
  }

  private async execute(personaId: string, job: ScheduledJobKind): Promise<JobResult> {
    const schedule = this.getPersonaSchedule(personaId);
    let result: JobResult;
    try {
      result = await this.runExclusive(personaId, async () => {
        this.running = { personaId, job };
        try {
          return job === 'sync'
            ? await this.options.runner.sync(personaId)
            : await this.options.runner.publish(personaId, schedule.publish.destination, schedule.publish.syncFirst);
        } finally {
          this.running = null;
        }
      });
    } catch (err) {
      result = {
        at: this.now().toISOString(),
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    // Record even failures as a run, so a broken destination waits for its next slot
    const config = this.loadConfig();
    const current = config.personas[personaId];
    if (current) {
      const ran = { lastRunAt: this.now().toISOString(), lastResult: result };
      if (job === 'sync') current.sync = { ...current.sync, ...ran };
      else current.publish = { ...current.publish, ...ran };
    }
    config.history = [{ ...result, personaId, job }, ...config.history].slice(0, HISTORY_LIMIT);
    this.saveConfig(config);
    this.options.onJobFinished?.(personaId, job, result);
    return result;
  }
}
