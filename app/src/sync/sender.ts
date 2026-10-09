/* the worker's half of the composer (docs/composer.md, sending): it owns
   the outbox and the drafts, keeps both in indexeddb, posts each send to
   boxbox's api with its client id, retries it with the same id, and
   settles it on the daemon's echo in the stream. the rules are outbox.ts;
   this is the io around them. */

import { Backoff } from "./backoff";
import type { FromWorker, Outgoing, StreamState } from "./messages";
import { type Answer, answered, DRAFT_TROUBLE_AFTER, type Draft, type DraftMessage, draftRetryMs, echoed, entryOf, nextWaiting, OUTBOX_CAP, OUTBOX_PHOTO_BYTES, type OutboxEntry, overdue, type Photo, perfVerb, photoBytes, postBudgetMs, removed, splitDraft, viewOfEntry, wasQueued } from "./outbox";
import type { Frame, Message } from "./protocol";
import type { Telemetry } from "./telemetry";

/** how often a send that is waiting for its echo is looked at */
const WATCH_MS = 5000;
/** drafts are written this long after the last keystroke, so typing costs one write a pause, not one a key */
const DRAFT_DEBOUNCE_MS = 300;
/** how long a call without photos may take before it is given up and tried again with its id: a network that vanishes
    without a reset leaves a fetch open for minutes */
const POST_MS = 20_000;
/** what a send's post is given beyond the server's own waits (`postBudgetMs`: the upload, then the host's time to take
    it): the round trip. with no photos that is the server's 15 s and this, the 20 s a post always had */
const POST_MARGIN_MS = 5_000;

type Identity = { device: string; deviceClass: string };

/** what the sender writes through: the worker's cache, kept to the two writes so the sender does not reach into indexeddb */
export type OutboxStore = {
  putDraft(key: string, words: Draft | null, photos?: readonly Photo[]): Promise<void>;
  putEntry(clientID: string, entry: OutboxEntry | null): Promise<void>;
};

/** what a message says whose photos went back to the draft because too many were waiting to go: what happened, where they
    are, and what to do */
export function photosSentBack(count: number): string {
  const [photos, are] = count === 1 ? ["photo", "is"] : ["photos", "are"];
  return `too many photos are waiting to go, so this message did not go. its ${photos} ${are} back in the draft. edit it back there too, and send it when the others have gone`;
}

/** why an unsend did not take, in the composer's words rather than the daemon's ids */
function unsendRefusal(answer: Answer): string {
  if (answer.kind === "refused" && answer.name === "BusyError") return "already sent: the agent has it, so it cannot be taken back";
  if (answer.kind === "refused" && answer.status === 404) return "it is not waiting anymore: it went, or another device took it back";
  return answer.kind === "taken" ? "" : answer.message;
}

/** a send's `perf.send` props: what it was and how it went, never its words */
function sendProps(entry: OutboxEntry) {
  return { verb: perfVerb(entry), retries: Math.max(0, entry.attempts - 1), queued: wasQueued(entry) ? 1 : 0, chars: entry.text.length, photos: entry.photos.length };
}

/** the host and, once known, the session a send's telemetry row names */
function where(entry: OutboxEntry): { host: string; session?: string } {
  const session = entry.target.kind === "session" ? entry.target.session : entry.session;
  return { host: entry.target.host, ...(session ? { session } : {}) };
}

export class Sender {
  private readonly entries = new Map<string, OutboxEntry>();
  /** drafts waiting for their write: the words record, or null to forget the draft */
  private readonly drafts = new Map<string, Draft | null>();
  /** the newest words of each draft, whether or not they have been written: what a write that failed is made again from, so
      words an older write carried can never be put over words a newer edit has written. an entry lives only while its
      draft does, so the map is bounded by the drafts */
  private readonly latest = new Map<string, Draft>();
  /** write rounds that failed in a row; zero when the last one landed */
  private draftFailures = 0;
  /** the person has been told this device cannot keep drafts, and not yet that it can again */
  private draftsAnnounced = false;
  /** the photos each draft holds, as the last edit that changed the set sent them: a keystroke carries none (`"kept"`).
      an entry lives only while its draft holds photos, so the map is bounded by the drafts, and by the device's photo cap */
  private readonly photoSets = new Map<string, Photo[]>();
  /** drafts whose photo set changed since the last write: the only ones whose photos go to indexeddb */
  private readonly photosChanged = new Set<string>();
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private watch: ReturnType<typeof setInterval> | undefined;
  private liveSince: number | null = null;
  private readonly posting = new Set<string>();
  /** the posts in flight, by client id, so a dropped stream can end them at once */
  private readonly inflight = new Map<string, AbortController>();
  /** per draft being written: when it started, its longest text and most photos. an entry lives only while its
      draft holds words or photos, so the map is bounded by the drafts */
  private readonly writing = new Map<string, { since: number; peak: number; photos: number }>();

