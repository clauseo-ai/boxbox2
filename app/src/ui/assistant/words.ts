/* the assistant surfaces' words and accessible names, pure, so a test pins them (docs/thread.md, copy; docs/design.md,
   accessible names for agent surfaces). every string a row draws or a control is named by is made here, from the
   wire's fields, and never from the runtime's name. */

import type { Agent, MediaPart, Origin, Quote, Reaction } from "./wire";

/* —— time and size —— */

/** a duration as the rows say it, rounded to the second: "0:14", "12:05" */
export function clockOf(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** a message's time of day, 24 hour, as the bubble's time slot says it: "09:12" */
export function timeOf(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** a size the way a file card says it: "84 kb", "2.4 mb", "320 b" */
export function sizeOf(bytes: number): string {
  if (bytes < 1000) return `${bytes} b`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} kb`;
  const mb = bytes / 1_000_000;
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, "") : Math.round(mb)} mb`;
}

/* —— who —— */

/** the agent's own name: its label's name, else "<source> · <machine>" as push copy names it (agents.md, needs) */
export function agentName(agent: Pick<Agent, "label">): string {
  return agent.label.name ?? `${agent.label.source} · ${agent.label.machine}`;
}

/** the agent's runtime and machine, the picker's second line: "openclaw · vm-b"; a cmx agent says "on vm-a" */
export function agentPlace(agent: Pick<Agent, "label">): string {
  return agent.label.name ? `${agent.label.source} · ${agent.label.machine}` : `on ${agent.label.machine}`;
}

/** how a screen reader hears an agent, with no middle dot: "cmx on vm-a", "<name>, openclaw on vm-b" */
export function agentSpoken(agent: Pick<Agent, "label">): string {
  return agent.label.name ? `${agent.label.name}, ${agent.label.source} on ${agent.label.machine}` : `${agent.label.source} on ${agent.label.machine}`;
}

/** who a quote or a reaction names: "you", the agent's name for "agent", else the person's label as sent */
export function whoOf(by: string, agent: string): string {
  if (by === "you") return "you";
  if (by === "agent") return agent;
  return by;
}

/* —— the origin line —— */

/** a channel by its name, as "via <channel>" reads it: `control-ui` is "the control ui" */
export function channelWord(name: string): string {
  return name === "control-ui" ? "the control ui" : name;
}

/** the bubble's time slot: "09:12 · via whatsapp" for a message that came in on a channel, the time alone otherwise */
export function timeLine(at: number, origin: Origin | undefined): string {
  return origin?.kind === "channel" ? `${timeOf(at)} · via ${channelWord(origin.name)}` : timeOf(at);
}

/** a scheduled run's mark line: "scheduled, 08:00: morning check", "heartbeat, 08:30" */
export function scheduledLine(at: number, name: string | undefined): string {
  if (name === "heartbeat") return `heartbeat, ${timeOf(at)}`;
  return name ? `scheduled, ${timeOf(at)}: ${name}` : `scheduled, ${timeOf(at)}`;
}

/* —— media —— */

/** the type tile's word for a file: pdf, doc, zip, txt, or the extension cut to four letters */
export function typeWord(mime: string, filename: string): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(filename)?.[1]?.toLowerCase();
  if (mime === "application/pdf" || ext === "pdf") return "pdf";
  if (ext === "docx" || ext === "doc" || mime.includes("wordprocessing") || mime === "application/msword") return "doc";
  if (ext === "zip" || mime === "application/zip") return "zip";
  if (mime.startsWith("text/") && (ext === undefined || ext === "txt")) return "txt";
  if (ext) return ext.slice(0, 4);
  return mime.split("/")[1]?.slice(0, 4) ?? "file";
}

/** a filename that is a generated hash says nothing: "3f9a0c…" or a uuid is not a caption */
export function isHashName(filename: string): boolean {
  const stem = filename.replace(/\.[a-z0-9]{1,8}$/i, "");
  return /^[0-9a-f]{16,}$/i.test(stem) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem) || /^(img|image|file)[-_]?[0-9a-f]{12,}$/i.test(stem);
}

/** a long name cut in the middle, keeping the extension: "booking-con…firm.pdf" */
export function middleCut(filename: string, max = 22): string {
  const chars = [...filename];
  if (chars.length <= max) return filename;
  const keepEnd = Math.ceil((max - 1) / 2);
  const keepStart = max - 1 - keepEnd;
  return `${chars.slice(0, keepStart).join("")}…${chars.slice(chars.length - keepEnd).join("")}`;
}

/** what a part's media is now: ready to show, still being copied, lost by the gateway, or evicted by boxbox (the media route's 410) */
export type MediaGone = "pending" | "missing" | "evicted" | null;

