/* one machine: a window in the violet pair (design.md, the machines). its
   head is the os's mark in a lit tile, the name and the connection in
   home's chip, the line that says what the machine is ("Mac mini · macOS
   26.1"), and a mono line that says which cmx2 it runs and for how long;
   three figures say what is on it now (threads that want you, threads
   working, the daemon's memory); three meters pressed into it say how the
   machine is doing (cpu load, memory, disk) over a spec line; its
   terminals sit pressed into it; its verbs sit at its foot. reload is
   safe and fires at once. restart and forget are
   confirmed in place: the foot turns into the consequence in words and two
   choices, the verb itself and the way out, and the verb carries itself by
   its word, never by red (design.md, the terminal's kill). */

import { createEffect, createMemo, createSignal, createUniqueId, Index, Match, onCleanup, Show, Switch } from "solid-js";
import type { HostStatus } from "../../api/client";
import { refreshHosts, state } from "../../store";
import { HostTerminals } from "../term/terminals";
import { stateOf } from "../window/view";
import { forgetMachine, reloadMachine, restartMachine } from "./actions";
import { OsMark } from "./marks";
import { duration, identity, type Meter, meters, osMark, spec } from "./system";

const numbers = new Intl.NumberFormat("en");
const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
/** while a restart comes back, the hosts are reread this often, for this long */
const WATCH_MS = 1000;
const WATCH_FOR_MS = 60_000;
/** the daemon's memory, uptime with it, is sampled this often while connected (server/src/upstream/memory.rs), with a
    few seconds for the read that carried it */
const SAMPLE_EVERY_MS = 65_000;
/** the machine's system is sampled every 30 s (server/src/upstream/system.rs), with a few seconds for the read */
const SYSTEM_EVERY_MS = 35_000;

type Arming = "idle" | "restart" | "forget";
type Note = { text: string; failed: boolean } | null;

