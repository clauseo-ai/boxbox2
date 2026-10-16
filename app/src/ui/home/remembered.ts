/* what this device remembers about home's side columns (design.md, one layout law
   for three devices): whether the strip's row of windows is open or folded to its swatches, whether
   the windows are put away (focus), and what the inspector beside the stage shows. the rail is not
   remembered: it folds only while the details need its room (the native app's ipadfit), so
   `boxbox.rail`, which a person's fold once wrote, is no longer read. a preference of the device, not of the account: a phone and a
   mac fold differently. storage that is refused (a private window, a full disk) is ignored, and the
   defaults stand. */

export type RailState = "open" | "folded";
export type FocusState = "shown" | "hidden";
export type InspectorState = "details" | "turns" | "folded";

export const INSPECTOR_KEY = "boxbox.inspector";
export const STRIP_KEY = "boxbox.strip";
export const FOCUS_KEY = "boxbox.focus";

const RAIL_STATES: readonly RailState[] = ["open", "folded"];
const FOCUS_STATES: readonly FocusState[] = ["shown", "hidden"];
const INSPECTOR_STATES: readonly InspectorState[] = ["details", "turns", "folded"];

type Store = Pick<Storage, "getItem" | "setItem">;

/** reading `localStorage` itself throws where storage is blocked */
function deviceStore(): Store | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

function read<T extends string>(store: Store | null, key: string, allowed: readonly T[]): T | undefined {
  try {
    const value = store?.getItem(key);
    return allowed.find((state) => state === value);
  } catch {
    return undefined;
  }
}

function write(store: Store | null, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    // refused: the choice holds for this page and is forgotten after it
  }
}

export function readFocus(store: Store | null = deviceStore()): FocusState {
  return read(store, FOCUS_KEY, FOCUS_STATES) ?? "shown";
}

export function rememberFocus(state: FocusState, store: Store | null = deviceStore()): void {
  write(store, FOCUS_KEY, state);
}

export function readStrip(store: Store | null = deviceStore()): RailState {
  return read(store, STRIP_KEY, RAIL_STATES) ?? "open";
}

export function rememberStrip(state: RailState, store: Store | null = deviceStore()): void {
  write(store, STRIP_KEY, state);
}

export function readInspector(store: Store | null = deviceStore()): InspectorState {
  return read(store, INSPECTOR_KEY, INSPECTOR_STATES) ?? "details";
}

export function rememberInspector(state: InspectorState, store: Store | null = deviceStore()): void {
  write(store, INSPECTOR_KEY, state);
}