  constructor(
    private readonly cache: () => OutboxStore | null,
    private readonly identity: Identity,
    private readonly telemetry: Pick<Telemetry, "emit">,
    private readonly post: (message: FromWorker) => void,
    private readonly signal: AbortSignal,
  ) {}

  /** the outbox as indexeddb held it; posts that were in flight when the page went away go again, with their ids */
  restore(outbox: OutboxEntry[], drafts: Record<string, Draft> = {}): void {
    for (const entry of outbox) this.entries.set(entry.clientID, entry.state === "sending" ? { ...entry, state: "waiting" } : entry);
    // a kept draft's start is not stored; its last write stands in, so a restored draft's heldMs is a floor
    for (const [key, draft] of Object.entries(drafts)) {
      if (draft.text || draft.photos.length) this.writing.set(key, { since: draft.at, peak: draft.text.length, photos: draft.photos.length });
      if (draft.photos.length) {
        this.photoSets.set(key, draft.photos);
        // the next write of this draft carries its photos once, whatever record they were read from: a draft written
        // before the photos had a record of their own holds them in its words, and the words are written without them
        this.photosChanged.add(key);
      }
    }
  }

  views() {
    return [...this.entries.values()].sort((a, b) => a.at - b.at).map(viewOfEntry);
  }

  /* —— drafts —— */

  draft(key: string, incoming: DraftMessage | null, abandoned = false): void {
    if (incoming && incoming.photos !== "kept") {
      if (incoming.photos.length) this.photoSets.set(key, incoming.photos);
      else this.photoSets.delete(key);
      this.photosChanged.add(key);
    } else if (!incoming) {
      this.photoSets.delete(key);
      this.photosChanged.add(key);
    }
    const photos = this.photoSets.get(key) ?? [];
    this.measure(key, incoming ? { text: incoming.text, photos: photos.length } : null, abandoned);
    const words = incoming ? splitDraft({ ...incoming, photos }).words : null;
    if (words) this.latest.set(key, words);
    else this.latest.delete(key);
    this.drafts.set(key, words);
    this.armDrafts();
  }

