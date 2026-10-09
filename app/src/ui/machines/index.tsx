import { For, onCleanup, onMount, Show } from "solid-js";
import { leave, navigate } from "../../shell/navigation";
import { refreshHosts, signOut, state } from "../../store";
import { Host } from "./host";
import "./machines.css";
import { PairMachine } from "./pair";

/** while visible, the list rereads the hosts this often. a host's own
    window rereads faster while it watches a restart come back. */
const REFRESH_MS = 5000;

export function Machines() {
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = () => {
    stop();
    if (document.visibilityState === "visible") timer = setInterval(() => void refreshHosts(), REFRESH_MS);
  };
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const onVisibility = () => {
    if (document.visibilityState === "visible") void refreshHosts();
    start();
  };
  onMount(() => {
    start();
    document.addEventListener("visibilitychange", onVisibility);
  });
  onCleanup(() => {
    stop();
    document.removeEventListener("visibilitychange", onVisibility);
  });

  return (
    <section class="machines hosts" aria-labelledby="machines-title">
      {/* home is one pill away and this is its way back; settings is reached from here (design.md, the machines) */}
      <header class="machines-head">
        <div class="head-row">
          <button class="quiet screen-back" type="button" aria-label="back to the windows" onClick={() => leave({ name: "machines" })}>
            <span class="chevron" aria-hidden="true" />
            windows
          </button>
          <button class="head-pill" type="button" data-opens="settings" onClick={() => navigate({ name: "settings" })}>
            settings
          </button>
        </div>
        <h1 id="machines-title" tabindex="-1" data-screen-title>
          machines
        </h1>
      </header>
      <Show when={state.problem}>
        {(problem) => (
          <p class="problem" role="alert">
            {problem()}
          </p>
        )}
      </Show>
      <Show when={state.hosts.length === 0}>
        <p class="hosts-empty">no machines yet. pair one, or add a [[host]] to boxbox.toml.</p>
      </Show>
      {/* the windows, and after them the place the next one goes */}
      <ul class="host-list" aria-label="machines">
        <For each={state.hosts}>{(host) => <Host host={host} />}</For>
        <PairMachine />
      </ul>
      {/* the session is this device's, not a machine's: it ends at the foot of the page, out of the way */}
      <footer class="hosts-foot">
        <button class="quiet" type="button" onClick={() => void signOut()}>
          sign out
        </button>
      </footer>
    </section>
  );
}
