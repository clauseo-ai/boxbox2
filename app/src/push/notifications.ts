/* notifications on this device: the service worker's registration, the
   permission, and the server's copy of the subscription.

   - `startNotifications` runs once signed in: it waits for the service
     worker the shell registered at boot (app/src/shell/worker.ts) and, if
     permission was granted before, makes sure the server still holds this
     device's subscription (a new vapid key, a wiped server or a rotated
     endpoint all heal here, silently). the copy of what the server held
     last (push/saved.ts) decides whether a launch asks at all: it asks, and
     posts only when the copy differs, and at most once a day without a change.
   - `turnOnNotifications` must run inside a tap: safari only asks for
     permission from a user gesture.
   - `turnOffNotifications` unsubscribes here and on the server. */

import { api, type PushKind } from "../api/client";
import { registerServiceWorker } from "../shell/worker";
import { state, updatePush } from "../store";
import { deviceClass, deviceId, needsHomeScreen } from "./device";
import { forgetSaved, isFresh, type Keys, listing, listingWith, readSaved, type Saved, sameCopy, sameKeys, storage, writeSaved } from "./saved";

function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function startNotifications(): Promise<void> {
  if (!supported()) {
    updatePush({ permission: "unsupported" });
    return;
  }
  updatePush({ permission: Notification.permission });
  // a permission that is not granted has no subscription to keep: the copy goes, so granting it again posts at once
  if (Notification.permission !== "granted") forgetSaved(storage());
  const registration = await register();
  if (!registration || Notification.permission !== "granted" || state.push.busy) return;
  updatePush({ busy: true });
  try {
    await launchCheck(registration);
  } finally {
    updatePush({ busy: false });
  }
}

export async function turnOnNotifications(): Promise<void> {
  if (!supported() || state.push.busy) return;
  updatePush({ busy: true, problem: null });
  try {
    const permission = await Notification.requestPermission();
    updatePush({ permission });
    if (permission !== "granted") {
      if (permission === "denied") updatePush({ problem: blockedCopy() });
      return;
    }
    const registration = await register();
    if (registration) await subscribe(registration);
  } finally {
    updatePush({ busy: false });
  }
}

export async function turnOffNotifications(): Promise<void> {
  if (!supported() || state.push.busy) return;
  updatePush({ busy: true, problem: null });
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    await subscription?.unsubscribe();
    const { response } = await api.POST("/api/push/unsubscribe", { body: { device: deviceId() } });
    if (!response.ok) updatePush({ problem: `the server answered ${response.status}. try again.` });
    forgetSaved(storage());
    updatePush({ subscribed: false });
  } catch {
    updatePush({ problem: "the boxbox server is not answering. try again when it is." });
  } finally {
    updatePush({ busy: false });
  }
}

/** the registration push rides on: the page's one, which the shell made at boot (the same promise, never a second
    register call), once the worker is active */
async function register(): Promise<ServiceWorkerRegistration | null> {
  const registration = await registerServiceWorker();
  if (!registration) {
    updatePush({ problem: "notifications could not start in this browser. reload boxbox and try again." });
    return null;
  }
  return navigator.serviceWorker.ready;
}

/** a launch with permission granted: when the browser's subscription is the one the copy names and the copy was checked
    within the day, nothing is asked. otherwise the server is asked, and posted to only when its copy differs (`subscribe`) */
async function launchCheck(registration: ServiceWorkerRegistration): Promise<void> {
  const keys = keysOf((await registration.pushManager.getSubscription())?.toJSON());
  const copy = readSaved(storage());
  if (keys && copy && copy.device === deviceId() && sameKeys(copy, keys) && isFresh(copy, Date.now())) {
    updatePush({ subscribed: true, problem: null, kinds: copy.kinds });
    return;
  }
  await subscribe(registration, undefined, true);
}

