/* the solid side of the thread stories for pictures, files, quotes, reactions and the conversation's small rows
   (docs/thread.md, an assistant's thread). each draws one state from contract 2 shaped parts on an assistant's stage. */

import { createSignal, For, type JSX, Show } from "solid-js";
import { AudioFileCard, FileCard, ImageCard } from "../media/media";
import { Viewer, type ViewerImage } from "../media/viewer";
import { AgentWords, jumpTo, ReplyStrip, ScheduledLine, ThinkingLine, UnknownPartRow, YourMessage } from "../rows/conversation";
import { PlayerContext, createPlayer } from "../voice/player";
import { VoiceNote } from "../voice/note";
import type { ReplyTarget } from "../words";
import type { Reaction } from "../wire";
import { storyElement } from "./fake-audio";
import { AT, file, image, MACHINE, NAME, pictureUrl, speech, toneUrl, voice } from "./fixtures";
import { Frame, mount } from "./frame";

type Opts = { drive?: (el: HTMLElement) => void; readyAfter?: number; palette?: string };

function threadStory(node: () => JSX.Element, opts: Opts = {}) {
  return (el: HTMLElement) =>
    mount(el, () => {
      const [speed, setSpeed] = createSignal(1);
      const element = storyElement();
      const player = createPlayer({ speed, setSpeed, ...(element ? { element } : {}) });
      return (
        <PlayerContext.Provider value={player}>
          <Frame readyAfter={opts.readyAfter ?? 400} {...(opts.palette ? { palette: opts.palette } : {})} drive={(frame) => setTimeout(() => opts.drive?.(frame), 60)}>
            <div class="thread" data-scroller>
              {node()}
            </div>
          </Frame>
        </PlayerContext.Provider>
      );
    });
}

const click = (el: HTMLElement, label: string) => el.querySelector<HTMLElement>(`[aria-label^="${label}"]`)?.click();

/* ---------- pictures ---------- */

const landscape = () => image("m_i1", { width: 1600, height: 1000 });
const portrait = () => image("m_i2", { width: 900, height: 1600, filename: "receipt.jpg", flavour: "attached", mime: "image/jpeg" });

export const imageLandscape = threadStory(() => <ImageCard part={landscape()} src={pictureUrl(800, 500)} agent={NAME} machine={MACHINE} at={AT} />);
export const imagePortrait = threadStory(() => <ImageCard part={portrait()} src={pictureUrl(450, 800, 200)} agent={NAME} machine={MACHINE} at={AT} />);
export const imageNoSize = threadStory(() => <ImageCard part={image("m_i3", { filename: "plan.png", flavour: "attached" })} src={pictureUrl(400, 400, 120)} agent={NAME} machine={MACHINE} at={AT} />);
export const imageStates = threadStory(() => (
  <>
    <ImageCard part={image("m_i4", { width: 1600, height: 1000, media: { id: null, state: "pending" } })} agent={NAME} machine={MACHINE} at={AT} />
    <ImageCard part={image("m_i5", { width: 1600, height: 1000, filename: "court-map.png", size: 412_000, flavour: "attached", media: { id: null, state: "missing" } })} agent={NAME} machine={MACHINE} at={AT} />
    <ImageCard part={image("m_i6", { width: 1200, height: 900, filename: "basil.jpg", size: 1_840_000, flavour: "attached" })} src={pictureUrl(600, 450)} evicted agent={NAME} machine={MACHINE} at={AT} />
  </>
));
export const imageUploads = threadStory(() => (
  <>
    <YourMessage id="msg_u1" text="is this the right one?" at={AT}>
      <ImageCard part={image("m_i7", { width: 1200, height: 900, filename: "plant.jpg", flavour: "attached" })} src={pictureUrl(600, 450, 100)} agent={NAME} machine={MACHINE} at={AT} upload={{ state: "sending", progress: 0.4 }} />
    </YourMessage>
    <YourMessage id="msg_u2" text="" at={AT}>
      <ImageCard part={image("m_i8", { width: 1200, height: 900, filename: "plant.jpg", flavour: "attached" })} src={pictureUrl(600, 450, 100)} agent={NAME} machine={MACHINE} at={AT} upload={{ state: "failed", reason: "the upload stopped. tap to try again." }} />
    </YourMessage>
  </>
));

/* ---------- files ---------- */

