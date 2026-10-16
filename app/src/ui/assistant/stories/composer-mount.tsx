/* the solid side of the recorder's stories (docs/composer.md, recording): the real recorder, on a stream the page makes
   (an oscillator with a speaking rhythm through a MediaStreamDestination), so MediaRecorder, the analyser, the caps and
   the interruptions all run for real without a microphone. a story drives the key the way a finger or a mouse does. a
   note that is sent lands in the thread above as your voice bubble, playable from its own recorded bytes. */

import { createSignal, For, type JSX, Show } from "solid-js";
import { PlayerContext, createPlayer } from "../voice/player";
import { VoiceNote } from "../voice/note";
import type { Platform, Recording } from "../voice/recorder";
import { VoiceComposer, type VoiceComposerProps } from "../voice/voice-composer";
import { ReasoningChip, ReasoningDial } from "../thinking";
import type { AudioPart } from "../wire";
import { storyElement } from "./fake-audio";
import { MACHINE, NAME, WREN } from "./fixtures";
import { Frame, mount } from "./frame";

/** a stream that sounds like someone talking: a tone whose loudness rises and falls in syllables */
function talkingStream(): MediaStream {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  osc.frequency.value = 180;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 3.2;
  const depth = ctx.createGain();
  depth.gain.value = 0.35;
  lfo.connect(depth).connect(gain.gain);
  const out = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(out);
  osc.start();
  lfo.start();
  void ctx.resume();
  return out.stream;
}

export type FakeMic = { permission: PermissionState; last?: MediaStream };

export function fakePlatform(mic: FakeMic): Platform {
  return {
    getUserMedia: async () => {
      if (mic.permission === "denied") throw new DOMException("denied", "NotAllowedError");
      mic.permission = "granted";
      mic.last = talkingStream();
      return mic.last;
    },
    permission: async () => mic.permission,
    supported: (m) => MediaRecorder.isTypeSupported(m),
    remembered: () => mic.permission === "granted",
    remember: () => undefined,
  };
}

type Drive = (el: HTMLElement, mic: FakeMic) => void;

const key = (el: HTMLElement) => el.querySelector<HTMLElement>(".rec-key");
export const touch = (el: HTMLElement, type: "pointerdown" | "pointermove" | "pointerup", dx = 0, dy = 0) => {
  const k = key(el);
  if (!k) return;
  const box = k.getBoundingClientRect();
  k.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: "touch", isPrimary: true, button: 0, clientX: box.left + 22 + dx, clientY: box.top + 22 - dy }));
};
const click = (el: HTMLElement, label: string) => el.querySelector<HTMLElement>(`[aria-label^="${label}"]`)?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

type Setup = { /** the browser's own microphone and recorder (webPlatform), for the real check */ real?: boolean; permission?: PermissionState; notes?: boolean; noRecorder?: boolean; maxBytes?: number; maxMs?: number; draft?: string; mount?: "bar" | "sheet"; drive?: Drive; readyAfter?: number; dial?: boolean };

