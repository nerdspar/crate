/**
 * Music Assistant management DTOs (Phase 5).
 *
 * Crate-facing camelCase projections of MA's config API: configured providers
 * ("sources"), the manifests of provider types available to add, the config-flow
 * entries used to add/configure one, and the connection status shown in Settings.
 * Backed by MA commands: `config/providers`, `providers/manifests`,
 * `config/providers/get_entries|save|remove|reload`.
 */

export type MaProviderType = 'music' | 'player' | 'metadata' | 'plugin' | 'audio_analysis' | 'other';

/** A configured MA provider instance (`config/providers`). Crate surfaces the `music` ones as "sources". */
export interface MaSource {
  instanceId: string;
  /** Provider domain, e.g. "apple_music", "spotify", "builtin". */
  domain: string;
  type: MaProviderType;
  /** Display name (falls back to the default name / domain). */
  name: string;
  enabled: boolean;
  /** Built-in MA provider (its manifest is `builtin`) — can't be removed. */
  builtin: boolean;
  /** MA-reported last error, if the provider failed to load. */
  lastError: string | null;
}

/** A provider type available to add (`providers/manifests`). */
export interface MaProviderManifest {
  domain: string;
  name: string;
  type: MaProviderType;
  description: string | null;
  /** Docs URL for this provider, if any. */
  documentation: string | null;
  /** Whether more than one instance can be configured (e.g. two Apple Music accounts). */
  multiInstance: boolean;
  /** Built-in providers ship with MA and generally can't be removed. */
  builtin: boolean;
  allowDisable: boolean;
  /** Release stage: "stable" | "beta" | "experimental" | … (or null). */
  stage: string | null;
  /** Inline SVG icon markup, if provided. */
  iconSvg: string | null;
}

export type MaConfigValue = string | number | boolean | string[] | null;

/** One field in a provider's config flow (`config/providers/get_entries`). */
export interface MaConfigEntry {
  key: string;
  /** MA's ConfigEntryType: "string" | "integer" | "boolean" | "label" | "password" | "secure_string" | … */
  type: string;
  label: string;
  description: string | null;
  required: boolean;
  default: MaConfigValue;
  value: MaConfigValue;
  /** Select options, when present. */
  options: Array<{ title: string; value: string | number | boolean }>;
  /** [min, max] for numeric entries, else null. */
  range: [number, number] | null;
  multiValue: boolean;
  hidden: boolean;
  readOnly: boolean;
  /** Advanced fields are collapsed behind a disclosure by default. */
  advanced: boolean;
  /** Grouping key (e.g. "generic", "sync_options"). */
  category: string;
  /** Conditional visibility: show only when field `dependsOn` equals `dependsOnValue`
      (or does not equal `dependsOnValueNot`). */
  dependsOn: string | null;
  dependsOnValue: MaConfigValue;
  dependsOnValueNot: MaConfigValue;
  /** Action button (e.g. an OAuth "Authenticate" step): re-request entries with this action id. */
  action: string | null;
  actionLabel: string | null;
  helpLink: string | null;
}

/** MA connection config + live state (the token value never leaves the server). */
export interface MaConnection {
  /** MA base URL Crate points at. */
  url: string;
  /** Whether a token is stored. */
  hasToken: boolean;
  connected: boolean;
  serverVersion: string | null;
}

/** MA connection status for the Settings status card. */
export interface MaStatus {
  connected: boolean;
  /** MA base URL Crate is pointed at. */
  host: string;
  serverVersion: string | null;
  schemaVersion: number | null;
  /** Epoch ms the current connection authenticated, else null. */
  connectedSince: number | null;
  /** True when Crate co-hosts/manages this MA → restart is offered; false for an external MA. */
  managesMa: boolean;
}
