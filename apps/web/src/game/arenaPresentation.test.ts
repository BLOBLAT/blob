import { describe, expect, it } from "vitest";
import {
  directionTowardPoint,
  renderInterpolationAlpha,
  targetArenaZoom,
} from "./arenaPresentation.js";

describe("arena presentation controls", () => {
  it("smooths state patches responsively and zooms a compact viewport out slightly", () => {
    expect(renderInterpolationAlpha(16)).toBeGreaterThan(0.35);
    expect(renderInterpolationAlpha(16)).toBeLessThan(1);
    expect(targetArenaZoom(100, true)).toBeLessThan(targetArenaZoom(100, false));
  });

  it("derives direct pointer steering from the authoritative player position", () => {
    expect(directionTowardPoint({ x: 100, y: 100 }, { x: 220, y: 100 }, 8)).toEqual({ x: 1, y: 0 });
    expect(directionTowardPoint({ x: 100, y: 100 }, { x: 104, y: 105 }, 8)).toEqual({ x: 0, y: 0 });
  });
});
