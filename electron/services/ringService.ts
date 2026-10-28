import { HostedRing, JoinedRing, StudioDatabase } from '../db/database';
import {
  buildRingRequestUri,
  computeRingNeighbors,
  ConnectionsDocumentSchema,
  decodeRingRequestToken,
  DidDocumentSchema,
  encodeRingRequestToken,
  isUrlWithinSite,
  normalizeSiteUrl,
  parseRingRequestUri,
  publicKeyFingerprint,
  RingJoinRequest,
  signDocument,
  siteUrlToDidWeb,
  verifyDocumentSignature,
  WebringHubDocument,
  WebringHubDocumentSchema,
  WebringManifestSchema,
} from '../../src/shared/schema';
import { privatePeersAllowed } from '../security/networkGuard';
import { defaultJsonFetcher, JsonFetcher } from './ringCrawler';

const REQUEST_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** A newly approved member who never lists the ring is removed after this long. */
export const RING_APPROVAL_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
/** A member whose site can't be verified for this long is flagged to the maintainer. */
export const RING_MEMBER_FLAG_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface VerifiedHub {
  doc: WebringHubDocument;
  /** Signed by the maintainer's pinned key. Unverified hubs can never cause a removal. */
  verified: boolean;
  keyChanged: boolean;
  warning?: string;
}

export interface RingRequestReview {
  token: string;
  request: RingJoinRequest;
  ring: { id: string; name: string; hubUrl: string };
  applicant: { siteUrl: string; displayName: string; did: string; keyFingerprint: string };
  state: 'new' | 'already-member' | 'banned';
  banReason?: string;
}

export interface JoinedRingSyncResult {
  hubUrl: string;
  name: string;
  outcome: 'member' | 'still-requested' | 'removed' | 'closed' | 'unchanged' | 'error';
  warning?: string;
}

export interface HostedRingSyncResult {
  ringId: string;
  name: string;
  checked: number;
  confirmed: string[];
  autoRemoved: string[];
  failing: string[];
}

/**
 * Curated webrings over static files. A ring's maintainer publishes a signed hub document;
 * applicants send a private signed request link; membership needs both the hub listing the site
 * and the site's own signed connections.json listing the ring. Everything is pulled on demand.
 */
export class RingService {
  private fetcher: JsonFetcher;

  constructor(private db: StudioDatabase, customFetcher?: JsonFetcher) {
    this.fetcher = customFetcher || defaultJsonFetcher;
  }

