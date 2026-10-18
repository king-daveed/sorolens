/**
 * Server-backed email preferences for `/settings` (issue #613).
 *
 * The only notification preference the Sorolens API can actually act on is the
 * digest email, served by:
 *
 *   GET    /api/v1/reports/subscriptions?email=…   listReportSubscriptions
 *   POST   /api/v1/reports/subscriptions           createReportSubscription
 *   DELETE /api/v1/reports/subscriptions/{id}      deleteReportSubscription
 *
 * Those routes are what the digest mailer reads (`ListDueReportSubscriptions`),
 * so writing here is the difference between a preference and a promise. The
 * alert-email toggles have no server surface at all, so they stay in
 * `localStorage` and are labelled as browser-only by the settings page.
 *
 * There is no uniqueness constraint on (email, frequency) in the store, so
 * `syncWeeklyDigest` reconciles against the current list instead of blindly
 * posting: saving the same settings twice must not subscribe the address twice.
 */

import { ApiError } from "./api";
import type { NotificationPreferences } from "./settings";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080";

export type ReportFrequency = "daily" | "weekly";

/** One row of `GET /api/v1/reports/subscriptions`. */
export interface ReportSubscription {
  id: string;
  email: string;
  frequency: ReportFrequency;
  /** 0=Sunday..6=Saturday; the API defaults this to 1 (Monday). */
  dayOfWeek: number;
  createdAt: string;
}

/** Monday, matching both the API default and the digest copy in settings.ts. */
export const MONDAY = 1;

interface RawSubscription {
  id?: unknown;
  email?: unknown;
  frequency?: unknown;
  day_of_week?: unknown;
  created_at?: unknown;
}

function toSubscription(raw: unknown): ReportSubscription | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as RawSubscription;
  if (
    typeof record.id !== "string" ||
    typeof record.email !== "string" ||
    (record.frequency !== "daily" && record.frequency !== "weekly") ||
    typeof record.day_of_week !== "number" ||
    typeof record.created_at !== "string"
  ) {
    return null;
  }
  return {
    id: record.id,
    email: record.email,
    frequency: record.frequency,
    dayOfWeek: record.day_of_week,
    createdAt: record.created_at,
  };
}

async function parseError(res: Response): Promise<ApiError> {
  let message = res.statusText;
  let code: string | undefined;
  try {
    const body = (await res.json()) as { error?: string; code?: string };
    if (typeof body.error === "string") message = body.error;
    if (typeof body.code === "string") code = body.code;
  } catch {
    // A body that is not JSON is still a failed request; keep the status text.
  }
  return new ApiError(res.status, message, code);
}

/** Active digest subscriptions for `email`. An unknown email simply has none. */
export async function listReportSubscriptions(
  email: string
): Promise<ReportSubscription[]> {
  const url = `${API_URL}/api/v1/reports/subscriptions?email=${encodeURIComponent(
    email
  )}`;
  const res = await fetch(url);
  if (!res.ok) throw await parseError(res);

  const payload = (await res.json()) as { subscriptions?: unknown };
  const raw = Array.isArray(payload?.subscriptions)
    ? payload.subscriptions
    : [];
  const out: ReportSubscription[] = [];
  for (const entry of raw) {
    const sub = toSubscription(entry);
    if (sub) out.push(sub);
  }
  return out;
}

/** Registers a digest subscription; the server returns the stored row. */
export async function createReportSubscription(input: {
  email: string;
  frequency: ReportFrequency;
  dayOfWeek?: number;
}): Promise<ReportSubscription | null> {
  const res = await fetch(`${API_URL}/api/v1/reports/subscriptions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      frequency: input.frequency,
      day_of_week: input.dayOfWeek ?? MONDAY,
    }),
  });
  if (!res.ok) throw await parseError(res);
  return toSubscription(await res.json());
}

/** Removes one subscription by id. A 204 is the success answer. */
export async function deleteReportSubscription(id: string): Promise<void> {
  const res = await fetch(
    `${API_URL}/api/v1/reports/subscriptions/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw await parseError(res);
}

export type DigestSyncOutcome =
  /** Nothing to reconcile: no usable address, so nothing is sent to the API. */
  | "skipped"
  /** The server now matches the toggle (created, deleted, or already correct). */
  | "synced"
  /** The server state is unchanged because the request failed. */
  | "failed";

/**
 * Reconciles the weekly-digest toggle with the API.
 *
 * Returns "skipped" when the address is blank or malformed, because posting it
 * would only earn a 422 and the local copy is still the source of truth for the
 * toggles the API cannot serve.
 */
export async function syncWeeklyDigest(
  preferences: NotificationPreferences,
  isValidEmail: (value: string) => boolean
): Promise<DigestSyncOutcome> {
  const email = preferences.email.trim();
  if (!email || !isValidEmail(email)) return "skipped";

  try {
    const existing = await listReportSubscriptions(email);
    const weekly = existing.filter(
      (sub) => sub.frequency === "weekly" && sub.email === email
    );

    if (preferences.channels.weekly_digest) {
      if (weekly.length > 0) {
        // Collapse any historical duplicates down to the first row.
        for (const stale of weekly.slice(1)) {
          await deleteReportSubscription(stale.id);
        }
        return "synced";
      }
      await createReportSubscription({
        email,
        frequency: "weekly",
        dayOfWeek: MONDAY,
      });
      return "synced";
    }

    for (const sub of weekly) {
      await deleteReportSubscription(sub.id);
    }
    return "synced";
  } catch {
    return "failed";
  }
}
