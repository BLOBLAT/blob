export type TouchJoystickHand = "left" | "right";

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
