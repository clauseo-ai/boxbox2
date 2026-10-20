/* the plus menu's rows (docs/composer.md, the plus menu): a photo, a file, the commands, a mention, the shell, compacting,
   the agents and the full stage. drawn only after the plus key is pressed, so it is a chunk of its own (later.ts); the
   menu's box, its arrows and its escape stay the composer's, which owns the draft every row writes to. */

import { Show } from "solid-js";
import { ContextRing } from "./context";
import { MAX_ATTACHMENTS } from "./fit";
import { Icon, type IconName } from "./icons";
import { type Agent, type ContextFill, compactMeta } from "./words";

type ToolsMenuProps = {
  host: string;
  /** a thread's composer offers compacting; the new-thread sheet's has nothing to compact */
  session: boolean;
  agents: { count: number; open: () => void } | undefined;
  /** the draft is tall and not yet on the full stage */
  expand: boolean;
  fill: ContextFill | null;
  compacting: boolean;
  agent: Agent;
  /** each row's press; the composer closes the menu or turns it into another as the row says */
  onPhoto: () => void;
  onFile: () => void;
  onCommands: () => void;
  onMention: () => void;
  onShell: () => void;
  onCompact: () => void;
  onAgents: () => void;
  onExpand: () => void;
};

/* a press keeps the focus in the editor, so the keyboard stays up on a phone */
const keepFocus = (e: PointerEvent) => e.preventDefault();

export function ToolsMenu(props: ToolsMenuProps) {
  return (
    <>
      <button type="button" class="cz-option tool" role="menuitem" aria-label="add a photo" onPointerDown={keepFocus} onClick={() => props.onPhoto()}>
        <ToolTile icon="photo" />
        <b>photo</b>
        <em>{MAX_ATTACHMENTS} at most</em>
      </button>
      <button type="button" class="cz-option tool" role="menuitem" aria-label="add a file" onPointerDown={keepFocus} onClick={() => props.onFile()}>
        <ToolTile icon="doc" />
        <b>file</b>
        <em>pdf, text or json</em>
      </button>
      <button type="button" class="cz-option tool" role="menuitem" aria-label="commands" onPointerDown={keepFocus} onClick={() => props.onCommands()}>
        <ToolTile icon="command" />
        <b>commands</b>
        <em>this directory's</em>
      </button>
      <button type="button" class="cz-option tool" role="menuitem" aria-label="mention a file" onPointerDown={keepFocus} onClick={() => props.onMention()}>
        <ToolTile icon="file" />
        <b>mention</b>
        <em>a file on {props.host}</em>
      </button>
      <button type="button" class="cz-option tool" role="menuitem" aria-label="run in the shell" onPointerDown={keepFocus} onClick={() => props.onShell()}>
        <ToolTile icon="terminal" />
        <b>shell</b>
        <em>runs on {props.host}</em>
      </button>
      <Show when={props.session}>
        <button
          type="button"
          class="cz-option tool"
          role="menuitem"
          aria-label={`compact the thread${props.fill ? `, the context is ${props.fill.percent}% full` : ""}`}
          aria-disabled={props.compacting || props.agent !== "idle" ? "true" : undefined}
          title={props.fill?.words}
          onPointerDown={keepFocus}
          onClick={() => props.onCompact()}
        >
          <ToolTile icon="compact" />
          <span class="cz-tool-text">
            <b>compact</b>
            <small>summarises the thread so far to free the context</small>
          </span>
          <em class="cz-ctx">
            <Show when={props.agent === "idle" && !props.compacting ? props.fill : null}>{(f) => <ContextRing fill={f()} />}</Show>
            {compactMeta(props.agent, props.compacting, props.fill)}
          </em>
        </button>
      </Show>
      <Show when={props.agents}>
        {(agents) => (
          <button type="button" class="cz-option tool" role="menuitem" aria-label={`agents, ${agents().count}`} onPointerDown={keepFocus} onClick={() => props.onAgents()}>
            <ToolTile icon="agents" />
            <b>agents</b>
            <em>{agents().count ? `${agents().count} started` : "none yet"}</em>
          </button>
        )}
      </Show>
      <Show when={props.expand}>
        <button type="button" class="cz-option tool" role="menuitem" aria-label="write on the full stage" onPointerDown={keepFocus} onClick={() => props.onExpand()}>
          <ToolTile icon="expand" />
          <b>full stage</b>
          <em>the draft as the page</em>
        </button>
      </Show>
    </>
  );
}

/** a tool row's icon, in its quiet tile */
function ToolTile(props: { icon: IconName }) {
  return (
    <span class="cz-tile" aria-hidden="true">
      <Icon name={props.icon} />
    </span>
  );
}
