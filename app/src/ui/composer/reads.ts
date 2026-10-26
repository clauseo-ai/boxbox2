/* what the composer's menus are drawn from, through boxbox's api (never
   straight to a daemon): the thread directory's `/` commands, files that
   match an `@`, and the host's models and their efforts. commands are kept a while per host and directory, in a map with
   a fixed number of entries; files are read per keystroke pause and never kept. the repos and folders a new thread can
   start in are `place-reads.ts`, with home's field in its own chunk. */

import type { components } from "../../api/boxbox";
import { api } from "../../api/client";
import { setModels, setModelsRead, state } from "../../store";

export type CommandChoice = components["schemas"]["CommandChoice"];

/** entries kept per kind; the oldest leaves first */
const KEPT = 12;
/** how long a kept list is trusted before it is read again */
const FRESH_MS = 60_000;

type Kept<T> = { at: number; value: T };

export function keeper<T>() {
  const kept = new Map<string, Kept<T>>();
  return {
    get(key: string): T | null {
      const hit = kept.get(key);
      return hit && Date.now() - hit.at < FRESH_MS ? hit.value : null;
    },
    set(key: string, value: T): void {
      kept.delete(key);
      kept.set(key, { at: Date.now(), value });
      if (kept.size > KEPT) kept.delete(kept.keys().next().value as string);
    },
  };
}

const commandsKept = keeper<CommandChoice[]>();

/** a read's answer, or what to say when it did not come */
export type Read<T> = { ok: true; value: T } | { ok: false; message: string };

export const DID_NOT_ANSWER = "the host did not answer. try again in a moment";
/** the `@` menu shows this many; the daemon's default is 10 */
const FILES_SHOWN = 20;

export async function commands(host: string, directory: string): Promise<Read<CommandChoice[]>> {
  const key = `${host} ${directory}`;
  const kept = commandsKept.get(key);
  if (kept) return { ok: true, value: kept };
  try {
    const { data, error } = await api.GET("/api/hosts/{host}/commands", { params: { path: { host }, query: { directory } } });
    if (!data) return { ok: false, message: error?.error.message ?? DID_NOT_ANSWER };
    commandsKept.set(key, data);
    return { ok: true, value: data };
  } catch {
    return { ok: false, message: DID_NOT_ANSWER };
  }
}

export async function files(host: string, directory: string, query: string): Promise<Read<string[]>> {
  try {
    // the daemon's answer passes through as it came: a list of paths relative to the directory
    const { data, response } = await api.GET("/api/hosts/{host}/find/file", { params: { path: { host }, query: { directory, query, limit: FILES_SHOWN } } });
    if (Array.isArray(data) && data.every((path) => typeof path === "string")) return { ok: true, value: data as string[] };
    return { ok: false, message: response.ok ? "the file list came back in a shape this app does not read" : DID_NOT_ANSWER };
  } catch {
    return { ok: false, message: DID_NOT_ANSWER };
  }
}

/** a read of a host's models that is in flight, so a menu, a chip and a retry asking at once make one request */
const reading = new Map<string, Promise<void>>();
/** a model list that takes longer than this did not come: the picker must not say "reading" for ever */
const MODELS_MS = 10_000;

/** the host's models, read into the store through `fetchList` (`GET /config/providers` through boxbox, for the app). a read
    that fails or hangs is recorded as such (`state.modelsRead`), so the picker says the models did not come and offers a
    retry; asking again reads again. a list already in the store is not read twice, and asks that overlap make one read */
export function readModels(host: string, fetchList: () => Promise<components["schemas"]["HostModels"] | null>): Promise<void> {
  if (state.models[host]) return Promise.resolve();
  const flying = reading.get(host);
  if (flying) return flying;
  setModelsRead(host, "loading");
  const read = (async () => {
    try {
      const list = await fetchList();
      if (list) setModels(host, list);
      else setModelsRead(host, "failed");
    } catch {
      setModelsRead(host, "failed");
    } finally {
      reading.delete(host);
    }
  })();
  reading.set(host, read);
  return read;
}

export function ensureModels(host: string): Promise<void> {
  return readModels(host, async () => {
    const { data } = await api.GET("/api/hosts/{host}/models", { params: { path: { host } }, signal: AbortSignal.timeout(MODELS_MS) });
    return data ?? null;
  });
}
