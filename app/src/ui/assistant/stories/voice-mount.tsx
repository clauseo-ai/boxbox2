/* the solid side of the voice note stories (docs/thread.md, voice notes): every state of yours and the agent's, and the
   player really playing a tone made in the page. a story that plays mutes the element, since a page may play muted
   sound without a gesture and the screenshot test has none; the browser check plays it aloud. */

import { createSignal, type JSX } from "solid-js";
import { type Note, PlayerContext, createPlayer } from "../voice/player";
import { VoiceNote, type VoiceNoteProps } from "../voice/note";
import { AT, MACHINE, NAME, speech, toneUrl, voice } from "./fixtures";
import { storyElement } from "./fake-audio";
import { Frame, mount } from "./frame";

const agent = { mine: false as const, agent: NAME };
const you = { mine: true as const };

type Drive = (player: ReturnType<typeof createPlayer>, el: HTMLElement) => void;

function withPlayer(node: (player: ReturnType<typeof createPlayer>) => JSX.Element, opts: { drive?: Drive; readyAfter?: number; next?: (id: string) => Note | null } = {}) {
  return (el: HTMLElement) =>
    mount(el, () => {
      const [speed, setSpeed] = createSignal(1);
      const element = storyElement();
      const player = createPlayer({ speed, setSpeed, next: (id) => opts.next?.(id) ?? null, ...(element ? { element } : {}) });
      (window as unknown as { __player?: unknown }).__player = player;
      return (
        <PlayerContext.Provider value={player}>
          <Frame readyAfter={opts.readyAfter ?? 400} drive={(frame) => opts.drive?.(player, frame)}>
            <div class="thread">{node(player)}</div>
          </Frame>
        </PlayerContext.Provider>
      );
    });
}

const note = (props: Omit<VoiceNoteProps, "machine" | "album">) => <VoiceNote machine={MACHINE} album="plants and reminders" {...props} />;

const press = (el: HTMLElement, label: string) => el.querySelector<HTMLElement>(`[aria-label^="${label}"]`)?.click();

const MINE = voice("msg_1", 14_000, { waveform: speech(3), transcript: { text: "remind me to water the plants on friday, and the basil needs more sun so move it to the window" } });
const HERS = voice("msg_2", 22_000, { spoken: "booked. **court 3** at 18:00 on friday, and I added a reminder an hour before." });

export const mineSent = withPlayer(() => note({ part: MINE, at: AT - 180_000, who: you, src: toneUrl(14_000) }));
export const mineFromChannel = withPlayer(() => note({ part: voice("msg_1b", 9_000, { waveform: speech(5) }), at: AT - 600_000, who: you, origin: { kind: "channel", name: "whatsapp" }, src: toneUrl(9_000) }));
export const mineSending = withPlayer(() => note({ part: voice("msg_1c", 14_000, { waveform: speech(3) }), at: AT, who: you, send: { state: "sending", progress: 0.4 } }));
export const mineNotSent = withPlayer(() => note({ part: voice("msg_1d", 14_000, { waveform: speech(3) }), at: AT, who: you, send: { state: "failed", reason: "the upload stopped" }, onRetry: () => undefined, onBackToDraft: () => undefined }));
export const mineTranscriptOpen = withPlayer(() => note({ part: MINE, at: AT - 180_000, who: you, src: toneUrl(14_000) }), { drive: (_, el) => press(el, "transcript of your voice note") });
export const agentSettled = withPlayer(() => note({ part: voice("msg_2b", 22_000), at: AT, who: agent, src: toneUrl(22_000), peaks: speech(11) }));
export const agentNoPeaksYet = withPlayer(() => note({ part: voice("msg_2c", 22_000), at: AT, who: agent, src: toneUrl(22_000) }));
export const agentSpokenOpen = withPlayer(() => note({ part: HERS, at: AT, who: agent, src: toneUrl(22_000), peaks: speech(11) }), { drive: (_, el) => press(el, `what ${NAME} said`) });
export const pending = withPlayer(() => (
  <>
    {note({ part: voice("msg_3", 14_000, { media: { id: null, state: "pending" } }), at: AT, who: agent })}
    {note({ part: voice("msg_3b", 9_000, { waveform: speech(4), media: { id: null, state: "pending" } }), at: AT, who: you })}
  </>
));
export const missing = withPlayer(() => (
  <>
    {note({ part: voice("msg_4", 22_000, { media: { id: null, state: "missing" }, spoken: "the court is booked for friday at 18:00." }), at: AT, who: agent, peaks: speech(11) })}
    {note({ part: voice("msg_4b", 14_000, { waveform: speech(3), media: { id: null, state: "missing" }, transcript: { text: "book the court for friday" } }), at: AT - 60_000, who: you })}
  </>
));
export const evicted = withPlayer(() => (
  <>
    {note({ part: voice("msg_5", 22_000, { spoken: "the court is booked for friday at 18:00." }), at: AT, who: agent, evicted: true, peaks: speech(11) })}
    {note({ part: voice("msg_5b", 14_000, { waveform: speech(3) }), at: AT - 60_000, who: you, evicted: true })}
  </>
));
/* playing: the disc shows pause, the played part fills, the speed pill is beside the duration */
export const playing = withPlayer(() => note({ part: voice("msg_6", 6_000), at: AT, who: agent, src: toneUrl(6_000), peaks: speech(11) }), { readyAfter: 1400, drive: (player, el) => setTimeout(() => { press(el, `play ${NAME}'s voice note`); setTimeout(() => player.cycleSpeed(1.5), 200); }, 50) });
/* a note paused part way: its position in place of the duration, the speed pill kept until another starts */
export const paused = withPlayer(() => note({ part: voice("msg_7", 6_000, { waveform: speech(8) }), at: AT, who: you, src: toneUrl(6_000) }), { readyAfter: 1400, drive: (player, el) => setTimeout(() => { press(el, "play your voice note"); setTimeout(() => player.pause(), 900); }, 50) });
/* play on: the first ends and the next note, the agent's, plays after 300 ms */
export const playOn = (() => {
  const a = voice("msg_8", 1_200, { waveform: speech(2) });
  const b = voice("msg_9", 5_000);
  const notes: Record<string, Note> = {};
  const urls = { [a.id]: toneUrl(1_200), [b.id]: toneUrl(5_000, 300) };
  notes[b.id] = { id: b.id, src: urls[b.id] ?? "", durationMs: 5_000, title: `${NAME}'s voice note`, album: "" };
  return withPlayer(
    () => (
      <>
        {note({ part: a, at: AT - 60_000, who: you, src: urls[a.id] ?? "" })}
        {note({ part: b, at: AT, who: agent, src: urls[b.id] ?? "", peaks: speech(9) })}
      </>
    ),
    { readyAfter: 2600, next: (id) => (id === a.id ? (notes[b.id] ?? null) : null), drive: (_, el) => setTimeout(() => press(el, "play your voice note"), 50) },
  );
})();
