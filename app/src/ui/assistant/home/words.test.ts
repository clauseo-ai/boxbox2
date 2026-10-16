import { describe, expect, test } from "bun:test";
import { APPROVAL, AT, assistant, at, cmx } from "./fixtures";
import {
  agentRowName,
  answerName,
  assistantWindowName,
  availability,
  cardChip,
  cardMeta,
  cardSays,
  durationOf,
  footOrigin,
  footState,
  machineInitials,
  moreWords,
  pickerGroups,
  pickerOptionName,
  runsChip,
  runsName,
  runsTitle,
  runWords,
  startLine,
  voiceLine,
} from "./words";

const meta = (a: ReturnType<typeof assistant>) =>
  cardMeta(a, AT)
    .map((p) => p.text)
    .join(" · ");

describe("the window", () => {
  test("names the window by the assistant, the title and the state", () => {
    expect(assistantWindowName("wren", "dinner on friday", "wants", null)).toBe("wren: dinner on friday. wants you");
    expect(assistantWindowName("wren", "flights", "done", at(11, 40))).toBe("wren: flights. done at 11:40");
    expect(assistantWindowName("wren", "flights", "idle", null)).toBe("wren: flights. seen");
  });
  test("names the answer pill with the question, cut", () => {
    expect(answerName("wren", "book the 19:30 table at the corner place?")).toBe("answer wren: book the 19:30 table at the corner place?");
    expect(answerName("wren", "a ".repeat(60)).endsWith("...")).toBe(true);
  });
  test("footer state, and stale holds the time of the last read", () => {
    expect(footState("wants", at(11, 0), AT, null)).toBe("waiting");
    expect(footState("working", AT - 40_000, AT, null)).toBe("working 0:40");
    expect(footState("done", at(11, 40), AT, null)).toBe("done 11:40");
    expect(footState("working", AT - 40_000, AT, at(11, 40))).toBe("stale, 11:40");
  });
  test("footer origin: the channel, else the steps, else nothing", () => {
    expect(footOrigin("whatsapp", 3)).toBe("via whatsapp");
    expect(footOrigin("control-ui", 0)).toBe("via the control ui");
    expect(footOrigin(null, 3)).toBe("3 steps");
    expect(footOrigin(null, 1)).toBe("1 step");
    expect(footOrigin(null, 0)).toBe("");
  });
  test("tail words", () => {
    expect(moreWords(2)).toBe("and 2 more");
    expect(moreWords(0)).toBe("");
    expect(voiceLine(22_000)).toBe("voice note 0:22");
    expect(voiceLine(undefined)).toBe("voice note");
  });
  test("the runs window", () => {
    expect(runsTitle("wren")).toBe("wren's runs");
    expect(runsChip(3)).toBe("3 runs");
    expect(runsChip(1)).toBe("1 run");
    expect(runsName("wren", 3, at(8, 0))).toBe("wren's runs: 3 since 08:00");
    expect(runWords("morning check", "two meetings moved")).toBe("morning check: two meetings moved");
    expect(runWords(undefined, "nothing to do")).toBe("nothing to do");
  });
});

