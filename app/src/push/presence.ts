/* presence: tells the server what this device is looking at, so a thread
   on screen here buzzes nobody and a thread left open on a desk still
   reaches the phone (decision 7, decision 23).

   looking means visible and focused. the report goes out on every change
   (shown, hidden, focused, blurred, a new thread on stage, windows moving
   in or out of view) and every 30 s while looking; the server stops
   counting a report after 90 s, so a device that sleeps without a goodbye
   stops muting others on its own. leaving sends a last "not looking" as a
   beacon, which survives the page going away.

   while a thread is looked at, its banners are closed here too: news the
   person is reading needs no banner on the lock screen. */

import { createEffect, on, onCleanup } from "solid-js";
import { api, type PresenceReport } from "../api/client";
import { state } from "../store";
import { deviceId } from "./device";
import { latestWins } from "./latest";

const HEARTBEAT_MS = 30_000;

/** starts reporting; stops when the owning component is cleaned up. */
export function reportPresence(): void {
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // one post in flight, the newest report next: a burst of changes is the first and the last, never a post each
  const post = latestWins((report: PresenceReport) => api.POST("/api/presence", { body: report }));

  const current = (): PresenceReport => ({
    device: deviceId(),
    visible: document.visibilityState === "visible",
    focused: document.hasFocus(),
    thread: state.openThread,
    windowsInView: [...state.windowsInView],
  });

  const send = () => {
    if (state.gate !== "signed-in") return;
    const report = current();
    const looking = report.visible && report.focused;
    if (looking && heartbeat === undefined) heartbeat = setInterval(send, HEARTBEAT_MS);
    if (!looking && heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    // a failed report is not retried: the next change or heartbeat carries
    // the truth, and the server forgets a stale one in 90 s
    post(report);
    if (looking) void closeBanners([state.openThread, ...state.windowsInView]);
  };

  const leave = () => {
    if (state.gate !== "signed-in") return;
    const report: PresenceReport = { ...current(), visible: false, focused: false };
    navigator.sendBeacon("/api/presence", JSON.stringify(report));
  };

  const events = ["visibilitychange", "focus", "blur"] as const;
  for (const name of events) window.addEventListener(name, send);
  window.addEventListener("pagehide", leave);
  createEffect(on(() => [state.gate, state.openThread, ...state.windowsInView], send));

  onCleanup(() => {
    for (const name of events) window.removeEventListener(name, send);
    window.removeEventListener("pagehide", leave);
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
  });
}

async function closeBanners(threads: (string | null)[]): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration) return;
  for (const thread of threads) {
    if (thread === null) continue;
    for (const banner of await registration.getNotifications({ tag: `thread:${thread}` })) banner.close();
  }
}