export function goneOf(part: { media?: MediaPart["media"] }, evicted: boolean): MediaGone {
  if (evicted) return "evicted";
  if (part.media?.state === "pending") return "pending";
  if (part.media?.state === "missing") return "missing";
  return null;
}

/** the words in place of a lost or evicted file: "no longer on vm-b", "no longer on the server" */
export function goneWords(gone: "missing" | "evicted", machine: string): string {
  return gone === "missing" ? `no longer on ${machine}` : "no longer on the server";
}

/* —— voice notes: names (design.md, accessible names) —— */

export type NoteWho = { mine: true } | { mine: false; agent: string };

const whose = (who: NoteWho) => (who.mine ? "your" : `${who.agent}'s`);

/** play on a note (a toggle; the state is in aria-pressed): "play your voice note, 11:31, 0:14" */
export function playName(who: NoteWho, at: number, durationMs: number | undefined): string {
  return `play ${whose(who)} voice note, ${timeOf(at)}${durationMs === undefined ? "" : `, ${clockOf(durationMs)}`}`;
}

/** the scrubber: "position in <name>'s voice note, 11:34" */
export function scrubName(who: NoteWho, at: number): string {
  return `position in ${whose(who)} voice note, ${timeOf(at)}`;
}

/** the scrubber's value: "0:12 of 0:22" */
export function scrubValue(positionMs: number, durationMs: number): string {
  return `${clockOf(positionMs)} of ${clockOf(durationMs)}`;
}

/** the speed control, whose value is its name: "playback speed, 1.5 times" */
export function speedName(rate: number): string {
  return `playback speed, ${rate} times`;
}

/** the speed pill's face: "1x", "1.5x", "2x" */
export const speedFace = (rate: number): string => `${rate}x`;

/** the speeds a tap cycles through, in order */
export const SPEEDS = [1, 1.5, 2] as const;

export function nextSpeed(rate: number): number {
  const at = SPEEDS.indexOf(rate as (typeof SPEEDS)[number]);
  return SPEEDS[(at + 1) % SPEEDS.length] ?? 1;
}

/** a transcript fold: "transcript of your voice note, 11:31"; the agent's: "what <name> said, 11:34" */
export function foldName(who: NoteWho, at: number): string {
  return who.mine ? `transcript of your voice note, ${timeOf(at)}` : `what ${who.agent} said, ${timeOf(at)}`;
}

/** the fold's visible words: "transcript", "what <name> said" */
export function foldWords(who: NoteWho): string {
  return who.mine ? "transcript" : `what ${who.agent} said`;
}

/** the now playing line: "<name>'s voice note, 0:12 of 0:22" */
export function nowPlayingLine(who: NoteWho, positionMs: number, durationMs: number): string {
  return `${who.mine ? "your" : `${who.agent}'s`} voice note, ${scrubValue(positionMs, durationMs)}`;
}

/* —— the words a row is told apart by —— */

