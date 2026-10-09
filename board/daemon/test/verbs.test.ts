import { describe, expect, test } from "bun:test";
import { VerbEngine, type VerbEvent } from "../src/verbs";

const T = { holdMs: 350, doubleMs: 300 };

function collect(events: VerbEvent[], kinds: VerbEvent["kind"][]) {
  expect(events.map((e) => e.kind)).toEqual(kinds);
}

describe("the four-verb grammar", () => {
  test("tap: down, up, settles after the double window", () => {
    const v = new VerbEngine(T);
    collect(v.feed(5, true, 0), []);
    collect(v.feed(5, false, 100), []);
    collect(v.tick(300), []); /* window still open (100+300=400) */
    const settled = v.tick(401);
    collect(settled, ["tap"]);
    expect((settled[0] as { wire: number }).wire).toBe(5);
  });

  test("double: second down inside the window upgrades", () => {
    const v = new VerbEngine(T);
    v.feed(5, true, 0);
    v.feed(5, false, 100);
    collect(v.feed(5, true, 250), []);
    collect(v.feed(5, false, 320), ["double"]);
    collect(v.tick(1000), []); /* nothing left pending */
  });

  test("two slow taps are two taps, never a double", () => {
    const v = new VerbEngine(T);
    v.feed(5, true, 0);
    v.feed(5, false, 100);
    const first = v.feed(5, true, 500); /* window closed at 400 */
    collect(first, ["tap"]);
    v.feed(5, false, 560);
    collect(v.tick(900), ["tap"]);
  });

  test("hold: start fires AT threshold via tick, end on release", () => {
    const v = new VerbEngine(T);
    v.feed(7, true, 0);
    collect(v.tick(349), []);
    const start = v.tick(350);
    collect(start, ["holdStart"]);
    expect((start[0] as { at: number }).at).toBe(350);
    const end = v.feed(7, false, 900);
    collect(end, ["holdEnd"]);
    expect((end[0] as { heldMs: number }).heldMs).toBe(900);
    expect(v.isHeld(7)).toBe(false);
  });

  test("hold released before any tick still resolves as a hold", () => {
    const v = new VerbEngine(T);
    v.feed(7, true, 0);
    collect(v.feed(7, false, 500), ["holdStart", "holdEnd"]);
  });

  test("chord: a second key while one is down fuses the pair", () => {
    const v = new VerbEngine(T);
    v.feed(15, true, 0); /* radio down */
    const chord = v.feed(4, true, 120);
    collect(chord, ["chord"]);
    expect((chord[0] as { wires: [number, number] }).wires).toEqual([15, 4]);
    /* neither key taps or holds on release; the chord ends once */
    collect(v.feed(15, false, 700), ["chordEnd"]);
    collect(v.feed(4, false, 800), []);
    collect(v.tick(2000), []);
  });

  test("chord swallows the first key's pending hold", () => {
    const v = new VerbEngine(T);
    v.feed(15, true, 0);
    v.tick(350); /* radio holdStart fired */
    const events = v.feed(9, true, 400);
    collect(events, ["chord"]);
    collect(v.feed(9, false, 500), ["chordEnd"]);
    /* the radio's up must not fire a stray holdEnd */
    collect(v.feed(15, false, 600), []);
  });

  test("tapImmediate keys skip the double window", () => {
    const v = new VerbEngine(T, [11]);
    v.feed(11, true, 0);
    collect(v.feed(11, false, 80), ["tap"]);
  });

  test("isHeld answers while held, for the meter and the gauge", () => {
    const v = new VerbEngine(T);
    v.feed(15, true, 0);
    v.tick(360);
    expect(v.isHeld(15)).toBe(true);
    v.feed(15, false, 400);
    expect(v.isHeld(15)).toBe(false);
  });

  /* the 2026-07-27 wedge: nl went down on drive, the layer flipped to
     calc (which reports nothing), and the exit-hold's orphaned key-up
     arrived minutes later — closing the stale hold with a monstrous
     heldMs and re-toggling calc. a mode echo must wipe in-flight state. */
  test("reset drops open holds so a later orphan up settles nothing", () => {
    const v = new VerbEngine(T);
    v.feed(0, true, 0);
    collect(v.tick(350), ["holdStart"]); /* the hold is open */
    v.reset(); /* mode echo: the layer flipped under us */
    collect(v.feed(0, false, 200_000), []); /* orphan up: no holdEnd */
    collect(v.tick(201_000), []);
    expect(v.isHeld(0)).toBe(false);
  });

  test("reset clears an active chord", () => {
    const v = new VerbEngine(T);
    v.feed(15, true, 0);
    collect(v.feed(4, true, 100), ["chord"]);
    v.reset();
    collect(v.feed(15, false, 300), []); /* no chordEnd after reset */
    expect(v.activeChord()).toBeNull();
  });
});
