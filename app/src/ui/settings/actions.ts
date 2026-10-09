/* reading and saving preferences. appearance applies the moment it is
   chosen (it is this device's own screen) and is put back if the server
   does not keep it; everything else waits for the server's answer. */

import { api, type PushKind } from "../../api/client";
import { deviceClass, deviceId } from "../../push/device";
import {
  type DevicePrefs,
  type RepoPrefs,
  setDevicePrefs,
  setModels,
  setPrefs,
  setPushDevices,
  setRepoPrefs,
  state,
} from "../../store";
import { type Outcome, said, UNREACHABLE, verb } from "../machines/verb";
import { applyAppearance, DEFAULT_APPEARANCE } from "./appearance";

export function devicePrefs(): DevicePrefs {
  return state.prefs?.devices[deviceId()] ?? DEFAULT_APPEARANCE;
}

export async function loadPrefs(): Promise<string | null> {
  try {
    const { data, error, response } = await api.GET("/api/prefs");
    if (!data) return said(error, response.status);
    setPrefs(data);
    applyAppearance(devicePrefs());
    return null;
  } catch {
    return UNREACHABLE;
  }
}

export async function loadPushDevices(): Promise<string | null> {
  try {
    const { data, error, response } = await api.GET("/api/push");
    if (!data) return said(error, response.status);
    setPushDevices(data.devices);
    return null;
  } catch {
    return UNREACHABLE;
  }
}

export async function loadModels(host: string): Promise<string | null> {
  try {
    const { data, error, response } = await api.GET("/api/hosts/{host}/models", { params: { path: { host } } });
    if (!data) return said(error, response.status);
    setModels(host, data);
    return null;
  } catch {
    return UNREACHABLE;
  }
}

export function saveAppearance(next: DevicePrefs, changed: "theme" | "motion"): Promise<Outcome<DevicePrefs>> {
  const before = devicePrefs();
  const device = deviceId();
  applyAppearance(next);
  setDevicePrefs(device, next);
  const name = changed === "theme" ? "setTheme" : "setMotion";
  return verb(name, { surface: "settings", arg: next[changed] }, async () => {
    const failed = (error: string): Outcome<DevicePrefs> => {
      applyAppearance(before);
      setDevicePrefs(device, before);
      return { ok: false, error };
    };
    try {
      const { data, error, response } = await api.PUT("/api/prefs/devices/{device}", { params: { path: { device } }, body: next });
      return data ? { ok: true, value: data } : failed(`not saved. ${said(error, response.status)}`);
    } catch {
      return failed(`not saved. ${UNREACHABLE}`);
    }
  });
}

export function saveRepo(next: RepoPrefs): Promise<Outcome<RepoPrefs>> {
  return verb("setRepoDefaults", { surface: "settings", host: next.host, arg: next.effort ?? (next.model ? "model" : "cleared") }, async () => {
    try {
      const { data, error, response } = await api.PUT("/api/prefs/repos", { body: next });
      if (!data) return { ok: false, error: said(error, response.status) };
      setRepoPrefs(data);
      return { ok: true, value: data };
    } catch {
      return { ok: false, error: UNREACHABLE };
    }
  });
}

/** which kinds push to this device. push decides from the subscription, so
    the subscription is sent again with the new kinds (server/src/prefs.rs). */
export function savePushKinds(kinds: PushKind[]): Promise<Outcome<PushKind[]>> {
  return verb("setPushKinds", { surface: "settings", arg: kinds.length > 0 ? kinds.join("+") : "none" }, async () => {
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = (await registration?.pushManager.getSubscription())?.toJSON();
      const keys = subscription?.keys;
      if (!subscription?.endpoint || !keys?.p256dh || !keys.auth) {
        return { ok: false, error: "this device has no subscription. turn on notifications first." };
      }
      const body = {
        device: deviceId(),
        deviceClass: deviceClass(),
        endpoint: subscription.endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
        kinds,
      };
      const { data, error, response } = await api.POST("/api/push/subscribe", { body });
      if (!data) return { ok: false, error: said(error, response.status) };
      await loadPushDevices();
      return { ok: true, value: kinds };
    } catch {
      return { ok: false, error: UNREACHABLE };
    }
  });
}
