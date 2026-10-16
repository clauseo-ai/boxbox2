/* a voice note's row (docs/thread.md, voice notes; docs/design.md, the new rows): yours is a bubble on the right, the
   agent's a card on the left, inline with its prose. both hold a play disc, the waveform (64 peaks) and the duration; the
   waveform is the scrubber. what it says comes from the part alone (`audio`, `flavour: voice`): its media's state, its
   duration and peaks, and its folds (`transcript` on yours, `spoken` on the agent's).

   the sound is the app's one player (player.ts): this row only asks it to play, pause, seek and change speed, and draws
   the playhead it reports. a row without a player (a story that draws and does not play) draws the note and does nothing. */

import { createMemo, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Markdown } from "../../thread/thread";
import { clockOf, foldName, foldWords, goneWords, type MediaGone, nextSpeed, type NoteWho, playName, scrubName, scrubValue, speedFace, speedName, timeLine } from "../words";
import type { AudioPart, Origin } from "../wire";
import { peaksFor, watchNear } from "./peaks";
import { type Note, usePlayer } from "./player";
import "../parts.css";

/** where your note's send stands: going up (its bytes' share sent, 0 to 1), refused (the reason, in words), or sent */
export type NoteSend = { state: "sending"; progress: number } | { state: "failed"; reason: string } | { state: "sent" };

export type VoiceNoteProps = {
  part: AudioPart;
  /** the message's time (when it reached the agent) and where it came in */
  at: number;
  origin?: Origin | undefined;
  who: NoteWho;
  /** the agent's machine, for "no longer on vm-b" */
  machine: string;
  /** the media route answered 410 for these bytes */
  evicted?: boolean;
  /** the url the player streams the bytes from (the media route by id); none while there are no bytes */
  src?: string;
  /** peaks drawn for a note that came without them (peaks.ts); the part's own `waveform` wins */
  peaks?: readonly number[] | null;
  /** the media session's album: the thread's title */
  album?: string;
  send?: NoteSend;
  /** the send failed and the person taps the words: the same bytes under the same clientID */
  onRetry?: () => void;
  /** "back to draft": the note goes back to the composer's locked review state */
  onBackToDraft?: () => void;
  /** the thread's next note, for play on (the player asks the thread; a story wires two notes by hand) */
  ref?: (el: HTMLElement) => void;
};

const BARS = 64;

/** the note's duration in ms: the part's, rounded at the edges by the player once it knows better */
const lengthOf = (part: AudioPart) => part.durationMs ?? 0;

