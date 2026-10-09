import { describe, expect, test } from "bun:test";
import { openReview, type ReviewNeed, reviewLine } from "./open";

const need = (over: Partial<ReviewNeed> = {}): ReviewNeed => ({ id: "review:desk:ses_1:c:1", key: "desk:ses_1", kind: "review", rank: 3, raisedAt: 1, title: "x is ready to merge", body: "the toggle is in. tests pass.", checkout: "c", ...over });

describe("the line for a review that is out of view", () => {
  test("reads the note on one line, and is named for what it does", () => {
    expect(reviewLine(need(), false, false)).toEqual({ note: "the toggle is in. tests pass.", name: "ready to merge: the toggle is in. tests pass. go to it" });
    // a note that does not end a sentence is given its full stop before "go to it"
    expect(reviewLine(need({ body: "the toggle is in" }), false, false)?.name).toBe("ready to merge: the toggle is in. go to it");
  });

  test("a note that runs over lines is one line, whitespace made single", () => {
    const line = reviewLine(need({ body: "  the toggle is in.\n\n   tests pass.  " }), false, false);
    expect(line?.note).toBe("the toggle is in. tests pass.");
  });

  test("a review with no note says only that it is ready", () => {
    expect(reviewLine(need({ body: "" }), false, false)).toEqual({ note: "", name: "ready to merge. go to it" });
    expect(reviewLine(need({ body: "  \n " }), false, false)?.name).toBe("ready to merge. go to it");
  });

  test("a card on screen needs no line", () => {
    expect(reviewLine(need(), true, false)).toBeNull();
  });

  test("an ask's line outranks it: one line at a time", () => {
    expect(reviewLine(need(), false, true)).toBeNull();
  });

  test("no review, no line", () => {
    expect(reviewLine(undefined, false, false)).toBeNull();
  });

  test("when the ask's line goes, the review's line is there for a card still out of view", () => {
    expect(reviewLine(need(), false, true)).toBeNull();
    expect(reviewLine(need(), false, false)).not.toBeNull();
  });
});

describe("which need brings the review", () => {
  test("the newest open review, never a served one or another kind", () => {
    const served = need({ id: "old", servedAt: 5 });
    const fault = need({ id: "f", kind: "fault" });
    expect(openReview({ needs: [served, fault, need({ id: "a" }), need({ id: "b" })] })?.id).toBe("b");
    expect(openReview({ needs: [served, fault] })).toBeUndefined();
    expect(openReview(undefined)).toBeUndefined();
  });
});
