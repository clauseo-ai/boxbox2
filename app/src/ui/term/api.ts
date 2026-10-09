/* the terminal's rest calls, through boxbox's routes (server/src/pty).
   each answers the value or a problem in the interface's voice; none
   throws. a success body is cmx2's own json, passed through byte for byte,
   so it is typed by the vendored contract rather than boxbox's document,
   which can only call it an object. */

import { api } from "../../api/client";
import type { components } from "../../api/boxbox";
import { setShells, setTerminalList } from "../../store";
import type { PtyInfo, Shell } from "./types";

export type Result<T> = { ok: true; value: T } | { ok: false; problem: string };

type ErrorBody = components["schemas"]["ErrorBody"];
type Answer = { data?: unknown; error?: unknown; response: Response };

const UNREACHABLE = "the boxbox server is not answering. check it is running, then try again.";

/** the one place a passed-through body takes the contract's type; the server checked it came from the host */
function answer<T>({ data, error, response }: Answer): Result<T> {
  if (response.ok && data !== undefined) return { ok: true, value: data as T };
  const message = (error as ErrorBody | undefined)?.error?.message;
  return { ok: false, problem: message ?? `the server answered ${response.status}.` };
}

async function attempt<T>(call: () => Promise<Answer>): Promise<Result<T>> {
  try {
    return answer<T>(await call());
  } catch {
    return { ok: false, problem: UNREACHABLE };
  }
}

/** reads the host's terminals into the store */
export async function refreshTerminals(host: string): Promise<Result<PtyInfo[]>> {
  const result = await attempt<PtyInfo[]>(() => api.GET("/api/hosts/{host}/pty", { params: { path: { host } } }));
  if (result.ok) setTerminalList(host, result.value);
  return result;
}

/** reads the host's login shells into the store */
export async function refreshShells(host: string): Promise<Result<Shell[]>> {
  const result = await attempt<Shell[]>(() => api.GET("/api/hosts/{host}/pty/shells", { params: { path: { host } } }));
  if (result.ok) setShells(host, result.value);
  return result;
}

/** opens a terminal: the host's login shell, or `shell` started as a login shell */
export function createTerminal(host: string, options: { title: string; shell?: Shell; cwd?: string }): Promise<Result<PtyInfo>> {
  const body = {
    title: options.title,
    ...(options.shell ? { command: options.shell.path, args: ["-l"] } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
  return attempt<PtyInfo>(() => api.POST("/api/hosts/{host}/pty", { params: { path: { host } }, body }));
}

export function renameTerminal(host: string, id: string, title: string): Promise<Result<PtyInfo>> {
  return attempt<PtyInfo>(() => api.PUT("/api/hosts/{host}/pty/{id}", { params: { path: { host, id } }, body: { title } }));
}

export function resizeTerminal(host: string, id: string, cols: number, rows: number): Promise<Result<PtyInfo>> {
  return attempt<PtyInfo>(() =>
    api.PUT("/api/hosts/{host}/pty/{id}", { params: { path: { host, id } }, body: { size: { cols, rows } } }),
  );
}

export function killTerminal(host: string, id: string): Promise<Result<boolean>> {
  return attempt<boolean>(() => api.DELETE("/api/hosts/{host}/pty/{id}", { params: { path: { host, id } } }));
}
