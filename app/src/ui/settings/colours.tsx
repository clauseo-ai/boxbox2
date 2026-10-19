/* settings' repo colours (docs/design.md, settings and the colour sheet): every repo the fleet knows, one row each, with
   the colour it wears on every device and whether boxbox gave it or a person chose it. a press opens the same sheet the
   thread's menu and its repo line open. a repo here is a machine and a project root, as colours are kept: a worktree is
   its repo, unlike the new-thread defaults above, which are kept per folder. */

import { For, Show, createMemo, createSignal, lazy } from "solid-js";
import { state } from "../../store";
import { colourLine } from "../colour/picker-model";
import { repoRootOf } from "../composer/place";
import { RepoMark } from "../repo-mark/repo-mark";
import { placeName } from "../thread/place";
import { colourStyle } from "../window/repo";

/* most visits to settings never open it */
const ColourSheet = lazy(() => import("../colour/sheet").then((m) => ({ default: m.ColourSheet })));

type Coloured = { host: string; root: string; name: string; seen: number };

/** the repos with threads, the most recent first, then every repo the server has a colour for, by machine and name */
function colouredRepos(): Coloured[] {
  const byKey = new Map<string, Coloured>();
  for (const session of Object.values(state.fleet.sessions)) {
    const root = repoRootOf(session.info);
    const key = `${session.host}:${root}`;
    const seen = session.info.time.updated;
    const known = byKey.get(key);
    if (!known || known.seen < seen) byKey.set(key, { host: session.host, root, name: placeName(root, session.host), seen });
  }
  for (const host of state.fleet.hostNames) {
    for (const key of Object.keys(state.fleet.colours)) {
      if (!key.startsWith(`${host}:`) || byKey.has(key)) continue;
      const root = key.slice(host.length + 1);
      byKey.set(key, { host, root, name: placeName(root, host), seen: 0 });
    }
  }
  return [...byKey.values()].sort((a, b) => b.seen - a.seen || a.host.localeCompare(b.host) || a.name.localeCompare(b.name));
}

export function RepoColours() {
  const list = createMemo(colouredRepos);
  const [open, setOpen] = createSignal<{ repo: Coloured; from: HTMLElement } | null>(null);
  const close = () => {
    const from = open()?.from;
    setOpen(null);
    if (from?.isConnected) from.focus({ preventScroll: true });
  };
  return (
    <section class="settings-group" aria-labelledby="colours-title">
      <h2 id="colours-title">repo colours</h2>
      <Show when={list().length > 0} fallback={<p class="setting-hint">no repos yet. once a machine has threads, each repo's colour is here.</p>}>
        <ul class="repo-list" aria-label="repo colours">
          <For each={list()}>{(repo) => {
            const line = () => colourLine(repo, state.fleet.colours);
            return (
              <li>
                <button type="button" class="repo-colour" aria-label={`${repo.name} on ${repo.host}, ${line().colour.name}, ${line().automatic ? "automatic" : "chosen"}. choose its colour`} onClick={(e) => setOpen({ repo, from: e.currentTarget })}>
                  <RepoMark host={repo.host} root={repo.root} name={repo.name} size={36} />
                  <span class="repo-name">
                    <span>{repo.name}</span>
                    <span class="repo-colour-where">{repo.host}</span>
                  </span>
                  <span class="repo-colour-now">
                    <i class="repo-colour-dot plane-window" style={colourStyle(line().colour)} aria-hidden="true" />
                    {line().text}
                  </span>
                  <i class="repo-colour-chev" aria-hidden="true" />
                </button>
              </li>
            );
          }}</For>
        </ul>
      </Show>
      <Show when={open()} keyed>{(o) => <ColourSheet host={o.repo.host} root={o.repo.root} name={o.repo.name} onClose={close} />}</Show>
    </section>
  );
}
