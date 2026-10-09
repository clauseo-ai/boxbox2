import { For, Match, Show, Switch } from "solid-js";
import type { PushKind } from "../api/client";
import { state } from "../store";
import { needsHomeScreen } from "./device";
import { choosePushKinds, turnOffNotifications, turnOnNotifications } from "./notifications";

/** the four kinds, as a person names them (design.md, attention) */
const KINDS: { kind: PushKind; label: string }[] = [
  { kind: "ask", label: "questions and permissions" },
  { kind: "done", label: "a turn you started is done" },
  { kind: "fault", label: "an agent stopped" },
  { kind: "ready", label: "ready to merge" },
];

/** notifications on this device: on or off, and which of the four kinds
    push here (the whole settings page for push, design.md: attention),
    until first run (m8) takes the line on why. */
export function NotificationsRow() {
  const chip = () => {
    if (state.push.permission === "unsupported") return "not in this browser";
    if (state.push.permission === "denied") return "blocked";
    return state.push.subscribed ? "on" : "off";
  };
  return (
    <section class="notify" aria-labelledby="notify-title" data-state={chip()}>
      <div class="notify-line">
        <h2 id="notify-title">notifications</h2>
        <span class="chip">{chip()}</span>
      </div>
      <p class="notify-why">
        <Show when={state.push.permission === "unsupported" && needsHomeScreen()} fallback="so boxbox can tell you when an agent needs you or finishes.">
          add boxbox to your home screen, then open it from there to get notifications.
        </Show>
      </p>
      <Switch>
        <Match when={state.push.permission === "default" || (state.push.permission === "granted" && !state.push.subscribed)}>
          <button class="primary" type="button" disabled={state.push.busy} onClick={() => void turnOnNotifications()}>
            turn on notifications
          </button>
        </Match>
        <Match when={state.push.subscribed}>
          <button class="quiet" type="button" disabled={state.push.busy} onClick={() => void turnOffNotifications()}>
            turn off notifications
          </button>
        </Match>
      </Switch>
      <Show when={state.push.subscribed}>
        <fieldset class="notify-kinds" disabled={state.push.busy}>
          <legend>push to this device</legend>
          <For each={KINDS}>
            {({ kind, label }) => (
              <label class="notify-kind">
                <input
                  type="checkbox"
                  checked={state.push.kinds.includes(kind)}
                  onChange={(event) => {
                    const on = event.currentTarget.checked;
                    const next = KINDS.map((k) => k.kind).filter((k) => (k === kind ? on : state.push.kinds.includes(k)));
                    void choosePushKinds(next);
                  }}
                />
                {label}
              </label>
            )}
          </For>
        </fieldset>
      </Show>
      <Show when={state.push.problem}>
        {(problem) => (
          <p class="problem" role="alert">
            {problem()}
          </p>
        )}
      </Show>
    </section>
  );
}
