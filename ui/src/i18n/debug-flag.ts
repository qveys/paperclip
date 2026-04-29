/**
 * Shared helpers for the i18n debug flag. Extracted so `useT` and
 * `useI18nDebug` can't drift out of sync on the storage key, the event
 * name, or the SSR/exception guards.
 */

const ENABLED_VALUE = "1";

export const I18N_DEBUG_STORAGE_KEY = "paperclip.i18n.debug";
export const I18N_DEBUG_EVENT = "paperclip:i18n-debug-changed";

export function readDebugFlag(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(I18N_DEBUG_STORAGE_KEY) === ENABLED_VALUE;
  } catch {
    return false;
  }
}

export function writeDebugFlag(value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      window.localStorage.setItem(I18N_DEBUG_STORAGE_KEY, ENABLED_VALUE);
    } else {
      window.localStorage.removeItem(I18N_DEBUG_STORAGE_KEY);
    }
  } catch {
    /* localStorage may be denied (private mode, quota); the dispatch below
     * is still useful for in-tab subscribers. */
  }
  window.dispatchEvent(new Event(I18N_DEBUG_EVENT));
}
