/* the field's keys over an open token menu (docs/design.md, home: what next; decision 104), as pure rules so keys.test.ts
   is the whole story: what is highlighted when a menu opens, and what return, tab, the arrows and escape do.

   nothing resolves on a guess. a menu opened by typing has no row highlighted unless the typed word names a row exactly
   (a repo's name, a machine's name, a model's name or id); return with nothing highlighted is the composer's own (it sends
   the words as typed, "cc @alice" stays "cc @alice"), and tab with nothing highlighted does what tab does. a menu opened
   by a tap on a chip was opened on purpose, so its first row may be highlighted. "other folder" is never highlighted by
   itself, typed or tapped. keys pressed while an input method is composing (japanese, chinese) are the composition's. */

import { modelName } from "../model-name";
import { repoName } from "../window/repo";

/** a row of the open menu, flattened so the arrows and return walk one list */
export type Row =
  | { kind: "repo"; host: string; root: string; note: string }
  | { kind: "folder"; host: string; dir: string; name: string; repo: boolean }
  | { kind: "use"; host: string; dir: string }
  | { kind: "up"; dir: string }
  | { kind: "other" }
  | { kind: "machine"; name: string }
  | { kind: "model"; id: string; efforts: string[] };

/** how the menu was opened: by a token typed in the words, or by a tap on a chip */
export type Opened = "typed" | "tap";

/** the row a typed word names exactly, or none: a path, typed, is never taken by itself (prose is full of paths) */
export function exactRow(rows: readonly Row[], query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const said = q.replace(/[-_]/g, " ");
  const at = rows.findIndex((row) => {
    if (row.kind === "repo") return repoName(row.root).toLowerCase() === q;
    if (row.kind === "machine") return row.name.toLowerCase() === q;
    if (row.kind === "model") return row.id.toLowerCase() === q || (row.id.split("/").at(-1) ?? "").toLowerCase() === q || modelName(row.id) === said;
    return false;
  });
  return at < 0 ? null : at;
}

/** the row highlighted as a menu opens or its rows change, before an arrow moves it */
export function firstActive(rows: readonly Row[], opened: Opened, query: string): number | null {
  if (opened === "typed") return exactRow(rows, query);
  const at = rows.findIndex((row) => row.kind !== "other");
  return at < 0 ? null : at;
}

/** an input method is composing: its return commits the composition, its escape cancels it */
export function composing(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

/** what a key does over an open menu. `pass` leaves it to whatever has focus (the composer sends on return) */
export type MenuAction = { kind: "move"; to: number } | { kind: "choose"; index: number } | { kind: "look"; index: number } | { kind: "close" } | { kind: "hold" } | { kind: "pass" };

/** a key over the open menu: `count` rows, `active` the highlighted one (null: none), `inFind` focus in the menu's finder,
    `lookable` the highlighted row a folder with the finder's caret at its end, where the right arrow looks inside it */
export function menuKey(key: { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }, count: number, active: number | null, inFind: boolean, lookable = false): MenuAction {
  if (composing(key)) return { kind: "pass" };
  if (key.key === "ArrowRight" && inFind && lookable && active !== null) return { kind: "look", index: active };
  if (key.key === "ArrowDown" || key.key === "ArrowUp") {
    if (!count) return { kind: "pass" };
    const down = key.key === "ArrowDown";
    // from nothing highlighted, down is the first row and up the last
    if (active === null) return { kind: "move", to: down ? 0 : count - 1 };
    return { kind: "move", to: (active + (down ? 1 : -1) + count) % count };
  }
  if (key.key === "Tab" || (key.key === "Enter" && !key.shiftKey)) {
    if (active !== null && active < count) return { kind: "choose", index: active };
    // return in the finder with nothing highlighted has nothing to send: it is held there and does nothing
    return key.key === "Enter" && inFind ? { kind: "hold" } : { kind: "pass" };
  }
  if (key.key === "Escape") return { kind: "close" };
  return { kind: "pass" };
}
