import { describe, expect, test } from "bun:test";
import { type Boxed, carriers } from "./glide";

type Named = Boxed<string>;
const box = (el: string, layout: [number, number], visual: [number, number], inside: Named[] = [], text: Named["text"] = null, paint = false, wraps = false): Named => ({
  el,
  layout: { left: layout[0], right: layout[1] },
  visual: { left: visual[0], right: visual[1] },
  text,
  wraps,
  paint,
  inside,
});
const carried = (boxes: Named[], side: "left" | "right") => carriers(boxes, side).carried;

/* the rail folds: the card's left edge goes from 318 to 76 and its right edge stays at 1498. laid out at 76, a box
   must look to be where it was at 318 until the edge has arrived */
describe("carrying a stage's contents while its edge moves", () => {
  test("leaves a box that did not move where it is", () => {
    expect(carried([box("ruler", [1450, 1490], [1450, 1490])], "left")).toEqual([]);
  });

  test("carries a box that moved as one piece by how far it moved", () => {
    // the transcript's measure is centred: it moves by half of what the card grew by
    expect(carried([box("measure", [412, 1092], [533, 1213])], "left")).toEqual([{ el: "measure", dx: 121 }]);
  });

  test("carries a box that moved as one piece without looking inside it", () => {
    const inside = box("row", [412, 1092], [533, 1213]);
    expect(carried([box("measure", [412, 1092], [533, 1213], [inside])], "left")).toEqual([{ el: "measure", dx: 121 }]);
  });

  test("looks through a box that stretched, to the boxes inside it", () => {
    // the bar runs from edge to edge: its left edge moved by 242 and its right edge did not
    const title = box("title", [98, 400], [340, 642]);
    const buttons = box("buttons", [1400, 1476], [1400, 1476]);
    expect(carried([box("bar", [76, 1498], [318, 1498], [title, buttons])], "left")).toEqual([{ el: "title", dx: 242 }]);
  });

  test("looks through as deep as the box stretches", () => {
    const measure = box("measure", [412, 1092], [533, 1213]);
    const scroller = box("scroller", [76, 1498], [318, 1498], [measure]);
    const stage = box("stage", [76, 1498], [318, 1498], [scroller]);
    expect(carried([stage], "left")).toEqual([{ el: "measure", dx: 121 }]);
  });

  test("carries a stretched box with nothing inside it with the edge that moved", () => {
    expect(carried([box("flood", [76, 1498], [318, 1498])], "left")).toEqual([{ el: "flood", dx: 242 }]);
    // the inspector folds: the card's right edge goes from 1182 to 1498, its left edge stays
    expect(carried([box("flood", [318, 1498], [318, 1182])], "right")).toEqual([{ el: "flood", dx: -316 }]);
  });

  test("stretches a stretched box that only paints back to the width it had, about its middle", () => {
    // the flood: laid out from 76 to 1498, to look as it did from 318 to 1498. a translate would keep its new width, and its
    // gradients are laid out by that width
    const [flood] = carried([box("flood", [76, 1498], [318, 1498], [], null, true)], "left");
    expect(flood?.el).toBe("flood");
    expect(flood?.dx).toBe(121);
    expect(flood?.sx).toBeCloseTo(1180 / 1422, 6);
    // the inspector folds: the card's right edge goes from 1182 to 1498, its left edge stays
    const [shrunk] = carried([box("flood", [318, 1498], [318, 1182], [], null, true)], "right");
    expect(shrunk?.dx).toBe(-158);
    expect(shrunk?.sx).toBeCloseTo(864 / 1180, 6);
  });

  test("does not stretch a box that paints but has something inside it, or no width to stretch", () => {
    const inner = box("row", [98, 400], [340, 642]);
    expect(carried([box("bed", [76, 1498], [318, 1498], [inner], null, true)], "left")).toEqual([{ el: "row", dx: 242 }]);
    expect(carried([box("line", [76, 76], [318, 330], [], null, true)], "left")).toEqual([{ el: "line", dx: 242 }]);
  });

  test("carries a stretched box with words of its own whole, by the edge its words hang from, and not the boxes inside it", () => {
    // the bar's title: a line of text, and a dot inside the line that a look through the box would carry on its own
    const dot = box("dot", [98, 106], [340, 348]);
    expect(carried([box("subtitle", [98, 640], [340, 640], [dot], "left")], "left")).toEqual([{ el: "subtitle", dx: 242 }]);
    // the inspector folds, so the card's right edge moves: words that hang from the left edge stay where they are
    expect(carried([box("subtitle", [98, 640], [98, 956], [dot], "left")], "right")).toEqual([]);
    expect(carried([box("note", [98, 640], [98, 956], [], "right")], "right")).toEqual([{ el: "note", dx: 316 }]);
    expect(carried([box("centred", [98, 640], [98, 956], [], "center")], "right")).toEqual([{ el: "centred", dx: 158 }]);
  });

  test("says when words that run over several lines were given another width, which a carry cannot follow", () => {
    // the prose at the rail's narrowest: its column was 604 wide and is laid out 680 wide, and its lines break elsewhere
    const prose = (wraps: boolean, layout: [number, number], visual: [number, number]) => carriers([box("prose", layout, visual, [], "left", false, wraps)], "left").reflows;
    expect(prose(true, [98, 778], [98, 702])).toBe(true);
    // one line has no breaks to move; the same width has none either
    expect(prose(false, [98, 778], [98, 702])).toBe(false);
    expect(prose(true, [98, 778], [340, 1020])).toBe(false);
  });

  test("carries boxes in the direction they were pulled when the card shrinks", () => {
    // the rail opens: the card is laid out at 76 for the whole move, and the measure must end where the layout at 318 puts it
    expect(carried([box("measure", [533, 1213], [412, 1092])], "left")).toEqual([{ el: "measure", dx: -121 }]);
  });

  test("ignores a box that moved by less than a rect can say", () => {
    expect(carried([box("title", [98, 400], [98.3, 400.2])], "left")).toEqual([]);
  });

  test("carries each box beside it on its own", () => {
    const boxes = [box("title", [98, 400], [340, 642]), box("measure", [412, 1092], [533, 1213]), box("dock", [412, 1092], [533, 1213])];
    expect(carried(boxes, "left").map((c) => [c.el, c.dx])).toEqual([
      ["title", 242],
      ["measure", 121],
      ["dock", 121],
    ]);
  });
});
