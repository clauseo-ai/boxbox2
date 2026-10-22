/* a btw as the ui reads it (docs/thread.md, btw): a side question about a thread, answered by the agent's model from
   the session's context with no tools, and never put into the agent's context. the record is the neutral wire's
   `AgentBtw` (sync/protocol.ts), the verbs the worker's (sync/client.ts askBtw, dismissBtw, promoteBtw); the ui never
   fetches. the verbs come in through `BtwContext`, which the stage fills from the client and a story fills with fakes. */

import { createContext } from "solid-js";
import type { Btw } from "../../sync/protocol";
import type { BtwDone } from "../../sync/client";

export type { Btw } from "../../sync/protocol";
export type { BtwDone } from "../../sync/client";

/** the btw verbs, by thread key (`agent:thread`) */
export type BtwActions = {
  /** `clientID` names the ask: the composer carries the same one when it asks the same draft again after a failure, so the
      server answers a retry of an ask that did land with that btw rather than asking twice */
  ask: (key: string, question: string, clientID?: string) => Promise<BtwDone>;
  dismiss: (key: string, btwID: string) => Promise<BtwDone>;
  promote: (key: string, btwID: string) => Promise<BtwDone>;
};

/** what a turn and the composer read of a thread's btws: the verbs, the thread they act on, the cards a turn holds, the
    name each card's controls are told apart by, and where a promoted message's card is */
export type BtwThread = {
  key: () => string;
  actions: BtwActions;
  /** the btws a turn shows, in created order (place.ts) */
  of: (turnID: string) => readonly Btw[];
  /** the turn a btw is drawn in, for the marker that goes to it */
  turnOf: (btwID: string) => string | undefined;
  /** a btw's question as its controls name it, bounded and told apart from a namesake ("again") */
  nameOf: (btwID: string) => string;
};

export const BtwContext = createContext<BtwThread>();

/** the verbs alone, for the composer: a story or a stage with no thread data still gives it the ask */
export const BtwActionsContext = createContext<BtwActions>();