/** the first 40 characters of a message's words, cut at a word where one ends near the cut, one line */
export function excerptOf(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  if (chars.length <= max) return flat;
  const cut = chars.slice(0, max).join("");
  // the cut fell between two words: keep the whole of the last one
  if (chars[max] === " ") return `${cut.trimEnd()}…`;
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** a row's whose-and-when, as reply and react name it: "<name>, 11:34" or "your message, 11:31" */
function rowWho(mine: boolean, agent: string, at: number): string {
  return mine ? `your message, ${timeOf(at)}` : `${agent}, ${timeOf(at)}`;
}

/** the reply control on a row: "reply to <name>, 11:34: <excerpt>", "reply to your message, 11:31: <excerpt>" */
export function replyName(mine: boolean, agent: string, at: number, words: string): string {
  return `reply to ${rowWho(mine, agent, at)}: ${excerptOf(words)}`;
}

/** the react control on a row: "react to <name>, 11:34: <excerpt>" */
export function reactName(mine: boolean, agent: string, at: number, words: string): string {
  return `react to ${rowWho(mine, agent, at)}: ${excerptOf(words)}`;
}

/* —— quotes —— */

/** a quote's one line, led by its glyph's word for media: "voice note 0:22 · booked", "photo · ", "<file> · " */
export function quoteLine(quote: Pick<Quote, "preview" | "glyph" | "durationMs">, file?: string): string {
  const preview = quote.preview ?? "";
  const lead =
    quote.glyph === "audio" ? `voice note${quote.durationMs === undefined ? "" : ` ${clockOf(quote.durationMs)}`}` : quote.glyph === "image" ? "photo" : quote.glyph === "file" ? (file ?? "file") : null;
  if (lead === null) return preview;
  return preview ? `${lead} · ${preview}` : lead;
}

/** a quote whose original the source could not resolve: "replied to a message on whatsapp" */
export function unresolvedQuote(channel: string | null): string {
  return channel ? `replied to a message on ${channelWord(channel)}` : "replied to a message";
}

/** the quote block's name (a button when its original is in the thread): "go to the message it quotes, from <name>: <excerpt>" */
export function quoteName(sender: string, line: string): string {
  return `go to the message it quotes, from ${sender}: ${excerptOf(line)}`;
}

/** the reply strip's one line: a voice note's is "voice note 0:22", a card's its file name, words otherwise */
export function stripLine(target: ReplyTarget): string {
  if (target.kind === "audio") return target.durationMs === undefined ? "voice note" : `voice note ${clockOf(target.durationMs)}`;
  if (target.kind === "file") return target.filename;
  if (target.kind === "image") return target.filename ?? "photo";
  return excerptOf(target.text, 140);
}

/** what the reply strip quotes: a row's words, a voice note, a picture or a file */
export type ReplyTarget =
  | { kind: "text"; message: string; who: string; text: string }
  | { kind: "audio"; message: string; who: string; durationMs?: number }
  | { kind: "image"; message: string; who: string; filename?: string }
  | { kind: "file"; message: string; who: string; filename: string };

/** the strip as a group: "replying to <name>: <excerpt>" */
export function stripName(target: ReplyTarget): string {
  return `replying to ${target.who}: ${excerptOf(stripLine(target))}`;
}

/* —— reactions —— */

/** boxbox's own six, in their order (thread.md, reactions), each with its cldr short name */
export const REACTIONS: ReadonlyArray<{ emoji: string; name: string }> = [
  { emoji: "\u{1F44D}", name: "thumbs up" },
  { emoji: "\u2764\uFE0F", name: "red heart" },
  { emoji: "\u{1F602}", name: "face with tears of joy" },
  { emoji: "\u{1F62E}", name: "face with open mouth" },
  { emoji: "\u{1F622}", name: "crying face" },
  { emoji: "\u{1F64F}", name: "folded hands" },
];

/** an emoji's spoken name: the six by their cldr short names; any other an agent sent is named "reaction" with the glyph kept as content */
export function emojiName(emoji: string): string {
  const bare = emoji.replace(/\uFE0F/g, "");
  return REACTIONS.find((r) => r.emoji.replace(/\uFE0F/g, "") === bare)?.name ?? `reaction ${emoji}`;
}

/** reactions grouped into pills: one per emoji, in first-seen order, with who chose it and whether you did */
export type Pill = { emoji: string; count: number; mine: boolean; by: string[] };

export function pillsOf(reactions: readonly Reaction[]): Pill[] {
  const pills: Pill[] = [];
  for (const r of reactions) {
    const bare = r.emoji.replace(/\uFE0F/g, "");
    let pill = pills.find((p) => p.emoji.replace(/\uFE0F/g, "") === bare);
    if (!pill) pills.push((pill = { emoji: r.emoji, count: 0, mine: false, by: [] }));
    if (pill.by.includes(r.by)) continue;
    pill.by.push(r.by);
    pill.count += 1;
    if (r.by === "you") pill.mine = true;
  }
  return pills;
}

/** a pill's name: "thumbs up from <name>"; yours (a button): "your reaction, thumbs up. remove it" */
export function pillName(pill: Pill, agent: string): string {
  const name = emojiName(pill.emoji);
  if (pill.mine) return `your reaction, ${name}. remove it`;
  const who = pill.by.map((b) => whoOf(b, agent));
  return `${name} from ${who.length > 2 ? `${who.slice(0, -1).join(", ")} and ${who.at(-1)}` : who.join(" and ")}`;
}

/** the bar's option: "react with thumbs up" */
export const reactWith = (name: string): string => `react with ${name}`;

/* —— a send that is not confirmed (thread.md) —— */

export type Unconfirmed = "checking" | "uncertain" | "cancelled" | "generation-changed";

/** the words under the faded bubble; checking says it in the time slot instead */
export function unconfirmedWords(state: Unconfirmed, agent: string, machine: string): string {
  switch (state) {
    case "checking":
      return `checking with ${machine}`;
    case "uncertain":
      return `not confirmed: ${agent} may not have it.`;
    case "cancelled":
      return `not sent: ${machine} cancelled it.`;
    case "generation-changed":
      return `not sent: the conversation changed on ${machine}. read it, then send again.`;
  }
}

/** the one control: "send it again: <excerpt>" */
export const againName = (words: string): string => `send it again: ${excerptOf(words)}`;

/* —— an unknown part —— */

/** the fallback row for a kind this build does not know (agents.md): it names the kind and says to update */
export function unknownWords(kind: string): string {
  return `a ${kind} part this version of boxbox cannot show. update the app to see it.`;
}
