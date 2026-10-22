/* what the composer's menu shows while the draft begins a command, a mention or a shell line (docs/composer.md, the
   menus): the `/` commands of the thread's directory, the files an `@` matches, and what a `!` line will do. the words
   typed open it, never the first paint, so it is a chunk of its own (ui/later.ts), warmed with the other surfaces; the
   composer reads the lists, walks them with the keyboard and picks. its look is composer.css. */

import { For, Show } from "solid-js";
import type { CommandChoice } from "./reads";
import { ContextRing } from "./context";
import { type ContextFill, slashShowsFill } from "./words";

export type SlashChoice = CommandChoice & { local?: boolean };

export type SuggestionsProps = {
  menu: "/" | "@" | "!";
  repo: string;
  host: string;
  /** the commands that match what is typed, the composer's own first */
  commands: readonly SlashChoice[];
  /** the directory's commands have been read */
  commandsRead: boolean;
  /** the files that match the `@`, null while they are read */
  files: readonly string[] | null;
  /** why a list could not be read */
  problem: string | null;
  /** what follows the `/` */
  query: string;
  /** the shell line's command, without its `!` */
  command: string;
  /** the option the keyboard is on */
  index: number;
  fill: ContextFill | null;
  onPick: (index: number) => void;
};

export function Suggestions(props: SuggestionsProps) {
  return (
    <>
      <Show when={props.menu === "/"}>
        <p class="cz-menu-head">commands in {props.repo}</p>
        <For each={props.commands} fallback={<p class="cz-note">{props.problem ?? (!props.commandsRead ? "reading the commands." : `no command starts with "${props.query}". it will go as a message.`)}</p>}>
          {(choice, index) => (
            <button type="button" class="cz-option" role="option" aria-selected={index() === props.index ? "true" : "false"} data-on={index() === props.index ? "" : undefined} onPointerDown={(e) => e.preventDefault()} onClick={() => props.onPick(index())}>
              <b>/{choice.name}</b>
              <span>{choice.description ?? ""}</span>
              <em class="cz-ctx">
                <Show when={slashShowsFill(choice) ? props.fill : null}>{(f) => <><ContextRing fill={f()} />{f().percent}%</>}</Show>
                {choice.hints.join(" ")}
              </em>
            </button>
          )}
        </For>
        <Show when={props.commands.length > 0 && (!props.commandsRead || props.problem)}>
          <p class="cz-note">{props.problem ?? "reading the commands."}</p>
        </Show>
      </Show>
      <Show when={props.menu === "@"}>
        <p class="cz-menu-head">files in {props.repo}</p>
        <For each={props.files ?? []} fallback={<p class="cz-note">{props.problem ?? (props.files === null ? "looking." : "no file matches.")}</p>}>
          {(path, index) => (
            <button type="button" class="cz-option file" role="option" aria-selected={index() === props.index ? "true" : "false"} data-on={index() === props.index ? "" : undefined} onPointerDown={(e) => e.preventDefault()} onClick={() => props.onPick(index())}>
              <b>{path.split("/").at(-1)}</b>
              <span>{path.split("/").slice(0, -1).join("/") || "."}</span>
            </button>
          )}
        </For>
      </Show>
      <Show when={props.menu === "!"}>
        <p class="cz-note">runs <b>{props.command || "a command"}</b> on {props.host}, in {props.repo}, as its own row in the thread. it starts no turn; the agent reads the output on its next one.</p>
      </Show>
    </>
  );
}
