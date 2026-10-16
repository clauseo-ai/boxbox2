/* the worker's indexeddb cache (docs/architecture.md, indexeddb layout):
   database `boxbox` v2 with `meta` (the cursor and counters), `fleet` (the
   model), `threads` (a head record per thread plus pages of 50 messages),
   `drafts` (the composer's words, one per target), `draftPhotos` (the same
   targets' photos, written only when the set changes; v3), `outbox` (sends
   the daemon has not echoed yet, by client id; v2; telemetry rows under
   `row:` and this device's replies to asks under `ask:` share it) and
   `prefs`.

   boot reads the meta, the fleet and the heads, never a page (`loadBoot`):
   a thread's pages come back when it is opened or held (`loadPages`), and
   the reducer marks a thread whose entries passed while it was cold, so the
   pages read later are read again from the daemon (reducer.ts, `Cold`).

   the cursor is written in the same transaction as the fleet and the
   thread pages it reflects. that is what makes a reload exactly once: the
   state read back at boot is exactly the state after the cursor's entry,
   so resuming from that cursor applies every later entry once and no
   earlier one again. */

import type { Cold, Counters, Fleet, SyncState } from "./reducer";
import { type Draft, joinDraft, type OutboxEntry, type Photo } from "./outbox";
import type { RawEvent } from "./telemetry";
import type { AskReply } from "./replies";
import type { Cursor, Message } from "./protocol";

const NAME = "boxbox";
const VERSION = 3;
/** a telemetry row's key in the outbox store; a send's key is its client id, a uuid, which never starts with this */
const ROW = "row:";
/** a reply's record's key in the outbox store (replies.ts): `ask:` and its book key */
const ASK = "ask:";
const STORES = ["meta", "fleet", "threads", "drafts", "draftPhotos", "outbox", "prefs"] as const;
export const PAGE = 50;

/** what changed since the last save: the fleet, and per thread the first message index that did
    (Infinity when only the head record did) */
export type Dirty = { fleet: boolean; threads: Map<string, number> };

export const cleanDirty = (): Dirty => ({ fleet: false, threads: new Map() });

type SyncMeta = { cursor: Cursor | null; counters: Counters };

/** a head record is a cold thread's head, and nothing else: the reducer's `Cold` is the one shape, but for the lease, which
    lives in memory only, so a page that is reloaded starts with every place of the held reserve free */
type ThreadHead = Omit<Cold, "leased">;

export type Booted = { cursor: Cursor | null; counters: Counters | null; fleet: Fleet | null; heads: Cold[] };

const headKey = (key: string) => `${key}#head`;
const pageKey = (key: string, page: number) => `${key}#${page}`;

/** a cold head as the record it was read from: one that never had a size is written without one, so it still reads as unsized */
function headRecord(head: Cold): Partial<ThreadHead> {
  const { leased: _lease, ...record } = head;
  if (record.sized) return record;
  const { bytes: _unknown, ...rest } = record;
  return rest;
}

/** a head as it was saved, with what heads written before this build lack filled in; null for a record that is no head */
function decodeHead(record: Partial<ThreadHead> | undefined): Cold | null {
  if (!record || typeof record.key !== "string") return null;
  const pages = record.pages ?? 0;
  return {
    key: record.key,
    status: record.status ?? "hydrating",
    hydration: record.hydration ?? 1,
    upstreamEpoch: record.upstreamEpoch ?? null,
    hydratedAt: record.hydratedAt ?? 0,
    lastUpstream: record.lastUpstream ?? 0,
    baseline: record.baseline ?? {},
    refetching: record.refetching ?? [],
    openedAt: record.openedAt ?? 0,
    heldAt: record.heldAt ?? 0,
    leased: false,
    // a head written before heads carried a size has none: it counts for nothing until its pages are read and measured
    bytes: record.bytes ?? 0,
    sized: record.bytes !== undefined,
    pages,
    stale: record.stale ?? false,
  };
}

function done(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("an indexeddb request failed"));
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("an indexeddb transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("an indexeddb transaction failed"));
  });
}

/** what opening the database reports to its owner */
export type OpenEvents = { blocked(): void; unblocked(): void; superseded(): void };

export class Cache {
  /** how many pages each thread had at the last save, so pages past a shrunk thread are deleted */
  private readonly pagesWritten = new Map<string, number>();

  private constructor(private readonly db: IDBDatabase) {}

