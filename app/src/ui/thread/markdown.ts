/* the agent's markdown on screen (docs/thread.md, code and copying). four surfaces read it (the answer, what a row said, a
   report, a compaction's summary) and one painter paints them all: it parses into a detached template, dresses each
   fenced block as a code block (a header with the language and a copy control, and highlighted code), and replaces only
   the top-level blocks whose html changed, so a settled block keeps its node, its focus, its hover and its "copied" for
   as long as the reply streams on beneath it. a reply being written is made in units (markdown-stream.ts) and a frame
   parses, sanitises and compares only the units that changed, the one being written, not the whole reply. the sanitiser is the same one, set before anything of ours is added: the
   controls are made by this file after it ran and are never let through it. */

import { HEAD, TAIL, boundedText, cutHtml, cutRuns } from "./big-text";
import { copyButton, copyFrom, forget, renameSoon, sourceOf, warmLater } from "./copy";
import { nameOf } from "./copy-names";
import { highlight, highlighterReady, loadHighlighter } from "./highlight";
import { languageOf } from "./languages";
import type { Stream } from "./markdown-stream";
import type { HtmlMemo } from "./memo-cache";

/** past this, a text is not worth keeping in the html cache */
const BIG = HEAD + TAIL;

/** the engine (markdown-engine.ts: marked and the sanitiser), fetched as the app starts. until it is here a text is painted as plain
    paragraphs, and again when it is: a thread opened on a cold load that has the engine's chunk still on the wire. a launch from the cache
    has it long before the thread's rows come */
type Engine = typeof import("./markdown-engine");
let engine: Engine | undefined;
let loading: Promise<Engine> | undefined;
export const markdownReady = (): boolean => engine !== undefined;
export const loadMarkdown = (): Promise<Engine> => (loading ??= import("./markdown-engine").then((m) => (engine = m)));
void loadMarkdown().catch(() => { loading = undefined; });

const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
/** the words of a text as plain paragraphs, for the moment before the engine is here: a paragraph is what is between blank lines, a line
    break is kept. nothing is read as markdown, so nothing is let through that could be taken for the thread */
export const plain = (md: string): string =>
  boundedText(md).shown.split(/\n{2,}/).filter((p) => p.trim() !== "").map((p) => `<p>${p.replace(/[&<>]/g, (c) => escapes[c] as string).replace(/\n/g, "<br>")}</p>`).join("");

/** what is painted of a text, as html: its head and tail when it is huge, in pieces parsed one at a time (big-text.ts), since marked takes
    time that grows with the square of what it is given. a text of an ordinary answer is one piece and is `sanitise` as it was */
export const render = (md: string): string => (engine ? engine.whole(md) : cutHtml(plain(md)));

/** the sanitised html of text that has settled, kept by its text in the store's cache (memo-cache.ts): a thread opened again, or a
    turn painted again (or a far turn's stand-in, far-turn.tsx), does not run marked and the sanitiser over an answer it has already read. the text a reply is still writing
    is never kept, since each frame's is its own */
export function settledHtml(md: string, cache: HtmlMemo | undefined): string {
  // a huge text is bounded when it is painted and kept in no cache: its key alone would be megabytes
  if (md.length > BIG) return render(md);
  const held = cache?.get(md);
  if (held !== undefined) return held;
  const html = render(md);
  // what was made before the engine was here is not what the text comes to, and is not kept
  if (engine) cache?.set(md, html, (md.length + html.length) * 2);
  return html;
}

/** a reply that has just settled, from the units it streamed in (markdown-stream.ts): they are made already, and joined they are its
    html, which the cache keeps as `settled` would */
function settledFrom(md: string, stream: Stream, cache: HtmlMemo | undefined): string[] {
  if (md.length > BIG) return stream.units(md);
  const held = cache?.get(md);
  if (held !== undefined) return [held];
  const units = stream.units(md);
  const html = units.join("");
  cache?.set(md, html, (md.length + html.length) * 2);
  return units;
}

/** one unit of a paint: its html, the first of the surface's blocks it made, and how many */
type Unit = { html: string; start: number; count: number };

