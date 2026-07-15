/**
 * Music Assistant provider — implements both MusicSource and PlayerTarget.
 *
 * MA collapses the source/target split: it supplies Apple Music search,
 * metadata, and artwork, and it plays to Sonos (and everything else) with
 * correct per-account authorization. See PROJECT.md for why Crate uses
 * MA instead of node-sonos-http-api + iTunes.
 */

import type {
  ExtraMediaKind,
  MaConfigEntry,
  MaConfigValue,
  MaProviderManifest,
  MaProviderType,
  MaSource,
  MaStatus,
  PlaybackState,
  PlayerState,
  PlayerType,
  RepeatMode,
  SourceKinds,
  Track,
} from '@crate/shared';
import { MaClient, type MaClientOptions, type MaEvent, type MaServerInfo } from './ma-client.js';
import type {
  MusicSource,
  PlayerTarget,
  ProviderAlbum,
  ProviderArtist,
  ProviderChapter,
  ProviderEpisode,
  ProviderLibraryAlbum,
  ProviderMediaItem,
  ProviderPlayer,
  ProviderPlaylist,
  ProviderQueue,
  ProviderQueueTrack,
  ProviderTrackHit,
  TransportCommand,
} from './interfaces.js';

function rec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** `apple_music://album/594061854` → { provider, type, id }. */
export function parseProviderUri(uri: string): { provider: string; type: string; id: string } | null {
  const m = /^([^:]+):\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) return null;
  return { provider: m[1]!, type: m[2]!, id: m[3]! };
}

function firstArtistName(item: Record<string, unknown>): string {
  const artists = arr(item['artists']);
  for (const a of artists) {
    const name = str(rec(a)['name']);
    if (name) return name;
  }
  const single = str(rec(item['artist'])['name']);
  return single ?? '(unknown artist)';
}

/** MA marks explicit content on the item's metadata; tri-state (true/false/unknown). */
function trackExplicit(item: Record<string, unknown>): boolean | null {
  const e = rec(item['metadata'])['explicit'];
  return typeof e === 'boolean' ? e : null;
}

function mapPlayerType(provider: string, name: string): PlayerType {
  const p = provider.toLowerCase();
  const n = name.toLowerCase();
  if (p.includes('sonos')) return 'sonos';
  if (n.includes('homepod')) return 'homepod';
  if (p.includes('airplay')) return 'airplay';
  if (p.includes('cast')) return 'cast';
  if (p.includes('web') || p.includes('builtin')) return 'web';
  return 'other';
}

function mapPlaybackState(raw: string | undefined): PlaybackState {
  switch (raw) {
    case 'playing':
      return 'playing';
    case 'paused':
      return 'paused';
    case 'idle':
      return 'idle';
    default:
      return 'unknown';
  }
}

function mapRepeat(v: string | undefined): RepeatMode {
  return v === 'one' || v === 'all' ? v : 'off';
}

/** Config keys of MA's builtin provider's auto-generated "smart" playlists (Random Album,
    Infinite Mix, Recently played, …) — the ones that clutter Crate search when left on. */
const BUILTIN_PLAYLIST_KEYS = [
  'all_favorite_tracks',
  'random_artist',
  'random_album',
  'random_tracks',
  'recently_played',
  'recently_added_tracks',
  'infinite_mix',
  'infinite_mix_favorites',
];

export class MusicAssistantProvider implements MusicSource, PlayerTarget {
  readonly id = 'music-assistant';
  private readonly client: MaClient;
  private readonly maBaseUrl: string;
  private stateDebounce: ReturnType<typeof setTimeout> | undefined;
  // Short-lived album/playlist track-list cache. Opening a card resolves the tracks
  // (getProviderAlbum → getTracks); reusing them when you then hit play makes the play
  // path skip that round-trip, so playback starts sooner.
  private readonly trackCache = new Map<string, { tracks: Track[]; at: number }>();
  // The source list changes rarely; cache it briefly so search/library keystrokes don't each round-trip.
  private providersCache: { at: number; data: Array<{ instanceId: string; name: string; domain: string; iconSvg: string | null; features: string[] }> } | null = null;
  private static readonly TRACK_TTL_MS = 5 * 60_000;
  // Interactive-auth (OAuth / MusicKit) authorize URLs, keyed by the session id we pass when
  // advancing a provider's auth action. MA emits an `auth_session` event with the real URL to open
  // (Spotify's accounts.spotify.com/authorize, Apple Music's MusicKit page, …); the admin polls for it.
  private readonly authUrls = new Map<string, { url: string; at: number }>();

  constructor(opts: MaClientOptions) {
    this.client = new MaClient(opts);
    this.maBaseUrl = opts.url.replace(/\/+$/, '');
    this.client.onEvent((e) => {
      if (e.event === 'auth_session' && typeof e.object_id === 'string' && typeof e.data === 'string') {
        this.authUrls.set(e.object_id, { url: e.data, at: Date.now() });
      }
    });
  }

  /** The authorize URL MA emitted for an in-progress auth flow (once), or null if not yet seen /
      expired (2 min). Consumed on read so it isn't reused. */
  takeAuthUrl(sessionId: string): string | null {
    const hit = this.authUrls.get(sessionId);
    if (!hit) return null;
    this.authUrls.delete(sessionId);
    return Date.now() - hit.at < 120_000 ? hit.url : null;
  }

  start(): Promise<MaServerInfo> {
    return this.client.start();
  }
  onConnect(cb: (info: MaServerInfo) => void): () => void {
    return this.client.onConnect(cb);
  }
  close(): void {
    this.client.close();
  }
  /** Whether the MA websocket is currently connected. */
  get connected(): boolean {
    return this.client.connected;
  }
  /** Epoch ms the current MA connection authenticated, or undefined if disconnected. */
  get connectedSince(): number | undefined {
    return this.client.connectedAt;
  }
  /** MA server version, once connected (for the System status detail line). */
  get serverVersion(): string | undefined {
    return this.client.serverInfo?.server_version;
  }
  /** Reconnect the MA websocket (the "reconnect Music Assistant" action). */
  reconnect(): void {
    this.client.reconnect();
  }

  // --- MA management (Phase 5): sources, provider manifests, status --------

