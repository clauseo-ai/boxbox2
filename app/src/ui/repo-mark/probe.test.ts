import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setRepoIcon, state } from "../../store";
import { iconKey, retryDelay, askAgainIn } from "./icons";
import { SAMPLE } from "./plate";
import { ensureRepoIcon, type IconOutcome, type ReadWith } from "./probe";

/* the asking, against a fetch that answers as the server does (status and x-repo-icon) or fails as a network does. only
   the paths that need no image are driven here (an image is drawn through a canvas, which is seen in a browser); what
   matters here is that a transient is never remembered as "no icon" and that a retry recovers on its own clock */

const realFetch = globalThis.fetch;
const realNow = Date.now;
let clock = 1_000_000;
let answers: Array<() => Response | Promise<Response>> = [];
let asked: string[] = [];
let n = 0;
let ROOT = "/work/api";
let KEY = iconKey("h", ROOT);

beforeEach(() => {
  clock = 1_000_000;
  Date.now = () => clock;
  answers = [];
  asked = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    asked.push(String(input));
    const next = answers.shift();
    if (!next) throw new Error("fetch was not expected");
    return Promise.resolve().then(next);
  }) as typeof fetch;
  // each test is its own repo: the store is the one place this state lives, and it has no way to forget one
  ROOT = `/work/api-${++n}`;
  KEY = iconKey("h", ROOT);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

const reply = (status: number, why?: string) => () => new Response(null, { status, ...(why ? { headers: { "x-repo-icon": why } } : {}) });
const down = () => {
  throw new TypeError("network error");
};

/** no canvas here: an image is drawn in a browser, and these tests stay on the paths that need none */
const NO_PIXELS: ReadWith["sample"] = () => Promise.resolve(null);

async function ask(): Promise<IconOutcome[]> {
  const seen: IconOutcome[] = [];
  await ensureRepoIcon("h", ROOT, { sample: NO_PIXELS, onRead: (outcome) => seen.push(outcome) });
  return seen;
}

describe("asking for a repo's icon", () => {
  test("each class the server names is kept as that class, with the clock of its own max-age", async () => {
    for (const [why, held] of [["none", 30 * 60_000], ["refused", 60 * 60_000], ["unsupported", 5 * 60_000], ["unproven", 60_000]] as const) {
      setRepoIcon(KEY, { state: "ready", plate: "dark", at: 0 });
      clock += 7 * 3_600_000;
      answers.push(reply(404, why));
      expect(await ask()).toEqual([why]);
      expect(state.repoIcons[KEY]).toEqual({ state: "absent", why, at: clock });
      expect(askAgainIn(state.repoIcons[KEY]!, clock)).toBe(held);
    }
  });

  test("an unknown class is none-length", async () => {
    answers.push(reply(404, "somewhere-new"));
    await ask();
    expect(state.repoIcons[KEY]).toMatchObject({ state: "absent", why: "none" });
  });

  test("a network error, a 503 and the server's own retry are retries, never none", async () => {
    answers.push(down, reply(503), reply(404, "retry"));
    const first = await ask();
    expect(first).toEqual(["retry"]);
    expect(state.repoIcons[KEY]).toEqual({ state: "retry", attempts: 1, at: clock });
    clock += retryDelay(1);
    await ask();
    expect(state.repoIcons[KEY]).toEqual({ state: "retry", attempts: 2, at: clock });
    clock += retryDelay(2);
    await ask();
    expect(state.repoIcons[KEY]).toEqual({ state: "retry", attempts: 3, at: clock });
  });

  test("a retry is not asked again before its time, and is after it", async () => {
    answers.push(down);
    await ask();
    clock += retryDelay(1) - 1;
    expect(await ask()).toEqual([]);
    expect(asked).toHaveLength(1);
    answers.push(reply(404, "none"));
    clock += 1;
    expect(await ask()).toEqual(["none"]);
  });

  test("a mark that is up recovers when its timer fires: the wait it is told is the retry delay, and what comes next replaces the retry", async () => {
    answers.push(down);
    await ask();
    const wait = askAgainIn(state.repoIcons[KEY]!, clock);
    expect(wait).toBe(retryDelay(1));
    // the mark's timer fires after exactly that wait, and asks the way it did the first time
    clock += wait as number;
    answers.push(reply(404, "unsupported"));
    await ensureRepoIcon("h", ROOT, { sample: NO_PIXELS });
    expect(state.repoIcons[KEY]).toMatchObject({ state: "absent", why: "unsupported" });
    expect(asked).toHaveLength(2);
  });

  test("two marks of one repo asking at once make one request", async () => {
    answers.push(reply(404, "none"));
    await Promise.all([ensureRepoIcon("h", ROOT, { sample: NO_PIXELS }), ensureRepoIcon("h", ROOT, { sample: NO_PIXELS })]);
    expect(asked).toHaveLength(1);
  });

  test("an empty root or host is not asked about", async () => {
    await ensureRepoIcon("h", "", { sample: NO_PIXELS });
    await ensureRepoIcon("", ROOT, { sample: NO_PIXELS });
    expect(asked).toEqual([]);
    expect(Object.keys(state.repoIcons).filter((key) => key.endsWith("\u0000"))).toEqual([]);
  });

  test("the url asked is the server's route, for the host and the root", async () => {
    answers.push(reply(404, "none"));
    await ask();
    expect(asked).toEqual([`/api/hosts/h/repo-icon?root=${encodeURIComponent(ROOT)}`]);
  });

  test("a read that never answers is given up on as a retry, not as none", async () => {
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as typeof fetch;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void) => realSetTimeout(fn, 0)) as unknown as typeof setTimeout;
    try {
      expect(await ask()).toEqual(["retry"]);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(state.repoIcons[KEY]).toMatchObject({ state: "retry", attempts: 1 });
  });

  test("a replaced image that cannot be re-read keeps the plate on screen", async () => {
    setRepoIcon(KEY, { state: "ready", plate: "light", at: clock - 7 * 3_600_000 });
    answers.push(down);
    await ask();
    expect(state.repoIcons[KEY]).toEqual({ state: "ready", plate: "light", at: clock });
  });

  test("a 200 is read through the sampler and becomes a plate; bytes that cannot be drawn are none, not a retry", async () => {
    const glyph = new Uint8ClampedArray(SAMPLE * SAMPLE * 4);
    for (let y = 12; y < 36; y++) for (let x = 12; x < 36; x++) glyph.set([10, 10, 12, 255], (y * SAMPLE + x) * 4);
    answers.push(() => new Response("png bytes", { status: 200, headers: { "content-type": "image/png" } }));
    const seen: IconOutcome[] = [];
    await ensureRepoIcon("h", ROOT, { sample: () => Promise.resolve({ pixels: glyph, aspect: 1 }), onRead: (outcome) => seen.push(outcome) });
    expect(seen).toEqual(["image"]);
    expect(state.repoIcons[KEY]).toEqual({ state: "ready", plate: "light", at: clock });

    ROOT = `${ROOT}-broken`;
    KEY = iconKey("h", ROOT);
    answers.push(() => new Response("not an image", { status: 200 }));
    expect(await ask()).toEqual(["unreadable"]);
    expect(state.repoIcons[KEY]).toMatchObject({ state: "absent", why: "none" });
  });
});
