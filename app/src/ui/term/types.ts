/* the terminal's types. a terminal and a shell are cmx2's shapes, passed
   through the server byte for byte, so they come from the vendored
   contract; the rest are the pane's own. */

import type { components, operations } from "../../api/cmx2";

export type PtyInfo = components["schemas"]["PtyInfo"];
export type Shell = operations["ptyShells"]["responses"][200]["content"]["application/json"][number];

/** a terminal: the host it lives on and its id there */
export type TerminalRef = { host: string; id: string };

/** the pane's connection to the relay: opening, showing live output, lost and redialling, or over for good */
export type Link = "connecting" | "live" | "down" | "ended";
