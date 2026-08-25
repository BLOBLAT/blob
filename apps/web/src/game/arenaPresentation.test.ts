import { describe, expect, it } from "vitest";
import {
  TOUCH_JOYSTICK_RADIUS,
  canStartTouchJoystick,
  renderInterpolationAlpha,
  targetArenaZoom,
  touchJoystickAnchor,
} from "./arenaPresentation.js";

describe("arena presentation controls", () => {
  it("anchors the virtual joystick at a thumb-reachable lower corner", () => {
    const left = touchJoystickAnchor(390, 520, "left");
    const right = touchJoystickAnchor(390, 520, "right");

    expect(left.x).toBeLessThan(120);
    expect(right.x).toBeGreaterThan(270);
    expect(left.y).toBeGreaterThan(400);
    expect(canStartTouchJoystick(left, left)).toBe(true);
    expect(canStartTouchJoystick({ x: left.x + TOUCH_JOYSTICK_RADIUS * 1.5, y: left.y }, left)).toBe(false);
  });

  it("smooths state patches and zooms a compact viewport out slightly", () => {
    expect(renderInterpolationAlpha(16)).toBeGreaterThan(0);
    expect(renderInterpolationAlpha(16)).toBeLessThan(1);
    expect(targetArenaZoom(100, true)).toBeLessThan(targetArenaZoom(100, false));
  });
});
