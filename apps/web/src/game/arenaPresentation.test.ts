import { describe, expect, it } from "vitest";
import {
  renderInterpolationAlpha,
  targetArenaZoom,
} from "./arenaPresentation.js";

describe("arena presentation controls", () => {
  it("smooths state patches responsively and zooms a compact viewport out slightly", () => {
    expect(renderInterpolationAlpha(16)).toBeGreaterThan(0.35);
    expect(renderInterpolationAlpha(16)).toBeLessThan(1);
    expect(targetArenaZoom(100, true)).toBeLessThan(targetArenaZoom(100, false));
  });
});
