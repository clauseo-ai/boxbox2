/* the wait a stage keeps for the ask a focus names (stage.tsx, goToAsk; store.ts, FOCUS_FOR_MS). pure but for its one timer, so
   it is tested without a browser: the stage starts it once it has its thread and the ask's row is not there, and when the
   wait is over it hands the focus back to be let go. */

export type Lapse<T extends object> = {
  /** starts the wait for `held`, once: a call for the one already waited on changes nothing (a frame that looks again must not
      push the end away), a call for another starts over */
  start(held: T): void;
  /** the wait is over without a verdict: the stage found the ask, or is gone */
  stop(): void;
};

export function createLapse<T extends object>(ms: number, release: (held: T) => void): Lapse<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting: T | null = null;
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
    waiting = null;
  };
  return {
    start(held) {
      if (waiting === held) return;
      stop();
      waiting = held;
      timer = setTimeout(() => {
        stop();
        release(held);
      }, ms);
    },
    stop,
  };
}
