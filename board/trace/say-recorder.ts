/* the readback recorder `say_command` points at in a traced run: appends
   one json line, the time and the words it was asked to say, to the log
   named first, and exits 0 without a sound. radio.ts tails the log.

     say-recorder.ts <log> [say's own arguments...] */

import { appendFileSync } from "node:fs";

const [log, ...argv] = process.argv.slice(2);
if (log === undefined) {
  console.error("usage: say-recorder.ts <log> [args...]");
  process.exit(2);
}
appendFileSync(log, `${JSON.stringify({ t: Date.now(), argv })}\n`);