describe("the agents screen", () => {
  test("durations", () => {
    expect(durationOf(12)).toBe("12 s");
    expect(durationOf(3 * 3600 + 5)).toBe("3 h");
    expect(durationOf(86_400)).toBe("1 day");
  });
  test("every pairing state's chip, mono line and words, as home.md's table says", () => {
    const pairing = assistant({ status: "pairing", connection: { lastError: APPROVAL } });
    expect(cardChip(pairing)).toEqual({ text: "waiting", look: "ring" });
    expect(meta(pairing)).toBe("openclaw 2026.10.1 · waiting for approval");

    const syncing = assistant({ status: "syncing" });
    expect(cardChip(syncing)).toEqual({ text: "syncing", look: "half" });
    expect(meta(syncing)).toBe("openclaw 2026.10.1 · paired");
    expect(cardSays(syncing)).toEqual({ text: "reading wren's threads.", failed: false });

    const ready = assistant();
    expect(cardChip(ready).text).toBe("connected");
    expect(meta(ready)).toBe("openclaw 2026.10.1 · up 3 h · paired");
    expect(cardSays(ready)).toBeNull();
    expect(meta(assistant({ connection: { origin: "config" } }))).toBe("openclaw 2026.10.1 · up 3 h");

    const untested = assistant({ connection: { version: "2026.11.0", untested: true } });
    expect(cardMeta(untested, AT)).toEqual([{ text: "openclaw 2026.11.0" }, { text: "untested", lit: true }]);
    expect(cardSays(untested)).toEqual({
      text: "openclaw 2026.11.0 on vm-b is untested; boxbox is pinned to 2026.10.1. anything that does not work says so where it fails.",
      failed: false,
    });

    expect(cardChip(assistant({ status: "connecting" }))).toEqual({ text: "connecting", look: "ring" });

    const down = assistant({ status: "down", connection: { since: at(11, 40), lastError: "connection refused" } });
    expect(cardChip(down)).toEqual({ text: "not answering", look: "fail" });
    expect(cardSays(down)).toEqual({ text: "connection refused. since 11:40", failed: true });

    const protocol = assistant({ status: "refused", connection: { refused: "protocol", version: "2026.12.0", protocol: 5 } });
    expect(cardChip(protocol)).toEqual({ text: "refused", look: "fail" });
    expect(meta(protocol)).toBe("openclaw 2026.12.0 · protocol 5");
    expect(cardSays(protocol)?.text).toBe("vm-b speaks openclaw protocol 5; boxbox speaks 4. update boxbox, or run the openclaw it is pinned to (2026.10.1).");

    const methods = assistant({ status: "refused", connection: { refused: "methods", lastError: "scope denied: sessions.write" } });
    expect(meta(methods)).toBe("openclaw 2026.10.1 · refused");
    expect(cardSays(methods)?.text).toBe("scope denied: sessions.write. pair it again from add an agent.");

    const auth = assistant({ status: "refused", connection: { refused: "auth", lastError: "device token revoked." } });
    expect(meta(auth)).toBe("openclaw 2026.10.1 · not paired");
    expect(cardSays(auth)?.text).toBe("device token revoked. pair it again from add an agent.");

    const key = assistant({ status: "refused", connection: { refused: "key" } });
    expect(meta(key)).toBe("openclaw · vm-b");
    expect(cardSays(key)?.text).toBe("another agent already has the key wren. pin a key for this one in boxbox.toml, then reload.");
  });
});

describe("start something", () => {
  test("a machine's two initials", () => {
    expect(machineInitials("vm-a")).toBe("va");
    expect(machineInitials("studio")).toBe("st");
    expect(machineInitials("build-box-2")).toBe("b2");
  });
  test("the row and the options are named as the law's table says", () => {
    expect(agentRowName(assistant())).toBe("agent for the new thread: wren, openclaw on vm-b");
    expect(agentRowName(cmx("vm-a"))).toBe("agent for the new thread: cmx on vm-a");
    expect(pickerOptionName(cmx("vm-a"))).toBe("cmx on vm-a");
    expect(pickerOptionName(assistant({ status: "down" }))).toBe("wren, openclaw on vm-b, not answering");
    expect(pickerOptionName(assistant({ status: "pairing" }))).toBe("wren, openclaw on vm-b, waiting for approval");
    expect(availability(assistant({ status: "syncing" }))).toBe("ready");
  });
  test("cmx first, then assistants with threads", () => {
    const quiet = assistant({ key: "moth", label: { name: "moth", source: "openclaw", machine: "vm-b" }, capabilities: { threads: false } });
    const groups = pickerGroups([assistant(), cmx("vm-a"), quiet, cmx("vm-c")]);
    expect(groups.square.map((a) => a.key)).toEqual(["cmx:vm-a", "cmx:vm-c"]);
    expect(groups.round.map((a) => a.key)).toEqual(["wren"]);
  });
  test("the line under the composer", () => {
    expect(startLine(assistant())).toBe("wren starts a new thread on vm-b.");
  });
});
