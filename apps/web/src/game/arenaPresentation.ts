export type TouchJoystickHand = "left" | "right";

export interface ArenaPoint {
  x: number;
  y: number;
}

/**
 * Convert a pointer target into an intent relative to the server-synchronized
 * player position. Rendering may interpolate behind that position, but it
 * must never make steering lag or overshoot the authoritative simulation.
 */
export function directionTowardPoint(player: ArenaPoint, target: ArenaPoint, stopDistance: number): ArenaPoint {
  const deltaX = target.x - player.x;
  const deltaY = target.y - player.y;
  const distance = Math.hypot(deltaX, deltaY);
  return Number.isFinite(distance) && distance > stopDistance
    ? { x: deltaX / distance, y: deltaY / distance }
    : { x: 0, y: 0 };
}

/**
 * Smooth 20 Hz authoritative state patches at the rendering frame rate while
 * settling most of each 50 ms movement step before the next patch arrives.
 * A slower filter looked pleasant at rest but made direct control feel late.
 */
export function renderInterpolationAlpha(deltaMs: number): number {
  const safeDelta = Math.min(Math.max(deltaMs, 0), 100);
  return 1 - Math.exp(-safeDelta * 0.032);
}

export function targetArenaZoom(mass: number, compactViewport: boolean): number {
  const zoom = 0.96 - Math.sqrt(Math.max(0, mass)) * 0.011 - (compactViewport ? 0.12 : 0);
  const minimum = compactViewport ? 0.44 : 0.52;
  const maximum = compactViewport ? 0.78 : 0.88;
  return Math.min(maximum, Math.max(minimum, zoom));
}
