export const ACCESS_GATE_ENABLED = false;

const ACCESS_PASSWORD = "https://blob.lat/";
const ACCESS_SESSION_KEY = "blob.private-build.access";

export function hasPrivateBuildAccess(): boolean {
  if (!ACCESS_GATE_ENABLED) {
    return true;
  }

  try {
    return window.sessionStorage.getItem(ACCESS_SESSION_KEY) === "granted";
  } catch {
    return false;
  }
}

export function unlockPrivateBuild(value: string): boolean {
  if (value !== ACCESS_PASSWORD) {
    return false;
  }

  try {
    window.sessionStorage.setItem(ACCESS_SESSION_KEY, "granted");
  } catch {
    // The current page remains usable even when browser storage is unavailable.
  }
  return true;
}
