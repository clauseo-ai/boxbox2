/* the trace file: a scenario's run, with every record timestamped from the
   start of the run, written so it names nothing on the machine it was
   recorded on and nothing a rerun would mint differently:

     - paths the world names (the project, its scratch dir, the home dir)
       become placeholders;
     - session ids become the aliases the scenario gave its threads
       (`<alpha>`), permission and question ids are numbered in order of
       first appearance (`<permission 1>`), and the daemon's minted device
       id becomes `<device>`.

   a replay run gets the same treatment before it is compared, so the two
   meet on equal terms. */

import { readFileSync, writeFileSync } from "node:fs";
import type { Run, TracedStep } from "./run";

export const FORMAT = 1;

export type Trace = {
  format: typeof FORMAT;
  scenario: string;
  about: string;
  recorded: {
    /** what the daemon ran against: server, commit, agent runtime */
    against: string;
    /** which daemon was under trace */
    daemon: string;
    at: string;
  };
  steps: TracedStep[];
};

export type Substitutions = {
  aliases: Map<string, string>;
  redactions: [string, string][];
};

const ASK_ID = /\b(per|que)_[0-9A-Za-z]{20,}\b/g;
const DEVICE_ID = /\bboard-[0-9A-Za-z_-]{8}\b/g;

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** the run as json, every machine- and run-specific string replaced */
export function scrub(run: Run, subs: Substitutions): TracedStep[] {
  let text = JSON.stringify(run.steps);
  for (const [id, alias] of subs.aliases) text = text.replace(new RegExp(escape(id), "g"), `<${alias}>`);
  /* longest first, so a path inside another is replaced by its own name */
  for (const [path, placeholder] of [...subs.redactions].sort((a, b) => b[0].length - a[0].length)) {
    text = text.replace(new RegExp(escape(path), "g"), placeholder);
  }
  const asks = new Map<string, string>();
  text = text.replace(ASK_ID, (id, kind: string) => {
    let named = asks.get(id);
    if (!named) {
      const noun = kind === "per" ? "permission" : "question";
      named = `<${noun} ${[...asks.values()].filter((v) => v.startsWith(`<${noun}`)).length + 1}>`;
      asks.set(id, named);
    }
    return named;
  });
  text = text.replace(DEVICE_ID, "<device>");
  return JSON.parse(text) as TracedStep[];
}

export function writeTrace(path: string, trace: Trace) {
  /* one record per line: a trace reads, and diffs in review, line by line */
  const steps = trace.steps.map((step) => {
    const records = step.records.map((r) => `      ${JSON.stringify(r)}`).join(",\n");
    const head = JSON.stringify({ label: step.label, kind: step.kind, startedAt: step.startedAt, endedAt: step.endedAt, keys: step.keys });
    return `    ${head.slice(0, -1)},\n      "records": [\n${records}\n      ]}`;
  });
  const header = JSON.stringify({ format: trace.format, scenario: trace.scenario, about: trace.about, recorded: trace.recorded }, null, 2);
  writeFileSync(path, `${header.slice(0, -2)},\n  "steps": [\n${steps.join(",\n")}\n  ]\n}\n`);
}

export function readTrace(path: string): Trace {
  const trace = JSON.parse(readFileSync(path, "utf8")) as Trace;
  if (trace.format !== FORMAT) throw new Error(`${path} is trace format ${String(trace.format)}; this checker reads format ${FORMAT}`);
  return trace;
}
