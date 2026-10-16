/* the one player for the app (docs/thread.md, voice notes, playback): one <audio> element, owned by the shell and handed
   to the rows through a context, so a note keeps playing when its row leaves the window's mounted turns or the stage goes
   back to home. the rows read its state and ask it to play, pause, seek and change speed; nothing in a row owns sound.

   - play on: when a note ends and the thread says the next row is a voice note (`next`), it plays after 300 ms, and so on.
     a pause, a seek by hand to another note, or starting another note ends the run.
   - speed is this device's: 1x, 1.5x, 2x, held for every note after it (`speed` and `setSpeed` are the device prefs').
   - the media session gets "<name>'s voice note", the thread's title and the palette's round mark as artwork, with
     play, pause, seek and next track (the next track is play on by hand).
   - the playhead is read once per animation frame while a note plays and never between notes (design.md, motion). */

import { createContext, createSignal, useContext } from "solid-js";

/** a note the player can play: its id (the part's), where its bytes are, and what the media session says about it */
export type Note = {
  id: string;
  src: string;
  durationMs: number;
  /** "<name>'s voice note" or "your voice note" */
  title: string;
  /** the thread's title */
  album: string;
  /** a data url of the palette's round mark, or none */
  artwork?: string;
};

export type PlayerDeps = {
  /** the speed this device chose; 1 when it never chose */
  speed: () => number;
  setSpeed: (rate: number) => void;
  /** the note after this one in its thread when that row is a voice note (with nothing between but a fold, a reaction
      or a turn's end), else null: the thread answers, since only it knows its rows */
  next?: (id: string) => Note | null;
  /** an element to play through; a fresh one by default (a test hands in its own) */
  element?: HTMLAudioElement;
  /** the play-on pause, ms */
  gap?: number;
};

export type Player = ReturnType<typeof createPlayer>;

export function createPlayer(deps: PlayerDeps) {
  const audio = deps.element ?? new Audio();
  audio.preload = "metadata";
  const [current, setCurrent] = createSignal<Note | null>(null);
  const [playing, setPlaying] = createSignal(false);
  const [position, setPosition] = createSignal(0);
  /** the note the speed pill shows on: the one playing, and after it ends until another starts */
  const [lastPlayed, setLastPlayed] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal<string | null>(null);
  let frame = 0;
  let playOn: ReturnType<typeof setTimeout> | undefined;

  const tick = () => {
    setPosition(audio.currentTime * 1000);
    frame = playing() ? requestAnimationFrame(tick) : 0;
  };
  const startTicking = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const stopTicking = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    setPosition(audio.currentTime * 1000);
  };

  audio.addEventListener("playing", () => {
    setPlaying(true);
    startTicking();
  });
  audio.addEventListener("pause", () => {
    setPlaying(false);
    stopTicking();
  });
  audio.addEventListener("error", () => {
    const note = current();
    if (note) setFailed(note.id);
    setPlaying(false);
    stopTicking();
  });
  audio.addEventListener("ended", () => {
    setPlaying(false);
    stopTicking();
    const note = current();
    setPosition(note?.durationMs ?? 0);
    const after = note && deps.next?.(note.id);
    if (after) playOn = setTimeout(() => void play(after), deps.gap ?? 300);
  });

  function load(note: Note, at: number) {
    clearTimeout(playOn);
    if (current()?.id !== note.id) {
      audio.src = note.src;
      setCurrent(note);
      setFailed(null);
      session(note);
    }
    audio.playbackRate = deps.speed();
    if (Math.abs(audio.currentTime * 1000 - at) > 40) audio.currentTime = at / 1000;
    setPosition(at);
  }

  /** plays a note from where it stands (or from `at`, ms): any other note stops */
  async function play(note: Note, at?: number) {
    const resume = current()?.id === note.id && !audio.ended ? audio.currentTime * 1000 : 0;
    load(note, at ?? resume);
    setLastPlayed(note.id);
    try {
      await audio.play();
    } catch (error) {
      // a play the browser refused (no gesture yet, or the bytes would not load) leaves the note paused; the row says why
      if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(note.id);
    }
  }

  /** a pause by hand: ends a play-on run too */
  function pause() {
    clearTimeout(playOn);
    audio.pause();
  }

  /** moves a note's playhead without sound: a tap or a drag on a note that is not playing makes it the current one */
  function seek(note: Note, at: number) {
    load(note, Math.max(0, Math.min(at, note.durationMs)));
  }

  /** stops whatever plays, for a recording that is starting (composer.md: starting a recording stops any note playing) */
  function stop() {
    pause();
  }

  function cycleSpeed(rate: number) {
    deps.setSpeed(rate);
    audio.playbackRate = rate;
  }

  /** where a note's playhead is: the live one for the current note, else 0 */
  const positionOf = (id: string) => (current()?.id === id ? position() : 0);
  const isPlaying = (id: string) => playing() && current()?.id === id;

  function session(note: Note) {
    const media = typeof navigator === "undefined" ? undefined : navigator.mediaSession;
    if (!media || typeof MediaMetadata === "undefined") return;
    media.metadata = new MediaMetadata({ title: note.title, album: note.album, artwork: note.artwork ? [{ src: note.artwork, sizes: "96x96", type: "image/png" }] : [] });
    media.setActionHandler("play", () => void play(note));
    media.setActionHandler("pause", pause);
    media.setActionHandler("seekto", (d) => d.seekTime !== undefined && seek(note, d.seekTime * 1000));
    media.setActionHandler("nexttrack", () => {
      const after = deps.next?.(note.id);
      if (after) void play(after);
    });
  }

  return { current, playing, position, lastPlayed, failed, play, pause, seek, stop, cycleSpeed, positionOf, isPlaying, speed: deps.speed, element: audio };
}

/** the player a shell provides to its rows; a row with none (a story that does not play) draws its note and plays nothing */
export const PlayerContext = createContext<Player | null>(null);
export const usePlayer = () => useContext(PlayerContext);
