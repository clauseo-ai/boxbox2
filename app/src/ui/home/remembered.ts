/* what this device remembers about home's two side columns (design.md, one layout law
   for three devices): whether the rail of windows is open or folded to its swatches, and what the
   inspector beside the stage shows. a preference of the device, not of the account: a phone and a
   mac fold differently. storage that is refused (a private window, a full disk) is ignored, and the
   defaults stand. */

export type RailState = "open" | "folded";
export type InspectorState = "details" | "turns" | "folded";

export const RAIL_KEY = "boxbox.rail";
export const INSPECTOR_KEY = "boxbox.inspector";

const RAIL_STATES: readonly RailState[] = ["open", "folded"];
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

export function readRail(store: Store | null = deviceStore()): RailState {
  return read(store, RAIL_KEY, RAIL_STATES) ?? "open";
}

export function readInspector(store: Store | null = deviceStore()): InspectorState {
  return read(store, INSPECTOR_KEY, INSPECTOR_STATES) ?? "details";
}

export function rememberRail(state: RailState, store: Store | null = deviceStore()): void {
  write(store, RAIL_KEY, state);
}

export function rememberInspector(state: InspectorState, store: Store | null = deviceStore()): void {
  write(store, INSPECTOR_KEY, state);
}
