/* the layers on home's stage: a thread's stage each, newest last. an agent's thread opens as a layer over its parent's, which
   stays mounted and, while the agent's is on top, takes no input. pure, so it is tested without a browser. */

import type { WindowView } from "../window/view";

export type StageLayer = {
  key: string;
  id: number;
  /** the thread this layer sits over: an agent's thread opened from its parent's */
  over?: string;
};

/** whether a layer is under another: some layer opened after it sits over its thread. layers are told apart by id, since a
    thread can be on the stage twice at once: the parent poured again from under its agent's thread, while the agent's layer that
    sits over the first one is still leaving. by key the new layer, which nothing sits over, would be covered too, and a stage
    that takes no input cannot take the ask a window's pill sent it to */
export function coveredBy(layers: readonly StageLayer[], layer: StageLayer): boolean {
  return layers.some((other) => other.over === layer.key && other.id > layer.id);
}

/** the view a layer draws for an agent the fleet does not hold, opened from its parent: the parent's repo and colour under the
    agent's own key, named by the row that opened it (its session id when the row gave no name), and none of the parent's
    state, since nothing about the agent's is followed (the native app's ThreadAgentStack.introduce) */
export function strayView(parent: WindowView, key: string, name: string | null): WindowView {
  const title = name?.trim() || key.slice(key.indexOf(":") + 1);
  return { ...parent, key, title, state: "idle", chip: null, since: null, tail: [], strip: null, ask: null, need: null, queued: 0, agents: 0, parkedAgents: 0, jobs: 0, diff: null, failure: null, review: null, retry: null };
}
