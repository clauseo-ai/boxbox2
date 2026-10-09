/* the layers on home's stage: a thread's stage each, newest last. an agent's thread opens as a layer over its parent's, which
   stays mounted and, while the agent's is on top, takes no input. pure, so it is tested without a browser. */

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
