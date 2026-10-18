/**
 * Clipboard helper for the values `/settings` asks users to carry elsewhere:
 * the workspace user ID and a freshly issued API token (issue #613).
 *
 * `navigator.clipboard` is undefined on non-secure origins and in some private
 * modes, so the fallback goes through a throwaway textarea and `execCommand`.
 * The call reports success instead of throwing, because the UI must say "copied"
 * only when the copy actually happened — and show the raw value when it did not.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied: fall through to the textarea route.
    }
  }

  if (typeof document === "undefined") return false;

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
