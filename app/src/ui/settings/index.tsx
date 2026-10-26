/* settings: this device's appearance and notifications, what a new
   thread in each repo starts with, and each repo's colour. every value lives in the server's
   prefs (server/src/prefs.rs); nothing here keeps its own copy. rows sit
   on the ground behind a hairline: they are settings, not machines
   (design.md, until m5). */

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { PushKind } from "../../api/client";
import { deviceId } from "../../push/device";
import { modelName } from "../model-name";
import { NotificationsRow } from "../../push/notifications-row";
import { leave } from "../../shell/navigation";
import { RepoMark } from "../repo-mark/repo-mark";
import { type HomePrefs, homePrefs, type RepoPrefs, state } from "../../store";
import { devicePrefs, loadModels, loadPrefs, loadPushDevices, saveAppearance, saveHome, savePushKinds, saveRepo } from "./actions";
import { RepoColours } from "./colours";
import { Segmented, Toggle } from "./controls";
import "./settings.css";

const KINDS: readonly { kind: PushKind; label: string }[] = [
  { kind: "ask", label: "questions and permissions" },
  { kind: "done", label: "a turn you started is done" },
  { kind: "fault", label: "a real fault" },
  { kind: "ready", label: "a worktree ready to review" },
];
const THEMES = [
  { value: "system", label: "system" },
  { value: "dark", label: "dark" },
  { value: "light", label: "light" },
] as const;
const CLEARS = [
  { value: "seen1h", label: "1 h after seen" },
  { value: "any3h", label: "3 h, seen or not" },
  { value: "never", label: "never" },
] as const;
const REDUCE = "(prefers-reduced-motion: reduce)";
const day = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });

export function Settings() {
  const [problem, setProblem] = createSignal<string | null>(null);
  const reduce = matchMedia(REDUCE);
  const [systemReduces, setSystemReduces] = createSignal(reduce.matches);
  const onReduce = () => setSystemReduces(reduce.matches);
  reduce.addEventListener("change", onReduce);
  onCleanup(() => reduce.removeEventListener("change", onReduce));

  onMount(async () => {
    const failed = (await Promise.all([loadPrefs(), loadPushDevices()])).find((p) => p !== null);
    setProblem(failed ?? null);
  });

  const prefs = devicePrefs;
  const reduced = () => prefs().motion === "reduced" || (prefs().motion === "system" && systemReduces());
  const save = async (next: Parameters<typeof saveAppearance>[0], changed: "theme" | "motion") => {
    const outcome = await saveAppearance(next, changed);
    setProblem(outcome.ok ? null : outcome.error);
  };

  const mine = createMemo(() => state.pushDevices.find((d) => d.device === deviceId()));
  const others = createMemo(() => state.pushDevices.filter((d) => d.device !== deviceId()));
  const [kindsBusy, setKindsBusy] = createSignal(false);
  const toggleKind = async (kind: PushKind, on: boolean) => {
    const current = mine()?.kinds ?? [];
    const next = KINDS.map((k) => k.kind).filter((k) => (k === kind ? on : current.includes(k)));
    setKindsBusy(true);
    const outcome = await savePushKinds(next);
    setKindsBusy(false);
    setProblem(outcome.ok ? null : outcome.error);
  };

  return (
    <section class="settings" aria-labelledby="settings-title">
      <header class="machines-head">
        <div class="head-row">
          <button class="quiet screen-back" type="button" aria-label="back to machines" onClick={() => leave({ name: "settings" })}>
            <span class="chevron" aria-hidden="true" />
            machines
          </button>
        </div>
        <h1 id="settings-title" tabindex="-1" data-screen-title>
          settings
        </h1>
      </header>
      <Show when={problem()}>
        {(said) => (
          <p class="problem" role="alert">
            {said()}
          </p>
        )}
      </Show>

      <section class="settings-group" aria-labelledby="appearance-title">
        <h2 id="appearance-title">this device</h2>
        <div class="setting">
          <span class="setting-label" id="theme-label">
            appearance
          </span>
          <Segmented label="appearance" value={prefs().theme} choices={THEMES} onChange={(theme) => void save({ ...prefs(), theme }, "theme")} />
        </div>
        <div class="setting">
          <span class="setting-label">
            reduce motion
            <span class="setting-hint">
              <Show when={prefs().motion !== "system"} fallback="follows the system">
                <button class="link" type="button" onClick={() => void save({ ...prefs(), motion: "system" }, "motion")}>
                  follow the system
                </button>
              </Show>
            </span>
          </span>
          <Toggle label="reduce motion" checked={reduced()} onChange={(on) => void save({ ...prefs(), motion: on ? "reduced" : "full" }, "motion")} />
        </div>
      </section>

      <HomeGroup onProblem={setProblem} />

      <section class="settings-group" aria-labelledby="reach-title">
        <h2 id="reach-title">what reaches this device</h2>
        <NotificationsRow />
        <Show when={state.push.subscribed && mine()}>
          {(device) => (
            <For each={KINDS}>
              {(k) => (
                <div class="setting">
                  <span class="setting-label">{k.label}</span>
                  <Toggle
                    label={k.label}
                    checked={device().kinds.includes(k.kind)}
                    disabled={kindsBusy()}
                    onChange={(on) => void toggleKind(k.kind, on)}
                  />
                </div>
              )}
            </For>
          )}
        </Show>
        <Show when={others().length > 0}>
          <ul class="other-devices" aria-label="other devices">
            <For each={others()}>
              {(device) => (
                <li>
                  <span>
                    {device.deviceClass}, since {day.format(device.since)}
                  </span>
                  <span class="setting-hint">
                    {device.kinds.length === 0 ? "nothing" : KINDS.filter((k) => device.kinds.includes(k.kind)).map((k) => k.label).join(", ")}
                  </span>
                </li>
              )}
            </For>
          </ul>
          <p class="setting-hint">change another device's notifications on that device.</p>
        </Show>
      </section>

      <RepoDefaults onProblem={setProblem} />

      <RepoColours />
    </section>
  );
}