  /** writes the drafts a pause in typing from now. while writes are failing the retry's own, backed off timer stands: an edit
      does not make it sooner, since each try can be megabytes of photo and the words are kept in memory meanwhile */
  private armDrafts(): void {
    if (this.draftFailures > 0) return;
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => void this.writeDrafts(), DRAFT_DEBOUNCE_MS);
  }

  /** friction.abandon: what was written and thrown away, read from the draft before it is cleared */
  private measure(key: string, draft: { text: string; photos: number } | null, abandoned: boolean): void {
    const chars = draft?.text.length ?? 0;
    const photos = draft?.photos ?? 0;
    const was = this.writing.get(key);
    if (abandoned && was) {
      const host = key.startsWith("new:") ? key.split(":")[1] : key.slice(0, key.indexOf(":"));
      this.telemetry.emit("friction.abandon", { what: "compose", chars: was.peak, files: was.photos, heldMs: Date.now() - was.since }, host ? { host } : {});
    }
    if (chars || photos) this.writing.set(key, { since: was?.since ?? Date.now(), peak: Math.max(was?.peak ?? 0, chars), photos: Math.max(was?.photos ?? 0, photos) });
    else this.writing.delete(key);
  }

  /** the page is going away: drafts are written now */
  async flush(): Promise<void> {
    clearTimeout(this.draftTimer);
    await this.writeDrafts();
  }

  private async writeDrafts(): Promise<void> {
    const cache = this.cache();
    const pending = [...this.drafts];
    this.drafts.clear();
    // only the drafts written now give up their photo marks: a restored draft's waits for its first edit
    const changed = new Set(pending.map(([key]) => key).filter((key) => this.photosChanged.delete(key)));
    let failed = false;
    for (const [key, words] of pending) {
      try {
        await cache?.putDraft(key, words, words && changed.has(key) ? (this.photoSets.get(key) ?? []) : undefined);
      } catch {
        // a write that did not land (the quota, a closing database) is not given up: the draft goes back, made from its
        // newest words (an edit that came while this write was slow may have been written already, and must not be
        // written over by the words this one carried), and its photo set is still to be written
        failed = true;
        this.drafts.set(key, this.latest.get(key) ?? null);
        if (changed.has(key)) this.photosChanged.add(key);
      }
    }
    if (failed) {
      this.draftFailures += 1;
      // a few rounds in a row is not a blip: the person is told, once, that what they write is not being kept
      if (this.draftFailures >= DRAFT_TROUBLE_AFTER && !this.draftsAnnounced) {
        this.draftsAnnounced = true;
        this.post({ type: "drafts", kept: false });
      }
      clearTimeout(this.draftTimer);
      this.draftTimer = setTimeout(() => void this.writeDrafts(), draftRetryMs(this.draftFailures));
      return;
    }
    this.draftFailures = 0;
    if (this.draftsAnnounced) {
      this.draftsAnnounced = false;
      this.post({ type: "drafts", kept: true });
    }
    // edits that came in while this round was writing wait for their own pause
    if (this.drafts.size > 0) this.armDrafts();
  }

  /* —— sends —— */

  send(outgoing: Outgoing): void {
    // the photos' bytes are capped for real: a message that would pass the cap does not take its photos into the outbox. they go
    // back to the draft they came from, so nothing is lost, and the message stays as a failed card with its words alone, which
    // cannot be retried (that would send the words without them); editing it puts the words back in the draft beside them. the
    // composer asks for room before it takes a photo, so this is a backstop and not a path a person meets
    const over = outgoing.photos.length > 0 && this.photoBytesHeld() + photoBytes(outgoing.photos) > OUTBOX_PHOTO_BYTES;
    if (over || this.entries.size >= OUTBOX_CAP) {
      const refused = entryOf(over ? { ...outgoing, photos: [] } : outgoing, false);
      if (over) this.post({ type: "returned", key: refused.key, photos: outgoing.photos, text: null });
      // a full outbox means sends are stuck, and each is on screen with its reason; a new one is refused in words
      const error = over ? photosSentBack(outgoing.photos.length) : "too many messages are still waiting to go. retry or remove one first";
      this.put({ ...refused, state: "failed", error, ...(over ? { photosReturned: outgoing.photos.length } : {}) });
      return;
    }
    this.put(entryOf(outgoing, this.liveSince !== null));
    void this.pump();
  }

  /** the data url characters every entry's photos hold */
  private photoBytesHeld(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += photoBytes(entry.photos);
    return total;
  }

  retry(clientID: string): void {
    const entry = this.entries.get(clientID);
    // an entry whose photos went back to the draft would go as its words alone
    if (!entry || entry.state !== "failed" || entry.photosReturned) return;
    this.put({ ...entry, state: this.liveSince !== null ? "sending" : "waiting", attempts: 0, error: null });
    void this.pump();
  }

  /** forgets a failed send; `photosToDraft` hands its photos back to the draft they came from (the person is editing it) */
  discard(clientID: string, photosToDraft = false): void {
    const entry = this.entries.get(clientID);
    if (!entry || entry.state !== "failed") return;
    if (photosToDraft && entry.photos.length) this.post({ type: "returned", key: entry.key, photos: entry.photos, text: null });
    this.drop(entry);
  }

  /** takes back a queued message. for this device's own send, the entry ends when the daemon removes it */
  async unsend(key: string, messageID: string, clientID: string | null, toDraft = false): Promise<void> {
    const own = clientID ? this.entries.get(clientID) : undefined;
    if (own) this.put({ ...own, unsending: true });
    const [host, session] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    const res = await this.call(`/api/hosts/${encodeURIComponent(host)}/sessions/${encodeURIComponent(session)}/messages/${encodeURIComponent(messageID)}`, null, { method: "DELETE", ms: POST_MS });
    const ok = res.kind === "taken";
    // what was taken back is the person's again, its words and photos together and before the answer: the ui puts the words
    // into a draft that held nothing, and a photo coming back must not make it look as though it had
    const returned = ok && toDraft && own !== undefined;
    if (returned) this.post({ type: "returned", key: own.key, photos: own.photos, text: own.text });
    if (!ok && own) {
      const now = this.entries.get(own.clientID);
      if (now) this.put({ ...now, unsending: false });
    }
    this.post({ type: "unsent", key, messageID, ok, message: ok ? null : unsendRefusal(res), returned });
  }

  /* —— the stream —— */

  stream(state: StreamState): void {
    if (state === "live") {
      this.liveSince ??= Date.now();
      for (const entry of this.entries.values()) if (entry.state === "waiting") this.put({ ...entry, state: "sending" });
      void this.pump();
      this.watch ??= setInterval(() => this.check(), WATCH_MS);
    } else {
      this.liveSince = null;
      // the connection is gone: a post in flight may never be answered, so it ends now and its send waits on the
      // device, to go again with the same id when the stream is back (the daemon answers a repeat with the first answer)
      for (const controller of this.inflight.values()) controller.abort();
    }
  }

  /** a frame from the stream: the echo that settles a send, or the removal that ends an unsent one */
  frame(frame: Frame): void {
    if (this.entries.size === 0) return;
    if (frame.type === "message" && frame.info.clientID) {
      for (const entry of this.entries.values()) {
        if (entry.clientID !== frame.info.clientID) continue;
        this.settle(entry, echoed(entry, frame.key, frame.info, Date.now()));
      }
    } else if (frame.type === "message.removed") {
      for (const entry of this.entries.values()) {
        const next = removed(entry, frame.key, frame.messageID);
        if (next === null) this.drop(entry);
      }
    }
  }

  /** a thread's transcript, read whole after a reset or a refetch. an echo that went by while the stream was away
      (boxbox restarted, the cursor's epoch gone) is only here, and a send that landed must not be called "not sent" */
  read(key: string, messages: readonly Message[]): void {
    if (this.entries.size === 0) return;
    const now = Date.now();
    for (const { info } of messages) {
      const entry = info.clientID ? this.entries.get(info.clientID) : undefined;
      if (entry) this.settle(entry, echoed(entry, key, info, now));
    }
  }

  private settle(before: OutboxEntry, after: OutboxEntry): void {
    if (after === before) return;
    if (before.ackAt === null && after.ackAt !== null) {
      this.telemetry.emit("perf.send", sendProps(after), { ok: true, ms: after.ackAt - after.at, ...where(after) });
    }
    // a new thread's own session, said once, before the entry can be dropped: a ui that waits for its thread reads
    // this, never the outbox (which is gone the moment the echo lands) and never a guess from the fleet
    if (after.target.kind === "new" && after.session && !before.session) this.post({ type: "born", clientID: after.clientID, key: `${after.target.host}:${after.session}` });
    if (after.state === "landed") this.drop(after);
    else this.put(after);
  }

  private check(): void {
    const now = Date.now();
    for (const entry of this.entries.values()) {
      if (!overdue(entry, this.liveSince, now)) continue;
      this.put({ ...entry, state: "failed", error: "the daemon did not confirm it. retry sends it once, never twice" });
      this.telemetry.emit("perf.send", sendProps(entry), { ok: false, ms: now - entry.at, ...where(entry) });
    }
    if (this.entries.size === 0 && this.watch !== undefined) {
      clearInterval(this.watch);
      this.watch = undefined;
    }
  }

  /** posts what is due, oldest first; one post per entry at a time */
  private async pump(): Promise<void> {
    if (this.liveSince === null) return;
    const due = [...this.entries.values()].filter((e) => e.state === "sending" && e.attempts === 0 && !this.posting.has(e.clientID)).sort((a, b) => a.at - b.at);
    const waiting = nextWaiting([...this.entries.values()]);
    if (waiting) due.push(waiting);
    for (const entry of due) await this.deliver(entry.clientID);
  }

  private async deliver(clientID: string): Promise<void> {
    if (this.posting.has(clientID)) return;
    this.posting.add(clientID);
    const backoff = new Backoff(1000, 8000);
    try {
      for (;;) {
        const entry = this.entries.get(clientID);
        if (!entry || entry.state !== "sending" || this.signal.aborted) return;
        const attempted = { ...entry, attempts: entry.attempts + 1 };
        this.put(attempted);
        const [path, body] = this.request(attempted);
        const answer = await this.call(path, body, { clientID, ms: postBudgetMs(attempted.photos, POST_MARGIN_MS) });
        const latest = this.entries.get(clientID);
        if (!latest) return;
        const next = answered(latest, answer, Date.now());
        if (answer.kind === "unreachable" && next.state !== "failed") {
          if (this.liveSince === null) return this.put({ ...next, state: "waiting", attempts: 0 });
          this.put(next);
          await new Promise((resolve) => setTimeout(resolve, backoff.nextDelay()));
          continue;
        }
        if (next.state === "failed") {
          this.telemetry.emit("perf.send", sendProps(next), { ok: false, ms: Date.now() - next.at, ...where(next) });
        }
        this.settle(latest, next);
        return;
      }
    } finally {
      this.posting.delete(clientID);
    }
  }

  /** the route and body a send goes to */
  private request(entry: OutboxEntry): [string, Record<string, unknown>] {
    const host = encodeURIComponent(entry.target.host);
    const photos = entry.photos.map(({ mime, filename, url }) => ({ mime, filename, url }));
    const choice = { ...(entry.model ? { model: entry.model } : {}), ...(entry.effort ? { effort: entry.effort } : {}) };
    if (entry.target.kind === "new") {
      return [`/api/hosts/${host}/sessions`, { clientID: entry.clientID, directory: entry.target.directory, place: entry.target.place, text: entry.text, photos, ...choice }];
    }
    const at = `/api/hosts/${host}/sessions/${encodeURIComponent(entry.target.session)}`;
    switch (entry.verb) {
      case "prompt":
      case "start":
        return [`${at}/prompt`, { clientID: entry.clientID, text: entry.text, photos, ...choice }];
      case "steer":
        return [`${at}/steer`, { clientID: entry.clientID, text: entry.text, photos }];
      case "shell":
        return [`${at}/shell`, { clientID: entry.clientID, command: entry.text }];
      case "command": {
        const [name = "", ...rest] = entry.text.replace(/^\//, "").split(" ");
        return [`${at}/command`, { clientID: entry.clientID, command: name, ...(rest.length ? { arguments: rest.join(" ") } : {}) }];
      }
      default:
        return entry.verb satisfies never;
    }
  }

  /** one post to boxbox's api, its answer read into what it means for the send. it ends when the worker stops,
      when its time is up, or, for a send, when the stream drops */
  private async call(path: string, body: Record<string, unknown> | null, bound: { clientID?: string; ms: number; method?: "POST" | "DELETE" } = { ms: POST_MS }): Promise<Answer> {
    const controller = new AbortController();
    const stop = () => controller.abort();
    this.signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, bound.ms);
    if (bound.clientID) this.inflight.set(bound.clientID, controller);
    try {
      let res: Response;
      try {
        // every route with a body takes the device, which arms the turn for its "done" push
        const sent = body ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ device: this.identity.device, deviceClass: this.identity.deviceClass, ...body }) } : {};
        res = await fetch(path, {
          method: bound.method ?? "POST",
          ...sent,
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
      } catch {
        return { kind: "unreachable", message: "the boxbox server is not answering" };
      }
      // the status is the answer; a body that never finishes is ended by the same abort and read as empty
      return await this.answerOf(res, path);
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", stop);
      if (bound.clientID && this.inflight.get(bound.clientID) === controller) this.inflight.delete(bound.clientID);
    }
  }

  private async answerOf(res: Response, path: string): Promise<Answer> {
    // boxbox refuses as `{error: {message}}`; a passthrough route carries the daemon's own `{name, data: {message}}`
    const json = (await res.json().catch(() => null)) as { session?: string; error?: { message?: string; code?: string }; name?: string; data?: { message?: string } } | null;
    if (res.ok) return { kind: "taken", ...(typeof json?.session === "string" ? { session: json.session } : {}), landed: path.endsWith("/shell") };
    const message = json?.error?.message ?? json?.data?.message ?? `the server answered ${res.status}`;
    // a server that waited for room for a message's photos and had none has given its answer: it waited two minutes, and
    // three tries would be six. the person is told, and sends it again when they choose
    if (res.status === 503 && json?.error?.code === "photos-busy") return { kind: "refused", message, status: 503 };
    // a host that did not answer, a server stopping: worth trying again. anything else is an answer
    if (res.status === 502 || res.status === 503 || res.status === 504) return { kind: "unreachable", message };
    return { kind: "refused", message, status: res.status, ...(json?.name ? { name: json.name } : {}) };
  }

  private put(entry: OutboxEntry): void {
    this.entries.set(entry.clientID, entry);
    void this.cache()?.putEntry(entry.clientID, entry).catch(() => undefined);
    this.post({ type: "outbox", outbox: this.views() });
  }

  private drop(entry: OutboxEntry): void {
    this.entries.delete(entry.clientID);
    void this.cache()?.putEntry(entry.clientID, null).catch(() => undefined);
    this.post({ type: "outbox", outbox: this.views() });
  }
}