export const files = threadStory(() => (
  <>
    <FileCard part={file("m_f1", "booking-confirmation-court-3.pdf", "application/pdf", 84_000)} href="#booking.pdf" machine={MACHINE} />
    <FileCard part={file("m_f2", "notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 23_400)} href="#notes.docx" machine={MACHINE} />
    <FileCard part={file("m_f3", "photos-march.zip", "application/zip", 31_200_000)} href="#photos.zip" machine={MACHINE} />
    <FileCard part={file("m_f4", "shopping.txt", "text/plain", 412)} href="#shopping.txt" machine={MACHINE} />
    <FileCard part={file("m_f5", "garden-tour.mp4", "video/mp4", 8_400_000, { flavour: "generated" })} href="#garden.mp4" machine={MACHINE} />
  </>
));
export const fileStates = threadStory(() => (
  <>
    <FileCard part={file("m_f6", "itinerary.pdf", "application/pdf", 120_000, { media: { id: null, state: "pending" } })} machine={MACHINE} />
    <FileCard part={file("m_f7", "itinerary.pdf", "application/pdf", 120_000, { media: { id: null, state: "missing" } })} machine={MACHINE} />
    <FileCard part={file("m_f8", "itinerary.pdf", "application/pdf", 120_000)} href="#x" evicted machine={MACHINE} />
    <FileCard part={file("m_f9", "lease.pdf", "application/pdf", 2_100_000)} machine={MACHINE} upload={{ state: "sending", progress: 0.7 }} />
    <FileCard part={file("m_f10", "archive.zip", "application/zip", 31_000_000)} machine={MACHINE} upload={{ state: "failed", reason: `archive.zip is 31 mb. ${NAME} takes files up to 20 mb.` }} />
  </>
));
export const audioFile = threadStory(
  () => (
    <>
      <AudioFileCard part={voice("m_a1", 42_000, { flavour: "generated", mime: "audio/mpeg" })} filename="lullaby.mp3" size={1_200_000} src={toneUrl(42_000)} machine={MACHINE} />
      <AudioFileCard part={voice("m_a2", 42_000, { flavour: "attached", mime: "audio/mpeg", media: { id: null, state: "missing" } })} filename="voicemail.m4a" size={400_000} machine={MACHINE} />
    </>
  ),
  { readyAfter: 900, drive: (el) => click(el, "play lullaby.mp3") },
);

/* ---------- the viewer ---------- */

function viewerStory(start: number, then?: (el: HTMLElement) => void) {
  return threadStory(
    () => {
      const shots: ViewerImage[] = [
        { id: "v1", src: pictureUrl(1200, 800, 10), filename: "court-map.png", at: AT - 60_000 },
        { id: "v2", src: pictureUrl(800, 1200, 160), at: AT },
        { id: "v3", src: pictureUrl(1000, 1000, 260), filename: "basil.jpg", at: AT + 60_000 },
      ];
      const [open, setOpen] = createSignal<number | null>(start);
      return (
        <>
          <ImageCard part={image("m_v2", { width: 800, height: 1200 })} src={shots[1]?.src ?? ""} agent={NAME} machine={MACHINE} at={AT} onOpen={() => setOpen(1)} />
          <Show when={open() !== null}>
            <Viewer images={shots} start={open() ?? 0} agent={NAME} onClose={() => setOpen(null)} />
          </Show>
        </>
      );
    },
    { readyAfter: 700, ...(then ? { drive: then } : {}) },
  );
}
export const viewerOpen = viewerStory(1);
export const viewerNamed = viewerStory(0);
export const viewerZoomed = viewerStory(2, (el) => {
  void el;
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "+", bubbles: true }));
});

/* ---------- the origin line, quotes, reactions ---------- */

export const originLines = threadStory(() => (
  <>
    <YourMessage id="msg_o1" text="remind me to water the plants on friday" at={AT - 3_600_000} origin={{ kind: "channel", name: "whatsapp" }} />
    <YourMessage id="msg_o2" text="and the basil wants more sun" at={AT - 3_000_000} origin={{ kind: "channel", name: "control-ui" }} />
    <YourMessage id="msg_o3" text="thanks, sent from here" at={AT} />
  </>
));

const QUOTED = "booked. court 3 at 18:00 on friday, and a reminder at 17:00";

