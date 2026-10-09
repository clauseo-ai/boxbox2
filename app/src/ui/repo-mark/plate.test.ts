import { describe, expect, test } from "bun:test";
import { PLATE_DARK, PLATE_LIGHT, plateOf, SAMPLE } from "./plate";

type Pixel = [number, number, number, number];

/** an image as the canvas hands it over: SAMPLE by SAMPLE rgba, each pixel from `paint(x, y)` */
function image(paint: (x: number, y: number) => Pixel): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(SAMPLE * SAMPLE * 4);
  for (let y = 0; y < SAMPLE; y++) {
    for (let x = 0; x < SAMPLE; x++) pixels.set(paint(x, y), (y * SAMPLE + x) * 4);
  }
  return pixels;
}

const CLEAR: Pixel = [0, 0, 0, 0];
/** a glyph in the middle two thirds of an otherwise empty image */
const glyph = (ink: Pixel) => image((x, y) => (x > 12 && x < 36 && y > 12 && y < 36 ? ink : CLEAR));

describe("the plate a favicon sits on", () => {
  test("a dark icon on a transparent ground gets the light plate", () => {
    expect(plateOf(glyph([10, 10, 12, 255]), SAMPLE, 1)).toBe("light");
    expect(plateOf(glyph([29, 78, 216, 255]), SAMPLE, 1)).toBe("light"); // a deep blue
  });

  test("a light icon gets the dark glass, which is the bug v1 never fixed the other way round", () => {
    expect(plateOf(glyph([255, 255, 255, 255]), SAMPLE, 1)).toBe("dark");
    expect(plateOf(glyph([250, 204, 21, 255]), SAMPLE, 1)).toBe("dark"); // a bright yellow
  });

  test("a mid tone goes to the plate it contrasts with more", () => {
    expect(plateOf(glyph([255, 120, 20, 255]), SAMPLE, 1)).toBe("dark"); // orange
    expect(plateOf(glyph([30, 120, 90, 255]), SAMPLE, 1)).toBe("light"); // a deep green
  });

  test("an icon of a dark outline and a white fill is judged by what each plate would lose", () => {
    const ring = image((x, y) => {
      const d = Math.hypot(x - 24, y - 24);
      if (d < 16) return [255, 255, 255, 255];
      if (d < 20) return [0, 0, 0, 255];
      return CLEAR;
    });
    // the white fill is most of the ink: it is lost on the light plate, the thin outline on the dark one
    expect(plateOf(ring, SAMPLE, 1)).toBe("dark");
  });

  test("faint anti-aliased edges weigh by their alpha, not as full ink", () => {
    const soft = image((x, y) => (x > 12 && x < 36 && y > 12 && y < 36 ? [10, 10, 12, 255] : x % 2 === 0 ? [255, 255, 255, 6] : CLEAR));
    expect(plateOf(soft, SAMPLE, 1)).toBe("light");
  });

  test("an opaque square image is an app icon: it fills the tile, whatever its colours", () => {
    expect(plateOf(image(() => [20, 30, 120, 255]), SAMPLE, 1)).toBe("bleed");
    expect(plateOf(image((x) => (x < 24 ? [255, 255, 255, 255] : [0, 0, 0, 255])), SAMPLE, 1.04)).toBe("bleed");
  });

  test("opaque but not square keeps a plate: filling the tile would crop it", () => {
    expect(plateOf(image(() => [20, 30, 120, 255]), SAMPLE, 2)).toBe("light");
    expect(plateOf(image(() => [255, 255, 255, 255]), SAMPLE, 0.5)).toBe("dark");
  });

  test("an opaque image with empty corners (a round or already rounded icon) keeps a plate", () => {
    const disc = image((x, y) => (Math.hypot(x - 23.5, y - 23.5) < 24 ? [20, 30, 120, 255] : CLEAR));
    expect(plateOf(disc, SAMPLE, 1)).toBe("light");
  });

  test("an image with a single transparent corner is not an app icon", () => {
    const notched = image((x, y) => (x < 3 && y < 3 ? CLEAR : [20, 30, 120, 255]));
    expect(plateOf(notched, SAMPLE, 1)).not.toBe("bleed");
  });

  test("an empty image is no icon", () => {
    expect(plateOf(image(() => CLEAR), SAMPLE, 1)).toBeNull();
    expect(plateOf(glyph([0, 0, 0, 2]), SAMPLE, 1)).toBeNull();
  });

  test("a sample too short for its size is no icon", () => {
    expect(plateOf(new Uint8ClampedArray(16), SAMPLE, 1)).toBeNull();
  });
});

describe("the plates themselves", () => {
  test("they are opaque hex, so they read on the page's ground in both appearances", () => {
    expect(PLATE_LIGHT).toMatch(/^#[0-9a-f]{6}$/);
    expect(PLATE_DARK).toMatch(/^#[0-9a-f]{6}$/);
  });
});
