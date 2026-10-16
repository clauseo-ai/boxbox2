/* a stand-in for the player's <audio> in the screenshot test: a headless browser refuses play() without a gesture, even
   muted, so a story that shows a note playing runs the real player against this clock instead. it keeps time the way a
   media element does (currentTime, playbackRate, the playing, pause and ended events). open a story with `&aloud` in
   its url to play through a real element; the browser check does that with real clicks. */

import { TONES } from "./fixtures";

export class FakeAudio extends EventTarget {
  src = "";
  preload = "";
  muted = true;
  #rate = 1;
  get playbackRate(): number {
    return this.#rate;
  }
  set playbackRate(rate: number) {
    this.#at = this.currentTime;
    this.#since = performance.now();
    this.#rate = rate;
    if (!this.paused) this.#arm();
  }
  get duration(): number {
    return (TONES.get(this.src) ?? 0) / 1000;
  }
  paused = true;
  ended = false;
  error = null;
  #at = 0;
  #since = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  get currentTime(): number {
    return this.paused ? this.#at : Math.min(this.duration, this.#at + ((performance.now() - this.#since) / 1000) * this.playbackRate);
  }
  set currentTime(t: number) {
    this.#at = t;
    this.#since = performance.now();
    if (!this.paused) this.#arm();
  }
  play(): Promise<void> {
    if (this.ended) this.#at = 0;
    this.ended = false;
    this.paused = false;
    this.#since = performance.now();
    this.#arm();
    queueMicrotask(() => this.dispatchEvent(new Event("playing")));
    return Promise.resolve();
  }
  pause(): void {
    if (this.paused) return;
    this.#at = this.currentTime;
    this.paused = true;
    clearTimeout(this.#timer);
    this.dispatchEvent(new Event("pause"));
  }
  #arm() {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#at = this.duration;
      this.paused = true;
      this.ended = true;
      this.dispatchEvent(new Event("pause"));
      this.dispatchEvent(new Event("ended"));
    }, ((this.duration - this.#at) * 1000) / this.playbackRate);
  }
}

/** the element a story's player plays through: a real one with `&aloud` in the url, else the clock */
export function storyElement(): HTMLAudioElement | undefined {
  if (new URLSearchParams(location.search).has("aloud")) return undefined;
  return new FakeAudio() as unknown as HTMLAudioElement;
}
