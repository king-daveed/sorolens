/**
 * Unit tests for apps/web/lib/apiKeys.ts (issue #613).
 *
 * fetch is stubbed, so these assert the wire contract the settings page relies
 * on: the real `/api/v1/api-keys` paths, the session bearer that carries the
 * workspace identity, the narrowing of responses to non-secret metadata, and —
 * most importantly — the honest failure when the API refuses to mint a key for
 * a contributor session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./api";
import { SESSION_STORAGE_KEY } from "./user";
import {
  DASHBOARD_KEY_NAME,
  KeyIssuanceUnavailableError,
  createApiKey,
  isKeyIssuanceUnavailable,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
} from "./apiKeys";

const API_KEY_JSON = {
  id: "k_123",
  name: DASHBOARD_KEY_NAME,
  key_prefix: "sl_3f9a1c22",
  scopes: ["read:contracts"],
  user_id: "user_e2e",
  created_at: "2026-09-25T00:00:00.000Z",
  last_used_at: null,
  revoked_at: null,
  rotated_at: null,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function lastCall(): { url: string; init: RequestInit } {
  const calls = vi.mocked(fetch).mock.calls;
  const [url, init] = calls[calls.length - 1];
  return { url: String(url), init: init ?? {} };
}

describe("createApiKey", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({
        user_id: "user_e2e",
        token: "sls_session_token",
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      })
    );
  });

  afterEach(() => {
    window.localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("POSTs to the real endpoint with the session bearer and returns the token once", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(201, { ...API_KEY_JSON, key: "sl_3f9a1c22secretmaterial" })
    );

    const issued = await createApiKey({ userId: "user_e2e" });

    const { url, init } = lastCall();
    expect(url).toMatch(/\/api\/v1\/api-keys$/);
    expect(init.method).toBe("POST");
    expect(
      (init.headers as Record<string, string>).Authorization
    ).toBe("Bearer sls_session_token");
    expect(JSON.parse(String(init.body))).toEqual({
      name: DASHBOARD_KEY_NAME,
      scopes: ["read:contracts"],
      user_id: "user_e2e",
    });

    expect(issued.token).toBe("sl_3f9a1c22secretmaterial");
    // Metadata the page may keep, separated from the one-time plaintext.
    expect(issued).toEqual({
      id: "k_123",
      name: DASHBOARD_KEY_NAME,
      keyPrefix: "sl_3f9a1c22",
      scopes: ["read:contracts"],
      createdAt: "2026-09-25T00:00:00.000Z",
      token: "sl_3f9a1c22secretmaterial",
    });
  });

  it("omits user_id when no session exists, producing a scope-only key", async () => {
    window.localStorage.clear();
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(201, { ...API_KEY_JSON, user_id: null, key: "sl_x" })
    );

    await createApiKey({ name: "script" });

    const { init } = lastCall();
    expect(JSON.parse(String(init.body))).toEqual({
      name: "script",
      scopes: ["read:contracts"],
    });
    expect(
      (init.headers as Record<string, string>).Authorization
    ).toBeUndefined();
  });

  it("turns a 403 insufficient-role answer into an honest refusal", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(403, {
        error: "insufficient role",
        required: "admin",
        role: "contributor",
      })
    );

    const error = await createApiKey({ userId: "user_e2e" }).catch((e) => e);
    expect(error).toBeInstanceOf(KeyIssuanceUnavailableError);
    expect(isKeyIssuanceUnavailable(error)).toBe(true);
    expect((error as Error).message).toContain("admin-scoped credential");
    expect((error as Error).message).toContain("needs admin");
    expect((error as Error).message).toContain("No key was created");
    // The refusal is not a credential: nothing to display or persist.
    expect((error as KeyIssuanceUnavailableError).serverMessage).toBe(
      "insufficient role"
    );
  });

  it("treats an anonymous 401 as the same refusal", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(401, { error: "authentication required" })
    );

    await expect(createApiKey()).rejects.toBeInstanceOf(
      KeyIssuanceUnavailableError
    );
  });

  it("surfaces a validation failure as an ApiError, not a fake success", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(422, { error: "name is required", code: "invalid_input" })
    );

    await expect(createApiKey()).rejects.toBeInstanceOf(ApiError);
  });

  it("rejects a 201 body without a plaintext token instead of inventing one", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(201, API_KEY_JSON));

    await expect(createApiKey()).rejects.toThrow(/malformed key record/);
  });
});

describe("listApiKeys", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps the metadata page and drops any token material on the wire", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, {
        api_keys: [
          { ...API_KEY_JSON, key: "sl_should_not_be_trusted" },
          { id: "", name: "dropped" },
        ],
        next_cursor: "",
      })
    );

    const keys = await listApiKeys();

    expect(lastCall().url).toMatch(/\/api\/v1\/api-keys$/);
    expect(keys).toEqual([
      {
        id: "k_123",
        name: DASHBOARD_KEY_NAME,
        keyPrefix: "sl_3f9a1c22",
        scopes: ["read:contracts"],
        createdAt: "2026-09-25T00:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(keys)).not.toContain("sl_should_not_be_trusted");
  });

  it("refuses to list when the caller lacks the admin role", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(403, { error: "insufficient role", required: "admin" })
    );
    await expect(listApiKeys()).rejects.toBeInstanceOf(
      KeyIssuanceUnavailableError
    );
  });
});

describe("rotateApiKey and revokeApiKey", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rotates through the real subresource and returns the new plaintext once", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, { ...API_KEY_JSON, key: "sl_newtoken" })
    );

    const rotated = await rotateApiKey("k 123");

    expect(lastCall().url).toMatch(/\/api\/v1\/api-keys\/k%20123\/rotate$/);
    expect(rotated.token).toBe("sl_newtoken");
    expect(rotated.keyPrefix).toBe("sl_3f9a1c22");
  });

  it("revokes with DELETE and accepts the 204 answer", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    await expect(revokeApiKey("k_123")).resolves.toBeUndefined();
    expect(lastCall().init.method).toBe("DELETE");
    expect(lastCall().url).toMatch(/\/api\/v1\/api-keys\/k_123$/);
  });

  it("reports a revoked-but-unreachable answer as an error", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(404, { error: "not found", code: "not_found" })
    );

    await expect(revokeApiKey("nope")).rejects.toBeInstanceOf(ApiError);
  });
});
