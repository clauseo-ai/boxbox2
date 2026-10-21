/* what a command's and an output's copy controls copy (docs/thread.md, code and copying): the command whole as the agent sent it, in a bed of its own on
   every open shell row, and the output as the store holds it, cleaned at the press and cut at a cap that is said. */

import { describe, expect, test } from "bun:test";
import { COPY_OUTPUT_CAP, LINE_MAX, cleanOutput, headTail } from "./evidence";
import { homeAsTilde, shortPath, turnsOf } from "./model";
import { type RowCtx, plural, stepModel } from "./rows";
import type { WireMessage, WirePart } from "./wire";
import { neutral } from "./fixtures/wire";

const T0 = 1_790_000_000_000;
const user: WireMessage = neutral({ info: { id: "u", role: "user", time: { created: T0 } }, parts: [{ id: "u_p", type: "text", text: "go" } as WirePart] });
const shell = (command: string, output: string, extra: Record<string, unknown> = {}): WireMessage => neutral({
  info: { id: "a", role: "assistant", time: { created: T0 + 100, completed: T0 + 5000 } },
  parts: [{ id: "s", type: "tool", callID: "c", tool: "bash", state: { status: "completed", input: { command }, output, metadata: { exit: 0 }, time: { start: T0 + 200, end: T0 + 900 }, ...extra } } as unknown as WirePart],
});
const stepOf = (command: string, output: string, input: Record<string, unknown> = {}) => {
  const [turn] = turnsOf([user, shell(command, output, Object.keys(input).length ? { input: { command, ...input } } : {})], "/");
  const step = turn?.items.find((x) => x.k === "step");
  if (!step || step.k !== "step") throw new Error("no step");
  const ctx: RowCtx = { turns: turn ? [turn] : [], children: new Map(), thinking: "rows", now: T0 + 3000 };
  return { step, model: stepModel(step, ctx) };
};

describe("the command", () => {
  test("is the step's whole command, a leading cd and later lines included, and every open row has a bed of it", () => {
    const { step, model } = stepOf("cd ~/code/app && bun test\necho done", "ok");
    expect(step.command).toBe("cd ~/code/app && bun test\necho done");
    expect(model.body?.k === "shell" && model.body.command).toEqual(["cd ~/code/app && bun test", "echo done"]);
  });
  test("a one-line command has its bed too, so the control is always on the command", () => {
    const { model } = stepOf("ls -la", "total 0");
    expect(model.body?.k === "shell" && model.body.command).toEqual(["ls -la"]);
  });
});

const shellBody = (m: ReturnType<typeof stepOf>["model"]) => {
  if (m.body?.k !== "shell") throw new Error("not a shell body");
  return m.body;
};

describe("the command bed shows home as ~ and copies the command as it was sent", () => {
  test("the bed's lines have home as ~, even mid-command, and the copy is the raw command", () => {
    const sent = "cd /Users/dev/code/app && bun test --dir /home/ci/work\nls /Users/dev";
    const body = shellBody(stepOf(sent, "ok").model);
    expect(body.command).toEqual(["cd ~/code/app && bun test --dir ~/work", "ls ~"]);
    expect(body.commandRaw).toBe(sent);
  });
  test("a path inside a quote loses only the home part of it", () => {
    expect(homeAsTilde('cat "/Users/dev/my project/notes.md"')).toBe('cat "~/my project/notes.md"');
    expect(homeAsTilde("HOME=/Users/dev make")).toBe("HOME=~ make");
  });
  test("a path that only has home in its middle, or no name after it, is left alone", () => {
    for (const same of ["ls /mnt/Users/dev/x", "cd /srv/home/dev", "ls /Users/", "echo Users/dev", "ls ~/Users/dev/x", "ls ./home/dev"]) expect(homeAsTilde(same), same).toBe(same);
  });
  test("agrees with how the rest of the thread shortens a path (shortPath)", () => {
    for (const path of ["/Users/dev/code/app", "/home/dev/code", "/Users/dev"]) expect(homeAsTilde(path), path).toBe(shortPath(path, "/elsewhere"));
  });
});

