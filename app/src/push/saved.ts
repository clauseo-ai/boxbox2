/* this device's push subscription as the server last held it (push/notifications.ts). a launch with notifications on
   compares the browser's subscription with this copy, and asks the server only when they differ or the last check is a
   day old (docs/push.md, the launch's check). the copy is one entry in localStorage under a boxbox key. storage that is
   refused (a private window) keeps no copy, so every launch checks, as it did before this copy existed. */

import type { PushKind } from "../api/client";

const KEY = "boxbox.push.saved";
/** the longest a launch goes without asking the server whether its copy still holds */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const KINDS: readonly PushKind[] = ["ask", "done", "fault", "ready"];

export type Keys = { endpoint: string; p256dh: string; auth: string };

/** the server's copy of this device as the last successful check (or this device's own save) left it */
export type Saved = Keys & {
  device: string;
  /** the server's push key, the one the subscription was made with */
  publicKey: string;
  /** every subscribed device as the server listed it (`listing`) */
  devices: string;
  /** the kinds this device is pushed */
  kinds: PushKind[];
  /** when the copy was last checked against the server, ms since the epoch */
  checkedAt: number;
};

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** reading `localStorage` itself throws where storage is blocked */
export function storage(): Store | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** the device list as one string: a change to any device's kinds, or to who is listed, changes it */
export function listing(devices: readonly { device: string; kinds: readonly PushKind[] }[]): string {
  return devices
    .map((entry) => `${entry.device}:${entry.kinds.join("+")}`)
    .sort()
    .join(",");
}

/** the listing once this device holds `kinds`, as the server will list it after a save: its own entry replaced or added */
export function listingWith(devices: readonly { device: string; kinds: readonly PushKind[] }[], device: string, kinds: readonly PushKind[]): string {
  return listing([...devices.filter((entry) => entry.device !== device), { device, kinds }]);
}

export function readSaved(store: Store | null): Saved | null {
  try {
    const value: unknown = JSON.parse(store?.getItem(KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const text = ["device", "publicKey", "endpoint", "p256dh", "auth", "devices"].every((name) => typeof record[name] === "string");
    const kinds = Array.isArray(record.kinds) && (record.kinds as unknown[]).every((kind) => KINDS.includes(kind as PushKind));
    if (!text || !kinds || typeof record.checkedAt !== "number" || !Number.isFinite(record.checkedAt)) return null;
    return value as Saved;
  } catch {
    return null;
  }
}

export function writeSaved(store: Store | null, saved: Saved): void {
  try {
    store?.setItem(KEY, JSON.stringify(saved));
  } catch {
    /* refused: the next launch checks again */
  }
}

export function forgetSaved(store: Store | null): void {
  try {
    store?.removeItem(KEY);
  } catch {
    /* refused: nothing was kept */
  }
}

/** the copy names the subscription the browser holds */
export function sameKeys(saved: Saved, keys: Keys): boolean {
  return saved.endpoint === keys.endpoint && saved.p256dh === keys.p256dh && saved.auth === keys.auth;
}

/** the server's copy this device holds is the one the copy names: the same device, key, subscription and listing */
export function sameCopy(saved: Saved, next: Saved): boolean {
  return saved.device === next.device && saved.publicKey === next.publicKey && sameKeys(saved, next) && saved.devices === next.devices;
}

/** checked within the day, by a clock that has not run backwards */
export function isFresh(saved: Saved, now: number): boolean {
  const age = now - saved.checkedAt;
  return age >= 0 && age < CHECK_EVERY_MS;
}
