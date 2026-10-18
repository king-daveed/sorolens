/**
 * Unit tests for apps/web/lib/clipboard.ts (issue #613).
 *
 * The settings page may only say "copied" when the value really landed on the
 * clipboard, so both the async Clipboard API path and the textarea fallback have
 * to report success or failure truthfully.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { copyToClipboard } from "./clipboard";

describe("copyToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  function cleanup() {
    document.body.replaceChildren();
  }

  it("writes through navigator.clipboard when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyToClipboard("user_e2e")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("user_e2e");
  });

  it("falls back to a textarea and execCommand when the clipboard API is absent", async () => {
    vi.stubGlobal("navigator", {});
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      value: execCommand,
      configurable: true,
      writable: true,
    });

    await expect(copyToClipboard("sl_3f9a1c22token")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    // The throwaway node is removed once the copy is done.
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("returns false when the fallback copy is refused", async () => {
    vi.stubGlobal("navigator", {});
    Object.defineProperty(document, "execCommand", {
      value: vi.fn().mockReturnValue(false),
      configurable: true,
      writable: true,
    });

    await expect(copyToClipboard("user_e2e")).resolves.toBe(false);
  });

  it("returns false for an empty value and when the clipboard write is denied", async () => {
    expect(await copyToClipboard("")).toBe(false);

    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    Object.defineProperty(document, "execCommand", {
      value: vi.fn().mockReturnValue(false),
      configurable: true,
      writable: true,
    });
    await expect(copyToClipboard("user_e2e")).resolves.toBe(false);
  });
});