  /**
   * Ring data only ever comes from the public web: https URLs, never file:// or local paths
   * (which `defaultJsonFetcher` otherwise accepts for offline friend folders).
   */
  private async fetchPublicJson(url: string): Promise<unknown> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    const allowHttp = privatePeersAllowed() && parsed.protocol === 'http:';
    if (parsed.protocol !== 'https:' && !allowHttp) {
      throw new Error(`Ring URLs must use https: ${url}`);
    }
    return this.fetcher(parsed.toString());
  }

  private didDocumentUrl(siteUrl: string): string {
    const url = new URL(normalizeSiteUrl(siteUrl));
    // did:web puts root-domain documents under /.well-known and sub-path ones beside the site
    return url.pathname === '/' || url.pathname === ''
      ? `${url.origin}/.well-known/did.json`
      : `${normalizeSiteUrl(siteUrl)}/did.json`;
  }

  /**
   * Fetches a site's did.json, checks it belongs to that site, and pins its key on first use.
   * Returns the *pinned* key, so a changed key never verifies anything.
   */
  private async fetchSiteKey(
    siteUrl: string
  ): Promise<{ did: string; publicKeyPem: string; keyChanged: boolean }> {
    const normalized = normalizeSiteUrl(siteUrl);
    const expectedDid = siteUrlToDidWeb(normalized);
    const didDoc = DidDocumentSchema.parse(await this.fetchPublicJson(this.didDocumentUrl(normalized)));
    if (didDoc.id !== expectedDid) {
      throw new Error(`did.json at ${normalized} is for ${didDoc.id}, not ${expectedDid}`);
    }
    const fetchedPem = didDoc.verificationMethod[0]?.publicKeyPem;
    if (!fetchedPem) {
      throw new Error(`did.json at ${normalized} has no public key`);
    }
    const status = this.db.pinSiteKey(normalized, expectedDid, fetchedPem);
    const pinned = this.db.getSiteKey(normalized)!;
    return { did: expectedDid, publicKeyPem: pinned.publicKeyPem, keyChanged: status === 'changed' };
  }

  /**
   * Fetches and checks a hub document. Throws if the document isn't really the ring at `hubUrl`
   * (re-hosted copy, wrong maintainer); returns `verified: false` for unsigned (v1) hubs or a
   * changed maintainer key.
   */
  public async fetchHub(hubUrl: string): Promise<VerifiedHub> {
    const url = hubUrl.trim();
    const raw = (await this.fetchPublicJson(url)) as Record<string, unknown>;
    const doc = WebringHubDocumentSchema.parse(raw);
    if (doc.hubUrl.trim() !== url) {
      throw new Error(`This hub says it lives at ${doc.hubUrl}, not ${url}`);
    }
    const maintainerUrl = normalizeSiteUrl(doc.maintainerUrl);
    if (!isUrlWithinSite(url, maintainerUrl)) {
      throw new Error(`Hub ${url} isn't on its maintainer's site (${maintainerUrl})`);
    }
    if (!doc.proof) {
      return { doc, verified: false, keyChanged: false, warning: 'Unsigned (older) hub: membership can’t be verified.' };
    }
    if (doc.maintainerDid !== siteUrlToDidWeb(maintainerUrl)) {
      throw new Error(`Hub maintainer DID doesn't match ${maintainerUrl}`);
    }
    const key = await this.fetchSiteKey(maintainerUrl);
    if (key.keyChanged) {
      return {
        doc,
        verified: false,
        keyChanged: true,
        warning: 'The maintainer’s signing key changed. Ring links are frozen until you review it.',
      };
    }
    if (!verifyDocumentSignature(raw as Parameters<typeof verifyDocumentSignature>[0], key.publicKeyPem)) {
      throw new Error('Hub signature is invalid.');
    }
    return { doc, verified: true, keyChanged: false };
  }

  // ---------------------------------------------------------------------------
  // Applicant side

  /**
   * Verifies the hub, records the ring as 'requested', and returns a private signed request link
   * for the user to send the maintainer. The site must already be published (for its did.json).
   */
  public async requestToJoin(hubUrl: string): Promise<{ ring: JoinedRing; requestLink: string; warning?: string }> {
    const hub = await this.fetchHub(hubUrl);
    if (hub.doc.status === 'closed') {
      throw new Error(`"${hub.doc.name}" is closed and no longer accepts members.`);
    }
    const profile = this.db.getProfile();
    const siteUrl = normalizeSiteUrl(profile.siteUrl);
    const did = siteUrlToDidWeb(siteUrl);
    const unsigned: RingJoinRequest = {
      type: 'webring-join-request',
      version: 1,
      hubUrl: hub.doc.hubUrl.trim(),
      siteUrl,
      did,
      displayName: profile.displayName.slice(0, 120),
      createdAt: new Date().toISOString(),
    };
    const token = encodeRingRequestToken(signDocument(unsigned, did, this.db.getKeys().privateKeyPem));
    const existing = this.db.getJoinedRings().find((r) => r.hubUrl === unsigned.hubUrl);
    const ring = this.db.upsertJoinedRing({
      hubUrl: unsigned.hubUrl,
      name: hub.doc.name,
      description: hub.doc.description,
      maintainerUrl: normalizeSiteUrl(hub.doc.maintainerUrl),
      maintainerDid: hub.doc.maintainerDid || siteUrlToDidWeb(hub.doc.maintainerUrl),
      directoryUrl: hub.doc.directoryUrl || '',
      hubVerified: hub.verified,
      requestToken: token,
      status: existing?.status === 'member' ? 'member' : 'requested',
      syncWarning: hub.warning || '',
    });
    return { ring, requestLink: buildRingRequestUri(token), warning: hub.warning };
  }

  // ---------------------------------------------------------------------------
  // Maintainer side

  /**
   * Checks a request link without changing anything: valid signature from the applicant's own
   * site key, not expired, for a ring this persona hosts, and whether they're banned or already in.
   */
  public async reviewRequest(linkOrToken: string): Promise<RingRequestReview> {
    const token = parseRingRequestUri(linkOrToken);
    if (!token) throw new Error('That isn’t a ring request link.');
    let request: RingJoinRequest;
    try {
      request = decodeRingRequestToken(token);
    } catch {
      throw new Error('The ring request link is damaged or incomplete.');
    }
    const ring = this.db.getHostedRings().find((r) => r.hubUrl === request.hubUrl.trim());
    if (!ring) {
      throw new Error(
        `This request is for the ring at ${request.hubUrl}, which the active persona doesn’t host. Switch to the persona whose site is ${new URL(request.hubUrl).origin} and try again.`
      );
    }
    const siteUrl = normalizeSiteUrl(request.siteUrl);
    if (request.did !== siteUrlToDidWeb(siteUrl)) {
      throw new Error('The request’s identity doesn’t match its site.');
    }
    const age = Date.now() - new Date(request.createdAt).getTime();
    if (!(age < REQUEST_MAX_AGE_MS && age > -REQUEST_CLOCK_SKEW_MS)) {
      throw new Error('This request has expired. Ask the applicant to send a new one.');
    }
    const key = await this.fetchSiteKey(siteUrl);
    if (key.keyChanged) {
      throw new Error(`${siteUrl}'s signing key changed since you last saw it, so the request can’t be trusted.`);
    }
    if (!verifyDocumentSignature(request as Parameters<typeof verifyDocumentSignature>[0], key.publicKeyPem)) {
      throw new Error('The request’s signature is invalid.');
    }
    const keyFingerprint = publicKeyFingerprint(key.publicKeyPem);
    const ban = this.db.findRingBan(ring.id, { siteUrl, did: request.did, keyFingerprint });
    const alreadyMember =
      ring.members.some((m) => m.siteUrl === siteUrl) ||
      (ring.maintainerIsMember && siteUrl === normalizeSiteUrl(this.db.getProfile().siteUrl));
    return {
      token,
      request,
      ring: { id: ring.id, name: ring.name, hubUrl: ring.hubUrl },
      applicant: { siteUrl, displayName: request.displayName, did: request.did, keyFingerprint },
      state: ban ? 'banned' : alreadyMember ? 'already-member' : 'new',
      banReason: ban?.reason,
    };
  }

  /**
   * Approves, declines or bans a request. Re-checks everything first. Approval takes effect for
   * other sites once the maintainer publishes.
   */
  public async decideRequest(
    linkOrToken: string,
    decision: 'approve' | 'decline' | 'ban',
    reason?: string
  ): Promise<RingRequestReview> {
    const review = await this.reviewRequest(linkOrToken);
    if (decision === 'approve') {
      if (review.state === 'banned') {
        throw new Error(`${review.applicant.siteUrl} is banned from this ring. Unban them first.`);
      }
      if (review.state === 'new') {
        this.db.addRingMember(review.ring.id, review.applicant);
      }
    } else if (decision === 'ban') {
      this.db.banRingMember(review.ring.id, { ...review.applicant, reason });
    }
    // Declined requests aren't stored: requests are private and the applicant can ask again
    return review;
  }

  /**
   * Fetches a member's signed manifest and connections.json (without adding them as a friend or
   * to the feed). Only a fully verified result counts as evidence about their membership.
   */
  private async fetchMemberConnections(
    siteUrl: string
  ): Promise<{ hubUrls: string[]; displayName?: string }> {
    const normalized = normalizeSiteUrl(siteUrl);
    const key = await this.fetchSiteKey(normalized);
    if (key.keyChanged) {
      throw new Error('signing key changed');
    }
    const rawManifest = (await this.fetchPublicJson(`${normalized}/api/manifest.json`)) as Record<string, unknown>;
    const manifest = WebringManifestSchema.parse(rawManifest);
    if (!manifest.proof || !verifyDocumentSignature(rawManifest as Parameters<typeof verifyDocumentSignature>[0], key.publicKeyPem)) {
      throw new Error('manifest signature missing or invalid');
    }
    const endpoint = new URL(manifest.endpoints.connections, `${normalized}/`).toString();
    if (!isUrlWithinSite(endpoint, normalized)) {
      throw new Error('connections endpoint is on another site');
    }
    const rawConnections = (await this.fetchPublicJson(endpoint)) as Record<string, unknown>;
    const connections = ConnectionsDocumentSchema.parse(rawConnections);
    if (
      !connections.proof ||
      !verifyDocumentSignature(rawConnections as Parameters<typeof verifyDocumentSignature>[0], key.publicKeyPem)
    ) {
      throw new Error('connections signature missing or invalid');
    }
    if (normalizeSiteUrl(connections.siteUrl) !== normalized || connections.did !== key.did) {
      throw new Error('connections.json belongs to a different site');
    }
    return { hubUrls: connections.webrings.map((w) => w.hubUrl.trim()) };
  }

  // ---------------------------------------------------------------------------
  // Sync (part of "Sync All")

  /** Refreshes every ring this persona has joined or asked to join. */
  public async syncJoinedRings(): Promise<JoinedRingSyncResult[]> {
    const mySiteUrl = normalizeSiteUrl(this.db.getProfile().siteUrl);
    const results: JoinedRingSyncResult[] = [];
    for (const ring of this.db.getJoinedRings()) {
      if (ring.status === 'removed' || ring.status === 'closed') continue;
      const now = new Date().toISOString();
      let hub: VerifiedHub;
      try {
        hub = await this.fetchHub(ring.hubUrl);
      } catch (err) {
        const warning = err instanceof Error ? err.message : String(err);
        this.db.upsertJoinedRing({ hubUrl: ring.hubUrl, lastSyncedAt: now, syncWarning: warning });
        results.push({ hubUrl: ring.hubUrl, name: ring.name, outcome: 'error', warning });
        continue;
      }
      const { doc } = hub;
      if (hub.keyChanged) {
        // Freeze: keep the last good neighbours, change nothing else
        this.db.upsertJoinedRing({ hubUrl: ring.hubUrl, lastSyncedAt: now, syncWarning: hub.warning });
        results.push({ hubUrl: ring.hubUrl, name: ring.name, outcome: 'unchanged', warning: hub.warning });
        continue;
      }
      if (hub.verified && ring.hubUpdatedAt && doc.updatedAt < ring.hubUpdatedAt) {
        // An older copy (e.g. a stale CDN cache) is no news, not a removal
        this.db.upsertJoinedRing({ hubUrl: ring.hubUrl, lastSyncedAt: now, syncWarning: '' });
        results.push({ hubUrl: ring.hubUrl, name: ring.name, outcome: 'unchanged' });
        continue;
      }
      const common = {
        hubUrl: ring.hubUrl,
        lastSyncedAt: now,
        hubVerified: hub.verified,
        syncWarning: hub.warning || '',
        ...(hub.verified ? { hubUpdatedAt: doc.updatedAt } : {}),
      };
      if (doc.status === 'closed' && hub.verified) {
        this.db.upsertJoinedRing({ ...common, status: 'closed', prevSiteUrl: null, nextSiteUrl: null });
        results.push({ hubUrl: ring.hubUrl, name: ring.name, outcome: 'closed' });
        continue;
      }
      const neighbors = computeRingNeighbors(doc.members, mySiteUrl);
      if (neighbors.isMember) {
        this.db.upsertJoinedRing({
          ...common,
          status: 'member',
          name: doc.name,
          description: doc.description,
          maintainerUrl: normalizeSiteUrl(doc.maintainerUrl),
          maintainerDid: doc.maintainerDid || siteUrlToDidWeb(doc.maintainerUrl),
          directoryUrl: doc.directoryUrl || '',
          prevSiteUrl: neighbors.prevSiteUrl ?? null,
          nextSiteUrl: neighbors.nextSiteUrl ?? null,
          memberCount: neighbors.memberCount,
        });
        results.push({ hubUrl: ring.hubUrl, name: doc.name, outcome: 'member' });
      } else if (ring.status === 'requested') {
        this.db.upsertJoinedRing(common);
        results.push({ hubUrl: ring.hubUrl, name: ring.name, outcome: 'still-requested' });
      } else if (ring.status === 'member' && hub.verified) {
        this.db.upsertJoinedRing({ ...common, status: 'removed', prevSiteUrl: null, nextSiteUrl: null });
        results.push({ hubUrl: ring.hubUrl, name: ring.name, outcome: 'removed' });
      } else {
        // Legacy rows and unverified hubs are never removed automatically
        const warning =
          hub.warning || 'This hub doesn’t list your site. Request to join, or delete the ring.';
        this.db.upsertJoinedRing({ ...common, syncWarning: warning });
        results.push({ hubUrl: ring.hubUrl, name: ring.name, outcome: 'unchanged', warning });
      }
    }
    return results;
  }

  /**
   * Checks every member of every active hosted ring. Members whose verified connections.json no
   * longer lists the ring have left, and are removed (after the approval grace period for new
   * members). Unreachable sites or changed keys only raise a flag; nothing is deleted for them.
   */
  public async syncHostedRings(): Promise<HostedRingSyncResult[]> {
    const mySiteUrl = normalizeSiteUrl(this.db.getProfile().siteUrl);
    const results: HostedRingSyncResult[] = [];
    for (const ring of this.db.getHostedRings().filter((r) => r.status === 'active')) {
      const result: HostedRingSyncResult = {
        ringId: ring.id,
        name: ring.name,
        checked: 0,
        confirmed: [],
        autoRemoved: [],
        failing: [],
      };
      for (const member of ring.members) {
        if (member.siteUrl === mySiteUrl) continue;
        result.checked++;
        try {
          const { hubUrls } = await this.fetchMemberConnections(member.siteUrl);
          const listsRing = hubUrls.includes(ring.hubUrl);
          this.db.recordRingMemberCheck(ring.id, member.siteUrl, { ok: true, listsRing });
          if (listsRing) {
            if (!member.confirmedAt) result.confirmed.push(member.siteUrl);
          } else if (
            member.confirmedAt ||
            Date.now() - new Date(member.joinedAt).getTime() > RING_APPROVAL_GRACE_MS
          ) {
            this.db.removeRingMember(ring.id, member.siteUrl);
            result.autoRemoved.push(member.siteUrl);
          }
        } catch {
          this.db.recordRingMemberCheck(ring.id, member.siteUrl, { ok: false });
          result.failing.push(member.siteUrl);
        }
      }
      results.push(result);
    }
    return results;
  }
}

/** True when the maintainer should be told a member's site hasn't verified for a while. */
export function isRingMemberFlagged(
  member: HostedRing['members'][number],
  now = Date.now()
): boolean {
  if (member.failCount === 0) return false;
  const since = member.lastVerifiedAt || member.joinedAt;
  return now - new Date(since).getTime() > RING_MEMBER_FLAG_AFTER_MS;
}
