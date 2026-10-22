/* a recorded turn played live at speed, for the live stories: items arrive
   as they did, thoughts and prose stream word by word, long commands run
   with their output growing, and the turn settles at the end. a second of
   the turn is a twentieth of a second here, pauses capped. */

import { createSignal, onCleanup, onMount } from "solid-js";
import type { Item, Step, Turn } from "../model";
import type { RowCtx } from "../rows";
import { loadHighlighter } from "../highlight";
import { SayRow, TurnView } from "../thread";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function LiveReplay(props: { turn: Turn; ctx: RowCtx; speed?: number; onSettled?: () => void }) {
  const [items, setItems] = createSignal<Item[]>([]);
  const [now, setNow] = createSignal(props.turn.at);
  const [live, setLive] = createSignal(true);
  /* the reply is the newest item while the turn runs and streams as its newest row; settled, it is the turn's answer */
  const { answer, ...running } = props.turn;
  const source: readonly Item[] = answer ? [...props.turn.items, answer] : props.turn.items;
  const shown = (): Turn => (live() ? { ...running, items: items(), status: "working" } : props.turn);
  let stopped = false;
  const speed = () => props.speed ?? 20;

  async function advanceTo(target: number): Promise<void> {
    const gap = target - now();
    const real = Math.min(1400, Math.max(120, gap / speed()));
    const t0 = performance.now(), from = now();
    while (performance.now() - t0 < real && !stopped) { setNow(from + ((performance.now() - t0) / real) * gap); await wait(60); }
    setNow(target);
  }
  async function play(): Promise<void> {
    for (const it of source) {
      if (stopped) return;
      await advanceTo(Math.max(now(), it.at || now()));
      if (it.k === "think" || it.k === "say") {
        const words = it.text.split(/(\s+)/);
        const start = now();
        const copy = { ...it, text: "", streaming: true };
        setItems((xs) => [...xs, copy]);
        for (let w = 0; w < words.length && !stopped; w += 6) {
          const text = words.slice(0, w + 6).join("");
          setItems((xs) => xs.map((x) => (x === copy ? { ...x, text } : x)));
          setNow(start + (it.k === "think" ? it.ms || 1500 : 1500) * Math.min(1, (w + 6) / words.length));
          await wait(40);
        }
        setItems((xs) => xs.map((x) => (x.k === it.k && x.id === it.id ? { ...it } : x)));
      } else if (it.k === "step" && it.family === "shell" && it.ms >= 1500 && it.polls === undefined) {
        const lines = it.output?.lines ?? [];
        const running: Step = { ...it, status: "running", output: { lines: [" "], cut: 0, cutAt: -1 } };
        delete (running as { evidence?: unknown }).evidence;
        setItems((xs) => [...xs, running]);
        const real = Math.min(3200, Math.max(900, it.ms / 15)), t0 = performance.now();
        while (performance.now() - t0 < real && !stopped) {
          const f = (performance.now() - t0) / real;
          setNow(it.at + f * it.ms);
          setItems((xs) => xs.map((x) => (x.k === "step" && x.id === it.id ? { ...x, output: { lines: lines.slice(0, Math.max(1, Math.round(f * lines.length))), cut: 0, cutAt: -1 } } : x)));
          await wait(80);
        }
        setNow(it.at + it.ms);
        setItems((xs) => xs.map((x) => (x.k === "step" && x.id === it.id ? it : x)));
      } else {
        setItems((xs) => [...xs, it]);
        setNow(Math.max(now(), (it.at || now()) + (it.k === "step" ? it.ms : 0)));
      }
    }
    if (stopped) return;
    await wait(600);
    setLive(false);
    props.onSettled?.();
  }
  onMount(() => { void play(); });
  onCleanup(() => { stopped = true; });
  return <TurnView turn={shown()} ctx={props.ctx} live={live()} now={now()} />;
}

/** a reply streamed into the said row, a few characters a frame, through prose and several fences. a block that has settled must keep its
    node for the rest of the stream (markdown.ts), so its copy control keeps its focus, its hover and its "copied". every frame the story counts
    the settled blocks whose node was replaced; `data-replaced` on the sample says how many (it must be 0) and `data-replay` says when it is done */
export function CodeReplay(props: { text: string; per?: number; at: number }) {
  const [text, setText] = createSignal("");
  let host!: HTMLDivElement;
  let timer = 0;
  onMount(() => {
    const sample = host.closest<HTMLElement>(".stage-sample");
    let kept: Element[] = [];
    let replaced = 0, frames = 0;
    const per = props.per ?? 7;
    let shown = 0;
    const step = () => {
      shown = Math.min(props.text.length, shown + per);
      setText(props.text.slice(0, shown));
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const now = [...host.querySelectorAll(".say-md > :not(.caret-end)")];
        // every block but the one being written was there before and must be the same node
        for (let i = 0; i < kept.length - 1; i++) if (now[i] !== kept[i]) replaced++;
        kept = now;
        frames++;
        if (sample) { sample.dataset["replaced"] = String(replaced); sample.dataset["frames"] = String(frames); }
      }));
      if (shown < props.text.length) timer = window.setTimeout(step, 40);
      else window.setTimeout(() => { if (sample) sample.dataset["replay"] = "done"; }, 200);
    };
    /* the highlighter is a chunk fetched on demand (highlight.ts): a stream that began before it landed would repaint its first fence once, which is right and is not what this counts */
    void loadHighlighter().then(step);
  });
  onCleanup(() => clearTimeout(timer));
  return <div ref={host}><SayRow say={{ k: "say", id: "prt_replay", text: text(), at: props.at, streaming: text().length < props.text.length }} time="" /></div>;
}
