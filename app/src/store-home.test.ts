import { describe, expect, test } from "bun:test";
import { DEFAULT_HOME, readHome } from "./store";

describe("the home prefs' copy on this device", () => {
  test("a kept copy is read field by field; a field missing or of the wrong shape takes the default", () => {
    expect(readHome({ autoClear: "never", foldWorking: false, jobsAsNeeds: true })).toEqual({ autoClear: "never", foldWorking: false, jobsAsNeeds: true });
    expect(readHome({ autoClear: "soon", foldWorking: "yes", jobsAsNeeds: 1 })).toEqual(DEFAULT_HOME);
    expect(readHome({ foldWorking: false })).toEqual({ ...DEFAULT_HOME, foldWorking: false });
    expect(readHome(null)).toEqual(DEFAULT_HOME);
    expect(readHome([1, 2])).toEqual(DEFAULT_HOME);
    expect(readHome("seen1h")).toEqual(DEFAULT_HOME);
  });
});
