/* structured logging worthy of the singer bar: one line per event,
   ts + level + event + kv json. launchd captures stdout; nothing here
   ever throws. */

export type Logger = {
  info: (event: string, kv: Record<string, unknown>) => void;
  warn: (event: string, kv: Record<string, unknown>) => void;
  error: (event: string, kv: Record<string, unknown>) => void;
};

export function createLogger(): Logger {
  function line(level: string, event: string, kv: Record<string, unknown>) {
    try {
      const stamp = new Date().toISOString();
      console.log(`${stamp} ${level} ${event} ${JSON.stringify(kv)}`);
    } catch {
      /* logging must never take the daemon down */
    }
  }
  return {
    info: (e, kv) => line("info", e, kv),
    warn: (e, kv) => line("warn", e, kv),
    error: (e, kv) => line("error", e, kv),
  };
}