describe("where it ran", () => {
  test("is in the facts when the command's bed does not say it (a workdir the command does not name)", () => {
    const body = shellBody(stepOf("bun test", "ok", { workdir: "/Users/dev/code/app" }).model);
    expect(body.facts.map((f) => f.text)).toContain("in ~/code/app");
    expect(body.command).toEqual(["bun test"]);
  });
  test("is left out of the facts when the bed shows the command's own `cd dir &&`", () => {
    const body = shellBody(stepOf("cd /Users/dev/code/app && bun test", "ok").model);
    expect(body.command?.[0]).toBe("cd ~/code/app && bun test");
    expect(body.facts.map((f) => f.text).some((t) => t.startsWith("in "))).toBe(false);
  });
});

describe("the output's line count", () => {
  test("is the body's, for its bed's header, and the facts no longer say it", () => {
    const body = shellBody(stepOf("seq 1 22", Array.from({ length: 22 }, (_, i) => String(i + 1)).join("\n")).model);
    expect(body.outputLines).toBe(22);
    expect(plural(body.outputLines ?? 0, "line")).toBe("22 lines");
    expect(body.facts.map((f) => f.text).some((t) => /of output/.test(t))).toBe(false);
  });
  test("is one line for one line", () => {
    const body = shellBody(stepOf("pwd", "/tmp").model);
    expect(plural(body.outputLines ?? 0, "line")).toBe("1 line");
  });
  test("is the whole output's, not the shown part's", () => {
    const body = shellBody(stepOf("seq 1 100", Array.from({ length: 100 }, (_, i) => String(i + 1)).join("\n")).model);
    expect(body.outputLines).toBe(100);
    expect(body.output?.lines.length).toBe(24);
  });
  test("a command with no output has no count", () => {
    expect(shellBody(stepOf("true", "").model).outputLines).toBeUndefined();
  });
});

describe("what the bed says it cut", () => {
  test("a line shown that was cut at the cap marks the bed clipped, and the lines are cut at exactly the cap", () => {
    const { lines, clipped } = headTail(`short\n${"x".repeat(LINE_MAX + 1)}\nshort`);
    expect(clipped).toBe(true);
    expect(lines[1]?.length).toBe(LINE_MAX);
    expect(lines[1]?.endsWith("…")).toBe(true);
    expect(LINE_MAX).toBe(220);
  });
  test("a line at the cap is whole and clips nothing", () => {
    expect(headTail("x".repeat(LINE_MAX)).clipped).toBe(false);
  });
  test("a long line in the middle that is not shown clips nothing that is", () => {
    const rows = Array.from({ length: 60 }, (_, i) => (i === 30 ? "y".repeat(500) : `line ${i}`));
    const { clipped, cut } = headTail(rows.join("\n"));
    expect(cut).toBe(36);
    expect(clipped).toBe(false);
  });
  test("reaches the bed's model, which the copy's refusal words read", () => {
    const body = shellBody(stepOf("cat big", "x".repeat(500)).model);
    expect(body.output?.clipped).toBe(true);
    expect(shellBody(stepOf("echo hi", "hi").model).output?.clipped).toBeUndefined();
  });
});

describe("the output", () => {
  const raw = "Wall time: 0.4 seconds\nOutput:\n" + Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n") + "\n\n";
  test("the step keeps the store's own text, and the row shows a head and a tail of it", () => {
    const { step, model } = stepOf("bun test", raw);
    expect(step.output?.raw).toBe(raw);
    expect(step.output?.lines.length).toBe(24);
    expect(model.body?.k === "shell" && model.body.outputRaw).toBe(raw);
  });
  test("is cleaned when it is copied, not before: the preamble and the trailing blank lines go, every line stays whole", () => {
    const text = cleanOutput(raw);
    expect(text.startsWith("line 1\n")).toBe(true);
    expect(text.endsWith("line 40")).toBe(true);
    expect(text.split("\n").length).toBe(40);
  });
  test("keeps a line the row cuts at 220 characters whole", () => {
    const long = "x".repeat(500);
    const { step } = stepOf("cat big", long);
    expect(step.output?.lines[0]?.length).toBe(220);
    expect(cleanOutput(step.output?.raw ?? "")).toBe(long);
  });
  test("a copy is cut at a cap, which is 256,000 characters", () => {
    expect(COPY_OUTPUT_CAP).toBe(256_000);
  });
  test("a command with no output has no output to copy", () => {
    const { step, model } = stepOf("true", "");
    expect(step.output).toBeUndefined();
    expect(model.body?.k === "shell" && model.body.outputRaw).toBeUndefined();
  });
});
