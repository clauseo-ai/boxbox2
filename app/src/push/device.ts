/* this device's identity: an id minted once per browser profile (or
   installed app) and kept in localStorage, and its class from the
   dictionary's one ua sniff. push subscriptions, presence, the terminal
   relay and telemetry all name the device by this id; this is the one
   place it is read or minted. */

import { type DeviceClass, deviceClassOf } from "../../../telemetry/schema";

const KEY = "boxbox.device";
/** the server's rule for a device id */
const VALID = /^[A-Za-z0-9_-]{1,64}$/;

/** with storage refused (a locked-down profile) a device cannot keep an id, so this launch's stands in, and every
    caller on the page names the same device for as long as it is open */
const LAUNCH_ID = crypto.randomUUID();

export function deviceId(): string {
  let id: string | null;
  try {
    id = localStorage.getItem(KEY);
  } catch {
    return LAUNCH_ID;
  }
  if (id !== null && VALID.test(id)) return id;
  try {
    localStorage.setItem(KEY, LAUNCH_ID);
  } catch {
    /* refused after all: the launch's id still stands */
  }
  return LAUNCH_ID;
}

/** a browser under automation (the verification drives) says so, as the
    sync client does, so no digest has to exclude it by hand */
export function deviceClass(): DeviceClass {
  return navigator.webdriver ? "automation" : deviceClassOf(navigator.userAgent, navigator.maxTouchPoints);
}

/** safari on an iphone or ipad only offers web push inside an app added to
    the home screen, never in a tab */
export function needsHomeScreen(): boolean {
  const family = deviceClassOf(navigator.userAgent, navigator.maxTouchPoints);
  const apple = family === "iphone" || family === "ipad";
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  return apple && !standalone;
}