  /** Connection status for the Settings status card. `managesMa` is topology, not MA state. */
  maStatus(managesMa: boolean): MaStatus {
    const info = this.client.serverInfo;
    return {
      connected: this.connected,
      host: this.maBaseUrl,
      serverVersion: info?.server_version ?? null,
      schemaVersion: info?.schema_version ?? null,
      connectedSince: this.connectedSince ?? null,
      managesMa,
    };
  }

  /** All configured MA providers (`config/providers`). The `music` ones are Crate "sources".
      Cross-references the manifests so each source knows whether it's a non-removable builtin. */
  async listSources(): Promise<MaSource[]> {
    const [raw, manifests] = await Promise.all([
      this.client.command<unknown[]>('config/providers', {}),
      this.client.command<unknown[]>('providers/manifests', {}),
    ]);
    const builtinDomains = new Set<string>();
    for (const m of arr(manifests).map(rec)) {
      const domain = str(m['domain']);
      if (domain && m['builtin'] === true) builtinDomains.add(domain);
    }
    return arr(raw).map((r) => this.toSource(rec(r), builtinDomains));
  }

  private toSource(p: Record<string, unknown>, builtinDomains?: Set<string>): MaSource {
    const domain = str(p['domain']) ?? '';
    return {
      instanceId: str(p['instance_id']) ?? '',
      domain,
      type: (str(p['type']) as MaProviderType) ?? 'other',
      name: str(p['name']) ?? str(p['default_name']) ?? domain,
      enabled: p['enabled'] !== false,
      builtin: builtinDomains?.has(domain) ?? false,
      lastError: str(p['last_error']) ?? null,
    };
  }

  /** Provider types available to add (`providers/manifests`), optionally filtered by type. */
  async listAvailableProviders(type?: MaProviderType): Promise<MaProviderManifest[]> {
    const raw = await this.client.command<unknown[]>('providers/manifests', {});
    const all = arr(raw).map((r) => {
      const m = rec(r);
      return {
        domain: str(m['domain']) ?? '',
        name: str(m['name']) ?? '',
        type: (str(m['type']) as MaProviderType) ?? 'other',
        description: str(m['description']) ?? null,
        documentation: str(m['documentation']) ?? null,
        multiInstance: m['multi_instance'] === true,
        builtin: m['builtin'] === true,
        allowDisable: m['allow_disable'] !== false,
        stage: str(m['stage']) ?? null,
        iconSvg: str(m['icon_svg']) ?? null,
      } satisfies MaProviderManifest;
    });
    return type ? all.filter((m) => m.type === type) : all;
  }

  /** Config-flow fields for adding/configuring a provider (`config/providers/get_entries`).
      Re-call with `action` (from an entry's `action`) to advance an interactive flow (e.g. OAuth). */
  async getSourceConfigEntries(
    domain: string,
    opts: { instanceId?: string; action?: string; values?: Record<string, MaConfigValue> } = {},
  ): Promise<MaConfigEntry[]> {
    const raw = await this.client.command<unknown[]>(
      'config/providers/get_entries',
      {
        provider_domain: domain,
        instance_id: opts.instanceId ?? null,
        action: opts.action ?? null,
        values: opts.values ?? null,
      },
      // Advancing a flow (e.g. an OAuth "Authenticate" action) blocks server-side until the
      // user completes the browser sign-in, so give it minutes rather than the default 20s.
      opts.action ? 300_000 : 20_000,
    );
    return arr(raw).map((r) => this.toConfigEntry(rec(r)));
  }

  private toConfigEntry(e: Record<string, unknown>): MaConfigEntry {
    const options = arr(e['options']).map((o) => {
      const r = rec(o);
      return { title: str(r['title']) ?? '', value: r['value'] as string | number | boolean };
    });
    const rng = arr(e['range']);
    const range = rng.length === 2 ? ([Number(rng[0]), Number(rng[1])] as [number, number]) : null;
    return {
      key: str(e['key']) ?? '',
      type: str(e['type']) ?? 'string',
      label: str(e['label']) ?? str(e['key']) ?? '',
      description: str(e['description']) ?? null,
      required: e['required'] === true,
      default: (e['default_value'] as MaConfigValue) ?? null,
      value: (e['value'] as MaConfigValue) ?? null,
      options,
      range,
      multiValue: e['multi_value'] === true,
      hidden: e['hidden'] === true,
      readOnly: e['read_only'] === true,
      advanced: e['advanced'] === true,
      category: str(e['category']) ?? 'generic',
      dependsOn: str(e['depends_on']) ?? null,
      dependsOnValue: (e['depends_on_value'] as MaConfigValue) ?? null,
      dependsOnValueNot: (e['depends_on_value_not'] as MaConfigValue) ?? null,
      action: str(e['action']) ?? null,
      actionLabel: str(e['action_label']) ?? null,
      helpLink: str(e['help_link']) ?? null,
    };
  }

  /** Add (no instanceId) or update (with instanceId) a provider (`config/providers/save`). */
  async saveSource(domain: string, values: Record<string, MaConfigValue>, instanceId?: string): Promise<MaSource> {
    const raw = await this.client.command<Record<string, unknown>>('config/providers/save', {
      provider_domain: domain,
      values,
      instance_id: instanceId ?? null,
    });
    return this.toSource(rec(raw));
  }

  /** Remove a provider instance, incl. MA's default source (`config/providers/remove`). */
  async removeSource(instanceId: string): Promise<void> {
    await this.client.command('config/providers/remove', { instance_id: instanceId });
    this.providersCache = null;
  }

  /** Reload a provider instance (`config/providers/reload`). */
  async reloadSource(instanceId: string): Promise<void> {
    await this.client.command('config/providers/reload', { instance_id: instanceId });
    this.providersCache = null;
  }

