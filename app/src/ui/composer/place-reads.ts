/* where a new thread can start, through boxbox's api (never straight to a daemon): the repos a machine has (kept a while
   per host, as the composer's commands are) and the folders inside a folder on it. only home's field reads them, so they
   ride in its chunk (ui/later.ts, `NextUp`) and not the first load. */

import type { components } from "../../api/boxbox";
import { api } from "../../api/client";
import { DID_NOT_ANSWER, keeper, type Read } from "./reads";

export type ProjectChoice = components["schemas"]["ProjectChoice"];
export type FolderList = components["schemas"]["Folders"];

const projectsKept = keeper<ProjectChoice[]>();

export async function projects(host: string): Promise<Read<ProjectChoice[]>> {
  const kept = projectsKept.get(host);
  if (kept) return { ok: true, value: kept };
  try {
    const { data, error } = await api.GET("/api/hosts/{host}/projects", { params: { path: { host } } });
    if (!data) return { ok: false, message: error?.error.message ?? DID_NOT_ANSWER };
    projectsKept.set(host, data);
    return { ok: true, value: data };
  } catch {
    return { ok: false, message: DID_NOT_ANSWER };
  }
}

/** the folders inside one folder on the host (cmx2's /global/fs through boxbox), for a thread in a place no thread has
    been in; read per pause in typing and never kept. `path` is absolute or starts with `~` */
export async function folders(host: string, path: string, prefix = ""): Promise<Read<FolderList>> {
  try {
    const { data, error } = await api.GET("/api/hosts/{host}/folders", { params: { path: { host }, query: { path, ...(prefix ? { prefix } : {}) } } });
    if (!data) return { ok: false, message: error?.error.message ?? DID_NOT_ANSWER };
    return { ok: true, value: data };
  } catch {
    return { ok: false, message: DID_NOT_ANSWER };
  }
}
