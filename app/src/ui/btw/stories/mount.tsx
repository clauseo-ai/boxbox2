/* the solid side of the btw stories (docs/thread.md, btw): a turn of a thread with its btws, drawn by the real TurnView
   inside the thread's ground, the btw context filled with fakes that answer as the worker would. */

import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { installMotionProperties } from "../../../motion/animate";
import { type Turn, turnsOf } from "../../thread/model";
import type { RowCtx } from "../../thread/rows";
import { TurnView } from "../../thread/thread";
import { Host } from "../../thread/stories/host";
import type { WireMessage } from "../../thread/wire";
import { REPO_COLOURS } from "../../window/repo";
import { btwNames, placeBtws } from "../place";
import { type Btw, BtwContext, type BtwDone, type BtwThread } from "../types";

export type BtwStory = "running" | "running-empty" | "done" | "error" | "dismissed" | "expanded" | "added" | "marker" | "several" | "streaming" | "live-turn";

const T0 = 1_790_000_000_000;
const QUESTION = "why does the deploy wait for the health check on every machine?";
const ANSWER = "because the rollout stops at the **first machine that never answers**: waiting for `/healthz` on each one means a bad build is caught on one machine, not all of them.\n\nthe wait is 30 s per machine with two retries, so a clean rollout across six takes about three minutes.";

const message = (info: Record<string, unknown>, text: string): WireMessage => ({ info: { created: T0, ...info }, parts: [{ id: `${String(info["id"])}_p`, type: "text", text }] }) as unknown as WireMessage;
const THREAD: WireMessage[] = [
  message({ id: "u1", role: "user" }, "make the deploy wait for the health check before it moves on"),
  message({ id: "a1", role: "assistant", completed: T0 + 40_000 }, "done: the deploy now waits for `/healthz` on each machine, retries twice with a backoff, and stops the rollout at the first machine that never answers."),
];
/* a turn still running: the agent's reply has no end yet */
const RUNNING: WireMessage[] = [
  ...THREAD,
  message({ id: "u3", role: "user", created: T0 + 120_000 }, "now roll it out to the staging machines"),
  { info: { id: "a3", role: "assistant", created: T0 + 121_000 }, parts: [{ id: "a3_p", type: "text", text: "rolling out to staging: the first two machines answered their health check, the third is starting", streaming: true }] } as unknown as WireMessage,
];
/* the words cmx2 puts in the thread for a promoted btw (packages/server/src/btw.ts, promotedText, at 3a9b3e3) */
const PROMOTED = message({ id: "u2", role: "user", created: T0 + 90_000, btw: "b1" }, `btw, i asked this on the side while you worked, and it was answered from this conversation.\n\nmy question:\n${QUESTION}\n\nthe answer:\n${ANSWER}`);

const btw = (over: Partial<Btw> = {}): Btw => ({ id: "b1", question: QUESTION, answer: ANSWER, status: "done", afterMessageID: "a1", created: T0 + 60_000, completed: T0 + 64_000, ...over });

const SETUPS: Record<BtwStory, () => { btws: Btw[]; promoted?: boolean; expand?: boolean; running?: boolean }> = {
  // asked mid-turn: the card sits at the end of the running turn, after what it has said so far
  "live-turn": () => ({ btws: [btw({ id: "b9", afterMessageID: "a3", status: "running", answer: "about three minutes for six machines: 30 s of health check each, ", created: T0 + 130_000 })], running: true }),
  running: () => ({ btws: [btw({ status: "running", answer: ANSWER.slice(0, 120) })] }),
  "running-empty": () => ({ btws: [btw({ status: "running", answer: "" })] }),
  done: () => ({ btws: [btw()] }),
  error: () => ({ btws: [btw({ status: "error", answer: "", error: "the model is overloaded right now" })] }),
  dismissed: () => ({ btws: [btw({ dismissed: T0 + 70_000 })] }),
  expanded: () => ({ btws: [btw({ dismissed: T0 + 70_000 })], expand: true }),
  added: () => ({ btws: [btw({ promotedMessageID: "u2" })], promoted: true }),
  marker: () => ({ btws: [btw({ promotedMessageID: "u2" })], promoted: true }),
  several: () => ({ btws: [btw(), btw({ id: "b2", question: "is the retry loop bounded?", answer: "yes: two retries, then the rollout stops.", created: T0 + 80_000 }), btw({ id: "b3", question: QUESTION, status: "running", answer: "", created: T0 + 85_000 })] }),
  streaming: () => ({ btws: [btw({ status: "running", answer: "" })] }),
};

const CTX: RowCtx = { reports: [], children: new Map(), thinking: "rows" };
const fake = (): Promise<BtwDone> => new Promise((done) => setTimeout(() => done({ ok: true }), 300));

export function mountBtw(el: HTMLElement, story: BtwStory): () => void {
  installMotionProperties();
  const setup = SETUPS[story]();
  const tone = REPO_COLOURS.find((c) => c.name === "teal") ?? REPO_COLOURS[0];
  // the stage's tokens are read on the sample around the mount, as the thread's stories set them
  const sample = el.closest<HTMLElement>(".stage-sample") ?? el;
  if (tone) {
    sample.style.setProperty("--tone", tone.light);
    sample.style.setProperty("--window-top", tone.top);
    sample.style.setProperty("--window-bottom", tone.bottom);
  }
  const [btws, setBtws] = createSignal<Btw[]>(setup.btws);
  const messages = setup.running ? RUNNING : setup.promoted ? [...THREAD, PROMOTED] : THREAD;
  const turns = turnsOf(messages, "/");
  const placed = () => placeBtws(messages.map((m) => ({ id: m.info.id, role: m.info.role })), btws());
  const thread: BtwThread = {
    key: () => "desk:ses_story",
    actions: { ask: fake, dismiss: fake, promote: fake },
    of: (id) => placed().get(id) ?? [],
    turnOf: (id) => { for (const [turn, list] of placed()) if (list.some((b) => b.id === id)) return turn; return undefined; },
    nameOf: (id) => btwNames(btws()).get(id) ?? "",
  };
  // the answer arrives a few words at a time, as the stream's 100 ms batches do, and settles
  let timer: ReturnType<typeof setInterval> | undefined;
  if (story === "streaming") {
    const words = ANSWER.split(/(?<= )/);
    let at = 0;
    timer = setInterval(() => {
      at += 2;
      const done = at >= words.length;
      setBtws([btw({ status: done ? "done" : "running", answer: words.slice(0, at).join("") })]);
      if (done) clearInterval(timer);
    }, 100);
  }
  const wide = sample.offsetWidth >= 700;
  sample.classList.toggle("wide", wide);
  const dispose = render((): JSX.Element => (
    <Host wide={wide} ledger={false}>
      <BtwContext.Provider value={thread}>
        {turns.map((t: Turn) => <TurnView turn={t} ctx={CTX} live={t.status === "working"} now={T0 + 140_000} />)}
      </BtwContext.Provider>
    </Host>
  ), el);
  if (setup.expand) queueMicrotask(() => el.querySelector<HTMLButtonElement>(".btw-chip")?.click());
  setTimeout(() => el.setAttribute("data-ready", ""), 400);
  return () => { clearInterval(timer); dispose(); };
}
