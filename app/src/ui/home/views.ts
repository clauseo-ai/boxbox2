/* each window's view, kept per window (docs/home.md, the windows). the
   view was made for every window whenever any thread sent a frame or any
   ask came or went, and every slot reconciled its own again; now a
   window's view is a memo of its own, made again only when its thread,
   its own asks or the colours change, and the slot reconciles only then. */

import { type Accessor, createMemo, mapArray } from "solid-js";
import type { Ask } from "../../sync/protocol";
import type { WindowView } from "../window/view";

const NO_ASKS: readonly Ask[] = [];
const sameAsks = (a: readonly Ask[], b: readonly Ask[]): boolean => a.length === b.length && a.every((ask, i) => ask === b[i]);

/** a key's view: from its memo while the key is in `order`, made on the spot otherwise (a stray agent's parent, a capsule) */
export function createViews(
  order: Accessor<readonly string[]>,
  asksBy: Accessor<Readonly<Record<string, readonly Ask[]>>>,
  view: (key: string, asks: readonly Ask[]) => WindowView | null,
): (key: string) => WindowView | null {
  const memos = createMemo(
    mapArray(order, (key) => {
      const asks = createMemo(() => asksBy()[key] ?? NO_ASKS, NO_ASKS, { equals: sameAsks });
      return createMemo(() => view(key, asks()));
    }),
  );
  const index = createMemo(() => {
    const list = memos();
    return new Map(order().map((key, i) => [key, list[i]] as const));
  });
  return (key) => {
    const memo = index().get(key);
    return memo ? memo() : view(key, asksBy()[key] ?? NO_ASKS);
  };
}
