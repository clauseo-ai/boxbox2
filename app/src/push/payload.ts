/* the push payload, as the server writes it (server/src/push/payload.rs),
   and the pure rules the service worker and the app apply to it. nothing
   here touches a browser api, so it is unit-tested with bun and imported by
   both sides. */

export type PushKind = "ask" | "done" | "fault" | "ready";

export type PushAction = { action: "answer" | "open"; title: string; url: string };

export type Payload = {
  v: 1;
  id: string;
  kind: PushKind;
  need: string;
  /** `thread:<host:session>`: one banner per thread */
  tag: string;
  thread: string;
  ask?: string;
  title: string;
  body: string;
  /** where tapping the banner itself goes */
  url: string;
  actions: PushAction[];
  device: string;
  deviceClass: string;
  /** the server's clock, ms since the epoch */
  sentAt: number;
  badge?: number;
};

/** what the service worker tells an open window when a click should move it */
export type OpenMessage = { type: "boxbox.open"; url: string };

/** where a deep link points: a thread, maybe an ask in it */
export type Link = { thread: string; ask: string | null; push: string | null };

const KINDS: readonly PushKind[] = ["ask", "done", "fault", "ready"];
const ACTIONS: readonly PushAction["action"][] = ["answer", "open"];
/** `host:session`, the same rule the server applies */
const THREAD = /^[a-z0-9-]{1,32}:[A-Za-z0-9_-]{1,128}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** the payload if `value` is one this build understands, else null. an
    unknown version is null too: a newer server's shape is not guessed at. */
export function parsePayload(value: unknown): Payload | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const id = text(value.id);
  const need = text(value.need);
  const tag = text(value.tag);
  const thread = text(value.thread);
  const title = text(value.title);
  const body = text(value.body);
  const url = text(value.url);
  const device = text(value.device);
  const deviceClass = text(value.deviceClass);
  const kind = KINDS.find((k) => k === value.kind);
  const { ask, badge, sentAt } = value;
  if (id === null || need === null || tag === null || thread === null || title === null) return null;
  if (body === null || url === null || device === null || deviceClass === null) return null;
  if (kind === undefined || !isAppPath(url) || typeof sentAt !== "number") return null;
  if (ask !== undefined && typeof ask !== "string") return null;
  if (badge !== undefined && (typeof badge !== "number" || badge < 0)) return null;
  const actions = Array.isArray(value.actions) ? value.actions.map(parseAction) : [null];
  if (actions.some((a) => a === null)) return null;
  return {
    v: 1,
    id,
    kind,
    need,
    tag,
    thread,
    ...(ask === undefined ? {} : { ask }),
    title,
    body,
    url,
    actions: actions.filter((a): a is PushAction => a !== null),
    device,
    deviceClass,
    sentAt,
    ...(badge === undefined ? {} : { badge }),
  };
}

function parseAction(value: unknown): PushAction | null {
  if (!isRecord(value)) return null;
  const action = ACTIONS.find((a) => a === value.action);
  const title = text(value.title);
  const url = text(value.url);
  if (action === undefined || title === null || url === null || !isAppPath(url)) return null;
  return { action, title, url };
}

/** a link inside this app: a path on this origin, never a url elsewhere. */
function isAppPath(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

/** where a click lands: the action's link, or the banner's own for a plain
    tap (ios reports no action, ever). an action the payload does not carry
    falls back to the banner's link. */
export function clickTarget(payload: Payload, action: string): string {
  return payload.actions.find((a) => a.action === action)?.url ?? payload.url;
}

/** the name telemetry gives a tap: the action, or `banner`. */
export function tapName(action: string): "answer" | "open" | "banner" {
  return action === "answer" || action === "open" ? action : "banner";
}

/** reads a deep link from a query string; null when it names no thread. */
export function readLink(search: string): Link | null {
  const query = new URLSearchParams(search);
  const thread = query.get("thread");
  if (thread === null || !THREAD.test(thread)) return null;
  return { thread, ask: query.get("ask"), push: query.get("push") };
}
