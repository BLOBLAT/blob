const FREE_NAME_KEY = "blob.free-player-name";
const PROFILE_NAME_KEY = "blob.profile-display-name";

export function getGamePlayerName(): string {
  const profileName = window.localStorage.getItem(PROFILE_NAME_KEY);
  if (profileName && isGameDisplayName(profileName)) {
    return profileName;
  }
  const existing = window.localStorage.getItem(FREE_NAME_KEY);
  if (existing && isGameDisplayName(existing)) {
    return existing;
  }
  const suffix = String(Date.now()).slice(-5);
  const name = "BLOB-" + suffix;
  window.localStorage.setItem(FREE_NAME_KEY, name);
  return name;
}

export function setProfileGameName(displayName: string | undefined): void {
  if (displayName && isGameDisplayName(displayName)) {
    window.localStorage.setItem(PROFILE_NAME_KEY, displayName);
    return;
  }
  window.localStorage.removeItem(PROFILE_NAME_KEY);
}

function isGameDisplayName(value: string): boolean {
  return /^[A-Za-z0-9 _-]{3,16}$/.test(value);
}