export const quotes = threadStory(() => (
  <>
    <AgentWords id="msg_q0" text={QUOTED} at={AT - 600_000}>
      <p>{QUOTED}</p>
    </AgentWords>
    <YourMessage id="msg_q1" text="perfect. add a reminder friday" at={AT - 300_000} quote={{ quote: { message: "msg_q0", sender: "agent", preview: "booked. court 3 at 18:00 on friday", glyph: "audio", durationMs: 22_000 }, agent: NAME, canJump: true, onJump: (m) => jumpTo(m) }} />
    <YourMessage id="msg_q2" text="this one" at={AT - 240_000} quote={{ quote: { message: "msg_x", sender: "agent", preview: null, glyph: "image" }, agent: NAME, thumb: pictureUrl(64, 64, 30), canJump: false }} />
    <YourMessage id="msg_q3" text="and this too" at={AT - 200_000} quote={{ quote: { message: "msg_x2", sender: "you", preview: "remind me to water the plants on friday", glyph: "text" }, agent: NAME, canJump: false }} />
    <YourMessage id="msg_q4" text="yes, that" at={AT - 100_000} origin={{ kind: "channel", name: "whatsapp" }} quote={{ quote: { message: null, sender: "agent", preview: null, glyph: "text" }, agent: NAME, channel: "whatsapp", canJump: false }} />
    <AgentWords id="msg_q5" text="done, friday at 21:00." at={AT} quote={{ quote: { message: "msg_q1", sender: "you", preview: "remind me to water the plants on friday", glyph: "text" }, agent: NAME, canJump: true, onJump: (m) => jumpTo(m) }}>
      <p>done, friday at 21:00.</p>
    </AgentWords>
  </>
));
export const quoteJump = threadStory(() => <QuotesJump />, { readyAfter: 900, drive: (el) => click(el, "go to the message it quotes, from you") });
function QuotesJump() {
  return (
    <>
      <YourMessage id="msg_j1" text="remind me to water the plants on friday" at={AT - 600_000} />
      <AgentWords id="msg_j2" text="done, friday at 21:00." at={AT} quote={{ quote: { message: "msg_j1", sender: "you", preview: "remind me to water the plants on friday", glyph: "text" }, agent: NAME, canJump: true, onJump: (m) => jumpTo(m) }}>
        <p>done, friday at 21:00.</p>
      </AgentWords>
    </>
  );
}

const ACTS = { agent: NAME, quotes: true, reactions: true };

export const rowControls = threadStory(
  () => (
    <>
      <YourMessage id="msg_c1" text="remind me to water the plants on friday" at={AT - 600_000} actions={ACTS} />
      <AgentWords id="msg_c2" text="set for friday at 18:00." at={AT} actions={ACTS}>
        <p>set for friday at 18:00.</p>
      </AgentWords>
    </>
  ),
  // focus within a row shows its controls, as hover does
  { drive: (el) => el.querySelector<HTMLElement>('[data-message="msg_c2"]')?.focus() },
);

const R = (emoji: string, by: string): Reaction => ({ emoji, by });

export const reactions = threadStory(() => (
  <>
    <YourMessage id="msg_r1" text="booked the court for friday" at={AT - 600_000} reactions={{ reactions: [R("\u{1F44D}", "agent")], agent: NAME }} />
    <AgentWords id="msg_r2" text="nice, see you there" at={AT - 300_000} reactions={{ reactions: [R("\u2764\uFE0F", "you"), R("\u2764\uFE0F", "sam"), R("\u{1F602}", "agent")], agent: NAME }}>
      <p>nice, see you there. I put the racket bag by the door so you do not forget it.</p>
    </AgentWords>
    <AgentWords id="msg_r3" text="reminder moved to 17:00" at={AT} reactions={{ reactions: [R("\u{1F64F}", "you")], agent: NAME, pending: "\u{1F64F}" }}>
      <p>reminder moved to 17:00.</p>
    </AgentWords>
    <YourMessage id="msg_r4" text="see you then" at={AT} origin={{ kind: "channel", name: "whatsapp" }} reactions={{ reactions: [R("\u{1F44D}", "you")], agent: NAME, mirrorFailed: "whatsapp" }} />
  </>
));

function BarStory(props: { channel: string | null }) {
  const [list, setList] = createSignal<Reaction[]>([]);
  const [open, setOpen] = createSignal(true);
  return (
    <>
      <div style={{ height: "64px" }} />
      <AgentWords
        id="msg_b1"
        text="the plants are watered"
        at={AT}
        actions={{ ...ACTS, onReact: () => setOpen(true) }}
        barOpen={open()}
        barChannel={props.channel}
        onCloseBar={() => setOpen(false)}
        onPickReaction={(e) => setList([R(e, "you")])}
        reactions={{ reactions: list(), agent: NAME, onRemove: () => setList([]) }}
      >
        <p>the plants are watered, and the basil is on the sill.</p>
      </AgentWords>
    </>
  );
}
export const reactionBar = threadStory(() => <BarStory channel="whatsapp" />);
export const reactionBarHere = threadStory(() => <BarStory channel={null} />);

/* ---------- the reply strip ---------- */

