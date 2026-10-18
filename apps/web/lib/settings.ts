/**
 * Persisted user preferences for the `/settings` page.
 *
 * Two kinds of value live here, and the page has to be honest about which is
 * which:
 *
 * - Values the API owns. An API key is issued by `POST /api/v1/api-keys` and a
 *   weekly digest email is registered with `POST /api/v1/reports/subscriptions`.
 *   Only the *metadata* the server echoes back is cached in `localStorage` —
 *   never a token, because the plaintext is returned exactly once and the API
 *   stores only its hash.
 * - Values this browser owns. The default network and the alert-email channel
 *   toggles have no user-profile endpoint, so they stay in `localStorage` and
 *   the UI labels them as browser-only instead of implying delivery exists.
 *
 * Every helper takes an optional `Storage` argument so it can be unit-tested
 * without a DOM.
 *
 * Theme is deliberately NOT stored here: `ThemeProvider` already owns the
 * `theme` key and applies it to `<html data-theme>`, so the theme card reads and
 * writes through that provider instead of duplicating the state.
 */

export const SETTINGS_STORAGE_KEY = "sorolens_settings";

/** Where a preference actually takes effect, and therefore how it must be labelled. */
export type PreferenceSource =
  /** Round-tripped to the Sorolens API, so it works from any browser. */
  | "api"
  /** Stored in this browser only; the API has no endpoint that reads it yet. */
  | "browser";

export type NotificationChannel =
  "critical_alerts" | "health_changes" | "weekly_digest";

export interface NotificationChannelMeta {
  id: NotificationChannel;
  label: string;
  description: string;
  /** How the toggle takes effect, surfaced verbatim next to the control. */
  source: PreferenceSource;
  sourceNote: string;
}

export const NOTIFICATION_CHANNELS: readonly NotificationChannelMeta[] = [
  {
    id: "critical_alerts",
    label: "Critical alerts",
    description: "Email me when a monitored contract raises a Critical alert.",
    // Only per-contract webhook/Slack/Discord/PagerDuty destinations exist
    // (POST /api/v1/watchdog/subscriptions); no email channel is served.
    source: "browser",
    sourceNote: "Saved in this browser only — the API has no email alerts yet.",
  },
  {
    id: "health_changes",
    label: "Health changes",
    description: "Email me when a contract moves to Degraded or Unresponsive.",
    source: "browser",
    sourceNote: "Saved in this browser only — the API has no email alerts yet.",
  },
  {
    id: "weekly_digest",
    label: "Weekly digest",
    description: "A Monday summary of activity across my tracked contracts.",
    // Backed by the report-subscription surface, which is what actually sends
    // the Monday email. See lib/reportPreferences.ts.
    source: "api",
    sourceNote: "Registered with the Sorolens API — works in every browser.",
  },
];

export interface NotificationPreferences {
  email: string;
  channels: Record<NotificationChannel, boolean>;
}

/**
 * What `/settings` keeps about a server-issued API key.
 *
 * Deliberately the non-secret half of an `APIKey` response: the id (needed for
 * rotate/revoke), the name, the `key_prefix` the API echoes back for
 * recognition, the granted scopes and the creation timestamp. The plaintext
 * token is returned once by `POST /api/v1/api-keys` and lives only in component
 * state for that one reveal — writing it to `localStorage` would leave a real
 * credential readable by any script on the origin.
 */
export interface StoredApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
}

/** Narrows an untrusted JSON payload to the fields it is allowed to persist. */
export function isStoredApiKey(value: unknown): value is StoredApiKey {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    record.id !== "" &&
    typeof record.name === "string" &&
    typeof record.keyPrefix === "string" &&
    Array.isArray(record.scopes) &&
    record.scopes.every((scope) => typeof scope === "string") &&
    typeof record.createdAt === "string"
  );
}

export interface UserSettings {
  /** Network pre-selected in the header selector on first load. */
  defaultNetwork: string;
  notifications: NotificationPreferences;
  /**
   * Metadata of the key the API issued for this browser, or null. Never a
   * token: see {@link StoredApiKey}.
   */
  apiKey: StoredApiKey | null;
}

