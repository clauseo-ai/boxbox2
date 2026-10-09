/* the terminal's verbs on the route table (docs/architecture.md, the route
   table): `?terminal=<host>:<id>` opens over the machines, and closing it
   goes back to them. the shell's navigation is the one writer of the url
   and the store; this names the two moves the pane and the machine windows
   make. */

import { navigate } from "../../shell/navigation";
import type { TerminalRef } from "./types";

export function openTerminal(terminal: TerminalRef): void {
  navigate({ name: "terminal", terminal });
}

/** the pane's `‹`, its `esc` and the ended plate's "close": back to the machines, the terminal's parent */
export function closeTerminal(): void {
  navigate({ name: "machines" });
}