/** home (design.md, settings): how home settles, for every device. the server's prefs, read with the rest; until they are
    read the rows are disabled and show this device's copy */
export function HomeGroup(props: { onProblem: (problem: string | null) => void }) {
  const save = async (change: Partial<HomePrefs>, changed: keyof HomePrefs) => {
    const outcome = await saveHome({ ...homePrefs(), ...change }, changed);
    props.onProblem(outcome.ok ? null : outcome.error);
  };
  const unread = () => state.prefs === null;
  return (
    <section class="settings-group" aria-labelledby="home-title">
      <h2 id="home-title">home</h2>
      <div class="setting setting-stack">
        <span class="setting-label">
          clear finished windows
          <span class="setting-hint">a done or idle window leaves home on its own. never one that asks, stopped, waits on a worktree review, or has messages queued. this runs on the server, so it happens with the app closed.</span>
        </span>
        <Segmented label="clear finished windows" value={homePrefs().autoClear} choices={CLEARS} disabled={unread()} onChange={(autoClear) => void save({ autoClear }, "autoClear")} />
      </div>
      <div class="setting">
        <span class="setting-label">
          fold working windows
          <span class="setting-hint">windows at work with nothing wrong fold into one capsule. one leaves it when it finishes, stops or asks.</span>
        </span>
        <Toggle label="fold working windows" checked={homePrefs().foldWorking} disabled={unread()} onChange={(foldWorking) => void save({ foldWorking }, "foldWorking")} />
      </div>
      <div class="setting">
        <span class="setting-label">
          job notices count as needs
          <span class="setting-hint">off: a background job's notice is a row in its thread. it does not add to the badge or move its window.</span>
        </span>
        <Toggle label="job notices count as needs" checked={homePrefs().jobsAsNeeds} disabled={unread()} onChange={(jobsAsNeeds) => void save({ jobsAsNeeds }, "jobsAsNeeds")} />
      </div>
    </section>
  );
}

/** `directory` keys the defaults (a worktree is its own entry); `root` is the project root the repo's mark is read by */
type Repo = { host: string; directory: string; root: string; seen: number };

/** the repos this fleet has threads in, most recent first, and any repo
    that already has defaults */