/** what a block was built from: its html, and for a block that ends in a fence still being written, that fact, so it is built again once it is not */
const keyOf = (node: Node, open: boolean): string => (node.nodeType === Node.ELEMENT_NODE ? (node as Element).outerHTML : node.textContent ?? "") + (open ? "\u0000open" : "");
/** the blank text between blocks is not a block */
const isBlock = (node: Node): boolean => node.nodeType === Node.ELEMENT_NODE || (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "");

/** `child` is the last thing in `el` that holds words: nothing but white space follows it (the caret goes after the last word) */
function endsWith(el: Element, child: Element): boolean {
  for (let n = el.lastChild; n && n !== child; n = n.previousSibling) if (n.nodeType !== Node.TEXT_NODE || (n.textContent ?? "").trim() !== "") return false;
  return true;
}

/** the source of a code block whose run too long to lay out was cut for display (big-text.ts): what its control copies. a block that was not
    cut has none, and its text is its source */
const sources = new WeakMap<Element, string>();

/** marked writes a fence as <pre><code class="language-ts">; a pre that is not that (an agent's own html) is left as it is */
const isFence = (pre: Element): boolean => pre.firstElementChild?.tagName === "CODE" && pre.children.length === 1;
const fencesIn = (el: Element): Element[] => (el.matches("pre") ? [el] : Array.from(el.querySelectorAll("pre"))).filter(isFence);

/** whether nothing follows `inner` inside `block`: the last thing a block holds, which is where a reply is writing */
function endsBlock(block: Element, inner: Element): boolean {
  for (let n: Element | null = inner; n && n !== block; n = n.parentElement) if (n.nextElementSibling) return false;
  return true;
}

/** a fence dressed as a code block: the language in its header's left, the copy control on its right, the code beneath, which scrolls on its own while the header stays.
    a fence with no language and one line has nothing to say in a header, so its control sits at the end of the line instead (`lone`). returns whether the fence is plain only for want of the highlighter */
function dress(pre: Element, open: boolean): boolean {
  const code = pre.firstElementChild as HTMLElement;
  const word = /(?:^|\s)language-(\S+)/.exec(code.className)?.[1];
  const { label, grammar } = languageOf(word);
  const whole = sourceOf(code);
  /* a run in it too long to lay out is cut for the page; its control copies the whole */
  const source = cutRuns(whole);
  if (source !== whole) sources.set(code, whole);
  const painted = highlight(grammar, source, open);
  /* the code keeps marked's own closing newline in both shapes, so the text a copy reads is the same either way */
  if (painted !== undefined) code.innerHTML = `${painted}\n`;
  else if (source !== whole) code.textContent = `${source}\n`;
  const block = document.createElement("div");
  const lone = !label && !source.includes("\n");
  block.className = lone ? "cblock lone" : "cblock";
  const control = copyButton("code", nameOf(label));
  pre.replaceWith(block);
  if (lone) block.append(pre, control);
  else {
    block.innerHTML = '<div class="cblock-h"><span class="cblock-lang"></span></div>';
    const head = block.firstElementChild as HTMLElement;
    const name = head.firstElementChild as HTMLElement;
    if (label) name.textContent = label; else name.remove();
    head.append(control);
    block.append(pre);
  }
  return grammar !== undefined && painted === undefined && !highlighterReady();
}

/** the top-level block as it will stand: its fences dressed, wherever they are in it. `open` says the block is the last of a reply that is still being written, so a fence that ends it is the one being written. `late` says a fence is waiting on the highlighter */
function build(node: Node, open: boolean): { node: Node; late: boolean } {
  if (node.nodeType !== Node.ELEMENT_NODE) return { node, late: false };
  const el = node as Element;
  const fences = fencesIn(el);
  const writing = open ? fences.at(-1) : undefined;
  const holder = document.createDocumentFragment();
  if (el.matches("pre")) holder.append(el);
  let late = false;
  for (const fence of fences) if (dress(fence, fence === writing && endsBlock(el, fence))) late = true;
  return { node: el.matches("pre") ? (holder.firstChild as Node) : el, late };
}

