import { describe, expect, test } from "bun:test";
import { endRoom, gapOf } from "./pin";
import { viewOf } from "./view";

/* a scroller 900 px tall with 3000 px of content (its end padding and the dock's room among them), under a dock 150 px tall */
const box = () => ({ scrollTop: 0, scrollHeight: 3000, clientHeight: 900 }) as unknown as HTMLElement;

describe("the view above the dock", () => {
  test("is the scroller less the dock, and goes as far as the scroller does", () => {
    const el = box();
    const view = viewOf(() => el, () => 150);
    expect(view.clientHeight).toBe(750);
    expect(view.scrollHeight).toBe(2850);
    expect(view.scrollHeight - view.clientHeight).toBe(el.scrollHeight - el.clientHeight);
  });
  test("is at the end where the scroller is, so the pin follows the same end", () => {
    const el = box();
    const view = viewOf(() => el, () => 150);
    view.scrollTop = 2100;
    expect(el.scrollTop).toBe(2100);
    expect(gapOf(view)).toBe(0);
  });
  test("asks whether the end is in view of the part above the glass", () => {
    const el = box();
    const view = viewOf(() => el, () => 150);
    el.scrollTop = 2000;
    // the content ends at 2800 (the foot's 40 and the dock's 150 under it, 10 px of room): in the scroller's box, under the glass in the view
    expect(el.scrollTop + el.clientHeight >= 2800).toBe(true);
    expect(view.scrollTop + view.clientHeight >= 2800).toBe(false);
    // the room a settle keeps is what the view's foot is past the end, the foot's padding counted and the dock's room not
    expect(endRoom(2100, view.clientHeight, 2800, 40)).toBe(10);
  });
  test("never goes below nothing while the dock is measured taller than a collapsed scroller", () => {
    const el = { scrollTop: 0, scrollHeight: 100, clientHeight: 100 } as unknown as HTMLElement;
    const view = viewOf(() => el, () => 150);
    expect(view.clientHeight).toBe(0);
    expect(view.scrollHeight).toBe(0);
  });
});
