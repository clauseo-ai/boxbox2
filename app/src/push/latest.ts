/* one call in flight, the latest request wins: a burst of reports (a loop that moves the open thread a hundred times in a
   second) goes out as the first and the last, never as a hundred posts. what a later call carries is the truth, so the
   ones between are not worth sending (the same reasoning as a presence report that is not retried). */

/** wraps an async sender: while one call is pending, newer values replace each other, and the newest goes when it ends */
export function latestWins<T>(run: (value: T) => Promise<unknown>): (value: T) => void {
  let flying = false;
  let waiting: { value: T } | null = null;
  const go = (value: T): void => {
    flying = true;
    void run(value)
      .catch(() => undefined)
      .finally(() => {
        flying = false;
        const next = waiting;
        waiting = null;
        if (next) go(next.value);
      });
  };
  return (value) => {
    if (flying) waiting = { value };
    else go(value);
  };
}
