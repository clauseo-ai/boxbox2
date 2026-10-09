/* the service worker, served at /sw.js with scope /. it is what runs when a
   push arrives with boxbox closed, and what paints the app on a cold launch
   with no network (architecture: the service worker).

   - install: precaches this build's ui (the list vite.config.ts writes into
     the build) and waits. it never skips waiting on its own: a new build
     takes over only once no boxbox window is open, so a deploy applies at
     the next cold launch and never under the person (design.md, honesty).
     it never claims open pages either: the page that registered it runs
     on the network until its next load.
   - activate: drops the caches of every older build.
   - fetch: a navigation inside the app is answered with this build's
     shell from the cache, and the build's own files from the cache; the
     api, other origins and anything not precached go to the network
     untouched. the shell and its hashed files come from one build, so a
     page never mixes two. where the browser has static routing, install
     also routes the api around this worker entirely, so a request never
     waits on it and a page's last requests as it unloads are not lost.
   - message `boxbox.take-over`: the page hit a protocol break and its only
     way on is a reload, so the waiting build takes over now.
   - push: every push shows a notification, whatever it holds. ios revokes a
     subscription whose pushes show nothing, so a payload this build cannot
     read still shows a plain banner rather than nothing.
   - notificationclick: focuses an open boxbox window and tells it where to
     go (no reload, no history entry), or opens the app at the deep link.
   - telemetry: push.delivered on arrival, push.tapped on a click, posted
     straight to /api/telemetry with the session cookie.

   the build bundles this file alone into dist/sw.js, so it imports nothing
   at runtime but ./payload, which has no imports of its own. in dev nothing
   is precached and fetch is left alone, so vite's hot reload is untouched. */

/// <reference lib="webworker" />

import { clickTarget, type OpenMessage, type Payload, parsePayload, tapName } from "./payload";

declare const self: ServiceWorkerGlobalScope;

/** the options chromium reads; typescript's dom lib has dropped `actions`
    and `renotify`, which chromium still honours and ios ignores */
type Options = NotificationOptions & {
  actions?: { action: string; title: string }[];
  renotify?: boolean;
  timestamp?: number;
};

/* written by the build (vite.config.ts): the build's id and every file it
   wrote, as paths, the shell first as "/". absent in dev. */
declare const BOXBOX_BUILD: string | undefined;
declare const BOXBOX_PRECACHE: readonly string[] | undefined;

const BUILD = typeof BOXBOX_BUILD === "string" ? BOXBOX_BUILD : null;
const PRECACHE: readonly string[] = typeof BOXBOX_PRECACHE === "object" ? BOXBOX_PRECACHE : [];
const CACHE_PREFIX = "boxbox-ui-";
const CACHE = `${CACHE_PREFIX}${BUILD ?? "dev"}`;
const SHELL = "/";
const PRECACHED = new Set(PRECACHE);
/** what the page says when the waiting build must take over (app/src/shell/worker.ts) */
const TAKE_OVER = "boxbox.take-over";

/** chromium's static routing (`InstallEvent.addRoutes`), which typescript's webworker lib does not have yet */
type RouterRule = { condition: { urlPattern: string }; source: "network" };
type RoutingInstallEvent = ExtendableEvent & { addRoutes?: (rules: RouterRule | RouterRule[]) => Promise<void> };

self.addEventListener("install", (event) => {
  // a file that fails to arrive fails the install, and the next visit tries again: a half-filled cache never serves
  if (BUILD) event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([...PRECACHE])));
  /* the api goes to the network without passing through this worker. with a fetch handler installed, chromium sends
     a controlled page's every request through the worker first, even the ones it hands back untouched, and requests a
     page makes as it unloads were lost on that way: of six telemetry posts sent at pagehide and hidden on a reload,
     a controlled page delivered four and an uncontrolled one six (docs/gotchas.md, the shell). a browser without
     static routing still hands them to the fetch handler below, which returns them untouched. a rule that fails to
     install leaves the worker as it was, never uninstalled */
  const routing = event as RoutingInstallEvent;
  if (BUILD && routing.addRoutes) event.waitUntil(routing.addRoutes({ condition: { urlPattern: "/api/*" }, source: "network" }).catch(() => undefined));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(forgetOlderBuilds());
});

