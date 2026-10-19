/* the one client for boxbox's own api, typed by the generated document.
   same origin, so the session cookie rides along; nothing here knows a
   host credential, since those never leave the server. */

import createClient from "openapi-fetch";
import { type Outcome, said, UNREACHABLE } from "../ui/machines/said";
import type { components, paths } from "./boxbox";

export const api = createClient<paths>({ baseUrl: "", credentials: "same-origin" });

export type HostStatus = components["schemas"]["HostStatus"];
export type Connection = components["schemas"]["Connection"];
export type PushKind = components["schemas"]["PushKind"];
export type PresenceReport = components["schemas"]["PresenceReport"];
/** one repo's colour as the server holds it: what it gave (`auto`) and what the person chose (`chosen`, null for automatic) */
export type RepoColourChoice = components["schemas"]["RepoColour"];

/** a choice's outcome, with the http status and the server's error code (`ErrorDetail.code`, null when the body carried
    none, as a proxy's 503 does) of a refusal. only `store-down` comes after every stream has heard the choice (the server
    could not keep it), which the colour sheet says differently from a choice that went nowhere. no status: the server
    did not answer */
export type ColourOutcome = Outcome<RepoColourChoice> | { ok: false; error: string; status: number; code: string | null };

/** chooses the colour a repo (a host and its root) wears on every device, by one of the ten's names, or automatic with
    null. the answer is the colour as the server now holds it, or what went wrong in the server's words. the store is not
    touched here: the same change reaches every client, this one included, as a `colour` frame on the stream, and that
    is what repaints */
export async function chooseColour(host: string, root: string, chosen: string | null): Promise<ColourOutcome> {
  try {
    const { data, error, response } = await api.PUT("/api/prefs/colours", { body: { host, root, chosen } });
    if (data) return { ok: true, value: data };
    const code = (error as { error?: { code?: unknown } } | undefined)?.error?.code;
    return { ok: false, error: said(error, response.status), status: response.status, code: typeof code === "string" ? code : null };
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}