export const DEFAULT_SETTINGS: UserSettings = {
  // "all" (ALL_NETWORKS in lib/network.tsx) keeps the dashboard's existing
  // unfiltered default, so the app only switches network once a user has
  // explicitly saved a preference here.
  defaultNetwork: "all",
  notifications: {
    email: "",
    channels: {
      critical_alerts: true,
      health_changes: true,
      weekly_digest: false,
    },
  },
  apiKey: null,
};

/** Deliberately permissive: catches typos without rejecting valid addresses. */
export function isValidEmail(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;
  if (/\s/.test(trimmed)) return false;
  return /^[^@.]+(\.[^@.]+)*@[^@.]+(\.[^@.]+)+$/.test(trimmed);
}

/**
 * Renders a live token for display without revealing the whole secret.
 *
 * Only ever applied to a token the API just handed back in the current page
 * lifetime; nothing here stores it.
 */
export function maskApiKey(key: string | null): string {
  if (!key) return "";
  if (key.length <= 12) return "•".repeat(key.length);
  return `${key.slice(0, 8)}${"•".repeat(8)}${key.slice(-4)}`;
}

/**
 * The resting display for a persisted key: the non-secret prefix the API
 * echoes back, padded so it reads like a redacted credential.
 */
export function storedKeyLabel(key: StoredApiKey | null): string {
  if (!key) return "—";
  return `${key.keyPrefix}${"•".repeat(8)}`;
}

function coerceSettings(raw: unknown): UserSettings {
  if (raw === null || typeof raw !== "object") return DEFAULT_SETTINGS;
  const value = raw as Partial<UserSettings>;
  const channels = (
    value.notifications as Partial<NotificationPreferences> | undefined
  )?.channels;

  // Merge over the defaults so a blob written by an older build (or a partial
  // write) can never leave the page reading `undefined`.
  return {
    defaultNetwork:
      typeof value.defaultNetwork === "string" && value.defaultNetwork
        ? value.defaultNetwork
        : DEFAULT_SETTINGS.defaultNetwork,
    notifications: {
      email:
        typeof value.notifications?.email === "string"
          ? value.notifications.email
          : DEFAULT_SETTINGS.notifications.email,
      channels: {
        critical_alerts:
          channels?.critical_alerts ??
          DEFAULT_SETTINGS.notifications.channels.critical_alerts,
        health_changes:
          channels?.health_changes ??
          DEFAULT_SETTINGS.notifications.channels.health_changes,
        weekly_digest:
          channels?.weekly_digest ??
          DEFAULT_SETTINGS.notifications.channels.weekly_digest,
      },
    },
    // Migration for the pre-#613 blob: `apiKey` used to hold a fabricated
    // `sl_live_…` string. A string is never a valid stored key, so it is
    // dropped on read rather than re-persisted as if it authenticated anything.
    // A valid object is narrowed field by field, so an accidental extra
    // property (a token, say) can never reach storage through this path.
    apiKey: apiKeyForStorage(value.apiKey),
  };
}

/** Keeps only the non-secret halves of a key record. */
function apiKeyForStorage(value: unknown): StoredApiKey | null {
  if (!isStoredApiKey(value)) return null;
  return {
    id: value.id,
    name: value.name,
    keyPrefix: value.keyPrefix,
    scopes: [...value.scopes],
    createdAt: value.createdAt,
  };
}

function resolveStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Storage can throw when cookies are blocked; fall back to defaults.
    return null;
  }
}

/** Reads stored preferences, always returning a complete settings object. */
export function loadSettings(storage?: Storage): UserSettings {
  const store = resolveStorage(storage);
  if (!store) return DEFAULT_SETTINGS;
  try {
    const raw = store.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return coerceSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Persists preferences. Returns false when storage is unavailable or full.
 *
 * The blob is written through `coerceSettings`, so only the whitelisted fields
 * reach storage: an object that happens to carry a live token (or any other
 * stray property) is reduced to display metadata on the way to disk.
 */
export function saveSettings(
  settings: UserSettings,
  storage?: Storage
): boolean {
  const store = resolveStorage(storage);
  if (!store) return false;
  try {
    store.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify(coerceSettings(settings))
    );
    return true;
  } catch {
    return false;
  }
}

export function clearSettings(storage?: Storage): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.removeItem(SETTINGS_STORAGE_KEY);
  } catch {
    // Nothing to do: the caller re-renders from defaults either way.
  }
}
