/* deep links from a push. a tap either launches the app at
   `/?thread=<host:session>&ask=<id>&push=<id>`, or focuses an open window
   and the service worker posts it the same link. `thread` is the sync
   client's own parameter (sync/client.ts opens it at start and mirrors the
   thread on stage into it); push adds `ask` and `push`, which become
   `state.focus` for the thread ui and are then cleared with
   `replaceState`: in-app navigation never pushes history (design.md,
   platform truth). a tap that reaches an open window while it shows the
   machines, settings or a terminal goes to the thread route through the
   shell's navigation, so the screen it was on steps aside. */

import { onCleanup } from "solid-js";
import { navigate } from "../shell/navigation";
import { openFocus } from "../store";
import { type OpenMessage, readLink } from "./payload";

/** takes the link the app was launched with, if any. call once at boot,
    before the sync client starts: it opens the thread itself. */
export function takeLaunchLink(): void {
  const link = readLink(location.search);
  if (!link) return;
  openFocus(link);
  const url = new URL(location.href);
  url.searchParams.delete("ask");
  url.searchParams.delete("push");
  history.replaceState(history.state, "", url);
}

/** follows links the service worker posts to this window. */
export function followWorkerLinks(): void {
  if (!("serviceWorker" in navigator)) return;
  const onMessage = (event: MessageEvent<unknown>) => {
    if (!isOpenMessage(event.data)) return;
    const link = readLink(new URL(event.data.url, location.origin).search);
    if (!link) return;
    openFocus(link);
    navigate({ name: "thread", thread: link.thread, at: null, part: null });
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  onCleanup(() => navigator.serviceWorker.removeEventListener("message", onMessage));
}

function isOpenMessage(data: unknown): data is OpenMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    "type" in data &&
    data.type === "boxbox.open" &&
    "url" in data &&
    typeof data.url === "string"
  );
}
