/* the stage over a thread the way a long delegating run leaves it, played live (docs/thread.md, live; docs/gotchas.md, the
   pin): an earlier turn that started two agents and ended while they still work (its tape keeps time for them), a reader who
   steered the running turn twice (each steer waits behind the step in flight as a queued message, is taken back and sent
   again as a steer, and lands as a turn of its own when the step ends), and a thought that streams for a minute while the
   agents' own clocks and threads move. everything is made up here from nothing a person said.

   the scroller must stay at the end the whole way: `data-gap` is the most the view was ever above the end at a checkpoint
   (two frames after each change, which is when the stage has followed it), `data-ended` how far above it ends, and
   `data-played` says the story is over. a driver opens the story (shots.ts leaves the live ones out: they run for a minute), waits
   for `data-played` and fails unless both are 0, in any engine; webkit is the one that fails it without the fix (docs/gotchas.md). */

import "../../../shell/stories/server";
import { type ReactElement, createElement, useEffect, useRef } from "react";
import { mountShell } from "../../../shell/stories/mount";
import { applyPatches, setOpenThread, state } from "../../../store";
import type { Message, Part, Thread } from "../../../sync/protocol";
import { familyOf } from "../../../sync/fixtures/neutral";

export default { title: "stage" };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

const WORDS = "the plan holds if each step names what it leaves behind so the next one can start from it without asking again".split(" ");
/** n words of made-up thinking, the same every time */
const thinking = (n: number): string => Array.from({ length: n }, (_, i) => WORDS[(i * 7) % WORDS.length]).join(" ");

const BRIEFS = ["map the build scripts and say which ones the new service can reuse", "read the pricing notes and list every number that appears twice"];

