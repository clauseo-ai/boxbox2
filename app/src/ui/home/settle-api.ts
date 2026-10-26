/* the server's side of settling, as the app asks for it (docs/home.md, settle): bringing cleared threads back, from the undo
   toast (`undo`) or the away sheet (`away`), and acknowledging the away list. each answers once the server has committed;
   the stream then brings the threads back to home where the order puts them, and an empty away list. */

import { api } from "../../api/client";
import { deviceIdentity } from "../../sync/client";
import { dropUndo, liveUndo, undoBusy, undoFailed } from "../../store";
import { said, UNREACHABLE } from "../machines/verb";
import { markBroughtBack } from "../window/clearing";

export type UnclearSource = "undo" | "away";

/** what came back: the keys the server brought back, and why the rest stayed (a mark already spent counts as back: the
    thread is on home), or what went wrong with the whole call */
export type Brought = { ok: true; back: string[]; refused: { key: string; message: string }[] } | { ok: false; error: string };

/** the server takes at most this many keys in one call (UnclearBody) */
export const UNCLEAR_MAX = 300;

export async function unclear(keys: readonly string[], source: UnclearSource): Promise<Brought> {
  if (keys.length === 0) return { ok: true, back: [], refused: [] };
  try {
    const { data, error, response } = await api.POST("/api/unclear", { body: { ...deviceIdentity(), keys: keys.slice(0, UNCLEAR_MAX), source } });
    if (!data) return { ok: false, error: said(error, response.status) };
    // their windows are born at once when the order brings them (clearing.ts), as a hand clear's hole closes at once
    markBroughtBack(data.uncleared);
    // a key whose mark was already spent is on home already: what the person asked for holds
    const spent = data.refused.filter((r) => r.why === "notcleared").map((r) => r.key);
    return { ok: true, back: [...data.uncleared, ...spent], refused: data.refused.filter((r) => r.why !== "notcleared").map((r) => ({ key: r.key, message: r.message })) };
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
}

/** the away list is seen (shown or dismissed): it leaves every device, and the threads stay cleared */
export async function awaySeen(): Promise<string | null> {
  try {
    const { error, response } = await api.POST("/api/away/seen", { body: deviceIdentity() });
    return response.ok ? null : said(error, response.status);
  } catch {
    return UNREACHABLE;
  }
}

/** the toast's undo, from its button or ⌘z: brings back exactly what the clear on screen cleared (an offer whose time ran
    out is no offer). the toast goes once all of it is back; a refusal or a failure always shows, saying why, even when a
    newer toast took over meanwhile (store.ts, `undoFailed`) */
export async function undoLast(): Promise<void> {
  const live = liveUndo();
  if (!live || live.busy) return;
  // a copy: the store merges a newer offer into the same object, and a failure must name this one
  const undo = { ...live, keys: [...live.keys] };
  undoBusy(undo.serial, true);
  const result = await unclear(undo.keys, "undo");
  if (!result.ok) return undoFailed(undo, `not brought back. ${result.error}`);
  const first = result.refused[0];
  if (first) return undoFailed(undo, result.refused.length === 1 ? first.message : `${result.refused.length} not brought back. ${first.message}`);
  dropUndo(undo.serial);
}
