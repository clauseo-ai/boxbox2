/* the composer's voice pieces (docs/composer.md, the mic key and recording; docs/design.md, motion: recording a voice
   note), standalone until contract 2 wires them into the real composer: the round key at the right of the words, which is
   the mic while the draft is empty and send the moment it is not, and the recorder the composer turns into.

   - touch and pen hold: pointer capture on the key, sideways toward the cancel line, up to the lock line (72 px)
   - a mouse click, a keyboard press and a screen reader's tap lock at once (holding a mouse button is not a web idiom)
   - ⌘⇧m (ctrl⇧m off a mac) records locked, return sends while locked, esc cancels
   - a voice note goes alone: words, quote and attachments do not ride it (the reply strip's quote does)

   the words, the chips and the plus key are drawn here with the composer's own classes, so the recorder can be seen in
   place; the real composer keeps its own and takes the key and the recorder from this file. */

import { createMemo, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Icon } from "../../composer/icons";
import { clockOf } from "../words";
import { LiveWave } from "./live-wave";
import { createRecorder, type Platform, type Recording, webPlatform } from "./recorder";
import { dragOf, NEAR_MS, releaseOf } from "./recorder-model";
import "../../composer/composer.css";
import "./recorder.css";

export type VoiceComposerProps = {
  /** the agent's name, as the placeholder and the names say it */
  agent: string;
  /** the agent declares voice notes (`voice.notes`); without it the key is send, as today */
  notes: boolean;
  /** the agent's attachments: what the recording must be, and its maxBytes */
  kinds: readonly string[];
  maxBytes?: number;
  /** the time cap, for a story that shows the cap without waiting fifteen minutes (the recorder's own is the law's) */
  maxMs?: number;
  /** the sheet's composer names its key for the new thread */
  mount?: "bar" | "sheet";
  /** the platform; the browser's by default (a story hands in a stand-in) */
  platform?: Platform | null;
  /** what sits in the top row beside the line when not recording (the model and thinking chips) */
  chips?: JSX.Element;
  /** text for the draft to start with */
  draft?: string;
  /** the header's live line follows: "<name> · listening" while recording on this device */
  onListening?: (listening: boolean) => void;
  /** starting a recording stops any note playing */
  onStart?: () => void;
  onSendNote: (note: Recording) => void;
  onSendText?: (text: string) => void;
};

const IS_MAC = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

