import { describe, expect, test } from "bun:test";
import { nameOf, reportLabel } from "./copy-names";
import { announcement, renameAll } from "./copy-run";

/** a control as renameAll reads it: its base name, and the name it has now */
function control(base: string): { dataset: { name: string }; label: string; getAttribute(n: string): string; setAttribute(n: string, v: string): void } {
  const c = { dataset: { name: base }, label: base, getAttribute: () => c.label, setAttribute: (_n: string, v: string) => { c.label = v; } };
  return c;
}
const thread = (controls: Array<ReturnType<typeof control>>) => ({ querySelectorAll: () => controls }) as unknown as Element;

describe("naming the copy controls of a thread", () => {
  test("namesakes are told apart in document order: the first keeps its name, then again, then third time", () => {
    const cs = [nameOf("typescript"), nameOf("bash"), nameOf("typescript"), "copy the reply", nameOf("typescript")].map(control);
    renameAll(thread(cs));
    expect(cs.map((c) => c.label)).toEqual(["copy the typescript code", "copy the bash code", "copy the typescript code, again", "copy the reply", "copy the typescript code, third time"]);
  });

  test("a control that appears above its namesake moves it on by one, and naming again settles on the same names", () => {
    const first = control("copy the output");
    const second = control("copy the output");
    renameAll(thread([first, second]));
    expect([first.label, second.label]).toEqual(["copy the output", "copy the output, again"]);
    const above = control("copy the output");
    renameAll(thread([above, first, second]));
    expect([above.label, first.label, second.label]).toEqual(["copy the output", "copy the output, again", "copy the output, third time"]);
    renameAll(thread([above, first, second]));
    expect([above.label, first.label, second.label]).toEqual(["copy the output", "copy the output, again", "copy the output, third time"]);
  });

  test("a report is named for its agent, so two agents' reports are not namesakes", () => {
    const cs = [reportLabel("helper", false), reportLabel("worker", false), reportLabel("helper", true)].map(control);
    renameAll(thread(cs));
    expect(cs.map((c) => c.label)).toEqual(["copy helper's report", "copy worker's report", "copy helper's note"]);
  });
});

describe("the announcement", () => {
  test("says what was copied, from the control's name", () => {
    expect(announcement("copy the typescript code")).toBe("copied the typescript code");
    expect(announcement("copy helper's report, again")).toBe("copied helper's report, again");
    expect(announcement("")).toBe("copied");
  });
});
