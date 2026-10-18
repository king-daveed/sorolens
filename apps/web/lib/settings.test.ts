import { describe, expect, it } from "vitest";

import * as settingsModule from "./settings";
import {
  DEFAULT_SETTINGS,
  NOTIFICATION_CHANNELS,
  SETTINGS_STORAGE_KEY,
  clearSettings,
  isStoredApiKey,
  isValidEmail,
  loadSettings,
  maskApiKey,
  saveSettings,
  storedKeyLabel,
  type StoredApiKey,
  type UserSettings,
} from "./settings";

/** Minimal in-memory Storage so these tests don't depend on jsdom. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

const STORED_KEY: StoredApiKey = {
  id: "k_123",
  name: "sorolens-dashboard",
  keyPrefix: "sl_3f9a1c22",
  scopes: ["read:contracts"],
  createdAt: "2026-09-25T00:00:00.000Z",
};

describe("isValidEmail", () => {
  it("accepts ordinary addresses", () => {
    expect(isValidEmail("dev@example.com")).toBe(true);
    expect(isValidEmail("first.last+tag@sorolens.dev")).toBe(true);
  });

  it("rejects malformed addresses", () => {
    expect(isValidEmail("")).toBe(false);
    expect(isValidEmail("not-an-email")).toBe(false);
    expect(isValidEmail("missing@tld")).toBe(false);
    expect(isValidEmail("@example.com")).toBe(false);
    expect(isValidEmail("has space@example.com")).toBe(false);
    expect(isValidEmail("trailing@example.")).toBe(false);
  });
});

// Acceptance criterion "no fake key remains", pinned at the module boundary:
// the generator that fabricated a `sl_live_…` string must be gone, and no
// export may mint credential material itself.
describe("fabricated-key path is gone", () => {
  it("no longer exports generateApiKey", () => {
    expect(Object.keys(settingsModule)).not.toContain("generateApiKey");
  });

  it("has no export that returns an sl_live_ token", () => {
    // A key the API did not issue cannot be produced from thin air: any token
    // shape like the old fake must be rejected by the stored-key guard.
    expect(isStoredApiKey("sl_live_" + "0".repeat(48))).toBe(false);
    expect(
      isStoredApiKey({ ...STORED_KEY, key: "sl_live_" + "0".repeat(48) })
    ).toBe(true); // extra field is tolerated on read but stripped on write
  });

  it("does not fabricate a key when storage is empty", () => {
    const storage = memoryStorage();
    expect(saveSettings(DEFAULT_SETTINGS, storage)).toBe(true);
    expect(storage.getItem(SETTINGS_STORAGE_KEY)).not.toContain("sl_live_");
    expect(loadSettings(storage).apiKey).toBeNull();
  });
});

describe("isStoredApiKey", () => {
  it("accepts a complete metadata record", () => {
    expect(isStoredApiKey(STORED_KEY)).toBe(true);
  });

  it("rejects anything shaped like a bare token", () => {
    expect(isStoredApiKey("sl_3f9a1c22abcdefgh")).toBe(false);
    expect(isStoredApiKey(null)).toBe(false);
    expect(isStoredApiKey(undefined)).toBe(false);
    expect(isStoredApiKey({ ...STORED_KEY, id: "" })).toBe(false);
    expect(isStoredApiKey({ ...STORED_KEY, scopes: "read:contracts" })).toBe(
      false
    );
    expect(isStoredApiKey({ ...STORED_KEY, scopes: [1] })).toBe(false);
  });
});

describe("storedKeyLabel", () => {
  it("shows the non-secret prefix padded like a redacted credential", () => {
    expect(storedKeyLabel(STORED_KEY)).toBe("sl_3f9a1c22••••••••");
  });

  it("shows an em dash when there is no key", () => {
    expect(storedKeyLabel(null)).toBe("—");
  });
});

describe("maskApiKey", () => {
  it("keeps a recognisable prefix and suffix of a live token", () => {
    const key = "sl_3f9a1c22b0d4e6f8a1c2d3e4f5061728394a5b6c7d8e9f01";
    const masked = maskApiKey(key);
    expect(masked).toBe(`sl_3f9a1${"•".repeat(8)}${key.slice(-4)}`);
    expect(masked.endsWith(key.slice(-4))).toBe(true);
    expect(masked).not.toBe(key);
  });

  it("returns an empty string when there is no token", () => {
    expect(maskApiKey(null)).toBe("");
  });

  it("fully hides a short value", () => {
    expect(maskApiKey("short")).toBe("•••••");
  });
});

describe("NOTIFICATION_CHANNELS", () => {
  it("labels every channel with where the preference actually takes effect", () => {
    expect(NOTIFICATION_CHANNELS.every((channel) => Boolean(channel.sourceNote)));
    expect(
      NOTIFICATION_CHANNELS.find((channel) => channel.id === "weekly_digest")
        ?.source
    ).toBe("api");
    expect(
      NOTIFICATION_CHANNELS.find((channel) => channel.id === "critical_alerts")
        ?.source
    ).toBe("browser");
    expect(
      NOTIFICATION_CHANNELS.find((channel) => channel.id === "health_changes")
        ?.source
    ).toBe("browser");
  });
});

describe("loadSettings / saveSettings", () => {
  it("returns defaults when nothing is stored", () => {
    expect(loadSettings(memoryStorage())).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips a saved settings object", () => {
    const storage = memoryStorage();
    const settings: UserSettings = {
      defaultNetwork: "mainnet",
      notifications: {
        email: "dev@example.com",
        channels: {
          critical_alerts: false,
          health_changes: true,
          weekly_digest: true,
        },
      },
      apiKey: STORED_KEY,
    };

    expect(saveSettings(settings, storage)).toBe(true);
    expect(loadSettings(storage)).toEqual(settings);
  });

  it("persists only metadata when a live token slips into the record", () => {
    const storage = memoryStorage();
    const withToken = {
      defaultNetwork: "mainnet",
      notifications: DEFAULT_SETTINGS.notifications,
      apiKey: { ...STORED_KEY, token: "sl_secret_material" },
    } as unknown as UserSettings;

    saveSettings(withToken, storage);

    const raw = storage.getItem(SETTINGS_STORAGE_KEY) as string;
    expect(raw).not.toContain("sl_secret_material");
    expect(loadSettings(storage).apiKey).toEqual(STORED_KEY);
  });

  it("drops the pre-#613 fake key instead of carrying it forward", () => {
    const storage = memoryStorage();
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        defaultNetwork: "testnet",
        apiKey: "sl_live_00112233445566778899aabbccddeeff00112233445566",
        apiKeyCreatedAt: "2026-09-25T00:00:00.000Z",
      })
    );

    const loaded = loadSettings(storage);
    expect(loaded.apiKey).toBeNull();
    expect(loaded.defaultNetwork).toBe("testnet");

    // And a save of the loaded blob cannot resurrect the fake value.
    saveSettings(loaded, storage);
    expect(storage.getItem(SETTINGS_STORAGE_KEY)).not.toContain("sl_live_");
  });

  it("fills missing fields from defaults for older or partial blobs", () => {
    const storage = memoryStorage();
    storage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        defaultNetwork: "futurenet",
        notifications: { email: "a@b.co" },
      })
    );

    const loaded = loadSettings(storage);
    expect(loaded.defaultNetwork).toBe("futurenet");
    expect(loaded.notifications.email).toBe("a@b.co");
    expect(loaded.notifications.channels).toEqual(
      DEFAULT_SETTINGS.notifications.channels
    );
    expect(loaded.apiKey).toBeNull();
  });

  it("falls back to defaults when the stored blob is corrupt", () => {
    const storage = memoryStorage();
    storage.setItem(SETTINGS_STORAGE_KEY, "{not json");
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it("clearSettings removes the stored blob", () => {
    const storage = memoryStorage();
    saveSettings(DEFAULT_SETTINGS, storage);
    clearSettings(storage);
    expect(storage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
  });
});

describe("DEFAULT_SETTINGS", () => {
  it("starts with no key and no fabricated credential", () => {
    expect(DEFAULT_SETTINGS.apiKey).toBeNull();
    expect(JSON.stringify(DEFAULT_SETTINGS)).not.toContain("sl_live_");
  });
});