function repos(): Repo[] {
  const byKey = new Map<string, Repo>();
  for (const thread of Object.values(state.fleet.threads)) {
    const directory = thread.place?.directory ?? "";
    const key = `${thread.agent}:${directory}`;
    const seen = thread.updated;
    const known = byKey.get(key);
    if (!known || known.seen < seen) byKey.set(key, { host: thread.agent, directory, root: thread.place?.root ?? "", seen });
  }
  for (const pref of state.prefs?.repos ?? []) {
    const key = `${pref.host}:${pref.directory}`;
    if (!byKey.has(key)) byKey.set(key, { host: pref.host, directory: pref.directory, root: pref.directory, seen: 0 });
  }
  return [...byKey.values()].sort((a, b) => b.seen - a.seen || a.directory.localeCompare(b.directory));
}

function RepoDefaults(props: { onProblem: (problem: string | null) => void }) {
  const list = createMemo(repos);
  // each host's models, read once it is connected: on a cold launch the hosts and the fleet arrive after this mounts
  const asked = new Set<string>();
  createEffect(() => {
    for (const { host } of list()) {
      if (asked.has(host) || state.hosts.find((h) => h.name === host)?.connection !== "connected") continue;
      asked.add(host);
      void loadModels(host).then((failed) => failed && props.onProblem(failed));
    }
  });
  return (
    <section class="settings-group" aria-labelledby="repos-title">
      <h2 id="repos-title">new threads</h2>
      <Show when={list().length > 0} fallback={<p class="setting-hint">no repos yet. once a machine has threads, each repo's model and effort defaults are set here.</p>}>
        <ul class="repo-list" aria-label="repos">
          <For each={list()}>{(repo) => <RepoRow repo={repo} onProblem={props.onProblem} />}</For>
        </ul>
      </Show>
    </section>
  );
}

function RepoRow(props: { repo: Repo; onProblem: (problem: string | null) => void }) {
  const name = () => props.repo.directory.split("/").filter(Boolean).pop() ?? props.repo.directory;
  const saved = () => state.prefs?.repos.find((r) => r.host === props.repo.host && r.directory === props.repo.directory);
  const models = () => state.models[props.repo.host];
  const model = () => models()?.models.find((m) => m.id === saved()?.model);
  const [busy, setBusy] = createSignal(false);
  const save = async (change: Partial<Pick<RepoPrefs, "model" | "effort">>) => {
    const next: RepoPrefs = { host: props.repo.host, directory: props.repo.directory, model: saved()?.model ?? null, effort: saved()?.effort ?? null, ...change };
    setBusy(true);
    const outcome = await saveRepo(next);
    setBusy(false);
    props.onProblem(outcome.ok ? null : outcome.error);
  };
  const label = () => `${name()} on ${props.repo.host}`;
  return (
    <li class="repo" aria-label={label()}>
      <div class="repo-head">
        <RepoMark host={props.repo.host} root={props.repo.root} name={name()} size={36} />
        <div class="repo-name">
          <span>{name()}</span>
          <span class="repo-where">
            {props.repo.host} · {props.repo.directory}
          </span>
        </div>
      </div>
      <div class="repo-choices">
        <select
          aria-label={`model for ${label()}`}
          disabled={busy() || !models()}
          onChange={(e) => void save({ model: e.currentTarget.value || null, effort: null })}
        >
          {/* each option says whether it is chosen: a select's value set before its options arrive is lost */}
          <option value="" selected={!saved()?.model}>
            {models() ? "the machine's default" : "models load when the machine answers"}
          </option>
          <For each={models()?.models ?? []}>
            {(m) => (
              <option value={m.id} selected={m.id === saved()?.model}>
                {modelName(m.id)}
              </option>
            )}
          </For>
        </select>
        <select
          aria-label={`effort for ${label()}`}
          disabled={busy() || !model() || model()?.efforts.length === 0}
          onChange={(e) => void save({ effort: e.currentTarget.value || null })}
        >
          <option value="" selected={!saved()?.effort}>
            the model's default effort
          </option>
          <For each={model()?.efforts ?? []}>
            {(effort) => (
              <option value={effort} selected={effort === saved()?.effort}>
                {effort}
              </option>
            )}
          </For>
        </select>
      </div>
    </li>
  );
}
