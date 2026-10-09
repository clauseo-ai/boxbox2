import { describe, expect, test } from "bun:test";
import type { components } from "../../api/boxbox";
import type { SessionEntry } from "../../sync/protocol";
import { extraOf } from "./extra";

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

const entry = (needs: Need[]): SessionEntry =>
  ({ key: "desk:ses_1", host: "desk", id: "ses_1", info: {}, status: null, agents: 0, processes: 0, tail: [], needs, read: null }) as unknown as SessionEntry;

describe("a window's needs", () => {
  test("a session with nothing waiting reads as seen", () => {
    expect(extraOf(entry([]))).toEqual({ seen: true });
  });

  test("a done, a job notice or a review waiting is not seen", () => {
    for (const kind of ["done", "job", "review"] as const) expect(extraOf(entry([need(kind)])).seen).toBe(false);
  });

  test("an open review carries its note to the window, a served one does not", () => {
    expect(extraOf(entry([need("review", "the toggle is in, tests pass")]))).toEqual({ review: "the toggle is in, tests pass", seen: false });
    const served = { ...need("review"), servedAt: 5 };
    expect(extraOf(entry([served])).review).toBeUndefined();
  });

  test("an open fault carries its reason to the window", () => {
    expect(extraOf(entry([need("fault")]))).toEqual({ failure: "the provider is down", seen: true });
  });
});
