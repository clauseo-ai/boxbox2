import { afterEach, describe, expect, jest, test } from "bun:test";
import { COPIED_MS, REFUSED_MS, REFUSED_WORDS, copyFrom, forget, show } from "./copy";
import { settle } from "./copy-run";

/* a control, and the page around it, as far as a press touches them */
function fake(refused?: string) {
  const word = { textContent: "copy" };
  const status = { className: "", textContent: "", setAttribute: () => {} };
  const body = { querySelector: () => null, append: () => {} };
  const button = {
    dataset: (refused ? { refused } : {}) as Record<string, string | undefined>,
    querySelector: (selector: string) => (selector === ".copy-w" ? word : null),
    getAttribute: () => "copy the typescript code",
    closest: () => null,
    ownerDocument: { body, createElement: () => status },
  };
  return { button: button as unknown as HTMLElement, word, status, state: () => button.dataset["state"] };
}

const globals = globalThis as unknown as { navigator: { clipboard?: unknown }; requestAnimationFrame: (f: () => void) => number };
const had = { clipboard: globals.navigator.clipboard, raf: globals.requestAnimationFrame };
afterEach(() => {
  globals.navigator.clipboard = had.clipboard;
  globals.requestAnimationFrame = had.raf;
});

describe("a press copies in the tap's own call", () => {
  test("the clipboard is written before anything has been awaited (ios allows the copy only inside the tap's handler)", async () => {
    const written: string[] = [];
    globals.navigator.clipboard = { writeText: async (t: string) => { written.push(t); } };
    globals.requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;
    const { button } = fake();
    copyFrom(button, "export const a = 1;");
    expect(written).toEqual(["export const a = 1;"]);
    await Bun.sleep(5);
    forget(button);
  });

  test("the outcome is on the control as soon as the copy has landed, without waiting for the chunk that holds it", async () => {
    globals.navigator.clipboard = { writeText: async () => {} };
    globals.requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;
    const { button, word, state } = fake();
    copyFrom(button, "x");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(state()).toBe("copied");
    expect(word.textContent).toBe("copied");
    await Bun.sleep(20);
    forget(button);
  });

  test("a refusal says so in place, never silently, in the control's own words where it has them", async () => {
    globals.navigator.clipboard = { writeText: async () => { throw new Error("no"); } };
    globals.requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;
    const plain = fake();
    const report = fake("could not copy. read the whole report, then select it");
    copyFrom(plain.button, "x");
    copyFrom(report.button, "x");
    await Bun.sleep(20);
    expect(plain.state()).toBe("refused");
    expect(plain.word.textContent).toBe(REFUSED_WORDS);
    expect(report.state()).toBe("refused");
    expect(report.word.textContent).toBe("could not copy. read the whole report, then select it");
    forget(plain.button);
    forget(report.button);
  });
});

describe("drawing a control", () => {
  test("copy, copied and a refusal are its word and its data-state, and back", () => {
    const { button, word, state } = fake();
    show(button, "copied");
    expect([state(), word.textContent]).toEqual(["copied", "copied"]);
    show(button, "refused");
    expect([state(), word.textContent]).toEqual(["refused", REFUSED_WORDS]);
    show(button, null);
    expect([state(), word.textContent]).toEqual([undefined, "copy"]);
  });
  test("how long each holds: the reply's 1.6 s, and a refusal, which is words to read, longer", () => {
    expect(COPIED_MS).toBe(1600);
    expect(REFUSED_MS).toBeGreaterThan(COPIED_MS);
  });
});

describe("settling a press", () => {
  test("the status is emptied at the end only if it still holds this press's words", () => {
    jest.useFakeTimers();
    try {
      globals.requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;
      const first = fake();
      settle(first.button, true);
      jest.advanceTimersByTime(10);
      expect(first.status.textContent).toBe("copied the typescript code");
      jest.advanceTimersByTime(COPIED_MS);
      expect(first.status.textContent).toBe("");
      expect(first.state()).toBeUndefined();
      // a later press has said something else by the time the first one's hold ends
      const second = fake();
      settle(second.button, true);
      jest.advanceTimersByTime(10);
      second.status.textContent = "copied the reply";
      jest.advanceTimersByTime(COPIED_MS);
      expect(second.status.textContent).toBe("copied the reply");
    } finally {
      jest.useRealTimers();
    }
  });
  test("a press that stopped at the cap says so, not the control's name", async () => {
    globals.requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;
    const { button, status } = fake();
    settle(button, true, "copied the first 256,000 characters of the output");
    await Bun.sleep(5);
    expect(status.textContent).toBe("copied the first 256,000 characters of the output");
    forget(button);
  });
  test("a control that left the page lets go of its timer, so nothing is drawn on it after", () => {
    jest.useFakeTimers();
    try {
      const { button, state } = fake();
      globals.requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;
      show(button, "copied");
      settle(button, true);
      forget(button);
      jest.advanceTimersByTime(REFUSED_MS * 2);
      expect(state()).toBe("copied");
    } finally {
      jest.useRealTimers();
    }
  });
});
