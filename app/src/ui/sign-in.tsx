import { createSignal, Show } from "solid-js";
import { clearProblem, signIn, state } from "../store";

export function SignIn() {
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy() || password().length === 0) return;
    setBusy(true);
    const ok = await signIn(password());
    setBusy(false);
    if (!ok) setPassword("");
  }

  return (
    <section class="gate" aria-labelledby="gate-title">
      <h1 id="gate-title" class="wordmark">
        boxbox
      </h1>
      <form class="gate-form" onSubmit={submit}>
        <label class="field">
          <span class="field-label">password</span>
          <input
            type="password"
            name="password"
            autocomplete="current-password"
            required
            value={password()}
            onInput={(e) => {
              setPassword(e.currentTarget.value);
              clearProblem();
            }}
            aria-invalid={state.problem !== null}
            aria-describedby="gate-problem"
          />
        </label>
        <button class="primary" type="submit" disabled={busy()}>
          {busy() ? "signing in" : "sign in"}
        </button>
        <p id="gate-problem" class="problem" role="alert">
          <Show when={state.problem}>{(problem) => problem()}</Show>
        </p>
      </form>
    </section>
  );
}