export const LiveSteered = (): ReactElement => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = mountShell(el, "thread");
    let gone = false;
    void (async () => {
      while (!gone && !el.dataset["ready"]) await sleep(100);
      const open = state.openThread;
      const template = open ? state.fleet.threads[open] : undefined;
      if (gone || !open || !template) return;
      const host = open.split(":")[0] ?? "";
      const now = Date.now();
      const main = "ses_steered_main";
      const key = `${host}:${main}`;
      const kids = ["ses_steered_a", "ses_steered_b"];
      const entry = (id: string, parent: string | undefined, title: string, activity: Thread["activity"]): Thread => {
        const { parent: _parent, ...rest } = template;
        return { ...rest, key: `${host}:${id}`, id, activity, needs: [], tail: [], title, created: now - 400_000, updated: now, ...(parent ? { parent } : {}) };
      };
      /* the thread a part or a message is in is the store's key, not a field (`_thread` keeps the builders' calls as they read) */
      const msg = (id: string, _thread: string, role: "user" | "assistant", created: number, extra: Record<string, unknown> = {}, completed?: number): Message["info"] => ({ id, role, created, ...(completed === undefined ? {} : { completed }), ...extra }) as Message["info"];
      const tool = (id: string, _thread: string, messageID: string, name: string, input: Record<string, unknown>, at: number, metadata: Record<string, unknown> = {}): Part => ({ id, messageID, type: "tool", callID: id, tool: name, family: familyOf(name), state: { status: "completed", input, output: "", metadata, time: { start: at, end: at + 900 } } });
      const text = (id: string, _thread: string, messageID: string, body: string, extra: Record<string, unknown> = {}): Part => ({ id, messageID, type: "text", text: body, ...extra }) as Part;
      const thought = (id: string, _thread: string, messageID: string, body: string, at: number, extra: Record<string, unknown> = {}): Part => ({ id, messageID, type: "reasoning", text: body, time: { start: at }, ...extra }) as Part;

      // the earlier turn: a brief, a few steps, two agents started, its own turn over
      const t0 = now - 330_000;
      const earlier: Message[] = [
        { info: msg("m_u1", main, "user", t0), parts: [text("p_u1", main, "m_u1", "plan the new service and use agents for the reading")] },
        { info: msg("m_a1", main, "assistant", t0 + 2_000, {}, t0 + 9_000), parts: [thought("p_a1r", main, "m_a1", thinking(30), t0 + 2_000, { time: { start: t0 + 2_000, end: t0 + 6_000 } }), tool("p_a1t", main, "m_a1", "exec_command", { cmd: "ls scripts" }, t0 + 6_500)] },
        ...kids.map((kid, i): Message => ({
          info: msg(`m_a${i + 2}`, main, "assistant", t0 + 10_000 + i * 2_000, {}, t0 + 11_000 + i * 2_000),
          parts: [tool(`p_sp${i}`, main, `m_a${i + 2}`, "spawn", { brief: BRIEFS[i] }, t0 + 10_000 + i * 2_000, { agents: [{ id: kid, name: `reader_${i + 1}`, seat: "scout" }], child_session_id: kid })],
        })),
      ];
      // the steers, each already landed as a turn of its own, then the running turn's steps so far
      const s0 = now - 110_000;
      const running: Message[] = [
        { info: msg("m_s1", main, "user", s0, { steer: true }), parts: [text("p_s1", main, "m_s1", "go on, and keep it short")] },
        { info: msg("m_s2", main, "user", s0 + 9_000, { steer: true }), parts: [text("p_s2", main, "m_s2", "and name the files")] },
        { info: msg("m_a5", main, "assistant", s0 + 12_000, {}, s0 + 20_000), parts: [thought("p_a5r", main, "m_a5", thinking(24), s0 + 12_000, { time: { start: s0 + 12_000, end: s0 + 15_000 } }), tool("p_a5t", main, "m_a5", "message", { to: "reader_1", message: "send what you have so far" }, s0 + 16_000)] },
        { info: msg("m_a6", main, "assistant", s0 + 20_500, {}, s0 + 26_000), parts: [tool("p_a6t", main, "m_a6", "exec_command", { cmd: "cat notes.md" }, s0 + 21_000)] },
        { info: msg("m_a7", main, "assistant", now - 20_000), parts: [thought("p_a7r", main, "m_a7", "", now - 20_000, { streaming: true })] },
      ];
      const child = (kid: string, i: number): Message[] => [
        { info: msg(`${kid}_u`, kid, "user", t0 + 10_000, { mail: { kind: "task", from: "/root", fromID: main } }), parts: [text(`${kid}_up`, kid, `${kid}_u`, BRIEFS[i] ?? "", {})] },
        ...[1, 2, 3].map((n): Message => ({ info: msg(`${kid}_a${n}`, kid, "assistant", t0 + 12_000 + n * 9_000, {}, t0 + 18_000 + n * 9_000), parts: [tool(`${kid}_t${n}`, kid, `${kid}_a${n}`, "exec_command", { cmd: `step ${n}` }, t0 + 13_000 + n * 9_000)] })),
      ];
      applyPatches([
        { path: ["fleet", "asks"], value: {} },
        { path: ["fleet", "threads", key], value: entry(main, undefined, "plan the new service", { state: "busy", since: t0 }) },
        { path: ["fleet", "threads", `${host}:${kids[0]}`], value: entry(kids[0] as string, main, "reader_1 (scout)", { state: "busy", since: t0 + 10_000 }) },
        { path: ["fleet", "threads", `${host}:${kids[1]}`], value: entry(kids[1] as string, main, "reader_2 (scout)", { state: "idle" }) },
        ...kids.map((kid, i) => ({ path: ["threads", `${host}:${kid}`], value: { key: `${host}:${kid}`, status: "live", messages: child(kid, i) } })),
        { path: ["threads", key], value: { key, status: "live", messages: [...earlier, ...running] } },
      ]);
      setOpenThread(key);
      await sleep(1500);
      if (gone) return;
      const scroller = el.querySelector<HTMLElement>(".stage-scroll");
      if (!scroller) return;
      let worst = 0;
      const checkpoint = async () => { await frames(); await sleep(60); worst = Math.max(worst, Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight)); el.dataset["gap"] = String(worst); };
      el.dataset["gap"] = "0";
      const at = (i: number) => ["threads", key, "messages", i] as const;
      // the running step's thought grows a few words a tick
      const last = earlier.length + running.length - 1;
      const grow = async (from: number, to: number) => {
        for (let shown = from; shown < to && !gone; shown += 6) {
          applyPatches([{ path: [...at(last), "parts", 0, "text"], value: thinking(Math.min(to, shown)) }]);
          await sleep(100);
        }
      };
      // a minute of thought with the agents' clocks running, checked as it goes
      await checkpoint();
      for (let round = 0; round < 6 && !gone; round++) { await grow(40 + round * 120, 160 + round * 120); await checkpoint(); }
      // a steer sent now waits behind the step in flight as a queued message at the end, is taken back, and sent again as a steer
      const queued = (id: string, body: string, create: number): Message => ({ info: msg(id, main, "user", create, { queued: true }), parts: [text(`${id}_p`, main, id, body)] });
      const end = () => state.threads[key]?.messages.length ?? 0;
      applyPatches([{ path: ["threads", key, "messages", end()], value: queued("m_q1", "one more thing", Date.now()) }]);
      await checkpoint();
      applyPatches([{ path: ["threads", key, "messages"], value: (state.threads[key]?.messages ?? []).filter((m) => m.info.id !== "m_q1") }]);
      applyPatches([{ path: ["threads", key, "messages", end()], value: queued("m_q2", "one more thing", Date.now()) }]);
      await checkpoint();
      for (let round = 0; round < 3 && !gone; round++) { await grow(760 + round * 100, 860 + round * 100); await checkpoint(); }
      // the step ends: the thought is whole, the queued steer lands as a turn, and the next step begins
      const done = Date.now();
      applyPatches([
        { path: ["threads", key, "messages", last], value: { info: msg("m_a7", main, "assistant", now - 20_000, {}, done), parts: [thought("p_a7r", main, "m_a7", thinking(1060), now - 20_000, { time: { start: now - 20_000, end: done } }), tool("p_a7t", main, "m_a7", "exec_command", { cmd: "ls notes" }, done)] } },
        { path: ["threads", key, "messages"], value: [...(state.threads[key]?.messages ?? []).filter((m) => m.info.id !== "m_q2"), { info: msg("m_s3", main, "user", done, { steer: true }), parts: [text("p_s3", main, "m_s3", "one more thing")] }, { info: msg("m_a8", main, "assistant", done + 800), parts: [thought("p_a8r", main, "m_a8", "", done + 800, { streaming: true })] }] },
      ]);
      await checkpoint();
      const next = (state.threads[key]?.messages.length ?? 1) - 1;
      for (let n = 0; n < 40 && !gone; n++) { applyPatches([{ path: ["threads", key, "messages", next, "parts", 0, "text"], value: thinking(6 * (n + 1)) }]); await sleep(100); }
      await checkpoint();
      el.dataset["ended"] = String(Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight));
      el.dataset["played"] = "1";
      const post = new URLSearchParams(location.search).get("post");
      if (post) void fetch(post, { method: "POST", mode: "no-cors", body: JSON.stringify({ steered: { gap: el.dataset["gap"], ended: el.dataset["ended"] } }) }).catch(() => undefined);
    })();
    return () => { gone = true; stop(); };
  }, []);
  return createElement("div", { ref, className: "shell-story" });
};