/** the fence a reply is writing: the last of the last block, when nothing follows it */
function writingIn(block: Element | null): Element | undefined {
  if (!block) return undefined;
  const fences = block.matches(".cblock") ? [block] : Array.from(block.querySelectorAll(".cblock"));
  const last = fences.at(-1);
  return last && endsBlock(block, last) ? last : undefined;
}

const hasControl = (node: Node | undefined): boolean => node?.nodeType === Node.ELEMENT_NODE && (node as Element).querySelector("button[data-copy]") !== null;

export type Painter = {
  /** paints the markdown now. `caret` puts the caret at the end of the last thing written */
  paint(md: string, caret: boolean): void;
  dispose(): void;
};

/** a painter for one surface; `html` is the cache settled text is kept in, when the surface has one. `whole` paints every text as one unit, as
    painting did before units: the reference the said-streaming-equivalence story holds the units to. its clicks are one listener on the surface, which finds the control a click was on; its scroll watching is one listener too */
export function painter(surface: HTMLElement, html?: HtmlMemo, whole = false): Painter {
  const keys: string[] = [];
  const nodes: Node[] = [];
  /** which blocks hold a fence that is plain only because the highlighter had not arrived */
  const late: boolean[] = [];
  let thread: Element | null = null;
  let caret: HTMLElement | undefined;
  let writing: Element | undefined;
  let lastPaint: { md: string; caret: boolean } | undefined;
  /** the reply being written, in units (markdown-stream.ts): made while the caret shows, let go once the text settles */
  let stream: Stream | undefined;
  /** the units the last paint was made of: where each began among the blocks and how many it made. a unit made again as it was, where it
      was, is passed over whole, so a frame parses and compares only the unit being written */
  let kept: Unit[] = [];
  let waiting = false;
  let afterEngine = false;
  let gone = false;
  warmLater();

  /* a code block's code continues past its edge: marks it, as a bed does (thread.tsx, watchOverflow), so the fade shows where there is more.
     it is read once, in the frame after a block is made (the block a reply is writing is not read: it changes on every frame), and on every scroll */
  const check = (pre: Element) => pre.classList.toggle("overflows", pre.scrollWidth > pre.clientWidth + 2 && pre.scrollLeft + pre.clientWidth < pre.scrollWidth - 2);
  const onScroll = (event: Event) => { if (event.target instanceof HTMLPreElement) check(event.target); };
  /* scroll does not bubble, so the one listener takes it in the capture phase */
  surface.addEventListener("scroll", onScroll, { capture: true, passive: true });
  /* the copy happens in this call, the tap's own (copy.ts says why) */
  const onClick = (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>("button[data-copy]") : null;
    if (!button || !surface.contains(button)) return;
    const code = button.closest(".cblock")?.querySelector("pre > code");
    if (code) copyFrom(button, sources.get(code) ?? sourceOf(code));
  };
  surface.addEventListener("click", onClick);

  const place = (withCaret: boolean) => {
    caret?.remove();
    caret = undefined;
    writing?.classList.remove("writing");
    writing = undefined;
    if (!withCaret) return;
    /* a fence still being written holds back its copy control: it would copy half of it */
    writing = writingIn(surface.lastElementChild);
    writing?.classList.add("writing");
    /* down into the last element only while it is the last thing written: words after an inline code or a strong are the
       end, and a caret put inside the code sat in the middle of the sentence */
    let end: Element = surface;
    while (end.lastElementChild && endsWith(end, end.lastElementChild) && !end.lastElementChild.matches("pre, table, hr, .cblock")) end = end.lastElementChild;
    caret = document.createElement("span");
    caret.className = "caret-end";
    caret.setAttribute("aria-hidden", "true");
    end.append(caret);
  };

  /** the html of the text in units: the reply being written in its own, settled text as one, from the store's cache when it has it */
  const unitsOf = (md: string, withCaret: boolean): string[] => {
    if (!engine || whole) return [withCaret ? render(md) : settledHtml(md, html)];
    if (withCaret) return (stream ??= engine.stream()).units(md);
    const was = stream;
    stream = undefined;
    // a reply that has just settled is made of the units it streamed in, all of them made already
    return was ? settledFrom(md, was, html) : [settledHtml(md, html)];
  };

  /** the blocks of the units in order, each made only when its html is not what stands at its place; returns the units as painted */
  const apply = (units: readonly string[], withCaret: boolean, fresh: Element[]): { painted: Unit[]; touched: boolean } => {
    const painted: Unit[] = [];
    const template = document.createElement("template");
    const final = units.length - 1;
    let touched = false;
    let at = 0;
    units.forEach((unit, u) => {
      const was = kept[u];
      /* a unit before the last that is the one painted at the same place, and was not the last then either (so no block of it was open), stands */
      if (u < final && u < kept.length - 1 && was !== undefined && was.html === unit && was.start === at) { painted.push(was); at += was.count; return; }
      template.innerHTML = unit;
      const incoming = Array.from(template.content.childNodes).filter(isBlock);
      const last = incoming.length - 1;
      incoming.forEach((node, j) => {
        const i = at + j;
        /* the last block of a reply being written is built again when it is not, if it holds a fence: that is when its fence is highlighted in full and its control appears */
        const open = withCaret && u === final && j === last && node.nodeType === Node.ELEMENT_NODE && fencesIn(node as Element).length > 0;
        const key = keyOf(node, open);
        if (keys[i] === key) return;
        const built = build(node, open);
        late[i] = built.late;
        const made = built.node;
        const old = nodes[i];
        if (hasControl(old) || hasControl(made)) touched = true;
        if (old) surface.replaceChild(made, old); else surface.append(made);
        if (!open && made.nodeType === Node.ELEMENT_NODE) fresh.push(...(made as Element).querySelectorAll("pre"));
        nodes[i] = made;
        keys[i] = key;
      });
      painted.push({ html: unit, start: at, count: incoming.length });
      at += incoming.length;
    });
    for (let i = nodes.length - 1; i >= at; i--) {
      if (hasControl(nodes[i])) touched = true;
      nodes[i]?.parentNode?.removeChild(nodes[i] as Node);
    }
    nodes.length = at;
    keys.length = at;
    late.length = at;
    return { painted, touched };
  };

  const self: Painter = {
    paint(md, withCaret) {
      lastPaint = { md, caret: withCaret };
      const fresh: Element[] = [];
      const units = unitsOf(md, withCaret);
      caret?.remove();
      caret = undefined;
      let { painted, touched } = apply(units, withCaret, fresh);
      /* a last unit with no block leaves the text's last block in a unit passed over, which may be the one being written: painted again as one */
      if (withCaret && units.length > 1 && painted.at(-1)?.count === 0) {
        kept = [];
        const again = apply([units.join("")], withCaret, fresh);
        painted = again.painted;
        touched ||= again.touched;
      }
      kept = painted;
      place(withCaret);
      thread ??= surface.closest(".thread");
      if (touched) renameSoon(surface);
      if (fresh.length) {
        const read = () => { for (const pre of fresh) check(pre); };
        requestAnimationFrame(read);
        void document.fonts?.ready.then(read);
      }
      /* a text painted before the engine was here is painted again when it is */
      if (!engine && !afterEngine) {
        afterEngine = true;
        void loadMarkdown().then(() => {
          afterEngine = false;
          if (gone || !lastPaint) return;
          keys.fill("\u0000stale");
          kept = [];
          self.paint(lastPaint.md, lastPaint.caret);
        }, () => { afterEngine = false; });
      }
      /* fences that are plain for now are made again, once, when the highlighter lands: only the blocks that hold one, so a selection or a focus anywhere else stays */
      if (late.some(Boolean) && !waiting) {
        waiting = true;
        void loadHighlighter().then(() => {
          waiting = false;
          if (gone || !highlighterReady() || !lastPaint) return;
          late.forEach((l, i) => { if (l) keys[i] = "\u0000stale"; });
          kept = [];
          self.paint(lastPaint.md, lastPaint.caret);
        });
      }
    },
    dispose() {
      gone = true;
      surface.querySelectorAll("[data-copy]").forEach(forget);
      renameSoon(thread);
      surface.removeEventListener("scroll", onScroll, { capture: true });
      surface.removeEventListener("click", onClick);
    },
  };
  return self;
}