  /** The builtin provider's stored config values, keyed by entry key → resolved value.
      `config/providers/get`.values is a dict of full ConfigEntry objects (each with a `.value`);
      collapse it to key → (value ?? default), skipping display-only entries. */
  private async builtinConfigValues(): Promise<Record<string, unknown>> {
    const conf = rec(await this.client.command('config/providers/get', { instance_id: 'builtin' }));
    const stored = rec(conf['values']);
    const values: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(stored)) {
      const entry = rec(raw);
      if (entry['type'] === 'label' || entry['type'] === 'alert') continue;
      const v = entry['value'] ?? entry['default_value'];
      if (v !== null && v !== undefined) values[k] = v;
    }
    return values;
  }

  /** Whether MA's builtin smart playlists are currently exposed (any of them still enabled). */
  async getBuiltinPlaylistsEnabled(): Promise<boolean> {
    const values = await this.builtinConfigValues();
    // Each defaults to true, so "enabled" = not explicitly set to false.
    return BUILTIN_PLAYLIST_KEYS.some((k) => values[k] !== false);
  }

  /** Enable or disable ALL of MA's builtin smart playlists at once. Submits the provider's full
      config (MA's save validates the whole set, e.g. it rejects a missing log_level) with just the
      playlist keys overridden, preserving every other builtin setting (`config/providers/save`). */
  async setBuiltinPlaylists(enabled: boolean): Promise<void> {
    const values = await this.builtinConfigValues();
    for (const k of BUILTIN_PLAYLIST_KEYS) values[k] = enabled;
    await this.client.command('config/providers/save', { provider_domain: 'builtin', values, instance_id: 'builtin' });
  }

  // --- Artwork ------------------------------------------------------------

  private artworkUrl(item: Record<string, unknown>): string | null {
    const image = rec(item['image']);
    const fallback = rec(arr(rec(item['metadata'])['images'])[0]);
    const img = str(image['path']) ? image : fallback;
    const path = str(img['path']);
    const provider = str(img['provider']);
    if (!path) return null;
    if (/^https?:\/\//.test(path)) return path;
    // Non-URL provider path → route through MA's image proxy.
    const q = new URLSearchParams({ path, size: '0' });
    if (provider) q.set('provider', provider);
    return `${this.maBaseUrl}/imageproxy?${q.toString()}`;
  }

  private toProviderAlbum(item: Record<string, unknown>): ProviderAlbum | null {
    const uri = str(item['uri']);
    const title = str(item['name']);
    if (!uri || !title) return null;
    const explicit = rec(item['metadata'])['explicit'];
    // A library item's own `provider` is just "library"; the real streaming source is in its
    // provider_mappings — prefer that so source attribution/badges work for library albums too.
    const map = rec(arr(item['provider_mappings'])[0]);
    const source = str(map['provider_instance']) ?? str(map['provider_domain']);
    return {
      providerUri: uri,
      provider: source ?? str(item['provider']) ?? parseProviderUri(uri)?.provider ?? 'unknown',
      title,
      artist: firstArtistName(item),
      year: num(item['year']) ?? null,
      artworkUrl: this.artworkUrl(item),
      version: str(item['version']) || null,
      explicit: typeof explicit === 'boolean' ? explicit : null,
      inLibrary: item['favorite'] === true,
    };
  }

  private toProviderPlaylist(item: Record<string, unknown>): ProviderPlaylist | null {
    const uri = str(item['uri']);
    const name = str(item['name']);
    if (!uri || !name) return null;
    // A library item's own `provider` is just "library"; the real streaming source is in its
    // provider_mappings — prefer that so the source can be attributed/badged.
    const map = rec(arr(item['provider_mappings'])[0]);
    const source = str(map['provider_instance']) ?? str(map['provider_domain']);
    return {
      providerUri: uri,
      provider: source ?? str(item['provider']) ?? parseProviderUri(uri)?.provider ?? 'unknown',
      name,
      owner: str(item['owner']) ?? null,
      artworkUrl: this.artworkUrl(item),
    };
  }

  // --- MusicSource --------------------------------------------------------

  async search(query: string, limit = 20, providerInstance?: string): Promise<ProviderAlbum[]> {
    const result = rec(
      await this.client.command('music/search', {
        search_query: query,
        media_types: ['album'],
        limit,
        library_only: false,
        ...(providerInstance ? { provider: providerInstance } : {}),
      }),
    );
    return arr(result['albums'])
      .map((a) => this.toProviderAlbum(rec(a)))
      .filter((a): a is ProviderAlbum => a !== null);
  }

  private toTrackHit(item: Record<string, unknown>): ProviderTrackHit | null {
    const uri = str(item['uri']);
    const title = str(item['name']);
    if (!uri || !title) return null;
    return {
      trackUri: uri,
      title,
      artist: firstArtistName(item),
      album: str(rec(item['album'])['name']) ?? '',
      artworkUrl: this.artworkUrl(item),
      explicit: trackExplicit(item),
    };
  }

  private toProviderArtist(item: Record<string, unknown>): ProviderArtist | null {
    const uri = str(item['uri']);
    const name = str(item['name']);
    if (!uri || !name) return null;
    return {
      providerUri: uri,
      provider: str(item['provider']) ?? parseProviderUri(uri)?.provider ?? 'unknown',
      name,
      artworkUrl: this.artworkUrl(item),
    };
  }

  async searchAll(
    query: string,
    limit = 20,
    providerInstance?: string,
  ): Promise<{ artists: ProviderArtist[]; albums: ProviderAlbum[]; playlists: ProviderPlaylist[]; tracks: ProviderTrackHit[] }> {
    const result = rec(
      await this.client.command('music/search', {
        search_query: query,
        media_types: ['artist', 'album', 'playlist', 'track'],
        limit,
        library_only: false,
        ...(providerInstance ? { provider: providerInstance } : {}),
      }),
    );
    return {
      artists: arr(result['artists']).map((a) => this.toProviderArtist(rec(a))).filter((a): a is ProviderArtist => a !== null),
      albums: arr(result['albums']).map((a) => this.toProviderAlbum(rec(a))).filter((a): a is ProviderAlbum => a !== null),
      playlists: arr(result['playlists']).map((p) => this.toProviderPlaylist(rec(p))).filter((p): p is ProviderPlaylist => p !== null),
      tracks: arr(result['tracks']).map((t) => this.toTrackHit(rec(t))).filter((t): t is ProviderTrackHit => t !== null),
    };
  }

  /** An artist's albums — fast. */
  async getArtistAlbums(providerUri: string): Promise<ProviderAlbum[]> {
    const parsed = parseProviderUri(providerUri);
    if (!parsed) return [];
    const raw = await this.client.command('music/artists/artist_albums', {
      item_id: parsed.id,
      provider_instance_id_or_domain: parsed.provider,
    });
    return arr(raw).map((a) => this.toProviderAlbum(rec(a))).filter((a): a is ProviderAlbum => a !== null);
  }

  /** An artist's top tracks, popularity-ranked. Uses the provider's own text search
      (`music/search` for tracks) — the exact ranking the streaming app shows for an
      artist name — rather than `artist_tracks`, which returns an album-grouped catalog
      dump with no popularity. Results are cached per artist. */
  private artistTrackCache = new Map<string, { tracks: ProviderTrackHit[]; at: number }>();
  private static readonly ARTIST_TRACK_TTL_MS = 60 * 60_000; // top tracks change rarely — hold an hour
  private artistTrackInflight = new Map<string, Promise<ProviderTrackHit[]>>();
  async getArtistTopTracks(providerUri: string, artistName?: string): Promise<ProviderTrackHit[]> {
    if (!parseProviderUri(providerUri)) return [];
    const cached = this.artistTrackCache.get(providerUri);
    if (cached && Date.now() - cached.at < MusicAssistantProvider.ARTIST_TRACK_TTL_MS) return cached.tracks;
    // Coalesce concurrent requests (a prefetch + a tap) onto one MA call.
    const inflight = this.artistTrackInflight.get(providerUri);
    if (inflight) return inflight;
    const p = this.fetchArtistTopTracks(providerUri, artistName);
    this.artistTrackInflight.set(providerUri, p);
    try {
      return await p;
    } finally {
      this.artistTrackInflight.delete(providerUri);
    }
  }
  private async fetchArtistTopTracks(providerUri: string, artistName?: string): Promise<ProviderTrackHit[]> {
    const name = artistName?.trim();
    if (!name) return [];
    const wantProvider = parseProviderUri(providerUri)?.provider;
    const result = rec(
      await this.client.command('music/search', {
        search_query: name,
        media_types: ['track'],
        limit: 30,
        library_only: false,
      }),
    );
    // Provider search already ranks by popularity — keep that order. Filter to songs
    // actually crediting this artist (search can surface collabs/covers by others) and
    // to the artist's own provider, then drop title duplicates (e.g. "(… Version)").
    const target = name.toLowerCase();
    const seenTitle = new Set<string>();
    const tracks: ProviderTrackHit[] = [];
    for (const raw of arr(result['tracks'])) {
      const item = rec(raw);
      const hit = this.toTrackHit(item);
      if (!hit) continue;
      const byArtist = arr(item['artists']).some((a) => (str(rec(a)['name']) ?? '').toLowerCase() === target);
      if (!byArtist) continue;
      if (wantProvider && str(item['provider']) && str(item['provider']) !== wantProvider) continue;
      const tkey = hit.title.toLowerCase().replace(/\s*\(.*$/, '').trim();
      if (seenTitle.has(tkey)) continue;
      seenTitle.add(tkey);
      tracks.push(hit);
      if (tracks.length >= 25) break;
    }
    this.artistTrackCache.set(providerUri, { tracks, at: Date.now() });
    return tracks;
  }

  /** Connected streaming music sources (e.g. Apple Music accounts) — for searching
      each and labelling results by source. */
  async listMusicProviders(): Promise<Array<{ instanceId: string; name: string; domain: string; iconSvg: string | null; features: string[] }>> {
    const now = Date.now();
    if (this.providersCache && now - this.providersCache.at < 30_000) return this.providersCache.data;
    // Providers (which streaming sources are connected) + manifests (per-domain SVG icons).
    const [raw, manRaw] = await Promise.all([
      this.client.command('providers', {}),
      this.client.command('providers/manifests', {}).catch((): unknown[] => []),
    ]);
    const iconByDomain = new Map<string, string>();
    for (const m of arr(manRaw).map(rec)) {
      const d = str(m['domain']);
      const icon = str(m['icon_svg']);
      if (d && icon) iconByDomain.set(d, icon);
    }
    const data = arr(raw)
      .map(rec)
      .filter((p) => p['type'] === 'music' && p['is_streaming_provider'] === true && p['available'] !== false)
      .map((p) => {
        const instanceId = str(p['instance_id']) ?? '';
        const domain = str(p['domain']) ?? instanceId.split('--')[0] ?? '';
        // `supported_features` (e.g. "library_radios", "library_albums") declares what the source
        // actually serves — used to decide which media tabs to show, without hardcoding domains.
        const features = arr(p['supported_features']).map((f) => str(f) ?? '').filter(Boolean);
        return { instanceId, name: str(p['name']) ?? 'Music', domain, iconSvg: iconByDomain.get(domain) ?? null, features };
      })
      .filter((p) => p.instanceId);
    this.providersCache = { at: now, data };
    return data;
  }

  /** Which extra media kinds the connected sources can serve, keyed by kind — from each
      source's `supported_features` (e.g. TuneIn → radio; Spotify → podcast + audiobook).
      Drives which extra tabs the front-ends may show. */
  async sourceKinds(): Promise<SourceKinds> {
    const provs = await this.listMusicProviders().catch(() => []);
    const has = (feature: string): boolean => provs.some((p) => p.features.includes(feature));
    return {
      radio: has('library_radios'),
      podcast: has('library_podcasts'),
      audiobook: has('library_audiobooks'),
    };
  }

  /** The user's saved albums. MA returns `library://album/N` uris (canonical + playable)
      with a provider mapping that tells us the real source instance (which Apple Music
      account, later Spotify, etc.). Paged, and optionally scoped/searched/favorites. */
  async listLibraryAlbums(opts: {
    source?: string;
    search?: string;
    favorite?: boolean;
    limit: number;
    offset: number;
  }): Promise<ProviderLibraryAlbum[]> {
    const raw = arr(
      await this.client.command('music/albums/library_items', {
        limit: opts.limit,
        offset: opts.offset,
        order_by: 'sort_name',
        ...(opts.source ? { provider: opts.source } : {}),
        ...(opts.search ? { search: opts.search } : {}),
        ...(opts.favorite ? { favorite: true } : {}),
      }),
    );
    const out: ProviderLibraryAlbum[] = [];
    for (const r of raw) {
      const item = rec(r);
      const base = this.toProviderAlbum(item);
      if (!base) continue;
      const mapping = arr(item['provider_mappings']).map(rec)[0] ?? {};
      out.push({ ...base, sourceInstanceId: str(mapping['provider_instance']) ?? null });
    }
    return out;
  }

  async getAlbum(providerUri: string): Promise<ProviderAlbum | null> {
    const item = rec(await this.client.command('music/item_by_uri', { uri: providerUri }));
    return this.toProviderAlbum(item);
  }

  async getTracks(providerUri: string): Promise<Track[]> {
    const parsed = parseProviderUri(providerUri);
    if (!parsed) return [];
    const cached = this.trackCache.get(providerUri);
    if (cached && Date.now() - cached.at < MusicAssistantProvider.TRACK_TTL_MS) return cached.tracks;
    if (parsed.type === 'playlist') {
      const pl = await this.getPlaylistTracks(parsed.provider, parsed.id);
      this.trackCache.set(providerUri, { tracks: pl, at: Date.now() });
      return pl;
    }
    const raw = await this.client.command('music/albums/album_tracks', {
      item_id: parsed.id,
      provider_instance_id_or_domain: parsed.provider,
      in_library_only: false,
    });
    const tracks = arr(raw).map((t, i): Track => {
      const item = rec(t);
      return {
        index: num(item['track_number']) ?? i + 1,
        title: str(item['name']) ?? `Track ${i + 1}`,
        artist: firstArtistName(item),
        duration: num(item['duration']) ?? null,
        uri: str(item['uri']) ?? null,
        explicit: trackExplicit(item),
      };
    });
    this.trackCache.set(providerUri, { tracks, at: Date.now() });
    return tracks;
  }

  private async getPlaylistTracks(provider: string, id: string): Promise<Track[]> {
    const raw = await this.client.command('music/playlists/playlist_tracks', {
      item_id: id,
      provider_instance_id_or_domain: provider,
    });
    // Playlists have no track numbering of their own — use playlist position.
    // `artists` is often empty in this list payload, and the track's `album.uri`
    // is a name-based ref that won't resolve — so carry the track's own (real)
    // uri and resolve its album lazily on tap (getTrackAlbum).
    return arr(raw).map((t, i): Track => {
      const item = rec(t);
      return {
        index: num(item['position']) ?? i + 1,
        title: str(item['name']) ?? `Track ${i + 1}`,
        artist: arr(item['artists']).length ? firstArtistName(item) : '',
        duration: num(item['duration']) ?? null,
        uri: str(item['uri']) ?? null,
        explicit: trackExplicit(item),
        albumUri: str(item['uri']) ?? null,
      };
    });
  }

  /** Resolve a track uri to its real album uri + 0-based album position. Playlist
      tracks carry an unresolvable name-based album ref; the full track has the real one. */
  async getTrackAlbum(trackUri: string): Promise<{ albumUri: string; trackIndex: number } | null> {
    const parsed = parseProviderUri(trackUri);
    if (!parsed) return null;
    const full = rec(
      await this.client.command('music/tracks/get_track', {
        item_id: parsed.id,
        provider_instance_id_or_domain: parsed.provider,
      }),
    );
    const albumUri = str(rec(full['album'])['uri']);
    const trackNumber = num(full['track_number']) ?? 0;
    return albumUri ? { albumUri, trackIndex: trackNumber > 0 ? trackNumber - 1 : -1 } : null;
  }

  /** Resolve one playlist track's real metadata (playlist_tracks omits artists and
      gives a broken album ref): artist, real album uri, cover art, album position. */
  async enrichTrack(
    trackUri: string,
  ): Promise<{ artist: string; albumUri: string | null; artworkUrl: string | null; albumIndex: number } | null> {
    const parsed = parseProviderUri(trackUri);
    if (!parsed) return null;
    const full = rec(
      await this.client.command('music/tracks/get_track', {
        item_id: parsed.id,
        provider_instance_id_or_domain: parsed.provider,
      }),
    );
    const album = rec(full['album']);
    const trackNumber = num(full['track_number']) ?? 0;
    return {
      artist: firstArtistName(full),
      albumUri: str(album['uri']) ?? null,
      artworkUrl: this.artworkUrl(full) ?? this.artworkUrl(album),
      albumIndex: trackNumber > 0 ? trackNumber - 1 : -1,
    };
  }

  async listLibraryPlaylists(limit = 200): Promise<ProviderPlaylist[]> {
    const raw = await this.client.command('music/playlists/library_items', { limit, favorite: false });
    const items = Array.isArray(raw) ? raw : arr(rec(raw)['items']);
    return items.map((p) => this.toProviderPlaylist(rec(p))).filter((p): p is ProviderPlaylist => p !== null);
  }

  async searchPlaylists(query: string, limit = 20): Promise<ProviderPlaylist[]> {
    const result = rec(
      await this.client.command('music/search', {
        search_query: query,
        media_types: ['playlist'],
        limit,
        library_only: false,
      }),
    );
    return arr(result['playlists'])
      .map((p) => this.toProviderPlaylist(rec(p)))
      .filter((p): p is ProviderPlaylist => p !== null);
  }

  async getPlaylist(providerUri: string): Promise<ProviderPlaylist | null> {
    const item = rec(await this.client.command('music/item_by_uri', { uri: providerUri }));
    return this.toProviderPlaylist(item);
  }

  // --- Extra media: radio / podcasts / audiobooks -------------------------
  // MA exposes each kind through parallel search/library commands. A radio is a live stream;
  // a podcast is a container (fetch its episodes); an audiobook plays directly.

  private static readonly MEDIA_MA: Record<ExtraMediaKind, { search: string; result: string; library: string }> = {
    radio: { search: 'radio', result: 'radio', library: 'music/radios/library_items' },
    podcast: { search: 'podcast', result: 'podcasts', library: 'music/podcasts/library_items' },
    audiobook: { search: 'audiobook', result: 'audiobooks', library: 'music/audiobooks/library_items' },
  };

  /** The provider uri to store/play for a resolved MA item. MA's top-level `uri` is normally the
      playable `provider://type/id`, but for some providers (notably iTunes Podcast Search) it's the
      feed's homepage <link> — e.g. `https://wondery.com/…` — which can't fetch episodes or play.
      When the top-level uri's scheme doesn't match the item's provider, rebuild it from the matching
      provider_mapping's item_id (the real feed id). Search-result items already carry a correct
      top-level uri, so they pass through untouched. */
  private playableUri(item: Record<string, unknown>): string | undefined {
    const uri = str(item['uri']);
    const provider = str(item['provider']);
    if (!uri || !provider || uri.startsWith(`${provider}://`)) return uri;
    const mediaType = str(item['media_type']);
    const mappings = arr(item['provider_mappings']).map(rec);
    const m = mappings.find((x) => str(x['provider_instance']) === provider || str(x['provider_domain']) === provider) ?? mappings[0];
    const instance = m ? (str(m['provider_instance']) ?? str(m['provider_domain'])) : undefined;
    const itemId = m ? str(m['item_id']) : undefined;
    return instance && mediaType && itemId ? `${instance}://${mediaType}/${itemId}` : uri;
  }

  private toProviderMedia(item: Record<string, unknown>): ProviderMediaItem | null {
    const uri = this.playableUri(item);
    const name = str(item['name']);
    if (!uri || !name) return null;
    const md = rec(item['metadata']);
    const authors = arr(item['authors']).map(str).filter((a): a is string => !!a);
    // Audiobook chapters (MA `metadata.chapters`): { position, name, start, end } with start in seconds.
    const chapters = arr(md['chapters'])
      .map((c): ProviderChapter | null => {
        const ch = rec(c);
        const title = str(ch['name']);
        const start = num(ch['start']);
        return title && start != null ? { title, startSec: start } : null;
      })
      .filter((c): c is ProviderChapter => c !== null);
    // Short second line (spine + card): audiobook author(s) → podcast/label publisher →
    // radio tagline. The full blurb goes in `about` (shown behind an expander on the card),
    // NOT here — using the whole description as the second line made spines read strangely.
    const publisher = str(item['publisher']);
    const secondLine = (authors.length ? authors.join(', ') : null) ?? publisher ?? str(md['description']) ?? null;
    const about = str(md['description']) ?? null;
    return {
      providerUri: uri,
      provider: str(item['provider']) ?? parseProviderUri(uri)?.provider ?? 'unknown',
      name,
      description: secondLine,
      // Full description/blurb — only when it isn't already the second line (radio taglines).
      ...(about && about !== secondLine ? { about } : {}),
      artworkUrl: this.artworkUrl(item),
      durationSec: num(item['duration']) ?? null,
      resumeMs: num(item['resume_position_ms']) ?? null,
      fullyPlayed: item['fully_played'] === true,
      ...(chapters.length ? { chapters } : {}),
    };
  }

  /** Search one extra media kind (across all capable providers, or one when scoped). */
  async searchMedia(kind: ExtraMediaKind, query: string, limit = 20, providerInstance?: string): Promise<ProviderMediaItem[]> {
    const m = MusicAssistantProvider.MEDIA_MA[kind];
    const result = rec(
      await this.client.command('music/search', {
        search_query: query,
        media_types: [m.search],
        limit,
        library_only: false,
        ...(providerInstance ? { provider: providerInstance } : {}),
      }),
    );
    return arr(result[m.result])
      .map((r) => this.toProviderMedia(rec(r)))
      .filter((r): r is ProviderMediaItem => r !== null);
  }

  /** The user's saved items of one kind from the MA library. NB: omit the `favorite` filter —
      MA reads `favorite:false` as "non-favorites ONLY", which hid any favorited library item. */
  async listLibraryMedia(kind: ExtraMediaKind, limit = 200): Promise<ProviderMediaItem[]> {
    const raw = await this.client.command(MusicAssistantProvider.MEDIA_MA[kind].library, { limit });
    const items = Array.isArray(raw) ? raw : arr(rec(raw)['items']);
    return items.map((r) => this.toProviderMedia(rec(r))).filter((r): r is ProviderMediaItem => r !== null);
  }

  /** Resolve one item (name, subtitle, artwork) for ingestion. */
  async getMedia(providerUri: string): Promise<ProviderMediaItem | null> {
    const item = rec(await this.client.command('music/item_by_uri', { uri: providerUri }));
    return this.toProviderMedia(item);
  }

  /** A podcast's episodes (its playable children), newest first as MA returns them. */
  async listPodcastEpisodes(providerUri: string, limit = 200): Promise<ProviderEpisode[]> {
    const parsed = parseProviderUri(providerUri);
    if (!parsed) return [];
    const raw = await this.client.command('music/podcasts/podcast_episodes', {
      item_id: parsed.id,
      provider_instance_id_or_domain: parsed.provider,
      limit,
    });
    const items = Array.isArray(raw) ? raw : arr(rec(raw)['items']);
    return items
      .map((e): ProviderEpisode | null => {
        const ep = rec(e);
        const uri = str(ep['uri']);
        const title = str(ep['name']);
        if (!uri || !title) return null;
        const md = rec(ep['metadata']);
        const dur = num(ep['duration']);
        return {
          trackUri: uri,
          title,
          durationSec: dur ?? null,
          subtitle: str(md['description']) ?? null,
          releaseDate: str(md['release_date']) ?? null,
          resumeMs: num(ep['resume_position_ms']) ?? null,
          fullyPlayed: ep['fully_played'] === true,
        };
      })
      .filter((e): e is ProviderEpisode => e !== null);
  }

  // --- PlayerTarget -------------------------------------------------------

  async listPlayers(): Promise<ProviderPlayer[]> {
    const raw = await this.client.command('players/all', { return_unavailable: true });
    return arr(raw).map((p): ProviderPlayer => {
      const item = rec(p);
      const id = str(item['player_id']) ?? '';
      const name = str(item['display_name']) ?? str(item['name']) ?? id;
      const provider = str(item['provider']) ?? 'unknown';
      return { id, name, type: mapPlayerType(provider, name), available: item['available'] !== false, provider };
    });
  }

  async play(playerId: string, providerUri: string, opts?: { trackIndex?: number }): Promise<void> {
    const idx = opts?.trackIndex ?? 0;
    // Make end-of-queue deterministic regardless of the player's inherited MA settings — flow
    // mode can otherwise re-loop the final track. Fire-and-forget.
    void this.client.command('player_queues/repeat', { queue_id: playerId, repeat_mode: 'off' }).catch(() => {});
    // Whole album from the top: just queue it.
    if (idx <= 0) {
      await this.client.command('player_queues/play_media', { queue_id: playerId, media: providerUri, option: 'replace' });
      return;
    }
    const tracks = await this.getTracks(providerUri).catch((): Track[] => []);
    const startUri = tracks[idx]?.uri;
    if (!startUri) {
      await this.client.command('player_queues/play_media', { queue_id: playerId, media: providerUri, option: 'replace' });
      return;
    }
    // Play the exact tapped track immediately, then append the rest of the album in the
    // background so playback continues. This starts on the right song with NO track-0 blip
    // (unlike play_media(album)+play_index, which lets track 0 sound while the album loads).
    // NB: the "not encoded correctly" Sonos error on resume is an Apple-Music-to-Sonos
    // encoding bug (reproduces from the Music Assistant UI and even the native Sonos app),
    // independent of how we queue — so we keep the faster, blip-free path here.
    await this.client.command('player_queues/play_media', { queue_id: playerId, media: startUri, option: 'replace' });
    const rest = tracks.slice(idx + 1).map((t) => t.uri).filter((u): u is string => !!u);
    if (rest.length)
      void this.client.command('player_queues/play_media', { queue_id: playerId, media: rest, option: 'add' }).catch(() => {});
  }

  /** Play an explicit ordered list of track uris (e.g. a curated playlist shelf): the
      first replaces the queue and starts, the rest are appended so it plays through. */
  async playTracks(playerId: string, trackUris: string[]): Promise<void> {
    const [first, ...rest] = trackUris;
    if (!first) return;
    void this.client.command('player_queues/repeat', { queue_id: playerId, repeat_mode: 'off' }).catch(() => {});
    await this.client.command('player_queues/play_media', { queue_id: playerId, media: first, option: 'replace' });
    if (rest.length) void this.client.command('player_queues/play_media', { queue_id: playerId, media: rest, option: 'add' }).catch(() => {});
  }

  async transport(playerId: string, cmd: TransportCommand, positionSec?: number): Promise<void> {
    const map: Record<TransportCommand, string> = {
      // `resume` continues from the last position whether the queue was paused or
      // stopped; `play` alone can restart. In Crate, transport 'play' always means
      // "continue" (a fresh start goes through play_media).
      play: 'player_queues/resume',
      pause: 'player_queues/pause',
      next: 'player_queues/next',
      previous: 'player_queues/previous',
      seek: 'player_queues/seek',
    };
    const args: Record<string, unknown> = { queue_id: playerId };
    if (cmd === 'seek') args['position'] = Math.max(0, Math.floor(positionSec ?? 0));
    await this.client.command(map[cmd], args);
  }

  /** A player's live queue for the "Up Next" overlay. queue_id == player_id (as with transport). */
  async getQueue(playerId: string, limit = 100): Promise<ProviderQueue> {
    const active = rec(await this.client.command('player_queues/get_active_queue', { player_id: playerId }));
    // An idle/stopped player keeps its LAST queue in MA — that's stale, not "up next". Only surface
    // the queue while something is actually playing or paused; otherwise it reads as empty.
    const state = str(active['state']);
    if (state !== 'playing' && state !== 'paused') return { items: [], currentIndex: null };
    const raw = await this.client.command('player_queues/items', { queue_id: playerId, limit, offset: 0 });
    const items = (Array.isArray(raw) ? raw : arr(rec(raw)['items']))
      .map((r, i) => this.toQueueTrack(rec(r), i))
      .filter((x): x is ProviderQueueTrack => x !== null);
    return { items, currentIndex: num(active['current_index']) ?? null };
  }

  private toQueueTrack(item: Record<string, unknown>, index: number): ProviderQueueTrack | null {
    const id = str(item['queue_item_id']);
    if (!id) return null;
    const media = rec(item['media_item']);
    const artists = arr(media['artists'])
      .map((a) => str(rec(a)['name']))
      .filter((n): n is string => !!n);
    return {
      id,
      index,
      title: str(item['name']) ?? str(media['name']) ?? 'Unknown',
      subtitle: artists.length ? artists.join(', ') : (str(rec(media['album'])['name']) ?? null),
      artworkUrl: this.artworkUrl(item) ?? this.artworkUrl(media),
    };
  }

  async playQueueIndex(playerId: string, index: number): Promise<void> {
    await this.client.command('player_queues/play_index', { queue_id: playerId, index });
  }
  async moveQueueItem(playerId: string, queueItemId: string, posShift: number): Promise<void> {
    await this.client.command('player_queues/move_item', { queue_id: playerId, queue_item_id: queueItemId, pos_shift: posShift });
  }
  async removeQueueItem(playerId: string, itemIdOrIndex: string | number): Promise<void> {
    await this.client.command('player_queues/delete_item', { queue_id: playerId, item_id_or_index: itemIdOrIndex });
  }
  async clearQueue(playerId: string): Promise<void> {
    await this.client.command('player_queues/clear', { queue_id: playerId });
  }
  /** Append a media item (album/playlist/track uri) to the end of the player's queue. */
  async enqueue(playerId: string, providerUri: string): Promise<void> {
    await this.client.command('player_queues/play_media', { queue_id: playerId, media: providerUri, option: 'add' });
  }

  async setVolume(playerId: string, level: number): Promise<void> {
    await this.client.command('players/cmd/volume_set', {
      player_id: playerId,
      volume_level: Math.max(0, Math.min(100, Math.round(level))),
    });
  }

  async setMembers(targetPlayerId: string, add: string[], remove: string[]): Promise<void> {
    await this.client.command('players/cmd/set_members', {
      target_player: targetPlayerId,
      player_ids_to_add: add,
      player_ids_to_remove: remove,
    });
  }

  async setShuffle(playerId: string, enabled: boolean): Promise<void> {
    await this.client.command('player_queues/shuffle', { queue_id: playerId, shuffle_enabled: enabled });
  }

  async setRepeat(playerId: string, mode: RepeatMode): Promise<void> {
    await this.client.command('player_queues/repeat', { queue_id: playerId, repeat_mode: mode });
  }

  async getState(): Promise<PlayerState[]> {
    const [playersRaw, queuesRaw] = await Promise.all([
      this.client.command('players/all', { return_unavailable: true }),
      this.client.command('player_queues/all'),
    ]);

    const volumeById = new Map<string, { volume: number | null; muted: boolean }>();
    const groupLeaderById = new Map<string, string | null>();
    // The player's OWN state + active source + current media — carries external sources
    // (TV, line-in, AirPlay) that live outside MA's queue, so we can still show what a
    // speaker is playing even when its queue is empty or holds a stale (paused) track.
    const playerById = new Map<string, { state: string; activeSource: string | null; media: Record<string, unknown> | null }>();
    for (const p of arr(playersRaw)) {
      const item = rec(p);
      const id = str(item['player_id']);
      if (!id) continue;
      volumeById.set(id, { volume: num(item['volume_level']) ?? null, muted: item['volume_muted'] === true });
      // MA: `synced_to` = the leader this player follows; `group_childs` = members
      // when this player IS the leader. Solo players lead themselves.
      const syncedTo = str(item['synced_to']);
      const childs = arr(item['group_childs']);
      groupLeaderById.set(id, syncedTo ?? (childs.length ? id : id));
      playerById.set(id, {
        state: str(item['state']) ?? str(item['playback_state']) ?? 'idle',
        activeSource: str(item['active_source']) ?? null,
        media: item['current_media'] ? rec(item['current_media']) : null,
      });
    }
    // A player's active_source is a queue id (its own, or its group leader's) when it's
    // playing MA content; anything else (e.g. "tv", "line_in") is an EXTERNAL source.
    const queueIds = new Set(playerById.keys());

    return arr(queuesRaw)
      .map((q): PlayerState | null => {
        const queue = rec(q);
        const id = str(queue['queue_id']);
        if (!id) return null;
        const vol = volumeById.get(id) ?? { volume: null, muted: false };
        const current = rec(queue['current_item']);
        const media = rec(current['media_item']);
        const hasNow = str(media['name']) !== undefined || str(current['name']) !== undefined;
        // External source: the SPEAKER is playing something outside MA — TV audio, line-in,
        // AirPlay, Spotify Connect, etc. Detected by active_source not being a queue id
        // (its own or its group leader's). This takes priority over the queue, because a
        // speaker on the TV often still has a stale (paused) track sitting in its queue —
        // we must show the TV, not that leftover song.
        {
          const pi = playerById.get(id);
          const m = pi?.media ?? null;
          const extTitle = m ? str(m['title']) : undefined;
          const onExternal = !!pi?.activeSource && !queueIds.has(pi.activeSource);
          if (pi && onExternal && extTitle && (pi.state === 'playing' || pi.state === 'paused')) {
            return {
              playerId: id,
              state: pi.state === 'paused' ? 'paused' : 'playing',
              volume: vol.volume,
              muted: vol.muted,
              groupLeader: groupLeaderById.get(id) ?? id,
              shuffle: false,
              repeat: 'off',
              nowPlaying: {
                albumId: null,
                albumUri: null,
                title: extTitle,
                artist: (m && str(m['artist'])) ?? null,
                album: (m && str(m['album'])) ?? null,
                trackIndex: null,
                trackUri: null,
                duration: (m && num(m['duration'])) ?? null,
                elapsed: (m && num(m['elapsed_time'])) ?? null,
                artworkUrl: (m && str(m['image_url'])) ?? null,
              },
            };
          }
        }
        // Some players (e.g. Sonos via MA) report a *paused* queue as 'idle' while
        // keeping the loaded track — treat "idle with a current item" as paused so it
        // stays resumable and survives a reload, instead of reading as "nothing playing".
        const rawState = mapPlaybackState(str(queue['state']));
        return {
          playerId: id,
          state: rawState === 'idle' && hasNow ? 'paused' : rawState,
          volume: vol.volume,
          muted: vol.muted,
          groupLeader: groupLeaderById.get(id) ?? id,
          shuffle: queue['shuffle_enabled'] === true,
          repeat: mapRepeat(str(queue['repeat_mode'])),
          nowPlaying: hasNow
            ? {
                albumId: null,
                albumUri: str(rec(media['album'])['uri']) ?? null,
                title: str(media['name']) ?? str(current['name']) ?? null,
                artist: firstArtistName(media),
                album: str(rec(media['album'])['name']) ?? null,
                trackIndex: num(queue['current_index']) ?? null,
                trackUri: str(media['uri']) ?? str(current['uri']) ?? null,
                duration: num(current['duration']) ?? num(media['duration']) ?? null,
                elapsed: num(queue['elapsed_time']) ?? null,
                artworkUrl: this.artworkUrl(media) ?? this.artworkUrl(current) ?? this.artworkUrl(rec(media['album'])),
              }
            : null,
        };
      })
      .filter((s): s is PlayerState => s !== null);
  }

  /** Subscribe to frequent elapsed-time ticks (MA `queue_time_updated`). */
  onProgress(cb: (playerId: string, elapsed: number) => void): () => void {
    return this.client.onEvent((e: MaEvent) => {
      if (e.event !== 'queue_time_updated' || !e.object_id) return;
      const elapsed = typeof e.data === 'number' ? e.data : num(rec(e.data)['elapsed_time']);
      if (elapsed !== undefined) cb(e.object_id, elapsed);
    });
  }

  /** Fires (debounced) when the player roster/metadata changes — added, removed,
      or renamed in Music Assistant. */
  onPlayersChanged(cb: () => void): () => void {
    let deb: ReturnType<typeof setTimeout> | undefined;
    const relevant = new Set(['player_added', 'player_removed', 'player_updated']);
    return this.client.onEvent((e: MaEvent) => {
      if (!relevant.has(e.event)) return;
      if (deb) clearTimeout(deb);
      deb = setTimeout(cb, 800);
    });
  }

  onState(cb: (states: PlayerState[]) => void): () => void {
    const refetch = (): void => {
      if (this.stateDebounce) clearTimeout(this.stateDebounce);
      this.stateDebounce = setTimeout(() => {
        this.getState()
          .then(cb)
          .catch(() => {
            /* transient — next event will retry */
          });
      }, 400);
    };
    const relevant = new Set(['queue_updated', 'player_updated', 'player_added', 'player_removed']);
    return this.client.onEvent((e: MaEvent) => {
      if (relevant.has(e.event)) refetch();
    });
  }
}