  /** null when the browser offers no indexeddb (a private window): the worker runs without a cache.
      an upgrade waits for every other connection to close, so `events` say when this one is waiting on a tab running an
      older build (`blocked`, then `unblocked` when it is through), and when a newer build wants the database and this
      connection has let go of it (`superseded`: the cache is closed and this page should reload) */
  static async open(events?: OpenEvents): Promise<Cache | null> {
    if (typeof indexedDB === "undefined") return null;
    let blocked = false;
    try {
      const request = indexedDB.open(NAME, VERSION);
      request.onupgradeneeded = () => {
        for (const store of STORES) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
      };
      request.onblocked = () => {
        blocked = true;
        events?.blocked();
      };
      const db = (await done(request)) as IDBDatabase;
      db.onversionchange = () => {
        db.close();
        events?.superseded();
      };
      return new Cache(db);
    } catch {
      return null;
    } finally {
      if (blocked) events?.unblocked();
    }
  }

  /** the first frame's reads: the meta, the fleet and every thread's head. a thread's pages are not read until it is
      wanted (`loadPages`), so a launch costs what the fleet is, not what ten megabytes of transcript are */
  async loadBoot(): Promise<Booted> {
    const tx = this.db.transaction(["meta", "fleet", "threads"], "readonly");
    const threads = tx.objectStore("threads");
    const [meta, fleet, keys] = await Promise.all([
      done(tx.objectStore("meta").get("sync")) as Promise<SyncMeta | undefined>,
      done(tx.objectStore("fleet").get("fleet")) as Promise<Fleet | undefined>,
      done(threads.getAllKeys()) as Promise<IDBValidKey[]>,
    ]);
    const records = await Promise.all(keys.map(String).filter((id) => id.endsWith("#head")).map((id) => done(threads.get(id)) as Promise<Partial<ThreadHead> | undefined>));
    const heads: Cold[] = [];
    for (const record of records) {
      const head = decodeHead(record);
      if (!head) continue;
      this.pagesWritten.set(head.key, head.pages);
      heads.push(head);
    }
    return { cursor: meta?.cursor ?? null, counters: meta?.counters ?? null, fleet: fleet ?? null, heads };
  }

  /** a thread's messages from its pages, or null when a page the head counts is missing (the thread is read from the daemon) */
  async loadPages(head: Pick<Cold, "key" | "pages">): Promise<Message[] | null> {
    const tx = this.db.transaction("threads", "readonly");
    const store = tx.objectStore("threads");
    const pages = await Promise.all(Array.from({ length: head.pages }, (_, page) => done(store.get(pageKey(head.key, page))) as Promise<Message[] | undefined>));
    const messages: Message[] = [];
    for (const page of pages) {
      if (!page) return null;
      messages.push(...page);
    }
    return messages;
  }

  /** writes the cursor with everything `dirty` names, from one state, in one transaction */
  async save(state: SyncState, dirty: Dirty): Promise<void> {
    const tx = this.db.transaction(["meta", "fleet", "threads"], "readwrite");
    const threads = tx.objectStore("threads");
    tx.objectStore("meta").put({ cursor: state.cursor, counters: state.counters } satisfies SyncMeta, "sync");
    if (dirty.fleet) tx.objectStore("fleet").put(state.fleet, "fleet");
    for (const [key, from] of dirty.threads) {
      const thread = state.threads[key];
      const before = this.pagesWritten.get(key) ?? 0;
      if (!thread) {
        const cold = state.cold[key];
        // a cold thread's pages stay as they are; only its head changed (recency, or the journal passed it)
        if (cold) {
          threads.put(headRecord(cold), headKey(key));
          continue;
        }
        threads.delete(IDBKeyRange.bound(`${key}#`, `${key}#\uffff`));
        this.pagesWritten.delete(key);
        continue;
      }
      const pages = Math.ceil(thread.messages.length / PAGE);
      const first = Number.isFinite(from) ? Math.floor(from / PAGE) : pages;
      for (let page = first; page < pages; page++) threads.put(thread.messages.slice(page * PAGE, (page + 1) * PAGE), pageKey(key, page));
      for (let page = pages; page < before; page++) threads.delete(pageKey(key, page));
      threads.put(
        {
          key,
          status: thread.status,
          hydration: thread.hydration,
          upstreamEpoch: thread.upstreamEpoch,
          hydratedAt: thread.hydratedAt,
          lastUpstream: thread.lastUpstream,
          baseline: thread.baseline,
          refetching: Object.keys(thread.refetching),
          openedAt: thread.openedAt,
          heldAt: thread.heldAt,
          bytes: thread.bytes,
          sized: true,
          pages,
          stale: false,
        } satisfies ThreadHead,
        headKey(key),
      );
      this.pagesWritten.set(key, pages);
    }
    await committed(tx);
  }

