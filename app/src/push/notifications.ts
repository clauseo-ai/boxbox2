/* notifications on this device: the service worker's registration, the
   permission, and the server's copy of the subscription.

   - `startNotifications` runs once signed in: it waits for the service
     worker the shell registered at boot (app/src/shell/worker.ts) and, if
     permission was granted before, makes sure the server still holds this
     device's subscription (a new vapid key, a wiped server or a rotated
     endpoint all heal here, silently).
   - `turnOnNotifications` must run inside a tap: safari only asks for
     permission from a user gesture.
   - `turnOffNotifications` unsubscribes here and on the server. */

import { api, type PushKind } from "../api/client";
import { registerServiceWorker } from "../shell/worker";
import { state, updatePush } from "../store";
import { deviceClass, deviceId, needsHomeScreen } from "./device";

function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function startNotifications(): Promise<void> {
  if (!supported()) {
    updatePush({ permission: "unsupported" });
    return;
  }
  updatePush({ permission: Notification.permission });
  const registration = await register();
  if (!registration || Notification.permission !== "granted" || state.push.busy) return;
  updatePush({ busy: true });
  try {
    await subscribe(registration);
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
    updatePush({ subscribed: false });
  } catch {
    updatePush({ problem: "the boxbox server is not answering. try again when it is." });
  } finally {
    updatePush({ busy: false });
  }
}

/** the registration push rides on: registering again is a no-op when the shell already did at boot */
async function register(): Promise<ServiceWorkerRegistration | null> {
  const registration = await registerServiceWorker();
  if (!registration) {
    updatePush({ problem: "notifications could not start in this browser. reload boxbox and try again." });
    return null;
  }
  return navigator.serviceWorker.ready;
}

/** subscribes with the server's key (replacing a subscription made with
    another) and hands the subscription to the server. */
async function subscribe(registration: ServiceWorkerRegistration, chosen?: PushKind[]): Promise<void> {
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
    const saved = await api.POST("/api/push/subscribe", {
      body: {
        device: deviceId(),
        deviceClass: deviceClass(),
        endpoint: json.endpoint,
        keys: { p256dh, auth },
        // keep the kinds this device chose; all four the first time
        ...(kinds ? { kinds } : {}),
      },
    });
    if (!saved.data) {
      updatePush({ problem: `the server refused this device's subscription (${saved.response.status}).` });
      return;
    }
    updatePush({ subscribed: true, problem: null, kinds: kinds ?? ALL_KINDS });
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
