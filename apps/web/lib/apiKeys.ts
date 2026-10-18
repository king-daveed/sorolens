/**
 * Real API-key client for `/settings` (issue #613).
 *
 * The dashboard used to fabricate a `sl_live_…` string in the browser, which
 * looked like a credential and authenticated nothing. This module talks to the
 * endpoints the API actually serves:
 *
 *   POST   /api/v1/api-keys            createApiKey   (plaintext returned once)
 *   GET    /api/v1/api-keys            listApiKeys    (metadata only)
 *   POST   /api/v1/api-keys/{id}/rotate rotateApiKey  (plaintext returned once)
 *   DELETE /api/v1/api-keys/{id}       revokeApiKey
 *
 * Those four routes are admin-gated on the server (`RequireScopes` demands the
 * `admin:*` scope and `RequireRole("admin")` the admin role — see
 * apps/api/internal/middleware/{scopes,roles}.go). A dashboard session minted by
 * `POST /api/v1/auth/session` only carries the contributor role, so the honest
 * outcome for a normal user is a 401/403. That is surfaced as
 * {@link KeyIssuanceUnavailableError} and rendered as a plain explanation; the
 * UI never falls back to a made-up token.
 *
 * `docs/openapi.yaml` has no self-service key endpoint today. The missing
 * backend capability is a session-authenticated route — e.g.
 * `POST /api/v1/api-keys/me` — that issues a key bound to the calling user with
 * non-admin scopes.
 */

import { ApiError } from "./api";
import type { StoredApiKey } from "./settings";
import { sessionHeaders } from "./user";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

/** Scopes the settings page asks for: read-only access to the public surface. */
export const DEFAULT_KEY_SCOPES: readonly string[] = ["read:contracts"];

/** Name given to keys minted from the dashboard, so they are findable later. */
export const DASHBOARD_KEY_NAME = "sorolens-dashboard";

/** A key as issued by the API. `token` is the plaintext, shown exactly once. */
export interface IssuedApiKey extends StoredApiKey {
  token: string;
}

/**
 * The API refused to issue or manage a key because the caller is not an admin.
 * Named for what the user needs to know: key issuance is not available to this
 * session — not that the request "failed".
 */
export class KeyIssuanceUnavailableError extends Error {
  constructor(
    /** 401 (no usable credential) or 403 (credential lacks the admin role). */
    public status: number,
    /** The server's own `error` field, kept verbatim when present. */
    public serverMessage: string,
    public requiredRole?: string
  ) {
    super(
      `The Sorolens API only issues keys to an admin-scoped credential (${
        status === 401 ? "authentication required" : "insufficient role"
      }${requiredRole ? `: needs ${requiredRole}` : ""}). No key was created.`
    );
    this.name = "KeyIssuanceUnavailableError";
  }
}

interface RawApiKey {
  id?: unknown;
  name?: unknown;
  key_prefix?: unknown;
  scopes?: unknown;
  created_at?: unknown;
  revoked_at?: unknown;
  key?: unknown;
}

/**
 * Narrows an untrusted response body to the metadata the page may keep, or null
 * when the payload is not shaped like an APIKey. Kept private: callers get
 * either a narrowed record or a malformed-response error, never raw JSON.
 */
function toStoredApiKey(raw: unknown): StoredApiKey | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as RawApiKey;
  if (
    typeof record.id !== "string" ||
    record.id === "" ||
    typeof record.name !== "string" ||
    typeof record.key_prefix !== "string" ||
    typeof record.created_at !== "string" ||
    !Array.isArray(record.scopes) ||
    !record.scopes.every((scope) => typeof scope === "string")
  ) {
    return null;
  }
  return {
    id: record.id,
    name: record.name,
    keyPrefix: record.key_prefix,
    scopes: [...record.scopes],
    createdAt: record.created_at,
  };
}