  /** the composer's drafts by target key, the sends not yet echoed, the telemetry rows the server has not taken, and this device's
      replies to asks as they were written (replies.ts reads them) */
  async loadComposer(): Promise<{ drafts: Record<string, Draft>; outbox: OutboxEntry[]; rows: RawEvent[]; replies: unknown[] }> {
    const tx = this.db.transaction(["drafts", "draftPhotos", "outbox"], "readonly");
    const [keys, values, photoKeys, photoValues, outboxKeys, outboxValues] = await Promise.all([
      done(tx.objectStore("drafts").getAllKeys()) as Promise<IDBValidKey[]>,
      done(tx.objectStore("drafts").getAll()) as Promise<Draft[]>,
      done(tx.objectStore("draftPhotos").getAllKeys()) as Promise<IDBValidKey[]>,
      done(tx.objectStore("draftPhotos").getAll()) as Promise<Photo[][]>,
      done(tx.objectStore("outbox").getAllKeys()) as Promise<IDBValidKey[]>,
      done(tx.objectStore("outbox").getAll()) as Promise<unknown[]>,
    ]);
    const photoSets = new Map<string, Photo[]>();
    photoKeys.forEach((key, i) => photoSets.set(String(key), photoValues[i] ?? []));
    const drafts: Record<string, Draft> = {};
    // a draft written before the photos had a record of their own still holds them in its words: it reads as it was, and the
    // sender writes its photos into their own record with its first edit (`Sender.restore`)
    keys.forEach((key, i) => {
      const words = values[i];
      if (words) drafts[String(key)] = joinDraft(words, photoSets.get(String(key)));
    });
    // one store, three kinds of entry: a send by its client id, a row by `row:<id>`, a reply's record by `ask:<key>`
    const outbox: OutboxEntry[] = [];
    const rows: RawEvent[] = [];
    const replies: unknown[] = [];
    outboxKeys.forEach((key, i) => {
      const value = outboxValues[i];
      if (value === undefined) return;
      if (String(key).startsWith(ROW)) rows.push(value as RawEvent);
      else if (String(key).startsWith(ASK)) replies.push(value);
      else outbox.push(value as OutboxEntry);
    });
    return { drafts, outbox, rows, replies };
  }

  /** keeps telemetry rows in the outbox until the server takes them (telemetry.ts) */
  async putRows(rows: readonly RawEvent[]): Promise<void> {
    const tx = this.db.transaction("outbox", "readwrite");
    for (const row of rows) tx.objectStore("outbox").put(row, ROW + row.id);
    await committed(tx);
  }

  async forgetRows(ids: readonly string[]): Promise<void> {
    const tx = this.db.transaction("outbox", "readwrite");
    for (const id of ids) tx.objectStore("outbox").delete(ROW + id);
    await committed(tx);
  }

  /** writes a target's words, and its photos when `photos` is given (an empty set forgets them); null forgets the draft
      whole. the words record carries no photos, so a pause in typing writes bytes of text and not megabytes of photo */
  async putDraft(key: string, words: Draft | null, photos?: readonly Photo[]): Promise<void> {
    const tx = this.db.transaction(["drafts", "draftPhotos"], "readwrite");
    if (words) tx.objectStore("drafts").put(words, key);
    else tx.objectStore("drafts").delete(key);
    if (!words || photos?.length === 0) tx.objectStore("draftPhotos").delete(key);
    else if (photos) tx.objectStore("draftPhotos").put(photos, key);
    await committed(tx);
  }

  /** keeps a reply's record under its book key, and lets go of the records the book dropped past its cap */
  async putReply(key: string | null, record: AskReply | null, dropped: readonly string[]): Promise<void> {
    const tx = this.db.transaction("outbox", "readwrite");
    if (key && record) tx.objectStore("outbox").put(record, ASK + key);
    for (const old of dropped) tx.objectStore("outbox").delete(ASK + old);
    await committed(tx);
  }

  /** writes an outbox entry, or forgets it when it settled */
  async putEntry(clientID: string, entry: OutboxEntry | null): Promise<void> {
    const tx = this.db.transaction("outbox", "readwrite");
    if (entry) tx.objectStore("outbox").put(entry, clientID);
    else tx.objectStore("outbox").delete(clientID);
    await committed(tx);
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction([...STORES], "readwrite");
    for (const store of STORES) tx.objectStore(store).clear();
    this.pagesWritten.clear();
    await committed(tx);
  }

  close(): void {
    this.db.close();
  }
}
