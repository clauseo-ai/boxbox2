/* what a disposed stage's dom may keep of it (docs/open.md, the leak
   investigation). solid disposes a view's computations but leaves its dom as
   it was: each element keeps its delegated handlers (`$$click` and the like,
   expandos on the node) and the listeners `addEventListener` gave it, and
   every one of those closes over the component that made it, which holds the
   thread's data, its turns and every computation under it. while anything
   holds one node of the detached tree (safari reader's article finder caches
   hundreds of the page's elements in a world of its own, a web inspector
   console, a stray reference), the engine keeps the whole tree, and through
   it the whole stage, alive: a home-screen app that opened its thread a few
   times held a stage for each. `listen` is a listener taken off when its
   owner is disposed; `releaseDom` takes a disposed view's tree apart and
   drops the delegated handlers, so a node something still holds is a bare
   element that keeps nothing else alive. */

import { onCleanup } from "solid-js";

/** `el.addEventListener(type, handler)` until the current owner is disposed */
export function listen<K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K, handler: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions): void;
export function listen(el: EventTarget, type: string, handler: (event: Event) => void, options?: AddEventListenerOptions): void;
export function listen(el: EventTarget, type: string, handler: (event: Event) => void, options?: AddEventListenerOptions): void {
  el.addEventListener(type, handler, options);
  onCleanup(() => el.removeEventListener(type, handler, options));
}

/** the parts of a node `releaseDom` reads: a dom node, or a test's stand-in for one */
export type Releasable = { firstChild: Releasable | null; removeChild(child: Releasable): unknown; nextSibling: Releasable | null };

/** takes a detached tree apart, every node from its parent, and deletes the delegated handlers solid left on its nodes
    (`$$<event>` and `$$<event>Data`), so a node something still holds keeps neither the rest of the tree nor the view */
export function releaseDom(root: Releasable): void {
  const nodes: Releasable[] = [];
  const stack: Releasable[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Releasable; // the loop runs while the stack has one
    nodes.push(node);
    for (let child = node.firstChild; child; child = child.nextSibling) stack.push(child);
  }
  for (const node of nodes) {
    for (const key of Object.keys(node)) if (key.startsWith("$$")) delete (node as unknown as Record<string, unknown>)[key];
    for (let child = node.firstChild; child; child = node.firstChild) node.removeChild(child);
  }
}

/** on the owner's disposal: once `root` has left the document (solid takes a disposed view's nodes out in the same update), its
    tree is taken apart (`releaseDom`). a root still in the document is someone else's to keep, and is left whole */
export function releaseOnCleanup(root: () => (Node & Releasable) | undefined): void {
  onCleanup(() => {
    const el = root();
    if (el) queueMicrotask(() => { if (!el.isConnected) releaseDom(el); });
  });
}