export function Host(props: { host: HostStatus }) {
  const name = () => props.host.name;
  const connected = () => props.host.connection === "connected";
  const chip = () => ({ connected: "connected", connecting: "connecting", down: "not answering" })[props.host.connection];
  /* the fleet's threads on this machine, each in the state home's window shows (ui/window/view.ts, stateOf, an ask
     before everything): how many want you, and how many are working, as home's bar counts them. a turn's failure is a
     fact only home holds, so a failed thread still running reads as working here */
  const counts = createMemo(() => {
    const asked = new Set(Object.values(state.fleet.asks).map((ask) => ask.key));
    let wants = 0;
    let working = 0;
    for (const key of state.fleet.order) {
      const session = state.fleet.sessions[key];
      if (session?.host !== name()) continue;
      const status = session.status;
      const parked = status?.type === "idle" && status.parked ? status.parked : null;
      const shown = stateOf({
        ask: asked.has(key),
        failure: null,
        busy: status?.type === "busy" || status?.type === "retry",
        queued: status?.type === "busy" ? (status.queued ?? 0) : 0,
        parked: parked !== null,
        agents: parked?.agents ?? 0,
        seen: true,
      });
      if (shown === "wants") wants++;
      else if (shown === "working" || shown === "queued") working++;
    }
    return { wants, working };
  });
  /** how long the daemon has been up: its own count at its last sample, and the time since that sample as of the last
      read of the hosts. only while connected and from a sample of this connection, or a machine that is down, or just
      restarted, would say an uptime it does not have. the sample is in the server's clock and the read in this
      device's, so the time since is held to the minute between samples and a skewed clock cannot run it on */
  const upFor = () => {
    const memory = props.host.memory;
    const daemon = system();
    // the newer of the two samples that carry it: the system's comes every 30 s, memory's every minute
    const sample =
      daemon && (!memory || daemon.sampledAt > memory.sampledAt)
        ? { at: daemon.sampledAt, uptime: daemon.daemon.uptime, every: SYSTEM_EVERY_MS }
        : memory
          ? { at: memory.sampledAt, uptime: memory.uptimeS, every: SAMPLE_EVERY_MS }
          : null;
    return sample ? liveSpan(sample) : null;
  };
  /** a count of seconds as of a sample, run on by the time since it, only while this connection took it */
  const liveSpan = (sample: { at: number; uptime: number; every: number }) => {
    if (!connected() || sample.at < props.host.since) return null;
    const since = Math.min(sample.every, Math.max(0, (state.hostsAt ?? sample.at) - sample.at));
    return duration(sample.uptime + since / 1000);
  };
  /* what the machine is and how it is doing: the last sample, kept while the host is away (the meters then read as
     past, as the figures do); none from an older cmx2, which says so in one line instead of drawing empty meters */
  const system = () => props.host.system ?? null;
  const mark = () => osMark(system());
  const hostUp = () => {
    const s = system();
    return s ? liveSpan({ at: s.sampledAt, uptime: s.uptime, every: SYSTEM_EVERY_MS }) : null;
  };
  /** the daemon's own memory, from whichever of its two reports is newer */
  const rss = () => {
    const memory = props.host.memory;
    const daemon = system();
    if (daemon && (!memory || daemon.sampledAt > memory.sampledAt)) return daemon.daemon.rss;
    return memory?.rss ?? null;
  };
  const titleId = createUniqueId();
  const [arming, setArming] = createSignal<Arming>("idle");
  const [busy, setBusy] = createSignal(false);
  /* the verb pressed goes away with the foot it was in, so focus is put where the choice is: on the way out, the safe
     one; and back on the verb when the way out is taken. a pointer's press shows no ring for it (design.md, input) */
  const verbs: Partial<Record<Exclude<Arming, "idle">, HTMLButtonElement>> = {};
  let keep: HTMLButtonElement | undefined;
  const arm = (verb: Exclude<Arming, "idle">) => {
    setArming(verb);
    queueMicrotask(() => keep?.focus({ preventScroll: true }));
  };
  const disarm = () => {
    const was = arming();
    setArming("idle");
    if (was !== "idle") queueMicrotask(() => verbs[was]?.focus({ preventScroll: true }));
  };
  /* esc takes the way out; while the verb is on its way it does nothing, and is still the confirmation's, so the shell
     does not take it as back */
  const onConfirmKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (!busy()) disarm();
  };
  let noteEl: HTMLParagraphElement | undefined;
  /** after a verb that took its controls away, focus lands on what it said */
  const toNote = () => queueMicrotask(() => noteEl?.focus({ preventScroll: true }));
  const [note, setNote] = createSignal<Note>(null);
  const [restarting, setRestarting] = createSignal<{ at: number; connects: number } | null>(null);

  let watch: ReturnType<typeof setInterval> | undefined;
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  const unwatch = () => {
    if (watch !== undefined) clearInterval(watch);
    if (giveUp !== undefined) clearTimeout(giveUp);
    watch = undefined;
    giveUp = undefined;
  };
  onCleanup(unwatch);

  // a restart is back once the watcher has made a new connection and holds it
  createEffect(() => {
    const pending = restarting();
    if (!pending || !connected() || props.host.connects <= pending.connects) return;
    unwatch();
    setRestarting(null);
    const seconds = ((Date.now() - pending.at) / 1000).toFixed(1);
    setNote({ text: `restarted. back after ${seconds} s, ${props.host.health?.version ?? "same version"}.`, failed: false });
  });

  const reload = async () => {
    setBusy(true);
    setNote(null);
    const outcome = await reloadMachine(name());
    setBusy(false);
    if (!outcome.ok) return setNote({ text: outcome.error, failed: true });
    const { flushed, changed, mcp } = outcome.value;
    const parts = [
      flushed.length > 0 ? `flushed ${flushed.join(", ")}` : "nothing to flush",
      changed.length > 0 ? `${changed.length} config ${changed.length === 1 ? "file" : "files"} changed` : null,
      mcp.length > 0 ? `${mcp.filter((m) => m.status === "connected").length} of ${mcp.length} mcp servers connected` : null,
    ];
    setNote({ text: `reloaded at ${clock.format(Date.now())}: ${parts.filter(Boolean).join(", ")}.`, failed: false });
  };

  const restart = async () => {
    setBusy(true);
    setNote(null);
    const before = props.host.connects;
    const outcome = await restartMachine(name());
    setBusy(false);
    setArming("idle");
    if (!outcome.ok) {
      setNote({ text: outcome.error, failed: true });
      toNote();
      return;
    }
    setRestarting({ at: Date.now(), connects: before });
    setNote({ text: "restarting. its running turns were aborted.", failed: false });
    toNote();
    unwatch();
    watch = setInterval(() => void refreshHosts(), WATCH_MS);
    giveUp = setTimeout(() => {
      unwatch();
      setRestarting(null);
      setNote({ text: `${name()} has not come back after a minute. check its supervisor started it again.`, failed: true });
    }, WATCH_FOR_MS);
  };

  const forget = async () => {
    setBusy(true);
    const outcome = await forgetMachine(name());
    setBusy(false);
    if (!outcome.ok) {
      setArming("idle");
      setNote({ text: outcome.error, failed: true });
      toNote();
      return;
    }
    // the window leaves with the machine: focus goes to the screen's title, the top of what is left
    queueMicrotask(() => document.getElementById("machines-title")?.focus({ preventScroll: true }));
  };

  return (
    <li class="host" aria-labelledby={titleId} data-connection={props.host.connection}>
      <div class="host-main">
        <div class="host-head">
          <span class="host-tile" data-mark={mark()}>
            <OsMark mark={mark()} />
          </span>
          <div class="host-title">
            <h2 class="host-name" id={titleId}>
              {name()}
            </h2>
            <Show
              when={system()}
              fallback={
                <Show when={props.host.reportsSystem === false}>
                  <p class="host-what" data-quiet="">
                    update cmx2 to see this machine's stats.
                  </p>
                </Show>
              }
            >
              {(s) => <p class="host-what">{identity(s())}</p>}
            </Show>
          </div>
          <span class="host-chip">
            <i aria-hidden="true" />
            {chip()}
          </span>
        </div>
        <p class="host-meta">
          <Show when={props.host.health} fallback="never reached">
            {(health) => (
              <>
                cmx2 {health().version}
                <Show when={!health().contractMatches}>
                  <span class="host-mismatch">
                    {" · "}contract {health().contract}, boxbox speaks another
                  </span>
                </Show>
              </>
            )}
          </Show>
          <Show when={upFor()}>{(up) => <> · up {up()}</>}</Show>
          <Show when={props.host.origin === "paired"}> · paired</Show>
        </p>
        <Show when={props.host.connection !== "connected" && props.host.lastError}>
          {(error) => (
            <p class="host-error">
              {error()}. <span class="host-since">since {clock.format(props.host.since)}</span>
            </p>
          )}
        </Show>
        {/* the wire's count is boxbox's own business (telemetry keeps it); what it could not read is a failure, and said */}
        <Show when={props.host.frames.undecodable > 0}>
          <p class="host-error">
            {numbers.format(props.host.frames.undecodable)} {props.host.frames.undecodable === 1 ? "event" : "events"} could not be read. the server's log names each one.
          </p>
        </Show>
        {/* what is on the machine now. while it is not connected the figures are the last it said, and look it; a machine
            never reached has said nothing, so it shows none */}
        <Show when={props.host.health}>
          <dl class="host-figures" data-stale={connected() ? undefined : ""}>
            <div class="host-figure" data-lit={counts().wants > 0 ? "" : undefined}>
              <dt>{counts().wants === 1 ? "wants you" : "want you"}</dt>
              <dd>{numbers.format(counts().wants)}</dd>
            </div>
            <div class="host-figure">
              <dt>working</dt>
              <dd>{numbers.format(counts().working)}</dd>
            </div>
            <Show when={rss()}>
              {(bytes) => (
                <div class="host-figure">
                  <dt>cmx2 memory</dt>
                  <dd>
                    {numbers.format(Math.round(bytes() / 1_048_576))}
                    <small> mb</small>
                  </dd>
                </div>
              )}
            </Show>
          </dl>
        </Show>
        {/* how the machine is doing, pressed into the window as the terminals are. the meters are kept by place (Index),
            so a new sample moves each fill and mark by transform and nothing around them moves */}
        <Show when={system()}>
          {(s) => (
            <section class="host-gauges" aria-label={`how ${name()} is doing`} data-stale={connected() ? undefined : ""}>
              <Index each={meters(s())}>{(meter) => <Gauge meter={meter()} />}</Index>
              <p class="host-spec">{spec(s(), hostUp(), connected() ? null : clock.format(s().sampledAt))}</p>
            </section>
          )}
        </Show>
        <HostTerminals host={name()} reachable={connected()} />
      </div>
      <Switch>
        <Match when={arming() === "idle"}>
          <div class="host-foot">
            <div class="host-verbs">
              <button class="host-verb" type="button" aria-label={`reload ${name()}`} disabled={!connected() || busy()} onClick={() => void reload()}>
                reload
              </button>
              <button ref={(el) => (verbs.restart = el)} class="host-verb" type="button" aria-label={`restart ${name()}`} disabled={!connected() || busy() || restarting() !== null} onClick={() => arm("restart")}>
                restart
              </button>
              <Show when={props.host.origin === "paired"}>
                <button ref={(el) => (verbs.forget = el)} class="host-verb" type="button" aria-label={`forget ${name()}`} disabled={busy()} onClick={() => arm("forget")}>
                  forget
                </button>
              </Show>
            </div>
          </div>
        </Match>
        <Match when={arming() === "restart"}>
          <div class="host-confirm" role="group" aria-label={`restart ${name()}?`} onKeyDown={onConfirmKey}>
            <p>restart aborts every running turn on {name()}, then its daemon starts fresh.</p>
            <div class="host-choices">
              <button class="on-window" type="button" aria-label={`restart ${name()} now`} disabled={busy()} onClick={() => void restart()}>
                restart
              </button>
              <button ref={keep} class="quiet" type="button" aria-label={`keep ${name()} running`} disabled={busy()} onClick={disarm}>
                keep running
              </button>
            </div>
          </div>
        </Match>
        <Match when={arming() === "forget"}>
          <div class="host-confirm" role="group" aria-label={`forget ${name()}?`} onKeyDown={onConfirmKey}>
            <p>
              boxbox deletes its credential for {name()} and stops watching it. to cut it off on the machine too, run{" "}
              <code>cmx2 pair --revoke boxbox</code> there.
            </p>
            <div class="host-choices">
              <button class="on-window" type="button" aria-label={`forget ${name()} now`} disabled={busy()} onClick={() => void forget()}>
                forget
              </button>
              <button ref={keep} class="quiet" type="button" aria-label={`keep ${name()}`} disabled={busy()} onClick={disarm}>
                keep
              </button>
            </div>
          </div>
        </Match>
      </Switch>
      <Show when={note()}>
        {(said) => (
          <p ref={noteEl} class={said().failed ? "host-note failed" : "host-note"} role="status" tabindex="-1">
            {said().text}
          </p>
        )}
      </Show>
    </li>
  );
}