function keysOf(json: PushSubscriptionJSON | undefined): Keys | null {
  const endpoint = json?.endpoint;
  const p256dh = json?.keys?.p256dh;
  const auth = json?.keys?.auth;
  return endpoint && p256dh && auth ? { endpoint, p256dh, auth } : null;
}

/** subscribes with the server's key (replacing a subscription made with another) and hands the subscription to the
    server. a turn-on or a new kinds choice always posts; a launch (`launch`) posts only when the server's copy differs
    from the saved one. a check that does not come leaves the copy as it was, so the next launch asks again. */
async function subscribe(registration: ServiceWorkerRegistration, chosen?: PushKind[], launch = false): Promise<void> {
  try {
    const { data, response } = await api.GET("/api/push");
    if (!data) {
      updatePush({ problem: `the server answered ${response.status} for notifications. try again.` });
      return;
    }
    const key = fromBase64Url(data.publicKey);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = subscription.toJSON();
    const p256dh = json.keys?.p256dh;
    const auth = json.keys?.auth;
    if (!json.endpoint || !p256dh || !auth) {
      updatePush({ problem: "this browser gave boxbox an incomplete subscription. turn notifications off and on." });
      return;
    }
    const kinds: PushKind[] | undefined = chosen ?? data.devices.find((d) => d.device === deviceId())?.kinds;
    const copy: Saved = {
      device: deviceId(),
      publicKey: data.publicKey,
      endpoint: json.endpoint,
      p256dh,
      auth,
      devices: listing(data.devices),
      kinds: kinds ?? ALL_KINDS,
      checkedAt: Date.now(),
    };
    if (launch) {
      const held = readSaved(storage());
      if (held && sameCopy(held, copy)) {
        // the server holds what the copy says: the check is what is new
        writeSaved(storage(), { ...held, checkedAt: copy.checkedAt });
        updatePush({ subscribed: true, problem: null, kinds: held.kinds });
        return;
      }
    }
    const saved = await api.POST("/api/push/subscribe", {
      body: {
        device: copy.device,
        deviceClass: deviceClass(),
        endpoint: copy.endpoint,
        keys: { p256dh, auth },
        // keep the kinds this device chose; all four the first time
        ...(kinds ? { kinds } : {}),
      },
    });
    if (!saved.data) {
      updatePush({ problem: `the server refused this device's subscription (${saved.response.status}).` });
      return;
    }
    writeSaved(storage(), { ...copy, devices: listingWith(data.devices, copy.device, copy.kinds) });
    updatePush({ subscribed: true, problem: null, kinds: copy.kinds });
  } catch {
    updatePush({ problem: "notifications could not be turned on. check boxbox is running, then try again." });
  }
}

function blockedCopy(): string {
  return needsHomeScreen()
    ? "add boxbox to your home screen, open it from there, then turn notifications on."
    : "notifications are blocked for boxbox. allow them in the browser's site settings, then try again.";
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** the settings page saved this device's kinds with the subscription `keys` (`savePushKinds`): the copy follows, so the next
    launch sees the kinds the server holds. the listing is the one the server gave just before (`state.pushDevices`) */
export function rememberPushKinds(keys: Keys, kinds: PushKind[]): void {
  const held = readSaved(storage());
  if (!held || held.device !== deviceId()) return;
  writeSaved(storage(), { ...held, ...keys, kinds, devices: listingWith(state.pushDevices, held.device, kinds) });
}

function sameKey(current: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (!current) return false;
  const bytes = new Uint8Array(current);
  return bytes.length === wanted.length && bytes.every((b, i) => b === wanted[i]);
}

const ALL_KINDS: PushKind[] = ["ask", "done", "fault", "ready"];

/** which kinds push to this device: the whole settings page for push
    (design.md, attention). the subscription is saved again with them. */
export async function choosePushKinds(kinds: PushKind[]): Promise<void> {
  if (!supported()) return;
  updatePush({ busy: true });
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    if (registration) await subscribe(registration, kinds);
  } finally {
    updatePush({ busy: false });
  }
}
