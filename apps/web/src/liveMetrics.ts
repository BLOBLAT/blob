import { resolveGameServerUrl } from "./game/serverUrl.js";

export interface LiveMetricsSnapshot {
  liveVisitors: number;
  arenaPlayers: number;
}

export interface LiveMetricsController {
  stop(): void;
}

const VISITOR_ID_KEY = "blob.live-visitor-id";
const REFRESH_INTERVAL_MS = 30_000;

/**
 * Publishes only a random per-tab identifier to the game server. The server
 * retains it in memory for a short live-presence window; it is not analytics
 * storage and does not produce an all-time visitor count.
 */
export function startLiveMetrics(onUpdate: (metrics: LiveMetricsSnapshot | undefined) => void): LiveMetricsController {
  const visitorId = getOrCreateVisitorId();
  let stopped = false;
  let refreshTimer: number | undefined;

  const refresh = async (): Promise<void> => {
    if (stopped || document.visibilityState === "hidden") {
      scheduleRefresh();
      return;
    }
    if (!visitorId) {
      onUpdate(undefined);
      return;
    }
    try {
      const gameServerUrl = resolveGameServerUrl();
      const response = await fetch(new URL("/presence", `${gameServerUrl}/`), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ visitorId })
      });
      const payload: unknown = await response.json();
      onUpdate(response.ok && isLiveMetricsSnapshot(payload) ? payload : undefined);
    } catch {
      onUpdate(undefined);
    }
    scheduleRefresh();
  };

  const scheduleRefresh = (): void => {
    if (stopped || refreshTimer !== undefined) {
      return;
    }
    refreshTimer = window.setTimeout(() => {
      refreshTimer = undefined;
      void refresh();
    }, REFRESH_INTERVAL_MS);
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState === "visible") {
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
        refreshTimer = undefined;
      }
      void refresh();
    }
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  void refresh();
  return {
    stop(): void {
      stopped = true;
      if (refreshTimer !== undefined) {
        window.clearTimeout(refreshTimer);
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

function getOrCreateVisitorId(): string | undefined {
  try {
    const existing = window.sessionStorage.getItem(VISITOR_ID_KEY);
    if (existing && /^[A-Za-z0-9_-]{16,128}$/.test(existing)) {
      return existing;
    }
    const visitorId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replaceAll("-", "")
      : undefined;
    if (!visitorId) {
      return undefined;
    }
    window.sessionStorage.setItem(VISITOR_ID_KEY, visitorId);
    return visitorId;
  } catch {
    return undefined;
  }
}

function isLiveMetricsSnapshot(value: unknown): value is LiveMetricsSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const metrics = value as { liveVisitors?: unknown; arenaPlayers?: unknown };
  return Number.isSafeInteger(metrics.liveVisitors)
    && Number.isSafeInteger(metrics.arenaPlayers)
    && (metrics.liveVisitors as number) >= 0
    && (metrics.arenaPlayers as number) >= 0;
}
