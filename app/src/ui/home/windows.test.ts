import { describe, expect, test } from "bun:test";
import { detailsPlace, docksBeside, stageWidth, toggleName } from "./windows";

describe("the windows' toggle", () => {
  test("is named for what a tap does", () => {
    expect(toggleName("strip", "open")).toBe("fold the windows");
    expect(toggleName("rail", "open")).toBe("hide the windows");
    expect(toggleName("strip", "folded")).toBe("show the windows");
    expect(toggleName("rail", "folded")).toBe("show the windows");
    expect(toggleName("rail", "hidden")).toBe("show the windows");
  });
});

describe("where the details go", () => {
  test("they dock only beside a column of 704 or more", () => {
    expect(docksBeside(704 + 342)).toBe(true);
    expect(docksBeside(704 + 341)).toBe(false);
  });

  test("the deck never docks", () => {
    expect(detailsPlace("deck", 2560)).toEqual({ docks: false, foldsRail: false });
  });

  test("an ipad's portrait strip takes them as a sheet, a tall monitor's strip docks them", () => {
    expect(detailsPlace("strip", 820)).toEqual({ docks: false, foldsRail: false });
    expect(detailsPlace("strip", 1440)).toEqual({ docks: true, foldsRail: false });
  });

  test("at the rail the open rail gives way first, and where even that is too narrow they are a sheet", () => {
    // the owner's ipad in landscape: details beside the folded rail
    expect(detailsPlace("rail", 1180)).toEqual({ docks: true, foldsRail: true });
    expect(detailsPlace("rail", 1366)).toEqual({ docks: true, foldsRail: true });
    // the rail between 1000 and the fold's reach: a sheet, the rail stays open
    expect(detailsPlace("rail", 1100)).toEqual({ docks: false, foldsRail: false });
    // wide enough beside the open rail
    expect(detailsPlace("rail", 1390)).toEqual({ docks: true, foldsRail: false });
  });

  test("with the windows put away the card has the screen, and the rail never folds", () => {
    expect(detailsPlace("rail", 1180, true)).toEqual({ docks: true, foldsRail: false });
    expect(detailsPlace("rail", 1060, true)).toEqual({ docks: false, foldsRail: false });
    expect(detailsPlace("strip", 1080, true)).toEqual({ docks: true, foldsRail: false });
  });

  test("the stage's width follows the windows", () => {
    expect(stageWidth("rail", 1180, "hidden")).toBe(1152);
    expect(stageWidth("rail", 1180, "open")).toBe(848);
    expect(stageWidth("rail", 1180, "folded")).toBe(1090);
    expect(stageWidth("strip", 820, "open")).toBe(792);
  });
});
