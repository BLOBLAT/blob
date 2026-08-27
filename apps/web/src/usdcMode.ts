export const USDC_MODE_PREVIEW_ENABLED = true;

const USDC_MODE_ACCESS_CODE = "0188666";
const USDC_MODE_SESSION_KEY = "blob.usdc-mode-preview.access";

export function hasUsdcModePreviewAccess(): boolean {
  if (!USDC_MODE_PREVIEW_ENABLED) {
    return true;
  }

  try {
    return window.sessionStorage.getItem(USDC_MODE_SESSION_KEY) === "granted";
  } catch {
    return false;
  }
}

export function unlockUsdcModePreview(value: string): boolean {
  if (!USDC_MODE_PREVIEW_ENABLED) {
    return true;
  }
  if (value !== USDC_MODE_ACCESS_CODE) {
    return false;
  }

  try {
    window.sessionStorage.setItem(USDC_MODE_SESSION_KEY, "granted");
  } catch {
    // The current tab can still enter its preview if browser storage is blocked.
  }
  return true;
}
