/* the model menu (docs/composer.md, the model menu): the models a person uses, a star away from the rest. it opens on the
   starred models and the one in use, with a quiet switch to every model grouped under its provider; with nothing starred
   it opens on all of them and says one line about starring; typing searches all of them, the starred first. the rules are
   models.ts's; this draws them and walks them with arrows (shift and return stars, return uses, escape goes back to the
   words). state here is the menu's own and begins again each time it opens. */

import { createComputed, createEffect, createMemo, createSignal, For, on, Show, untrack } from "solid-js";
import { play } from "../../motion/animate";
import { SNAP } from "../../motion/springs";
import type { HostModels } from "../../store";
import { effortRange } from "./effort";
import { Icon } from "./icons";
import { ProviderMark } from "./mark";
import { providerKey, providerWords } from "./marks";
import { arrange, defaultView, type View } from "./models";
import { modelName } from "../model-name";
import type { ListState } from "./words";
import { modelsNote } from "./menu-words";

export type ModelChoice = HostModels["models"][number];

type ModelMenuProps = {
  models: HostModels | undefined;
  list: ListState;
  favorites: readonly string[];
  /** the model the thread (or this draft) is on: always on the short list, marked with a check */
  inUse: string | null;
  /** when a pick takes effect, in the a18 rule's words */
  when: string;
  /** " for the new thread" in the sheet, so every name stays unique beside the bar's */
  ofThread: string;
  /** a keyboard and a mouse: the filter takes focus when the menu opens. a phone keeps its keyboard down until the field is tapped */
  fine: boolean;
  onPick: (model: ModelChoice, fromFilter: boolean) => void;
  onStar: (id: string) => void;
  onRetry: () => void;
  /** escape: close, and the words take focus back */
  onEscape: () => void;
};

type Entry = { kind: "model"; model: ModelChoice } | { kind: "switch"; to: View };