self.addEventListener("message", (event) => {
  const data: unknown = event.data;
  if (typeof data === "object" && data !== null && "type" in data && data.type === TAKE_OVER) void self.skipWaiting();
});

if (BUILD) {
  self.addEventListener("fetch", (event) => {
    const { request } = event;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
    if (request.mode === "navigate") event.respondWith(fromCache(SHELL, request));
    else if (PRECACHED.has(url.pathname)) event.respondWith(fromCache(url.pathname, request));
  });
}

/** this build's copy, or the network when the cache lost it (storage pressure can evict a cache whole) */
async function fromCache(key: string, request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  // the server varies by accept-encoding, which the cache's stored request never carried: the stored body is the
  // one answer for this build either way
  return (await cache.match(key, { ignoreVary: true })) ?? fetch(request);
}

async function forgetOlderBuilds(): Promise<void> {
  for (const name of await caches.keys()) {
    if (name.startsWith(CACHE_PREFIX) && name !== CACHE) await caches.delete(name);
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(received(event.data));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const payload = parsePayload(event.notification.data);
  event.waitUntil(clicked(payload, event.action));
});

async function received(data: PushMessageData | null): Promise<void> {
  const payload = parsePayload(readJson(data));
  if (!payload) {
    await self.registration.showNotification("boxbox", {
      body: "something needs you. open boxbox to see it.",
      tag: "boxbox",
    });
    return;
  }
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const options: Options = {
    body: payload.body,
    tag: payload.tag,
    data: payload,
    // a thread's newer news replaces its banner and should be noticed
    renotify: true,
    timestamp: payload.sentAt,
    actions: payload.actions.map(({ action, title }) => ({ action, title })),
  };
  await self.registration.showNotification(payload.title, options);
  await badge(payload.badge);
  await report(payload, {
    kind: "push.delivered",
    session: payload.thread,
    ms: Math.max(0, Date.now() - payload.sentAt),
    props: { need: payload.need, tag: payload.tag, id: payload.id, open: windows.length > 0 ? 1 : 0 },
  });
}

async function clicked(payload: Payload | null, action: string): Promise<void> {
  const url = payload ? clickTarget(payload, action) : "/";
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
  if (open) {
    // focus first: the click's permission to raise a window is short-lived
    await open.focus();
    const message: OpenMessage = { type: "boxbox.open", url };
    open.postMessage(message);
  } else {
    await self.clients.openWindow(url);
  }
  if (payload) {
    await report(payload, {
      kind: "push.tapped",
      session: payload.thread,
      ms: Math.max(0, Date.now() - payload.sentAt),
      props: { tag: payload.tag, action: tapName(action), need: payload.need, id: payload.id, open: open ? 1 : 0 },
    });
  }
}

function readJson(data: PushMessageData | null): unknown {
  try {
    return data?.json() ?? null;
  } catch {
    return null;
  }
}

async function badge(count: number | undefined): Promise<void> {
  if (count === undefined || !("setAppBadge" in self.navigator)) return;
  try {
    await (count > 0 ? self.navigator.setAppBadge(count) : self.navigator.clearAppBadge());
  } catch {
    /* the platform refused a badge; the banner already said it */
  }
}

/** best effort: telemetry must never cost a notification. */
async function report(payload: Payload, event: Record<string, unknown>): Promise<void> {
  try {
    await fetch("/api/telemetry", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device: payload.device,
        deviceClass: payload.deviceClass,
        events: [{ ...event, at: Date.now(), host: payload.thread.split(":")[0] }],
      }),
    });
  } catch {
    /* offline or signed out; the server's push.sent row still stands */
  }
}
