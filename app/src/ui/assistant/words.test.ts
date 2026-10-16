import { describe, expect, test } from "bun:test";
import {
  againName, agentName, agentPlace, agentSpoken, channelWord, clockOf, emojiName, excerptOf, foldName, isHashName, middleCut, nextSpeed, pillName, pillsOf,
  playName, quoteLine, quoteName, REACTIONS, reactName, replyName, scheduledLine, scrubName, scrubValue, sizeOf, speedName, stripLine, stripName, timeLine,
  typeWord, unconfirmedWords, unknownWords, unresolvedQuote,
} from "./words";

const AT = new Date(2026, 9, 15, 11, 34).getTime();
const wren = { label: { name: "wren", source: "openclaw" as const, machine: "vm-b" } };
const cmx = { label: { source: "cmx" as const, machine: "vm-a" } };

describe("time and size", () => {
  test("a duration rounds to the second as m:ss", () => {
    expect(clockOf(14_400)).toBe("0:14");
    expect(clockOf(14_600)).toBe("0:15");
    expect(clockOf(725_000)).toBe("12:05");
    expect(clockOf(-5)).toBe("0:00");
  });
  test("sizes read as a file card says them", () => {
    expect(sizeOf(412)).toBe("412 b");
    expect(sizeOf(84_000)).toBe("84 kb");
    expect(sizeOf(2_400_000)).toBe("2.4 mb");
    expect(sizeOf(31_200_000)).toBe("31 mb");
  });
});

describe("who", () => {
  test("an assistant and a cmx agent are named as the law's table says", () => {
    expect(agentName(wren)).toBe("wren");
    expect(agentPlace(wren)).toBe("openclaw · vm-b");
    expect(agentSpoken(wren)).toBe("wren, openclaw on vm-b");
    expect(agentName(cmx)).toBe("cmx · vm-a");
    expect(agentPlace(cmx)).toBe("on vm-a");
    expect(agentSpoken(cmx)).toBe("cmx on vm-a");
  });
});

describe("the origin line", () => {
  test("a channel's message carries it in the time slot; the control ui by its words; boxbox's by its time alone", () => {
    expect(timeLine(AT, { kind: "channel", name: "whatsapp" })).toBe("11:34 · via whatsapp");
    expect(timeLine(AT, { kind: "channel", name: "control-ui" })).toBe("11:34 · via the control ui");
    expect(timeLine(AT, undefined)).toBe("11:34");
    expect(timeLine(AT, { kind: "scheduled" })).toBe("11:34");
    expect(channelWord("telegram")).toBe("telegram");
  });
  test("a scheduled run's mark line names the run, and a heartbeat is its own word", () => {
    expect(scheduledLine(AT, "morning check")).toBe("scheduled, 11:34: morning check");
    expect(scheduledLine(AT, "heartbeat")).toBe("heartbeat, 11:34");
    expect(scheduledLine(AT, undefined)).toBe("scheduled, 11:34");
  });
});

