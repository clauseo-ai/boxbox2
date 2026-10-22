/* the turn models of every recorded transcript (fixtures/*.json, cmx2's shapes as recorded) built from their protocol 3 form,
   which the sync fixtures make as the server's translate.rs does (sync/fixtures/neutral.ts), digest for digest equal to the
   ones the model built from the cmx2 shapes before the port (fixtures/turn-digests.json, recorded by the model as it was then
   with RECORD=1). a turn is told by its whole json, its maps as their entries. the model reads protocol 3 alone since the port,
   so a change to what a turn is (decision 92: reports and notices are rows of the turn they came into) is recorded again from
   the neutral form, RECORD=1, and the digests then hold that model to what it built */

import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../../sync/protocol";
import { neutralMessage } from "../../sync/fixtures/neutral";
import { type Turn, projectRoot, turnsOf } from "./model";

type Json = Record<string, unknown>;
type Recorded = { info: Json; parts: Json[] };
type Imported = { session: { directory: string }; messages: Recorded[]; children: Array<{ session: { id: string }; messages: Recorded[] }> };
type Native = { session: { directory: string }; messages: Recorded[]; snapshots: Array<{ label: string; messages: Recorded[] }> };

const dir = join(import.meta.dir, "fixtures");
const read = <T,>(name: string): T => JSON.parse(readFileSync(join(dir, name), "utf8")) as T;

const sha = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
const turnDigest = (t: Turn): string => sha(JSON.stringify(t, (_k, v: unknown) => (v instanceof Map ? [...v.entries()] : v)));
const turnsDigest = (messages: readonly Message[], root: string): string[] => turnsOf(messages, root).map(turnDigest);

/** every transcript in the fixtures, under a name of its own, as the messages the model is given */
function transcripts(convert: (m: Recorded) => Message): Array<{ name: string; messages: Message[]; dir: string }> {
  const out: Array<{ name: string; messages: Message[]; dir: string }> = [];
  for (const file of ["cmx-deploy.json", "northstar-heavy.json"]) {
    const f = read<Imported>(file);
    const messages = f.messages.map(convert);
    out.push({ name: file, messages, dir: f.session.directory });
    const root = projectRoot(f.session.directory, messages);
    for (const c of f.children) out.push({ name: `${file} child ${c.session.id}`, messages: c.messages.map(convert), dir: root });
  }
  const n = read<Native>("notes-asks.json");
  out.push({ name: "notes-asks.json", messages: n.messages.map(convert), dir: n.session.directory });
  n.snapshots.forEach((s, i) => out.push({ name: `notes-asks.json snapshot ${i} ${s.label}`, messages: s.messages.map(convert), dir: n.session.directory }));
  return out;
}

const digests = (convert: (m: Recorded) => Message): Record<string, string[]> =>
  Object.fromEntries(transcripts(convert).map((t) => [t.name, turnsDigest(t.messages, projectRoot(t.dir, t.messages))]));

const RECORDED = join(dir, "turn-digests.json");

if (process.env["RECORD"] === "1") {
  test("records the turn digests of the cmx2 transcripts", () => {
    writeFileSync(RECORDED, `${JSON.stringify(digests(neutralMessage), null, 1)}\n`);
  });
} else {
  test("every fixture transcript's turns, built from its neutral form, digest as they did from cmx2's", () => {
    const recorded = JSON.parse(readFileSync(RECORDED, "utf8")) as Record<string, string[]>;
    const now = digests(neutralMessage);
    expect(Object.keys(now).length).toBeGreaterThan(20);
    expect(now).toEqual(recorded);
  });
}
