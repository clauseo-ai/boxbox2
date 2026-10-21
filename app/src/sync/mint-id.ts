/* a telemetry row's id, alone in its module: the ui thread mints ids for the events it hands the worker (client.ts),
   and importing it from telemetry.ts would carry the emitter into the first load (ui/home/perf.ts loads it later) */

/** v1's id shape: the stamp in base 36, a dash, eight random base-36 digits */
export function mintId(at: number): string {
  const random = crypto.getRandomValues(new Uint32Array(2));
  const tail = ((random[0] ?? 0) * 0x100000000 + (random[1] ?? 0)).toString(36).padStart(8, "0").slice(-8);
  return `${at.toString(36)}-${tail}`;
}
