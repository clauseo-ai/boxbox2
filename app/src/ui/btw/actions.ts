/* the btw verbs as the stage hands them to the cards and the composer: the worker's (sync/client.ts), which fold what
   the server answers into the store before the promise settles, so a card shows before the stream's echo. */

import { askBtw, dismissBtw, promoteBtw } from "../../sync/client";
import type { BtwActions } from "./types";

export const btwActions: BtwActions = { ask: askBtw, dismiss: dismissBtw, promote: promoteBtw };

/** an agent answers btws: its capabilities say so (`Capabilities.btw`, false or absent for a source without them) */
export function answersBtw(capabilities: { btw?: boolean | null } | undefined): boolean {
  return capabilities?.btw === true;
}