function composerStory(setup: Setup) {
  return (el: HTMLElement) =>
    mount(el, () => {
      const mic: FakeMic = { permission: setup.permission ?? "granted" };
      const [speed, setSpeed] = createSignal(1);
      const element = storyElement();
      const player = createPlayer({ speed, setSpeed, ...(element ? { element } : {}) });
      (window as unknown as { __player?: unknown }).__player = player;
      const [listening, setListening] = createSignal(false);
      const [sent, setSent] = createSignal<Array<{ part: AudioPart; src: string; at: number; state: "sending" | "sent" }>>([]);
      const [level, setLevel] = createSignal<string | null>("low");
      const [dial, setDial] = createSignal(setup.dial ?? false);
      const reasoning = WREN.capabilities.reasoning;
      const chips = (): JSX.Element => (
        <Show when={reasoning}>
          {(r) => (
            <Show when={dial()} fallback={<ReasoningChip reasoning={r()} level={level()} open={false} onToggle={() => setDial(true)} />}>
              <ReasoningDial reasoning={r()} level={level()} keyboard={false} onPick={(l) => setLevel(l)} onClose={() => setDial(false)} />
            </Show>
          )}
        </Show>
      );
      const onSendNote = (note: Recording) => {
        const at = Date.now();
        const part: AudioPart = { id: `prt_rec_${at}`, messageID: `msg_rec_${at}`, at: { step: 0, index: 0 }, type: "audio", mime: note.mime, media: { id: null, state: "ready" }, durationMs: note.durationMs, waveform: note.waveform, flavour: "voice" };
        const src = URL.createObjectURL(note.blob);
        (window as unknown as { __recorded?: unknown }).__recorded = { mime: note.mime, bytes: note.blob.size, durationMs: note.durationMs, waveform: note.waveform };
        setSent((s) => [...s, { part, src, at, state: "sending" }]);
        setTimeout(() => setSent((s) => s.map((n) => (n.part.id === part.id ? { ...n, state: "sent" } : n))), 900);
      };
      const props: VoiceComposerProps = {
        agent: NAME,
        notes: setup.notes ?? true,
        kinds: WREN.capabilities.attachments?.kinds ?? [],
        ...(setup.maxBytes !== undefined ? { maxBytes: setup.maxBytes } : {}),
        ...(setup.maxMs !== undefined ? { maxMs: setup.maxMs } : {}),
        ...(setup.real ? {} : { platform: setup.noRecorder ? null : fakePlatform(mic) }),
        ...(setup.draft !== undefined ? { draft: setup.draft } : {}),
        mount: setup.mount ?? "bar",
        chips: chips(),
        onListening: setListening,
        onStart: () => player.stop(),
        onSendNote,
      };
      return (
        <PlayerContext.Provider value={player}>
          <Frame readyAfter={setup.readyAfter ?? 500} drive={(frame) => setTimeout(() => setup.drive?.(frame, mic), 60)}>
            <div class="as-composer-story">
              <header class="as-head">
                <b>water the plants</b>
                <span class="as-live">{listening() ? `${NAME} · listening` : `${NAME} · done 11:40`}</span>
              </header>
              <div class="thread as-log">
                <For each={sent()}>{(n) => <VoiceNote part={n.part} at={n.at} who={{ mine: true }} machine={MACHINE} src={n.src} send={n.state === "sending" ? { state: "sending", progress: 0.6 } : { state: "sent" }} />}</For>
              </div>
              <VoiceComposer {...props} />
            </div>
          </Frame>
        </PlayerContext.Provider>
      );
    });
}

export const micIdle = composerStory({});
export const draftSends = composerStory({ draft: "and move the basil to the window" });
export const noVoiceNotes = composerStory({ notes: false });
export const noRecorder = composerStory({ noRecorder: true });
export const sheet = composerStory({ mount: "sheet" });
export const holding = composerStory({ readyAfter: 1600, drive: (el) => touch(el, "pointerdown") });
export const slidingToCancel = composerStory({ readyAfter: 1600, drive: (el) => { touch(el, "pointerdown"); setTimeout(() => touch(el, "pointermove", -70, 0), 500); } });
export const locking = composerStory({ readyAfter: 1600, drive: (el) => { touch(el, "pointerdown"); setTimeout(() => touch(el, "pointermove", 0, 40), 500); } });
export const locked = composerStory({ readyAfter: 2200, drive: (el) => click(el, `record a voice note for ${NAME}`) });
export const lockedByShortcut = composerStory({ readyAfter: 2200, drive: () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "m", shiftKey: true, metaKey: /mac/i.test(navigator.platform), ctrlKey: !/mac/i.test(navigator.platform), bubbles: true })) });
export const nearTheCap = composerStory({ readyAfter: 3200, maxMs: 62_000, drive: (el) => click(el, `record a voice note for ${NAME}`) });
export const atTheCap = composerStory({ readyAfter: 4200, maxMs: 3_000, drive: (el) => click(el, `record a voice note for ${NAME}`) });
export const interrupted = composerStory({ readyAfter: 2600, drive: (el, mic) => { click(el, `record a voice note for ${NAME}`); setTimeout(() => mic.last?.getAudioTracks()[0]?.dispatchEvent(new Event("ended")), 1500); } });
export const tooShort = composerStory({ readyAfter: 1200, drive: (el) => { touch(el, "pointerdown"); setTimeout(() => touch(el, "pointerup"), 200); } });
export const refused = composerStory({ permission: "denied", readyAfter: 800, drive: (el) => click(el, `record a voice note for ${NAME}`) });
export const sentNote = composerStory({ readyAfter: 4200, drive: (el) => { click(el, `record a voice note for ${NAME}`); setTimeout(() => click(el, "send the voice note"), 2600); } });
export const holdReleasedSends = composerStory({ readyAfter: 3600, drive: (el) => { touch(el, "pointerdown"); setTimeout(() => touch(el, "pointerup"), 2000); } });
export const thinkingDial = composerStory({ dial: true });
/** the browser's own microphone: the real check drives this one with real clicks (not in the screenshot run's states) */
export const realMicrophone = composerStory({ real: true });
