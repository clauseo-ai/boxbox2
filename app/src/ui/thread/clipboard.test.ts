import { describe, expect, test } from "bun:test";
import { type Env, type Field, type Page, copyText } from "./clipboard";

/** a page that records what the fallback did to it, in order */
function fakePage(opts: { refuses?: boolean; throws?: boolean } = {}): { page: Page; log: string[]; copied: string[] } {
  const log: string[] = [];
  const copied: string[] = [];
  let held = "";
  const field: Field = {
    get value() { return held; },
    set value(v: string) { held = v; },
    readOnly: false,
    style: { cssText: "" },
    setAttribute: () => {},
    focus: (o) => log.push(`field focus${o?.preventScroll ? " without scrolling" : ""}`),
    select: () => log.push("select"),
    setSelectionRange: (a, b) => log.push(`range ${a}-${b}`),
  };
  const page: Page = {
    field: () => field,
    attach: () => log.push("attach"),
    detach: () => log.push("detach"),
    command: () => { if (opts.throws) throw new Error("denied"); log.push("copy"); if (opts.refuses) return false; copied.push(held); return true; },
    focused: () => ({ focus: (o) => log.push(`restore focus${o?.preventScroll ? " without scrolling" : ""}`) }),
    selection: () => () => log.push("restore selection"),
  };
  return { page, log, copied };
}

describe("copying text", () => {
  test("the async api is used when it is there", async () => {
    const written: string[] = [];
    const { page, log } = fakePage();
    const env: Env = { clipboard: { writeText: async (t) => { written.push(t); } }, page };
    expect(await copyText("hello\n", env)).toBe(true);
    expect(written).toEqual(["hello\n"]);
    expect(log).toEqual([]);
  });

  test("a missing async api (a plain http origin) falls back to the textarea", async () => {
    const { page, copied } = fakePage();
    expect(await copyText("from a tailnet", { page })).toBe(true);
    expect(copied).toEqual(["from a tailnet"]);
  });

  test("an async api that refuses falls back to the textarea", async () => {
    const { page, copied } = fakePage();
    const env: Env = { clipboard: { writeText: async () => { throw new Error("not allowed"); } }, page };
    expect(await copyText("x", env)).toBe(true);
    expect(copied).toEqual(["x"]);
  });

  test("the text goes in exactly as it was given: no newline added, none taken", async () => {
    const { page, copied } = fakePage();
    await copyText("a\n  b", { page });
    await copyText("last line", { page });
    expect(copied).toEqual(["a\n  b", "last line"]);
  });

  test("the fallback selects by range for ios, and puts focus and the selection back after, without scrolling", async () => {
    const { page, log } = fakePage();
    await copyText("abcd", { page });
    expect(log).toEqual(["attach", "field focus without scrolling", "select", "range 0-4", "copy", "detach", "restore selection", "restore focus without scrolling"]);
  });

  test("both failing says so, and still leaves the page as it was", async () => {
    const { page, log } = fakePage({ refuses: true });
    const env: Env = { clipboard: { writeText: async () => { throw new Error("no"); } }, page };
    expect(await copyText("x", env)).toBe(false);
    expect(log.slice(-3)).toEqual(["detach", "restore selection", "restore focus without scrolling"]);
  });

  test("a command that throws is a failure, not an exception, and cleans up", async () => {
    const { page, log } = fakePage({ throws: true });
    expect(await copyText("x", { page })).toBe(false);
    expect(log.slice(-3)).toEqual(["detach", "restore selection", "restore focus without scrolling"]);
  });

  test("with no api and no page there is nothing to try", async () => {
    expect(await copyText("x", {})).toBe(false);
  });
});
