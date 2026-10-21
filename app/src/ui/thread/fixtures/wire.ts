/* the thread's tests write their messages in cmx2's shapes, as the recorded fixtures are; these hand them to the model as
   the server's translate makes them neutral (sync/fixtures/neutral.ts), never rewritten by hand */

import type { Message } from "../../../sync/protocol";
import { neutralMessage } from "../../../sync/fixtures/neutral";

/** a message in cmx2's shapes, neutral */
export const neutral = (m: { info: unknown; parts: readonly unknown[] }): Message => neutralMessage(m as { info: Record<string, unknown>; parts: Record<string, unknown>[] });
