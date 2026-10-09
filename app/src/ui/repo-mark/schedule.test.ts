import { describe, expect, test } from "bun:test";
import { askWhenDue, type Visibility } from "./schedule";

/** a page whose visibility the test turns, with the listeners it was given counted */
function page(hidden: boolean) {
  const listeners = new Set<() => void>();
  const stand: { hidden: boolean } & Visibility & { listeners: Set<() => void>; show(): void } = {
    hidden,
    listeners,
    addEventListener: (_type, fn) => void listeners.add(fn),
    removeEventListener: (_type, fn) => void listeners.delete(fn),
    show() {
      stand.hidden = false;
      for (const fn of [...listeners]) fn();
    },
  };
  return stand;
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a mounted mark asking again", () => {
  test("asks when its wait is over, on a page that is showing", async () => {
    let asked = 0;
    const cancel = askWhenDue(5, () => asked++, page(false));
    await tick(30);
    expect(asked).toBe(1);
    cancel();
  });

  test("does not ask while the page is hidden, and asks once when it is shown", async () => {
    let asked = 0;
    const stand = page(true);
    const cancel = askWhenDue(5, () => asked++, stand);
    await tick(30);
    expect(asked).toBe(0);
    stand.show();
    expect(asked).toBe(1);
    stand.show();
    expect(asked).toBe(1);
    cancel();
  });

  test("a page shown before the wait is over does not ask early", async () => {
    let asked = 0;
    const stand = page(true);
    const cancel = askWhenDue(40, () => asked++, stand);
    stand.show();
    expect(asked).toBe(0);
    cancel();
  });

  test("cancelling clears the timer and the listener: nothing asks after the mark is gone", async () => {
    let asked = 0;
    const stand = page(false);
    const cancel = askWhenDue(5, () => asked++, stand);
    expect(stand.listeners.size).toBe(1);
    cancel();
    expect(stand.listeners.size).toBe(0);
    await tick(30);
    expect(asked).toBe(0);

    const hiddenStand = page(true);
    const cancelHidden = askWhenDue(5, () => asked++, hiddenStand);
    await tick(30);
    cancelHidden();
    hiddenStand.show();
    expect(asked).toBe(0);
  });
});