const TARGETS: ReplyTarget[] = [
  { kind: "text", message: "msg_s1", who: NAME, text: "booked. court 3 at 18:00 on friday, and a reminder an hour before" },
  { kind: "audio", message: "msg_s2", who: NAME, durationMs: 22_000 },
  { kind: "file", message: "msg_s3", who: "you", filename: "booking-confirmation.pdf" },
];
export const replyStrip = threadStory(() => (
  <For each={TARGETS}>
    {(t) => (
      <div class="as-strip-demo">
        <ReplyStrip target={t} onClose={() => undefined} />
        <div class="as-strip-composer demo" aria-hidden="true">message {NAME}</div>
      </div>
    )}
  </For>
));

/* ---------- a send that is not confirmed ---------- */

export const unconfirmed = threadStory(() => (
  <>
    <YourMessage id="msg_n1" text="book the court for friday at six" at={AT - 300_000} unconfirmed={{ state: "checking", agent: NAME, machine: MACHINE }} />
    <YourMessage id="msg_n2" text="and tell sam" at={AT - 200_000} unconfirmed={{ state: "uncertain", agent: NAME, machine: MACHINE, onAgain: () => undefined }} />
    <YourMessage id="msg_n3" text="cancel the dentist" at={AT - 100_000} unconfirmed={{ state: "cancelled", agent: NAME, machine: MACHINE, onAgain: () => undefined }} />
    <YourMessage id="msg_n4" text="move it to monday" at={AT} unconfirmed={{ state: "generation-changed", agent: NAME, machine: MACHINE, onAgain: () => undefined }} />
  </>
));

/* ---------- small rows ---------- */

export const unknownPart = threadStory(() => (
  <>
    <UnknownPartRow kind="poll" />
    <UnknownPartRow kind="location" text="the community courts, north gate" />
  </>
));
export const scheduledAndThinking = threadStory(() => (
  <>
    <ScheduledLine at={AT - 3_600_000} name="morning check" />
    <AgentWords id="msg_t1" text="two meetings moved, nothing to do" at={AT - 3_590_000}>
      <p>two meetings moved, nothing to do.</p>
    </AgentWords>
    <ScheduledLine at={AT - 1_800_000} name="heartbeat" />
    <ThinkingLine />
  </>
));
export const groupSender = threadStory(() => (
  <>
    <YourMessage id="msg_g1" text="who is bringing the balls?" at={AT - 300_000} sender="sam" origin={{ kind: "channel", name: "whatsapp" }} />
    <YourMessage id="msg_g2" text="I will" at={AT - 200_000} origin={{ kind: "channel", name: "whatsapp" }} />
  </>
));

/* ---------- the approved screen, in one thread ---------- */

export const conversation = threadStory(() => (
  <>
    <YourMessage id="msg_w1" text="remind me to water the plants on friday" at={AT - 900_000} origin={{ kind: "channel", name: "whatsapp" }} actions={ACTS} />
    <AgentWords id="msg_w2" text="set for friday at 18:00." at={AT - 880_000} actions={ACTS}>
      <p>set for friday at 18:00.</p>
    </AgentWords>
    <VoiceNote part={voice("msg_w3", 14_000, { waveform: speech(3), transcript: { text: "and book the court for friday too" } })} at={AT - 600_000} who={{ mine: true }} machine={MACHINE} src={toneUrl(14_000)} />
    <VoiceNote part={voice("msg_w4", 22_000, { spoken: "booked. court 3 at 18:00 on friday." })} at={AT - 560_000} who={{ mine: false, agent: NAME }} machine={MACHINE} src={toneUrl(22_000)} peaks={speech(11)} />
    <ImageCard part={image("msg_w4", { width: 1600, height: 1000 })} src={pictureUrl(800, 500)} agent={NAME} machine={MACHINE} at={AT - 560_000} />
    <FileCard part={file("msg_w4", "booking.pdf", "application/pdf", 84_000)} href="#booking.pdf" machine={MACHINE} />
    <YourMessage id="msg_w5" text="perfect. add a reminder friday" at={AT - 300_000} quote={{ quote: { message: "msg_w4", sender: "agent", preview: "booked. court 3 at 18:00 on friday", glyph: "audio", durationMs: 22_000 }, agent: NAME, canJump: true, onJump: (m) => jumpTo(m) }} reactions={{ reactions: [R("\u{1F44D}", "agent")], agent: NAME }} actions={ACTS} />
    <AgentWords id="msg_w6" text="done, friday at 21:00." at={AT} quote={{ quote: { message: "msg_w1", sender: "you", preview: "remind me to water the plants on friday", glyph: "text" }, agent: NAME, canJump: true, onJump: (m) => jumpTo(m) }} actions={ACTS}>
      <p>done, friday at 21:00.</p>
    </AgentWords>
    <ThinkingLine />
  </>
));
