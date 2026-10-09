/* the service worker's registration, on every visit (docs/push.md, the
   service worker). the worker precaches this build's ui so a cold launch
   paints with no network, and a new build installs beside it and waits: it
   takes over only when no boxbox window is open, so nothing reloads under
   the person (design.md, honesty). the one exception is a protocol break,
   where the page cannot continue and its only button reloads: the waiting
   build is asked to take over first, so the reload lands on it. */

const WORKER = "/sw.js";
/** what the page says to a waiting worker; sw.ts listens for the same literal */
const TAKE_OVER = "boxbox.take-over";

/** registers /sw.js for the whole app. a browser without service workers, or one that refuses (a private window),
    runs the app from the network as before: the answer is null and nothing else changes */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    // dev serves the worker as an es module through vite; the build bundles it into one classic script. the
    // worker's own file is never taken from the http cache, so a deploy is found at the next launch
    return await navigator.serviceWorker.register(WORKER, { scope: "/", type: import.meta.env.DEV ? "module" : "classic", updateViaCache: "none" });
  } catch {
    return null;
  }
}

/** the server speaks a newer protocol: the newest build installs (if it has not yet) and takes over at once */
export async function takeWaitingBuild(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  if (!registration) return;
  await registration.update().catch(() => undefined);
  const next = registration.waiting ?? registration.installing;
  if (!next) return;
  if (next.state === "installed") {
    next.postMessage({ type: TAKE_OVER });
    return;
  }
  const onState = () => {
    if (next.state === "installed") next.postMessage({ type: TAKE_OVER });
    if (next.state === "installed" || next.state === "redundant") next.removeEventListener("statechange", onState);
  };
  next.addEventListener("statechange", onState);
}
