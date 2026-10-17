import { describe, expect, test } from "bun:test";
import { bareLinux, cloudVm, macMini, strainedLaptop } from "./fixtures";
import { duration, identity, meters, osMark, spec } from "./system";

describe("what a machine is", () => {
  test("each os wears its mark, and an unknown one a plain machine", () => {
    expect(osMark(macMini(0))).toBe("apple");
    expect(osMark(cloudVm(0))).toBe("ubuntu");
    expect(osMark(bareLinux(0))).toBe("linux");
    expect(osMark({ ...cloudVm(0), os: { ...cloudVm(0).os, name: "Debian GNU/Linux" } })).toBe("debian");
    expect(osMark({ ...macMini(0), os: { ...macMini(0).os, platform: "win32", name: "Windows" } })).toBe("windows");
    expect(osMark({ ...macMini(0), os: { ...macMini(0).os, platform: "freebsd" } })).toBe("machine");
    expect(osMark(null)).toBe("machine");
  });

  test("the line names the model, then the os, and says vm for a vm without a model", () => {
    expect(identity(macMini(0))).toBe("Mac mini · macOS 26.1");
    expect(identity(cloudVm(0))).toBe("Google Compute Engine · Ubuntu 24.04");
    expect(identity(bareLinux(0))).toBe("Arch Linux");
    expect(identity({ ...cloudVm(0), machine: { model: null, identifier: null, virtual: true } })).toBe("virtual machine · Ubuntu 24.04");
  });

  test("the spec line says up while live and as of while away", () => {
    expect(spec(macMini(0), "9 days", null)).toBe("Apple M4 Pro · arm64 · up 9 days");
    expect(spec(cloudVm(0), null, "14:02")).toBe("AMD EPYC 7B13 · x64 · as of 14:02");
  });

  test("durations take the largest whole unit", () => {
    expect([duration(12), duration(240), duration(3 * 3600), duration(86_400), duration(9 * 86_400)]).toEqual(["12 s", "4 min", "3 h", "1 day", "9 days"]);
  });
});

describe("how it is doing", () => {
  test("a comfortable mac reads calm", () => {
    const [cpu, memory, disk] = meters(macMini(0));
    expect(cpu).toMatchObject({ kind: "cpu", value: "17%", detail: "load 2.41 · 14 cores", warn: false });
    expect(cpu?.marks?.map((m) => m.toFixed(3))).toEqual(["0.141", "0.121"]);
    expect(memory).toMatchObject({ value: "64%", detail: "41 of 64 gb", warn: false });
    expect(disk).toMatchObject({ value: "79%", detail: "213 gb free", warn: false });
  });

  test("a strained laptop warns on all three, in words as well as colour", () => {
    const [cpu, memory, disk] = meters(strainedLaptop(0));
    expect(cpu).toMatchObject({ value: "216%", fill: 1, warn: true, detail: "load 17.3 · 8 cores" });
    expect(cpu?.label).toContain("load high");
    expect(memory).toMatchObject({ warn: true, detail: "1.2 gb free · low" });
    expect(disk).toMatchObject({ warn: true, detail: "4.9 gb free · low" });
  });

  test("a disk counts in tb from a thousand gb", () => {
    const big = { ...macMini(0), disk: { path: "/", total: 4e12, available: 3.2e12 } };
    expect(meters(big)[2]?.detail).toBe("3.2 tb free");
  });

  test("a machine without a disk reading draws two meters, never an empty one", () => {
    expect(meters({ ...cloudVm(0), disk: null }).map((m) => m.kind)).toEqual(["cpu", "memory"]);
  });
});