export function VoiceComposer(props: VoiceComposerProps) {
  const platform = props.platform === undefined ? webPlatform() : props.platform;
  const rec = createRecorder({ platform, kinds: props.kinds, ...(props.maxBytes !== undefined ? { maxBytes: props.maxBytes } : {}), ...(props.maxMs !== undefined ? { maxMs: props.maxMs } : {}), ...(props.onStart ? { onStart: props.onStart } : {}) });
  /** the mic is offered only with voice notes declared, a recorder in the browser, and a kind the agent takes */
  const offered = () => props.notes && rec.kind !== null;
  const [text, setText] = createSignal(props.draft ?? "");
  const [note, setNote] = createSignal<string | null>(null);
  const [drag, setDrag] = createSignal({ slide: 0, lock: 0, dx: 0 });
  const recording = () => rec.state() === "holding" || rec.state() === "locked" || rec.state() === "starting";
  const empty = () => text().trim().length === 0;
  const mic = () => offered() && empty();

  createMemo(() => props.onListening?.(rec.state() === "holding" || rec.state() === "locked"));

  let noteTimer: ReturnType<typeof setTimeout> | undefined;
  const say = (words: string | null, forMs?: number) => {
    clearTimeout(noteTimer);
    setNote(words);
    if (words && forMs) noteTimer = setTimeout(() => setNote(null), forMs);
  };
  const refusedWords = () =>
    /safari/i.test(navigator.userAgent) && !/chrome|crios|android/i.test(navigator.userAgent)
      ? "allow the microphone for this site in safari's settings, then try again."
      : "boxbox cannot use the microphone. turn it on in settings, then try again.";

  async function begin(mode: "holding" | "locked") {
    say(null);
    const ok = await rec.start(mode);
    if (!ok && rec.refused()) say(refusedWords());
  }

  async function send() {
    const out = await rec.finish();
    setDrag({ slide: 0, lock: 0, dx: 0 });
    if (out) props.onSendNote(out);
  }

  async function cancel() {
    await rec.cancel();
    setDrag({ slide: 0, lock: 0, dx: 0 });
  }

  /* —— the key's gestures —— */
  let windowEl!: HTMLDivElement;
  let origin: { x: number; y: number; t: number } | null = null;
  /** a touch's pointerup is followed by a click: that click is the hold's, not a press of its own */
  let swallowClick = false;

  const onDown = (e: PointerEvent) => {
    if (!mic() || rec.state() !== "idle" || e.pointerType === "mouse" || e.button !== 0) return;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // a pointer the page cannot capture (one a script made) still records; it just is not followed off the key
    }
    origin = { x: e.clientX, y: e.clientY, t: performance.now() };
    swallowClick = true;
    void begin("holding");
  };
  const onMove = (e: PointerEvent) => {
    if (!origin || rec.state() === "locked") return;
    const dx = e.clientX - origin.x;
    const dy = origin.y - e.clientY;
    const d = dragOf(dx, dy, windowEl.clientWidth);
    setDrag({ ...d, dx: Math.min(0, d.slide > 0 ? dx : 0) });
  };
  const onUp = (e: PointerEvent) => {
    if (!origin) return;
    const dx = e.clientX - origin.x;
    const dy = origin.y - e.clientY;
    const held = performance.now() - origin.t;
    origin = null;
    if (rec.state() === "locked") return setDrag({ slide: 0, lock: 0, dx: 0 });
    const what = releaseOf(dx, dy, held, windowEl.clientWidth);
    if (what === "cancel") void cancel();
    else if (what === "lock") {
      rec.lock();
      setDrag({ slide: 0, lock: 0, dx: 0 });
    } else if (what === "too-short") {
      void cancel();
      say("hold to record, or tap the lock to record hands free.", 4000);
    } else void send();
  };
  const onClick = (e: MouseEvent) => {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    if (rec.state() === "locked") return void send();
    if (!empty()) {
      props.onSendText?.(text());
      setText("");
      return;
    }
    // a mouse click, return on the key, or a screen reader's tap: locked at once
    if (mic() && rec.state() === "idle") void begin("locked");
    void e;
  };

  /* —— the keyboard —— */
  const onKey = (e: KeyboardEvent) => {
    const chord = (IS_MAC ? e.metaKey : e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "m";
    if (chord && mic() && rec.state() === "idle") {
      e.preventDefault();
      void begin("locked");
      return;
    }
    if (e.key === "Escape" && recording()) {
      e.preventDefault();
      void cancel();
      return;
    }
    if (e.key === "Enter" && rec.state() === "locked" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
    clearTimeout(noteTimer);
    void rec.cancel();
  });

  const stoppedWords = () =>
    rec.stopped() === "cap" ? "this is as long as a voice note can be. send it, or cancel it." : rec.stopped() === "interrupted" ? "recording stopped when another app took the microphone." : null;
  const keyName = () => {
    if (recording()) return "send the voice note";
    if (mic()) return props.mount === "sheet" ? "record a voice note for the new thread" : `record a voice note for ${props.agent}`;
    return props.mount === "sheet" ? "start the thread" : "send";
  };

  return (
    <div class="composer cz-voice" data-mount={props.mount ?? "bar"}>
      <div class="cz-window" ref={windowEl} data-rec={recording() ? rec.state() : undefined}>
        <div class="cz-top">
          <Show
            when={recording()}
            fallback={
              <>
                <div class="cz-line" aria-live="polite">
                  <Show when={note()}>{(n) => <span class="cz-t" data-prose>{n()}</span>}</Show>
                </div>
                {props.chips}
              </>
            }
          >
            <div class="rec-top">
              <span class="rec-dot" data-on={rec.stopped() ? undefined : ""} aria-hidden="true" />
              <span class="rec-timer" role="timer" aria-label="recording time" aria-live="off">
                {clockOf(Math.floor(rec.elapsed() / 1000) * 1000)}
              </span>
              <Show when={!rec.stopped() && rec.left() <= NEAR_MS}>
                <span class="rec-left">1 min left</span>
              </Show>
              <LiveWave ring={rec.ring} bars={rec.bars} />
            </div>
          </Show>
        </div>
        <Show when={recording() && stoppedWords()}>{(w) => <p class="rec-note" role="status">{w()}</p>}</Show>
        <div class="cz-body">
          <button class="cz-key plus" type="button" aria-label="add to the message" disabled={recording()} data-dim={recording() ? "" : undefined} onPointerDown={(e) => e.preventDefault()}>
            <Icon name="plus" />
          </button>
          <Show
            when={recording()}
            fallback={
              <textarea
                rows={1}
                value={text()}
                aria-label={props.mount === "sheet" ? "message for the new thread" : `message ${props.agent}`}
                placeholder={`message ${props.agent}`}
                onInput={(e) => setText(e.currentTarget.value)}
              />
            }
          >
            <div class="rec-mid">
              <Show
                when={rec.state() === "locked"}
                fallback={
                  <span class="rec-slide" style={{ transform: `translateX(${drag().dx}px)`, opacity: String(1 - drag().slide * 0.85) }}>
                    <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M7.5 2.5 4 6l3.5 3.5" /></svg>
                    slide to cancel
                  </span>
                }
              >
                <button type="button" class="rec-cancel" aria-label="cancel the voice note" onClick={() => void cancel()}>
                  cancel
                </button>
              </Show>
            </div>
          </Show>
          <div class="rec-keybox">
            <Show when={rec.state() === "holding" || rec.state() === "starting"}>
              <button type="button" class="rec-lock" aria-label="lock the recording" style={{ "--fill": String(drag().lock) }} onClick={() => rec.lock()}>
                <span class="rec-lock-track" aria-hidden="true" />
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 11V8.5a4.5 4.5 0 0 1 9 0V11M6.5 11h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z" /></svg>
              </button>
            </Show>
            <button
              type="button"
              class="rec-key"
              data-face={rec.state() === "holding" || rec.state() === "starting" ? "hot" : rec.state() === "locked" || !mic() ? "send" : "mic"}
              aria-label={keyName()}
              disabled={!mic() && !recording() && empty()}
              style={{ transform: `translateX(${drag().dx}px)` }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={() => {
                origin = null;
                if (rec.state() === "holding") void cancel();
              }}
              onClick={onClick}
              onContextMenu={(e) => e.preventDefault()}
            >
              <span class="rec-face" aria-hidden="true">
                <svg class="rec-g rec-g-mic" viewBox="0 0 24 24"><path d="M12 3.5a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0v-5a3 3 0 0 0-3-3zM6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3.5" /></svg>
                <svg class="rec-g rec-g-send" viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
