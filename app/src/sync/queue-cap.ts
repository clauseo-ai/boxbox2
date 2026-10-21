/* the one cap on unsent telemetry rows, shared by the worker's emitter (telemetry.ts) and the page (client.ts, `unsent`)
   so the two cannot drift. a module of its own: client.ts is in the first load and telemetry.ts loads lazily (perf.ts),
   and a static import of telemetry.ts from client.ts would pull it into the first load */

/** the server takes at most 500 per batch; a queue past this drops its oldest. the page holds no more of its own
    rows than this either (client.ts, `unsent`) */
export const QUEUE_CAP = 500;
