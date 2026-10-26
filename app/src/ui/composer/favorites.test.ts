import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_HOME, type Prefs, setPrefs, state } from "../../store";
import { createFavorites, favorites, type Saved } from "./favorites";

const prefsOf = (list: string[]): Prefs => ({ devices: {}, repos: [], models: { favorites: list }, home: DEFAULT_HOME });
const kept = (list: string[]): Promise<Saved> => Promise.resolve({ ok: true, value: { favorites: list } });
const refused = (error: string) => (): Promise<Saved> => Promise.resolve({ ok: false, error });
const never = () => Promise.resolve(null);
/** a route whose answers are held until the test lets them go, in whatever order it likes */
function held() {
  const releases: Array<(saved: Saved) => void> = [];
  const sent: string[][] = [];
  const save = (list: string[]) => new Promise<Saved>((resolve) => (sent.push(list), releases.push(resolve)));
  return { save, sent, release: (at: number, saved: Saved) => releases[at]?.(saved) };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => setPrefs(prefsOf(["a/one"])));

describe("a star on a model", () => {
  test("is on screen before the server has answered, and what the server keeps replaces it", async () => {
    const route = held();
    const stars = createFavorites({ save: route.save, read: never });
    const pressed = stars.toggle("b/two");
    expect(favorites()).toEqual(["a/one", "b/two"]);
    await tick();
    expect(route.sent).toEqual([["a/one", "b/two"]]);
    route.release(0, { ok: true, value: { favorites: ["a/one", "b/two"] } });
    expect(await pressed).toEqual({ ok: true, value: true });
    expect(favorites()).toEqual(["a/one", "b/two"]);
  });

  test("a second press takes it off again", async () => {
    const stars = createFavorites({ save: kept, read: never });
    expect(await stars.toggle("a/one")).toEqual({ ok: true, value: false });
    expect(favorites()).toEqual([]);
  });

  test("is put back, with the reason, when the server does not keep it", async () => {
    const stars = createFavorites({ save: refused("the boxbox server is not answering"), read: never });
    expect(await stars.toggle("b/two")).toEqual({ ok: false, error: "not saved. the boxbox server is not answering" });
    expect(favorites()).toEqual(["a/one"]);
  });

  test("a sixty-fifth is refused before anything is sent", async () => {
    setPrefs(prefsOf(Array.from({ length: 64 }, (_, i) => `p/m${i}`)));
    let sent = false;
    const stars = createFavorites({ save: () => ((sent = true), kept([])), read: never });
    expect((await stars.toggle("p/new")).ok).toBe(false);
    expect(sent).toBe(false);
    expect(state.prefs?.models.favorites).toHaveLength(64);
  });
});

describe("presses close together", () => {
  test("go to the server one at a time, in press order, each with the list as it was after that press", async () => {
    const route = held();
    const stars = createFavorites({ save: route.save, read: never });
    const one = stars.toggle("b/two");
    const two = stars.toggle("c/three");
    await tick();
    // the second waits for the first to be answered
    expect(route.sent).toEqual([["a/one", "b/two"]]);
    route.release(0, { ok: true, value: { favorites: ["a/one", "b/two"] } });
    await one;
    await tick();
    expect(route.sent).toEqual([["a/one", "b/two"], ["a/one", "b/two", "c/three"]]);
    route.release(1, { ok: true, value: { favorites: ["a/one", "b/two", "c/three"] } });
    await two;
    expect(favorites()).toEqual(["a/one", "b/two", "c/three"]);
  });

  test("end on the newest list on screen whichever press is answered, and an older answer never replaces it", async () => {
    const route = held();
    const stars = createFavorites({ save: route.save, read: never });
    const one = stars.toggle("b/two");
    const two = stars.toggle("c/three");
    await tick();
    route.release(0, { ok: true, value: { favorites: ["a/one", "b/two"] } });
    await one;
    expect(favorites()).toEqual(["a/one", "b/two", "c/three"]);
    await tick();
    route.release(1, { ok: true, value: { favorites: ["a/one", "b/two", "c/three"] } });
    await two;
    expect(favorites()).toEqual(["a/one", "b/two", "c/three"]);
  });

  test("when every press is refused the list goes back to what the server last kept, not to a half-way list", async () => {
    const stars = createFavorites({ save: refused("the host did not answer"), read: never });
    await Promise.all([stars.toggle("b/two"), stars.toggle("c/three")]);
    expect(favorites()).toEqual(["a/one"]);
  });
});

describe("reading the prefs again when the menu opens", () => {
  test("brings in a star another device made", async () => {
    const stars = createFavorites({ save: kept, read: () => Promise.resolve(prefsOf(["a/one", "z/other-device"])) });
    await stars.refresh();
    expect(favorites()).toEqual(["a/one", "z/other-device"]);
  });

  test("does not put back an old list when the read left before a press and landed after it", async () => {
    let answer: (prefs: Prefs) => void = () => undefined;
    const stars = createFavorites({ save: kept, read: () => new Promise<Prefs>((resolve) => (answer = resolve)) });
    const reading = stars.refresh();
    await stars.toggle("b/two");
    // the press is settled; the read now lands, carrying the list as it was before the press
    answer(prefsOf(["a/one"]));
    await reading;
    expect(favorites()).toEqual(["a/one", "b/two"]);
  });

  test("does not read while a press is out", async () => {
    const route = held();
    let reads = 0;
    const stars = createFavorites({ save: route.save, read: () => ((reads += 1), Promise.resolve(prefsOf(["a/one"]))) });
    const pressed = stars.toggle("b/two");
    await stars.refresh();
    expect(reads).toBe(0);
    await tick();
    route.release(0, { ok: true, value: { favorites: ["a/one", "b/two"] } });
    await pressed;
  });
});