function toIssuedApiKey(raw: unknown): IssuedApiKey | null {
  const stored = toStoredApiKey(raw);
  const token = (raw as RawApiKey | null)?.key;
  if (!stored || typeof token !== "string" || token === "") return null;
  return { ...stored, token };
}

async function readErrorBody(res: Response): Promise<Record<string, string>> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const field of ["error", "code", "required", "role"]) {
      if (typeof body[field] === "string") out[field] = body[field] as string;
    }
    return out;
  } catch {
    return {};
  }
}

async function request<T>(
  path: string,
  init: RequestInit,
  parse: (body: unknown) => T | null
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = await readErrorBody(res);
    if (res.status === 401 || res.status === 403) {
      throw new KeyIssuanceUnavailableError(
        res.status,
        body.error ?? res.statusText,
        body.required
      );
    }
    throw new ApiError(res.status, body.error || res.statusText, body.code);
  }

  if (res.status === 204) return undefined as T;

  const payload: unknown = await res.json().catch(() => null);
  const parsed = parse(payload);
  if (parsed === null) {
    throw new ApiError(res.status, "The API returned a malformed key record.");
  }
  return parsed;
}

/** What the settings page asks the API for when it wants a key. */
export interface CreateApiKeyInput {
  name?: string;
  scopes?: readonly string[];
  /** Workspace user the key is bound to; omitted for a scope-only key. */
  userId?: string;
}

/**
 * Creates a key through the API. The plaintext arrives in `token` for this one
 * call only — the caller displays it once and persists just the metadata half.
 */
export function createApiKey(
  input: CreateApiKeyInput = {}
): Promise<IssuedApiKey> {
  const body: Record<string, unknown> = {
    name: input.name ?? DASHBOARD_KEY_NAME,
    scopes: [...(input.scopes ?? DEFAULT_KEY_SCOPES)],
  };
  if (input.userId) body.user_id = input.userId;

  return request<IssuedApiKey>(
    "/api/v1/api-keys",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: sessionHeaders(input.userId),
    },
    toIssuedApiKey
  );
}

/** Lists the key metadata the API has on record. Never includes token material. */
export function listApiKeys(userId?: string): Promise<StoredApiKey[]> {
  return request<{ api_keys?: unknown[] }>(
    "/api/v1/api-keys",
    { method: "GET", headers: sessionHeaders(userId) },
    (payload) => {
      const raw = (payload as { api_keys?: unknown } | null)?.api_keys;
      if (!Array.isArray(raw)) return null;
      const keys: StoredApiKey[] = [];
      for (const entry of raw) {
        const stored = toStoredApiKey(entry);
        if (stored) keys.push(stored);
      }
      return keys;
    }
  );
}

/** Rotates an existing key in place; the new plaintext comes back once. */
export function rotateApiKey(id: string, userId?: string): Promise<IssuedApiKey> {
  return request<IssuedApiKey>(
    `/api/v1/api-keys/${encodeURIComponent(id)}/rotate`,
    { method: "POST", headers: sessionHeaders(userId) },
    toIssuedApiKey
  );
}

/** Revokes a key server-side. A 204 is success; nothing is read back. */
export async function revokeApiKey(
  id: string,
  userId?: string
): Promise<void> {
  const res = await fetch(
    `${API_URL}/api/v1/api-keys/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        ...sessionHeaders(userId),
      },
    }
  );

  if (res.ok) return;

  const body = await readErrorBody(res);
  if (res.status === 401 || res.status === 403) {
    throw new KeyIssuanceUnavailableError(
      res.status,
      body.error ?? res.statusText,
      body.required
    );
  }
  throw new ApiError(res.status, body.error || res.statusText, body.code);
}

/** True when a refusal means "this deployment does not let the dashboard mint keys". */
export function isKeyIssuanceUnavailable(
  error: unknown
): error is KeyIssuanceUnavailableError {
  return error instanceof KeyIssuanceUnavailableError;
}