/** one meter: its name, its words and its figure on one line, the track under them. the fill is a full-width bar slid
    left by what is not used, and the cpu's marks (its load over 5 and 15 minutes) full-width layers slid right, so a new
    sample moves them by transform alone and the track's rounded end clips the fill (design.md, motion) */
function Gauge(props: { meter: Meter }) {
  const percent = () => Math.round(props.meter.fill * 100);
  return (
    <div class="gauge" data-kind={props.meter.kind} data-warn={props.meter.warn ? "" : undefined} role="meter" aria-label={props.meter.kind} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent()} aria-valuetext={props.meter.label}>
      <span class="gauge-name" aria-hidden="true">
        {props.meter.kind}
      </span>
      <span class="gauge-detail" aria-hidden="true">
        {props.meter.detail}
      </span>
      <span class="gauge-value" aria-hidden="true">
        {props.meter.value}
      </span>
      <span class="gauge-track" aria-hidden="true">
        <span class="gauge-tube">
          <span class="gauge-fill" style={{ transform: `translateX(${(props.meter.fill - 1) * 100}%)` }} />
        </span>
        <Show when={props.meter.marks}>
          {(marks) => (
            <span class="gauge-marks">
              <span class="gauge-mark" data-span="5" style={{ transform: `translateX(${marks()[0] * 100}%)` }} />
              <span class="gauge-mark" data-span="15" style={{ transform: `translateX(${marks()[1] * 100}%)` }} />
            </span>
          )}
        </Show>
      </span>
    </div>
  );
}
