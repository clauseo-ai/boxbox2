/* the one client for boxbox's own api, typed by the generated document.
   same origin, so the session cookie rides along; nothing here knows a
   host credential, since those never leave the server. */

import createClient from "openapi-fetch";
import type { components, paths } from "./boxbox";

export const api = createClient<paths>({ baseUrl: "", credentials: "same-origin" });

export type HostStatus = components["schemas"]["HostStatus"];
export type Connection = components["schemas"]["Connection"];
export type PushKind = components["schemas"]["PushKind"];
export type PresenceReport = components["schemas"]["PresenceReport"];
