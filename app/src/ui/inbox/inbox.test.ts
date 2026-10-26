import { describe, expect, test } from "bun:test";
import type { components } from "../../api/boxbox";
import { thread } from "../../sync/fixtures/neutral";
import type { Thread } from "../../sync/protocol";
import { counts, extraOf } from "./extra";

type Need = components["schemas"]["Need"];

const need = (kind: Need["kind"], body = "the provider is down"): Need => ({
  id: `${kind}:desk:ses_1`,
  kind,
  key: "desk:ses_1",
  rank: kind === "fault" ? 1 : 2,
  raisedAt: 1,
  title: "api stopped",
  body,
});

const entry = (needs: Need[]): Thread => thread("desk:ses_1", { agent: "desk", needs });

describe("a window's needs", () => {
  test("a session with nothing waiting reads as seen", () => {
    expect(extraOf(entry([]), false)).toEqual({ seen: true });
  });

  test("a done, a job notice or a review waiting is not seen, with job notices counted as needs", () => {
    for (const kind of ["done", "job", "review"] as const) expect(extraOf(entry([need(kind)]), true).seen).toBe(false);
  });

  test("with job notices not counted (the default), a job notice alone leaves the window seen, and a done beside it does not", () => {
    expect(extraOf(entry([need("job")]), false).seen).toBe(true);
    expect(extraOf(entry([need("job"), need("done")]), false).seen).toBe(false);
  });

  test("only a job notice is filtered: every other kind counts whatever the choice", () => {
    for (const kind of ["permission", "question", "fault", "review", "done"] as const) expect(counts({ kind }, false)).toBe(true);
    expect(counts({ kind: "job" }, false)).toBe(false);
    expect(counts({ kind: "job" }, true)).toBe(true);
  });

  test("an open review carries its note to the window, a served one does not", () => {
    expect(extraOf(entry([need("review", "the toggle is in, tests pass")]), false)).toEqual({ review: "the toggle is in, tests pass", seen: false });
    const served = { ...need("review"), servedAt: 5 };
    expect(extraOf(entry([served]), false).review).toBeUndefined();
  });

  test("an open fault carries its reason to the window", () => {
    expect(extraOf(entry([need("fault")]), false)).toEqual({ failure: "the provider is down", seen: true });
  });
});