export function VoiceNote(props: VoiceNoteProps) {
  const player = usePlayer();
  const mine = () => props.who.mine;
  const gone = createMemo<MediaGone>(() => (props.evicted ? "evicted" : props.part.media.state === "pending" ? "pending" : props.part.media.state === "missing" ? "missing" : null));
  const playable = () => gone() === null && props.src !== undefined && props.send?.state !== "sending" && player !== null;
  const note = (): Note => ({
    id: props.part.id,
    src: props.src ?? "",
    durationMs: lengthOf(props.part),
    title: props.who.mine ? "your voice note" : `${props.who.agent}'s voice note`,
    album: props.album ?? "",
  });
  const playing = () => player?.isPlaying(props.part.id) ?? false;
  const [drag, setDrag] = createSignal<number | null>(null);
  /** the playhead in ms: the drag's while the finger is down, else the player's for this note */
  const head = () => drag() ?? player?.positionOf(props.part.id) ?? 0;
  const played = () => (lengthOf(props.part) > 0 ? Math.min(1, head() / lengthOf(props.part)) : 0);
  /* an agent's note comes without peaks: they are drawn from its bytes in a worker once the card comes within 2.5 screens of
     the view (peaks.ts), and until then, or where the browser cannot decode it, the waveform is a flat line */
  const [drawn, setDrawn] = createSignal<readonly number[] | null>(null);
  onMount(() => {
    if (props.part.waveform || props.peaks || !props.src) return;
    const src = props.src;
    const stop = watchNear(rowEl, () => {
      void peaksFor(props.part.media.id ?? props.part.id, () => fetch(src).then((r) => r.arrayBuffer()), props.part.durationMs).then((p) => p && setDrawn(Array.from(p)));
    });
    onCleanup(stop);
  });
  const peaks = createMemo(() => {
    const own = props.part.waveform ?? props.peaks ?? drawn() ?? null;
    if (!own || own.length === 0 || gone() === "pending") return null;
    return own;
  });
  const [open, setOpen] = createSignal(false);
  const foldText = () => (props.who.mine ? props.part.transcript?.text : props.part.spoken);
  const showSpeed = () => playable() && (playing() || player?.lastPlayed() === props.part.id);
  const durationText = () => (drag() !== null || playing() || (player?.positionOf(props.part.id) ?? 0) > 0 ? clockOf(head()) : clockOf(lengthOf(props.part)));

  const toggle = () => {
    if (!player || !playable()) return;
    if (playing()) player.pause();
    else void player.play(note());
  };

  /* the scrubber: a drag follows the finger 1:1 and shows its position in place of the duration; release plays from there
     if it was playing; a tap jumps there. arrow keys step 5 s, page keys 15 s */
  let waveEl!: HTMLDivElement;
  let downAt: { x: number; was: boolean } | null = null;
  const msAt = (clientX: number) => {
    const box = waveEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * lengthOf(props.part);
  };
  const onDown = (e: PointerEvent) => {
    if (!playable() || e.button !== 0) return;
    waveEl.setPointerCapture(e.pointerId);
    downAt = { x: e.clientX, was: playing() };
    setDrag(msAt(e.clientX));
  };
  const onMove = (e: PointerEvent) => {
    if (downAt) setDrag(msAt(e.clientX));
  };
  const onUp = (e: PointerEvent) => {
    if (!downAt || !player) return;
    const at = msAt(e.clientX);
    const was = downAt.was;
    downAt = null;
    setDrag(null);
    if (was) void player.play(note(), at);
    else player.seek(note(), at);
  };
  const onCancel = () => {
    downAt = null;
    setDrag(null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!player || !playable()) return;
    const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 5000 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -5000 : e.key === "PageUp" ? 15000 : e.key === "PageDown" ? -15000 : null;
    const to = e.key === "Home" ? 0 : e.key === "End" ? lengthOf(props.part) : step === null ? null : head() + step;
    if (to === null) return;
    e.preventDefault();
    const clamped = Math.max(0, Math.min(to, lengthOf(props.part)));
    if (playing()) void player.play(note(), clamped);
    else player.seek(note(), clamped);
  };

  const timeSlot = () => {
    if (props.send?.state === "sending") return "sending";
    const base = timeLine(props.at, props.origin);
    const g = gone();
    return mine() && (g === "missing" || g === "evicted") ? `${goneWords(g, props.machine)} · ${base}` : base;
  };

  let rowEl!: HTMLDivElement;
  onMount(() => props.ref?.(rowEl));

  return (
    <div class="vn-row" data-mine={mine() ? "" : undefined} ref={rowEl}>
      <div
        class="vn"
        data-mine={mine() ? "" : undefined}
        data-state={props.send?.state === "sending" ? "sending" : gone() !== null ? "gone" : playing() ? "playing" : undefined}
        data-gone={gone() ?? undefined}
        classList={{ bad: props.send?.state === "failed" }}
      >
        <div class="vn-main">
          <Disc gone={gone()} playable={playable()} playing={playing()} mine={mine()} name={playName(props.who, props.at, props.part.durationMs)} progress={props.send?.state === "sending" ? props.send.progress : null} onToggle={toggle} />
          <div
            ref={waveEl}
            class="vn-wave"
            role={playable() ? "slider" : undefined}
            tabIndex={playable() ? 0 : undefined}
            aria-label={playable() ? scrubName(props.who, props.at) : undefined}
            aria-valuemin={playable() ? 0 : undefined}
            aria-valuemax={playable() ? Math.round(lengthOf(props.part) / 1000) : undefined}
            aria-valuenow={playable() ? Math.round(head() / 1000) : undefined}
            aria-valuetext={playable() ? scrubValue(head(), lengthOf(props.part)) : undefined}
            aria-hidden={playable() ? undefined : "true"}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onCancel}
            onKeyDown={onKey}
          >
            <Bars peaks={peaks()} class="vn-bars" />
            <Show when={playable()}>
              <Bars peaks={peaks()} class="vn-bars vn-played" style={{ "clip-path": `inset(0 ${(1 - played()) * 100}% 0 0)` }} />
            </Show>
          </div>
          <div class="vn-side">
            <span class="vn-dur-line">
              <Show when={showSpeed()}>
                <button type="button" class="vn-speed" aria-label={speedName(player?.speed() ?? 1)} onClick={() => player?.cycleSpeed(nextSpeed(player.speed()))}>
                  {speedFace(player?.speed() ?? 1)}
                </button>
              </Show>
              <span class="vn-dur">{durationText()}</span>
            </span>
            <Show when={!mine()}>
              <span class="vn-who">{gone() === "missing" || gone() === "evicted" ? goneWords(gone() as "missing" | "evicted", props.machine) : `${(props.who as { agent: string }).agent}'s voice`}</span>
            </Show>
          </div>
        </div>
        <Show when={mine()}>
          <time class="vn-time origin">{timeSlot()}</time>
        </Show>
      </div>
      <Show when={props.send?.state === "failed" ? (props.send as { reason: string }).reason : null}>
        {(reason) => (
          <p class="vn-failed">
            <button type="button" class="vn-retry" aria-label={`send your voice note again, ${timeLine(props.at, undefined)}`} onClick={() => props.onRetry?.()}>
              not sent: {reason()}. tap to try again.
            </button>
            <Show when={props.onBackToDraft}>
              <button type="button" class="vn-back" aria-label={`back to draft: your voice note, ${timeLine(props.at, undefined)}`} onClick={() => props.onBackToDraft?.()}>
                back to draft
              </button>
            </Show>
          </p>
        )}
      </Show>
      <Show when={foldText()}>
        {(text) => (
          <>
            <button type="button" class="vn-fold" aria-expanded={open() ? "true" : "false"} aria-label={foldName(props.who, props.at)} onClick={() => setOpen(!open())}>
              <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" /></svg>
              {foldWords(props.who)}
            </button>
            <Show when={open()}>
              <div class="vn-text">{mine() ? <p>{text()}</p> : <Markdown class="say-md" text={text()} />}</div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

/** the play disc: play and pause crossing in the fade curve; a still quarter arc while the bytes are being copied; a dashed
    ring once they are gone. only a playable note's disc is a button */
function Disc(props: { gone: MediaGone; playable: boolean; playing: boolean; mine: boolean; name: string; progress: number | null; onToggle: () => void }) {
  const face = (
    <>
      <svg class="vn-glyph vn-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 6.2v11.6c0 .8.9 1.3 1.6.9l9-5.8c.6-.4.6-1.3 0-1.7l-9-5.8c-.7-.5-1.6 0-1.6.8z" /></svg>
      <svg class="vn-glyph vn-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="6" width="3.6" height="12" rx="1.2" /><rect x="13.4" y="6" width="3.6" height="12" rx="1.2" /></svg>
    </>
  );
  return (
    <Show
      when={props.playable}
      fallback={
        <span class="vn-disc" data-still={props.gone ?? (props.progress !== null ? "sending" : "idle")} aria-hidden="true">
          <Show when={props.gone === "pending"}>
            <svg class="vn-arc" viewBox="0 0 20 20"><path d="M10 2a8 8 0 0 1 8 8" /></svg>
          </Show>
          <Show when={props.gone === null}>{face}</Show>
          <Show when={props.progress}>{(p) => <Ring progress={p()} />}</Show>
        </span>
      }
    >
      <button type="button" class="vn-disc" aria-pressed={props.playing ? "true" : "false"} aria-label={props.name} onClick={() => props.onToggle()}>
        {face}
      </button>
    </Show>
  );
}

/** a 20 px determinate ring: an upload's share sent, in the accent over black 30% */
export function Ring(props: { progress: number }) {
  const C = 2 * Math.PI * 8;
  return (
    <span class="media-ring" aria-hidden="true">
      <svg viewBox="0 0 20 20">
        <circle cx="10" cy="10" r="8" class="media-ring-track" />
        <circle cx="10" cy="10" r="8" class="media-ring-fill" style={{ "stroke-dasharray": `${C}`, "stroke-dashoffset": `${C * (1 - Math.max(0, Math.min(1, props.progress)))}` }} />
      </svg>
    </span>
  );
}

/** the bars: 64 peaks as rounded bars that share the waveform's width, or a flat line of the note's length that says
    nothing false while there are none */
export function Bars(props: { peaks: readonly number[] | null; class: string; style?: JSX.CSSProperties }) {
  const bars = createMemo(() => {
    const p = props.peaks;
    if (!p) return null;
    return Array.from({ length: BARS }, (_, i) => Math.max(10, Math.round(((p[Math.floor((i * p.length) / BARS)] ?? 0) / 255) * 100)));
  });
  return (
    <span class={props.class} style={props.style} data-flat={bars() ? undefined : ""} aria-hidden="true">
      <Show when={bars()}>{(b) => b().map((h) => <i style={{ height: `${h}%` }} />)}</Show>
    </span>
  );
}