describe("media words", () => {
  test("the type tile's word", () => {
    expect(typeWord("application/pdf", "booking.pdf")).toBe("pdf");
    expect(typeWord("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "notes.docx")).toBe("doc");
    expect(typeWord("application/zip", "a.zip")).toBe("zip");
    expect(typeWord("text/plain", "list.txt")).toBe("txt");
    expect(typeWord("video/mp4", "tour.mp4")).toBe("mp4");
    expect(typeWord("application/octet-stream", "data")).toBe("octe");
  });
  test("a generated hash is not a caption", () => {
    expect(isHashName("3f9a0c1b2d3e4f5a6b7c.png")).toBe(true);
    expect(isHashName("0b8f2c1e-3d4a-4b5c-9e8f-112233445566.jpg")).toBe(true);
    expect(isHashName("receipt.jpg")).toBe(false);
  });
  test("a long name is cut in the middle and keeps its end", () => {
    expect(middleCut("booking-confirmation.pdf")).toBe("booking-co…rmation.pdf");
    expect(middleCut("short.pdf")).toBe("short.pdf");
  });
});

describe("voice note names", () => {
  const you = { mine: true as const };
  const her = { mine: false as const, agent: "wren" };
  test("play, scrub, speed and fold are named as the law's table says", () => {
    expect(playName(you, AT, 14_000)).toBe("play your voice note, 11:34, 0:14");
    expect(playName(her, AT, 22_000)).toBe("play wren's voice note, 11:34, 0:22");
    expect(scrubName(her, AT)).toBe("position in wren's voice note, 11:34");
    expect(scrubValue(12_000, 22_000)).toBe("0:12 of 0:22");
    expect(speedName(1.5)).toBe("playback speed, 1.5 times");
    expect(foldName(you, AT)).toBe("transcript of your voice note, 11:34");
    expect(foldName(her, AT)).toBe("what wren said, 11:34");
  });
  test("the speed cycles 1x, 1.5x, 2x", () => {
    expect(nextSpeed(1)).toBe(1.5);
    expect(nextSpeed(1.5)).toBe(2);
    expect(nextSpeed(2)).toBe(1);
    expect(nextSpeed(3)).toBe(1);
  });
});

describe("reply, react and quote", () => {
  test("a row is told apart by its author, its clock and the first 40 characters of its words", () => {
    expect(excerptOf("remind me to water the plants on friday, and the basil")).toBe("remind me to water the plants on friday,…");
    expect(replyName(false, "wren", AT, "booked. court 3 at 18:00")).toBe("reply to wren, 11:34: booked. court 3 at 18:00");
    expect(replyName(true, "wren", AT, "hello")).toBe("reply to your message, 11:34: hello");
    expect(reactName(false, "wren", AT, "booked")).toBe("react to wren, 11:34: booked");
  });
  test("a quote's line is led by its glyph's word for media", () => {
    expect(quoteLine({ preview: "booked. court 3", glyph: "audio", durationMs: 22_000 })).toBe("voice note 0:22 · booked. court 3");
    expect(quoteLine({ preview: null, glyph: "audio" })).toBe("voice note");
    expect(quoteLine({ preview: null, glyph: "image" })).toBe("photo");
    expect(quoteLine({ preview: "see this", glyph: "file" }, "booking.pdf")).toBe("booking.pdf · see this");
    expect(quoteLine({ preview: "hello", glyph: "text" })).toBe("hello");
    expect(unresolvedQuote("whatsapp")).toBe("replied to a message on whatsapp");
    expect(quoteName("wren", "booked")).toBe("go to the message it quotes, from wren: booked");
  });
  test("the reply strip's line and name", () => {
    const voice = { kind: "audio" as const, message: "m", who: "wren", durationMs: 22_000 };
    expect(stripLine(voice)).toBe("voice note 0:22");
    expect(stripLine({ kind: "audio", message: "m", who: "wren" })).toBe("voice note");
    expect(stripLine({ kind: "file", message: "m", who: "you", filename: "booking.pdf" })).toBe("booking.pdf");
    expect(stripName(voice)).toBe("replying to wren: voice note 0:22");
  });
});

describe("reactions", () => {
  test("the six, in their order, named by their cldr short names", () => {
    expect(REACTIONS.map((r) => r.name)).toEqual(["thumbs up", "red heart", "face with tears of joy", "face with open mouth", "crying face", "folded hands"]);
    expect(emojiName("\u2764")).toBe("red heart");
    expect(emojiName("\u{1F525}")).toBe("reaction \u{1F525}");
  });
  test("one pill per emoji, counted by sender, yours marked; the list is whole, never a diff", () => {
    const pills = pillsOf([
      { emoji: "\u2764\uFE0F", by: "you" },
      { emoji: "\u2764", by: "sam" },
      { emoji: "\u{1F44D}", by: "agent" },
      { emoji: "\u{1F44D}", by: "agent" },
    ]);
    expect(pills.map((p) => [p.count, p.mine])).toEqual([[2, true], [1, false]]);
    expect(pillName(pills[0] ?? { emoji: "", count: 0, mine: false, by: [] }, "wren")).toBe("your reaction, red heart. remove it");
    expect(pillName(pills[1] ?? { emoji: "", count: 0, mine: false, by: [] }, "wren")).toBe("thumbs up from wren");
  });
});

describe("a send that is not confirmed", () => {
  test("each state's words, and the control's name", () => {
    expect(unconfirmedWords("checking", "wren", "vm-b")).toBe("checking with vm-b");
    expect(unconfirmedWords("uncertain", "wren", "vm-b")).toBe("not confirmed: wren may not have it.");
    expect(unconfirmedWords("cancelled", "wren", "vm-b")).toBe("not sent: vm-b cancelled it.");
    expect(unconfirmedWords("generation-changed", "wren", "vm-b")).toBe("not sent: the conversation changed on vm-b. read it, then send again.");
    expect(againName("book the court")).toBe("send it again: book the court");
  });
  test("an unknown part names its kind and says to update", () => {
    expect(unknownWords("poll")).toBe("a poll part this version of boxbox cannot show. update the app to see it.");
  });
});