export function ModelMenu(props: ModelMenuProps) {
  const [query, setQuery] = createSignal("");
  const [view, setView] = createSignal<View>("all");
  // the opening view is chosen once, when the list is first here: starring the first model in the whole list must not
  // collapse it under the finger that is starring
  let decided = false;
  createComputed(() => {
    const models = props.models;
    if (decided || !models) return;
    decided = true;
    setView(defaultView(models.models, untrack(() => props.favorites)));
  });

  const arranged = createMemo(() => arrange({ models: props.models?.models ?? [], favorites: props.favorites, inUse: props.inUse, query: query(), view: view() }));
  const stars = createMemo(() => new Set(props.favorites));
  const entries = createMemo<Entry[]>(() => {
    const shown = arranged();
    const rows: Entry[] = shown.rows.map((model) => ({ kind: "model", model }));
    if (!shown.toggle) return rows;
    const gate: Entry = { kind: "switch", to: shown.toggle.to };
    // the way to the short list is the first thing in the whole one; the way to the whole list is the last thing in the short one
    return shown.of === "favorites" ? [...rows, gate] : [gate, ...rows];
  });
  const at = createMemo(() => new Map(entries().flatMap((entry, i) => (entry.kind === "model" ? [[entry.model.id, i] as const] : []))));
  const [active, setActive] = createSignal(0);
  let root: HTMLDivElement | undefined;
  let find: HTMLInputElement | undefined;
  const scrollActive = () => queueMicrotask(() => root?.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" }));

  // the menu opens on the model in use, however far down it is; typing or switching moves to the best place to start
  createEffect(
    on([() => Boolean(props.models), view, query], ([ready, , typed]) => {
      if (!ready) return;
      const first = entries().findIndex((entry) => entry.kind === "model");
      const used = props.inUse === null ? -1 : (at().get(props.inUse) ?? -1);
      setActive(Math.max(0, typed.trim() ? first : used >= 0 ? used : first));
      scrollActive();
    }),
  );
  // the filter takes focus once, when the list is first here: a later read replaces the list and must not pull focus off a star
  createEffect(
    on(
      () => Boolean(props.models),
      (here) => {
        if (props.fine && here) queueMicrotask(() => find?.focus({ preventScroll: true }));
      },
    ),
  );

  const choose = (entry: Entry | undefined, fromFilter: boolean) => {
    if (!entry) return;
    if (entry.kind === "model") props.onPick(entry.model, fromFilter);
    else setView(entry.to);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const count = entries().length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!count) return;
      setActive((i) => (i + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
      scrollActive();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = entries()[active()];
      if (event.shiftKey) {
        if (entry?.kind === "model") props.onStar(entry.model.id);
      } else choose(entry, true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onEscape();
    }
  };

  // a menu rises into place on the snap spring (reduced motion lands it)
  const rise = (el: HTMLElement) => queueMicrotask(() => play(el, [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], SNAP));

  const row = (model: ModelChoice, meta: "provider" | "effort") => {
    const index = () => at().get(model.id) ?? -1;
    const used = () => model.id === props.inUse;
    const starred = () => stars().has(model.id);
    const words = providerWords(model.provider);
    return (
      <div class="cz-model-row" data-on={used() ? "" : undefined} data-active={index() === active() ? "" : undefined}>
        <button
          type="button"
          class="cz-option model"
          aria-label={`${modelName(model.id)}, ${words}${props.ofThread}`}
          aria-current={used() ? "true" : undefined}
          onPointerEnter={() => index() >= 0 && setActive(index())}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => props.onPick(model, document.activeElement === find)}
        >
          <ProviderMark provider={providerKey(model)} size={28} />
          <b class="cz-name">{modelName(model.id)}</b>
          <Show when={used()}>
            <span class="cz-check" aria-hidden="true"><Icon name="check" /></span>
          </Show>
          <em>{meta === "provider" ? words : effortRange(model.efforts)}</em>
        </button>
        <button
          type="button"
          class="cz-star"
          aria-pressed={starred() ? "true" : "false"}
          aria-label={`favorite ${modelName(model.id)}, ${words}${props.ofThread}`}
          onPointerDown={(e) => e.preventDefault()}
          onClick={(e) => {
            // the store takes the press at once, so whether the star was off is read before it is pressed
            const wasOff = !starred();
            props.onStar(model.id);
            // a star that is put on pops, once, on the snap spring: a real event, never a loop
            if (wasOff) play(e.currentTarget.querySelector("svg") ?? e.currentTarget, [{ transform: "scale(.55)" }, { transform: "scale(1.18)", offset: 0.55 }, { transform: "none" }], SNAP);
          }}
        >
          <Icon name="star" />
        </button>
      </div>
    );
  };

  const gate = (to: View, words: string) => (
    <button
      type="button"
      class="cz-switch"
      aria-label={`${to === "all" ? `show all ${props.models?.models.length ?? 0} models` : "show only your favorites"}${props.ofThread}`}
      data-active={entries()[active()]?.kind === "switch" ? "" : undefined}
      onPointerEnter={() => setActive(entries().findIndex((entry) => entry.kind === "switch"))}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => setView(to)}
    >
      <Icon name={to === "all" ? "chevronDown" : "star"} />
      <span>{words}</span>
    </button>
  );

  return (
    <div class="cz-model-menu" ref={(el) => { root = el; rise(el); }}>
      <p class="cz-menu-head">
        <span>the thread's model</span>
        <span>{props.when}</span>
      </p>
      <Show when={props.models}>
        <label class="cz-search cz-model-find">
          <Icon name="search" />
          <input
            ref={find}
            class="cz-find"
            type="text"
            value={query()}
            aria-label={`find a model${props.ofThread}`}
            aria-keyshortcuts="Shift+Enter"
            placeholder="type to find a model"
            autocapitalize="off"
            autocomplete="off"
            autocorrect="off"
            spellcheck={false}
            enterkeyhint="go"
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
        </label>
      </Show>
      <Show when={arranged().hint && !query().trim() && props.models}>
        <p class="cz-hint"><Icon name="star" />star the ones you use to keep this menu short</p>
      </Show>
      <Show when={arranged().toggle && arranged().of === "all"}>{gate(arranged().toggle?.to ?? "favorites", arranged().toggle?.words ?? "")}</Show>
      <Show
        when={arranged().rows.length > 0}
        fallback={
          <>
            <Show when={props.models} fallback={<p class="cz-note" role="status">{modelsNote(props.list === "failed" ? "failed" : "loading")}</p>}>
              <p class="cz-note">{query().trim() ? `no model matches "${query().trim()}".` : "this machine lists no models."}</p>
            </Show>
            <Show when={props.list === "failed"}>
              <button type="button" class="cz-option tool" aria-label={`read the models again${props.ofThread}`} onPointerDown={(e) => e.preventDefault()} onClick={props.onRetry}>
                <span class="cz-tile"><Icon name="retry" /></span>
                <b>retry</b>
                <em>read the models again</em>
              </button>
            </Show>
          </>
        }
      >
        <Show when={arranged().shape === "grouped"} fallback={<For each={arranged().rows}>{(model) => row(model, "provider")}</For>}>
          <For each={arranged().groups}>
            {(group) => (
              <div class="cz-group" role="group" aria-label={group.words}>
                <p class="cz-group-head">
                  <ProviderMark provider={group.key} size={18} />
                  <span class="cz-group-name">{group.words}</span>
                  <em>{group.models.length}</em>
                </p>
                <For each={group.models}>{(model) => row(model, "effort")}</For>
              </div>
            )}
          </For>
        </Show>
      </Show>
      <Show when={arranged().toggle && arranged().of === "favorites"}>{gate(arranged().toggle?.to ?? "all", arranged().toggle?.words ?? "")}</Show>
      <Show when={props.fine && props.models}>
        <p class="cz-keys" aria-hidden="true">
          <span><kbd>↑↓</kbd> move</span>
          <span><kbd>↵</kbd> use</span>
          <span><kbd>⇧↵</kbd> star</span>
        </p>
      </Show>
    </div>
  );
}
