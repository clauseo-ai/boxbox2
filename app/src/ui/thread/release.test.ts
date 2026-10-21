/* a disposed stage keeps nothing alive through a node something still holds (release.ts): a tree of stand-in nodes whose
   handlers close over a large scope, as a stage's do, is disposed while one of its nodes is held, the way safari reader
   holds a stage's scroller. without the release the scope lives on; with it, it is collected. the listener half needs solid's
   browser build (`bun test --conditions browser`, the justfile's check); the plain pass runs the rest. */

import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { listen, releaseDom, releaseOnCleanup } from "./release";

/** the parts of a dom node the release and the listeners touch */
class Node_ {
  firstChild: Node_ | null = null;
  nextSibling: Node_ | null = null;
  parentNode: Node_ | null = null;
  isConnected = false;
  readonly listeners = new Map<string, Set<(event: Event) => void>>();
  [expando: `$$${string}`]: unknown;
  append(child: Node_): Node_ {
    child.parentNode = this;
    if (!this.firstChild) this.firstChild = child;
    else {
      let last = this.firstChild;
      while (last.nextSibling) last = last.nextSibling;
      last.nextSibling = child;
    }
    return child;
  }
  removeChild(child: Node_): Node_ {
    if (this.firstChild === child) this.firstChild = child.nextSibling;
    else for (let n = this.firstChild; n; n = n.nextSibling) if (n.nextSibling === child) { n.nextSibling = child.nextSibling; break; }
    child.parentNode = null;
    child.nextSibling = null;
    return child;
  }
  addEventListener(type: string, fn: (event: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (event: Event) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
}

const reactive = (() => {
  try {
    let ran = false;
    const dispose = createRoot((d) => { listen(new Node_() as unknown as EventTarget, "x", () => undefined); return d; });
    ran = true;
    dispose();
    return ran;
  } catch { return false; }
})();

/** a stage's shape: a root, its scroller with listeners, rows under it with delegated handlers, every handler closing over `scope`.
    returns the held scroller and a weak reference to the scope; nothing else keeps the scope */
function mountStage(held: Node_[], how: { listen: boolean; release: "none" | "now" | "cleanup" }): { scope: WeakRef<object>; root: Node_; dispose: () => void } {
  const scope = { turns: new Array(10_000).fill("a turn"), name: "the stage's data" };
  const root = new Node_();
  const scroller = root.append(new Node_());
  for (let i = 0; i < 20; i++) {
    const row = scroller.append(new Node_());
    row.$$click = () => scope.name;
    row.append(new Node_()).$$pointerdown = () => scope.turns.length;
  }
  const dispose = createRoot((d) => {
    if (how.listen) {
      listen(scroller as unknown as EventTarget, "scroll", () => void scope.turns.length);
      listen(scroller as unknown as EventTarget, "wheel", () => void scope.name);
    }
    if (how.release === "cleanup") releaseOnCleanup(() => root as unknown as Node & Parameters<typeof releaseDom>[0]);
    return d;
  });
  held.push(scroller);
  return { scope: new WeakRef(scope), root, dispose };
}

async function collected(refs: WeakRef<object>[]): Promise<number> {
  await new Promise((r) => setTimeout(r, 0));
  Bun.gc(true);
  await new Promise((r) => setTimeout(r, 0));
  Bun.gc(true);
  return refs.filter((r) => r.deref() === undefined).length;
}

describe("a disposed stage's dom", () => {
  test("without the release, a held node keeps every stage it belonged to", async () => {
    const held: Node_[] = [];
    const refs: WeakRef<object>[] = [];
    for (let i = 0; i < 8; i++) {
      const { scope, dispose } = mountStage(held, { listen: false, release: "none" });
      dispose();
      refs.push(scope);
    }
    expect(await collected(refs)).toBe(0);
    expect(held.length).toBe(8);
  });

  test("taken apart, a held node keeps nothing of the stage", async () => {
    const held: Node_[] = [];
    const refs: WeakRef<object>[] = [];
    for (let i = 0; i < 8; i++) {
      const { scope, root, dispose } = mountStage(held, { listen: false, release: "now" });
      dispose();
      releaseDom(root);
      refs.push(scope);
    }
    expect(await collected(refs)).toBe(8);
    for (const node of held) {
      expect(node.firstChild).toBeNull();
      expect(node.parentNode).toBeNull();
    }
  });

  test.skipIf(!reactive)("its listeners come off with the stage, and its tree is taken apart once it left the document", async () => {
    const held: Node_[] = [];
    const refs: WeakRef<object>[] = [];
    const kept: WeakRef<object>[] = [];
    for (let i = 0; i < 8; i++) {
      const { scope, dispose } = mountStage(held, { listen: true, release: "cleanup" });
      dispose();
      refs.push(scope);
    }
    // a stage still in the document when it is disposed is left whole
    const connected = mountStage([], { listen: true, release: "cleanup" });
    connected.root.isConnected = true;
    connected.dispose();
    kept.push(connected.scope);
    await Promise.resolve();
    for (const node of held) for (const set of node.listeners.values()) expect(set.size).toBe(0);
    expect(await collected(refs)).toBe(8);
    expect(connected.root.firstChild).not.toBeNull();
    expect(kept[0]?.deref()).toBeDefined();
  });
});
