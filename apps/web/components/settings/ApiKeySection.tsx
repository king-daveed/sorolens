"use client";

import { useState } from "react";
import { maskApiKey, storedKeyLabel, type StoredApiKey } from "@/lib/settings";
import {
  DASHBOARD_KEY_NAME,
  DEFAULT_KEY_SCOPES,
  createApiKey,
  isKeyIssuanceUnavailable,
  revokeApiKey,
} from "@/lib/apiKeys";
import { ApiError } from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";
import { SettingsCard, type SaveState } from "./SettingsCard";

/**
 * API-key card, backed by `POST /api/v1/api-keys` (issue #613).
 *
 * It used to fabricate a `sl_live_…` string in the browser: a credential that
 * authenticated nothing, stored in plaintext forever. Now every action is a call
 * to the API:
 *
 * - Generate/Regenerate mints a real key, bound to the session's user ID, with
 *   the read-only `read:contracts` scope. The plaintext arrives once, is kept in
 *   component state for that one reveal, and is never written to storage — only
 *   the id / name / prefix / scopes / created_at metadata is, through `onCommit`.
 * - Revoke deletes it server-side first; the local record is cleared only when
 *   the API confirms.
 * - When the API refuses (it requires the admin role, which a dashboard session
 *   does not hold), the card says so plainly. It never falls back to a made-up
 *   key, which is the whole point of the issue.
 */
export function ApiKeySection({
  apiKey,
  userId,
  status,
  onCommit,
}: {
  /** Metadata of the key the API issued, or null. Never a token. */
  apiKey: StoredApiKey | null;
  /** Workspace user ID the new key is bound to. */
  userId: string;
  status: SaveState;
  /** Persists the metadata half; called after the API has accepted the change. */
  onCommit: (next: StoredApiKey | null) => boolean;
}) {
  /** Plaintext from the last successful create/rotate. State only, never stored. */
  const [liveToken, setLiveToken] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");

  async function generate() {
    setBusy(true);
    setError(null);
    setNotice(null);
    setCopied("idle");
    try {
      const issued = await createApiKey({
        name: DASHBOARD_KEY_NAME,
        scopes: DEFAULT_KEY_SCOPES,
        userId: userId || undefined,
      });
      setLiveToken(issued.token);
      setRevealed(true);
      onCommit({
        id: issued.id,
        name: issued.name,
        keyPrefix: issued.keyPrefix,
        scopes: issued.scopes,
        createdAt: issued.createdAt,
      });
      setNotice(
        "Copy this token now — the API stores only its hash and will never show it again."
      );
    } catch (err) {
      setLiveToken(null);
      if (isKeyIssuanceUnavailable(err)) {
        setError(err.message);
        setNotice(
          "Ask an operator to create the key for you (admin role), or add a self-service endpoint such as POST /api/v1/api-keys/me."
        );
      } else {
        setError(
          err instanceof ApiError
            ? `The API refused to create a key (${err.status}: ${err.message}). No key was created.`
            : "Could not reach the API, so no key was created."
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!apiKey) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await revokeApiKey(apiKey.id, userId || undefined);
      setLiveToken(null);
      onCommit(null);
      setNotice("Key revoked on the server. This browser no longer stores it.");
    } catch (err) {
      setError(
        isKeyIssuanceUnavailable(err)
          ? "The API would not accept the revocation from this session, so the key is unchanged."
          : err instanceof ApiError
            ? `Could not revoke the key (${err.status}: ${err.message}).`
            : "Could not reach the API; the key is unchanged."
      );
    } finally {
      setBusy(false);
    }
  }

  async function copyToken() {
    if (!liveToken) return;
    setCopied((await copyToClipboard(liveToken)) ? "copied" : "failed");
  }

  return (
    <SettingsCard
      testId="settings-api-key"
      title="API key"
      description="A personal key for calling the Sorolens API from your own scripts. Keys are issued by the API; only the non-secret prefix is kept in this browser."
      status={status}
      hideSave
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-[var(--color-text-primary)]">
            {apiKey ? "Active key" : "No API key"}
          </p>
          <p className="text-xs text-[var(--color-text-secondary)]">
            {apiKey
              ? `“${apiKey.name}” · ${apiKey.scopes.join(", ")} · created ${new Date(
                  apiKey.createdAt
                ).toLocaleDateString()}`
              : "Generate a key to authenticate your own requests."}
          </p>
        </div>

        <code
          data-testid="settings-api-key-value"
          className="rounded bg-[var(--color-bg-page)] px-2 py-1 font-mono text-xs text-[var(--color-text-primary)]"
        >
          {liveToken && revealed ? maskApiKey(liveToken) : storedKeyLabel(apiKey)}
        </code>
      </div>

      <div
        className="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3"
        aria-busy={busy || undefined}
      >
        <button
          type="button"
          data-testid="settings-api-key-generate"
          disabled={busy}
          onClick={() => void generate()}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy
            ? "Asking the API…"
            : apiKey
              ? "Regenerate key"
              : "Generate key"}
        </button>

        <button
          type="button"
          data-testid="settings-api-key-copy"
          disabled={!liveToken || busy}
          onClick={() => void copyToken()}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Copy token
        </button>

        {liveToken && (
          <button
            type="button"
            disabled={!apiKey || busy}
            onClick={() => setRevealed((current) => !current)}
            className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {revealed ? "Hide" : "Reveal"}
          </button>
        )}

        <button
          type="button"
          data-testid="settings-api-key-revoke"
          disabled={!apiKey || busy}
          onClick={() => void revoke()}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          Revoke
        </button>
      </div>

      {copied !== "idle" && (
        <p
          data-testid="settings-api-key-copied"
          role="status"
          aria-live="polite"
          className="text-xs text-[var(--color-text-secondary)]"
        >
          {copied === "copied"
            ? "Token copied to your clipboard."
            : "Copy blocked by the browser — reveal the token and copy it manually."}
        </p>
      )}

      {error && (
        <p
          data-testid="settings-api-key-error"
          role="alert"
          className="text-xs text-[var(--color-text-secondary)]"
        >
          {error}
        </p>
      )}

      {notice && (
        <p
          data-testid="settings-api-key-notice"
          role="status"
          aria-live="polite"
          className="text-xs text-[var(--color-text-secondary)]"
        >
          {notice}
        </p>
      )}
    </SettingsCard>
  );
}
