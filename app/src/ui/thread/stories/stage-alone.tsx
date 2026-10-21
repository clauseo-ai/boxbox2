/* the solid side of a story that shows the stage alone, outside home: the thread's own surface over a store filled by hand.
   home draws a stage only for a thread whose window it has, so a thread the fleet does not hold (older than its host's
   newest 300, an agent's thread opened by its key) is shown here, on the stage the way a link to it would put it. */

import { render } from "solid-js/web";
import { bootSync } from "../../../store";
import type { Fleet, ThreadView } from "../../../sync/reducer";
import journal from "../../home/fixtures/journal-p3.ndjson?raw";
import { endOf, keyOf, parseJournal, replay, TITLES } from "../../home/fixtures/replay";
import { Stage } from "../stage";
import { notesTranscript } from "./transcript";

const recorded = parseJournal(journal);
const final = replay(recorded);
const AT = endOf(recorded);

export type AloneOptions = {
  /** the fleet holds the thread's session (false: a thread it does not follow) */
  followed: boolean;
  /** opened over another thread, as an agent's: the stage names that one as its parent (here, another thread the fleet holds) */
  agent?: boolean;
  /** changes to the fleet and the thread before the stage mounts */
  shape?: (fleet: Fleet, thread: ThreadView, key: string) => { fleet: Fleet; thread: ThreadView };
};

export function mountStageAlone(el: HTMLElement, options: AloneOptions): () => void {
  let dispose: (() => void) | undefined;
  let gone = false;
  void (async () => {
    const key = keyOf(final.state, TITLES.wants);
    const base = await notesTranscript(key);
    const { [key]: _own, ...others } = final.state.fleet.threads;
    const fleet0: Fleet = options.followed ? final.state.fleet : { ...final.state.fleet, threads: others, order: final.state.fleet.order.filter((k) => k !== key) };
    const { fleet, thread } = options.shape ? options.shape(fleet0, base, key) : { fleet: fleet0, thread: base };
    bootSync({ fleet, threads: { [key]: thread }, drafts: {}, outbox: [], stream: { state: "live", since: Date.now() - 60_000, lastEventAt: AT } });
    if (gone) return;
    const parent = options.agent ? Object.keys(fleet.threads).find((k) => k !== key) : undefined;
    dispose = render(() => (
      <div style={{ position: "fixed", inset: "0" }}>
        <Stage threadKey={key} deck {...(parent ? { parent } : {})} />
      </div>
    ), el);
    // the stage lands at the end in its next frames
    requestAnimationFrame(() => requestAnimationFrame(() => { if (!gone) el.dataset["ready"] = "1"; }));
  })();
  return () => { gone = true; dispose?.(); };
}
