export type TouchJoystickHand = "left" | "right";

export interface ScreenPoint {
  x: number;
  y: number;
}

export const TOUCH_JOYSTICK_RADIUS = 66;

/**
 * Keep the joystick above the browser's gesture area while leaving the lower
 * corner reachable with the thumb. Coordinates are in the Phaser viewport.
 */
export function touchJoystickAnchor(width: number, height: number, hand: TouchJoystickHand): ScreenPoint {
  const horizontalInset = Math.min(92, Math.max(76, width * 0.16));
  const verticalInset = Math.min(96, Math.max(78, height * 0.2));
  return {
    x: hand === "left" ? horizontalInset : Math.max(horizontalInset, width - horizontalInset),
    y: Math.max(TOUCH_JOYSTICK_RADIUS + 8, height - verticalInset),
  };
}

export function canStartTouchJoystick(pointer: ScreenPoint, anchor: ScreenPoint): boolean {
  return Math.hypot(pointer.x - anchor.x, pointer.y - anchor.y) <= TOUCH_JOYSTICK_RADIUS * 1.45;
}

/** Smooth 20 Hz authoritative state patches at the rendering frame rate. */
export function renderInterpolationAlpha(deltaMs: number): number {
  const safeDelta = Math.min(Math.max(deltaMs, 0), 100);
  return 1 - Math.exp(-safeDelta * 0.024);
}

export function targetArenaZoom(mass: number, compactViewport: boolean): number {
  const zoom = 0.96 - Math.sqrt(Math.max(0, mass)) * 0.011 - (compactViewport ? 0.12 : 0);
  const minimum = compactViewport ? 0.44 : 0.52;
  const maximum = compactViewport ? 0.78 : 0.88;
  return Math.min(maximum, Math.max(minimum, zoom));
}
