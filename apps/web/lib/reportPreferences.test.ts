/**
 * Unit tests for apps/web/lib/reportPreferences.ts (issue #613).
 *
 * The weekly-digest toggle is the one notification preference the API can act
 * on, so these pin the reconciliation against
 * `GET/POST/DELETE /api/v1/reports/subscriptions`: it must be idempotent (the
 * store has no unique constraint), it must not post a malformed address, and a
 * server failure must be reported as a failure rather than a silent "saved".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isValidEmail, type NotificationPreferences } from "./settings";
import {
  createReportSubscription,
  deleteReportSubscription,
  listReportSubscriptions,
  syncWeeklyDigest,
} from "./reportPreferences";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function calls(): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(([url, init]) =>
      `${init?.method ?? "GET"} ${new URL(String(url)).pathname}${new URL(
        String(url)
      ).search}`
    );
}

function preferences(
  overrides: Partial<NotificationPreferences> = {}
): NotificationPreferences {
  return {
    email: "dev@example.com",
    channels: {
      critical_alerts: true,
      health_changes: true,
      weekly_digest: true,
    },
    ...overrides,
  };
}

const WEEKLY = {
  id: "sub_1",
  email: "dev@example.com",
  frequency: "weekly",
  day_of_week: 1,
  created_at: "2026-09-25T00:00:00.000Z",
};

describe("listReportSubscriptions", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("queries by email and keeps only well-formed rows", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(200, {
        subscriptions: [WEEKLY, { id: "bad", frequency: "hourly" }],
      })
    );

    const subs = await listReportSubscriptions("dev@example.com");

    expect(calls()[0]).toContain(
      "/api/v1/reports/subscriptions?email=dev%40example.com"
    );
    expect(subs).toEqual([
      {
        id: "sub_1",
        email: "dev@example.com",
        frequency: "weekly",
        dayOfWeek: 1,
        createdAt: "2026-09-25T00:00:00.000Z",
      },
    ]);
  });

  it("throws an ApiError when the address is missing server-side", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(422, { error: "email query parameter is required" })
    );
    await expect(listReportSubscriptions("")).rejects.toThrow(
      /email query parameter is required/
    );
  });
});

describe("createReportSubscription", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("posts the frequency and Monday day_of_week the mailer reads", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(201, WEEKLY));

    await createReportSubscription({
      email: "dev@example.com",
      frequency: "weekly",
    });

    const [, init] = vi.mocked(fetch).mock.calls[0];
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      email: "dev@example.com",
      frequency: "weekly",
      day_of_week: 1,
    });
  });
});

describe("deleteReportSubscription", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("deletes by id and accepts 204", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    await expect(deleteReportSubscription("sub 1")).resolves.toBeUndefined();
    expect(calls()[0]).toContain("/api/v1/reports/subscriptions/sub%201");
  });
});

describe("syncWeeklyDigest", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("creates a subscription when the toggle is on and none exists", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { subscriptions: [] }))
      .mockResolvedValueOnce(jsonResponse(201, WEEKLY));

    await expect(syncWeeklyDigest(preferences(), isValidEmail)).resolves.toBe(
      "synced"
    );
    expect(calls()).toEqual([
      "GET /api/v1/reports/subscriptions?email=dev%40example.com",
      "POST /api/v1/reports/subscriptions",
    ]);
  });

  it("is idempotent: an existing weekly row is not duplicated", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, { subscriptions: [WEEKLY] })
    );

    await expect(syncWeeklyDigest(preferences(), isValidEmail)).resolves.toBe(
      "synced"
    );
    expect(calls()).toHaveLength(1);
  });

  it("collapses duplicate weekly rows down to one", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(200, {
          subscriptions: [WEEKLY, { ...WEEKLY, id: "sub_2" }],
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(syncWeeklyDigest(preferences(), isValidEmail)).resolves.toBe(
      "synced"
    );
    expect(calls()[1]).toContain("/api/v1/reports/subscriptions/sub_2");
  });

  it("deletes the subscription when the toggle is off", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(200, { subscriptions: [WEEKLY, { ...WEEKLY, id: "sub_9" } ] })
      )
      .mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      syncWeeklyDigest(
        preferences({ channels: { ...preferences().channels, weekly_digest: false } }),
        isValidEmail
      )
    ).resolves.toBe("synced");
    expect(calls()).toEqual([
      "GET /api/v1/reports/subscriptions?email=dev%40example.com",
      "DELETE /api/v1/reports/subscriptions/sub_1",
      "DELETE /api/v1/reports/subscriptions/sub_9",
    ]);
  });

  it("leaves the API alone when there is no usable address", async () => {
    await expect(
      syncWeeklyDigest(preferences({ email: "  " }), isValidEmail)
    ).resolves.toBe("skipped");
    await expect(
      syncWeeklyDigest(preferences({ email: "not-an-email" }), isValidEmail)
    ).resolves.toBe("skipped");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports failure instead of pretending the preference persisted", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("offline"));
    await expect(syncWeeklyDigest(preferences(), isValidEmail)).resolves.toBe(
      "failed"
    );

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(500, { error: "db" }));
    await expect(syncWeeklyDigest(preferences(), isValidEmail)).resolves.toBe(
      "failed"
    );
  });
});
