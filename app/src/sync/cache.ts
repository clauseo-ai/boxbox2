/* the worker's indexeddb cache (docs/architecture.md, indexeddb layout):
   database `boxbox` v4 with `meta` (the cursor and counters), `fleet` (the
   model, a record per session, ask and host plus one per other field and an
   index of their keys in order; v4, `fleetRecords`), `threads` (a head
   record per thread plus its pages, `layout`),
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
   earlier one again.

   a save writes what changed and no more: the sessions, asks and hosts a
   patch named, and a thread's pages from the first message that changed,
   so a streaming thread rewrites its last message, not its last fifty. the
   worker's `Saver` keeps one save in flight at most: what changes while it
   commits waits for the next, which writes all of it. */

import type { Cold, Counters, Fleet, Patch, SyncState } from "./reducer";
import { type Draft, joinDraft, type OutboxEntry, type Photo } from "./outbox";
import type { RawEvent } from "./telemetry";
import type { AskReply } from "./replies";
import type { Cursor, Message } from "./protocol";

const NAME = "boxbox";
/** v4 split the fleet's one record into a record per entry (`fleetRecords`), in place (`open`) */
const VERSION = 4;
/** a telemetry row's key in the outbox store; a send's key is its client id, a uuid, which never starts with this */
const ROW = "row:";
/** a reply's record's key in the outbox store (replies.ts): `ask:` and its book key */
const ASK = "ask:";
const STORES = ["meta", "fleet", "threads", "drafts", "draftPhotos", "outbox", "prefs"] as const;
export const PAGE = 50;

/** the fleet's fields kept as a record per entry; every other field is a record of its own */
const ENTRIES = ["sessions", "asks", "hosts"] as const;
type EntryField = (typeof ENTRIES)[number];
const isEntryField = (field: unknown): field is EntryField => ENTRIES.some((name) => name === field);

/** what changed since the last save. `fleet`: the whole fleet (a reset, or a map replaced whole); `entries`: per map, the
    keys whose entry changed or went; `fields`: the fleet's other fields that changed; `threads`: per thread the first
    message index that changed (Infinity when only the head record did) */
export type Dirty = { fleet: boolean; entries: Record<EntryField, Set<string>>; fields: Set<string>; threads: Map<string, number> };

export const cleanDirty = (): Dirty => ({ fleet: false, entries: { sessions: new Set(), asks: new Set(), hosts: new Set() }, fields: new Set(), threads: new Map() });

const isClean = (dirty: Dirty): boolean =>
  !dirty.fleet && dirty.fields.size === 0 && dirty.threads.size === 0 && ENTRIES.every((field) => dirty.entries[field].size === 0);

/** a thread's records are to be written from message `from` on (0: all of them; Infinity: the head alone) */
export function markThread(dirty: Dirty, key: string, from: number): void {
  dirty.threads.set(key, Math.min(from, dirty.threads.get(key) ?? from));
}

/** what the reducer's patches changed, from their paths alone, at whatever depth they name: `["fleet", "sessions", key, ...]`
    is that session's record, `["threads", key, "messages", at, ...]` the thread's pages from message `at` */
export function markPatches(dirty: Dirty, patches: readonly Patch[]): void {
  for (const { path } of patches) {
    const [root, field, key] = path;
    if (root === "fleet") {
      if (field === undefined) dirty.fleet = true;
      else if (!isEntryField(field)) dirty.fields.add(String(field));
      else if (typeof key === "string") dirty.entries[field].add(key);
      else dirty.fleet = true;
    } else if (root === "threads" && typeof field === "string") {
      const part = path[2];
      // the head's own fields (status, trouble) leave every page as it was
      const from = part === undefined ? 0 : part !== "messages" ? Number.POSITIVE_INFINITY : typeof path[3] === "number" ? path[3] : 0;
      markThread(dirty, field, from);
    }
  }
}

/** `from`'s changes join `into`'s: a write that failed is still to write */
function mergeDirty(into: Dirty, from: Dirty): void {
  into.fleet ||= from.fleet;
  for (const field of ENTRIES) for (const key of from.entries[field]) into.entries[field].add(key);
  for (const field of from.fields) into.fields.add(field);
  for (const [key, at] of from.threads) markThread(into, key, at);
}

/** about how many bytes a value takes to store: its strings by their length (read, never copied), 8 a number, and the names
    of its keys. it walks what is written, so it costs what the write does, a fraction of the clone */
export function weight(value: unknown): number {
  switch (typeof value) {
    case "string":
      return value.length;
    case "number":
    case "boolean":
      return 8;
    case "object": {
      if (value === null) return 1;
      let total = 8;
      if (Array.isArray(value)) {
        for (const item of value as unknown[]) total += weight(item);
        return total;
      }
      const record = value as Record<string, unknown>;
      for (const name in record) total += name.length + weight(record[name]);
      return total;
    }
    default:
      return 0;
  }
}

type SyncMeta = {
  cursor: Cursor | null;
  counters: Counters;
  /** the cache that wrote it, and a number each save takes one past, so a writer can tell another wrote since (`Cache.save`) */
  writer?: string;
  generation?: number;
};

/** the fleet store's index record: the fleet's fields in their order, and each map's keys in theirs, so the fleet read back
    is the one saved down to the order `Object.keys` gives */
type FleetIndex = { fields: string[]; keys: Record<EntryField, string[]> };

const INDEX = "index";
const fieldKey = (field: string) => `field:${field}`;
const entryKey = (field: EntryField, key: string) => `${field}:${key}`;

const indexOf = (fleet: Fleet): FleetIndex => ({
  fields: Object.keys(fleet),
  keys: { sessions: Object.keys(fleet.sessions), asks: Object.keys(fleet.asks), hosts: Object.keys(fleet.hosts) },
});

const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key, i) => key === b[i]);
const sameIndex = (a: FleetIndex, b: FleetIndex) => sameKeys(a.fields, b.fields) && ENTRIES.every((field) => sameKeys(a.keys[field], b.keys[field]));

/** a fleet as the records the fleet store keeps it in: the index, one per entry of each map, one per other field. a fleet
    saved before v4 had no colours: its index names none, and it reads with none, as before */
function fleetRecords(fleet: Fleet): [string, unknown][] {
  const index = indexOf(fleet);
  const records: [string, unknown][] = [[INDEX, index]];
  const fields = fleet as unknown as Record<string, unknown>;
  for (const field of index.fields) {
    if (!isEntryField(field)) records.push([fieldKey(field), fields[field]]);
  }
  for (const field of ENTRIES) {
    const map: Record<string, unknown> = fleet[field] ?? {};
    for (const key of index.keys[field]) records.push([entryKey(field, key), map[key]]);
  }
  return records;
}

/** the fleet the records hold, built in the index's order; null when no fleet was saved */
function fleetOf(index: FleetIndex | undefined, records: Map<string, unknown>): Fleet | null {
  if (!index) return null;
  const fleet: Record<string, unknown> = {};
  for (const field of index.fields) {
    if (!isEntryField(field)) {
      fleet[field] = records.get(fieldKey(field));
      continue;
    }
    const map: Record<string, unknown> = {};
    for (const key of index.keys[field]) {
      // an index names only keys whose records it was written with; a record missing is left out rather than read as undefined
      const record = records.get(entryKey(field, key));
      if (record !== undefined) map[key] = record;
    }
    fleet[field] = map;
  }
  // the records are the fleet's own, written from one by `fleetRecords`
  return fleet as unknown as Fleet;
}

/** where each page of a thread of `count` messages starts, and where the last ends. the last message, the one a stream grows,
    has a page of its own; before it, pages of fifty, then what is left in pages of 32, 16, 8, 4, 2 and 1, largest first. a
    message that joins the end then rewrites only the small pages it merges with, as a binary counter carries, so a message
    is rewritten a few times on its way into a page of fifty rather than with every message after it. `loadPages` reads any
    layout, so pages written as fifty to the end before v4 read as they are */
export function layout(count: number): number[] {
  if (count === 0) return [0];
  const before = count - 1;
  const full = before - (before % PAGE);
  const starts: number[] = [];
  for (let start = 0; start < full; start += PAGE) starts.push(start);
  let start = full;
  for (let size = 32; size >= 1; size /= 2) {
    if (((before - full) & size) === 0) continue;
    starts.push(start);
    start += size;
  }
  starts.push(before, count);
  return starts;
}

/** what a save wrote: records put and their size by `weight` */
export type SaveStats = { puts: number; bytes: number };

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

/** a cold thread's head after another writer saved: the pages are that writer's, so the head keeps what the disk's head says
    of them (their count and size) and this page's recency, and is marked stale, so the thread is read again from the daemon
    when it is opened, as one the journal passed while it was cold. with no head on disk the pages are gone, and its
    restore finds a page missing and reads it afresh */
function strangerHead(cold: Cold, disk: Partial<ThreadHead> | undefined): Partial<ThreadHead> {
  const mine = headRecord(cold);
  if (!disk) return { ...mine, stale: true };
  return { ...disk, openedAt: cold.openedAt, heldAt: cold.heldAt, stale: true };
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

/** v4's upgrade: the one `fleet` record earlier versions wrote becomes the records `fleetRecords` makes of it */
function splitFleet(store: IDBObjectStore): void {
  const read = store.get("fleet");
  read.onsuccess = () => {
    const whole = read.result as Fleet | undefined;
    if (!whole) return;
    store.delete("fleet");
    for (const [key, value] of fleetRecords(whole)) store.put(value, key);
  };
}

/** what opening the database reports to its owner */
export type OpenEvents = { blocked(): void; unblocked(): void; superseded(): void };

export class Cache {
  /** where each page of a thread starts (`layout`), for the threads whose pages this cache wrote or read, so a save rewrites
      only the pages that changed; a thread missing here is written whole */
  private readonly layouts = new Map<string, number[]>();
  /** the fleet store's index as it is on disk; null until read or written, and a fleet saved then is written whole */
  private fleetIndex: FleetIndex | null = null;
  /** this cache, as the meta names the writer of the last save */
  private readonly writer = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  /** the meta's writer and generation as this cache last read or wrote them: a meta that says otherwise was written by another */
  private seen: { writer: string | undefined; generation: number | undefined } = { writer: undefined, generation: undefined };

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
      request.onupgradeneeded = (event) => {
        for (const store of STORES) if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store);
        // a fleet saved whole before v4 is split where it lies, in the upgrade's own transaction, so the cache survives it
        if (event.oldVersion > 0 && event.oldVersion < 4 && request.transaction) splitFleet(request.transaction.objectStore("fleet"));
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
    const fleetStore = tx.objectStore("fleet");
    const [meta, fleetKeys, fleetValues, keys] = await Promise.all([
      done(tx.objectStore("meta").get("sync")) as Promise<SyncMeta | undefined>,
      done(fleetStore.getAllKeys()) as Promise<IDBValidKey[]>,
      done(fleetStore.getAll()) as Promise<unknown[]>,
      done(threads.getAllKeys()) as Promise<IDBValidKey[]>,
    ]);
    const records = await Promise.all(keys.map(String).filter((id) => id.endsWith("#head")).map((id) => done(threads.get(id)) as Promise<Partial<ThreadHead> | undefined>));
    const heads: Cold[] = [];
    for (const record of records) {
      const head = decodeHead(record);
      if (!head) continue;
      heads.push(head);
    }
    this.seen = { writer: meta?.writer, generation: meta?.generation };
    const fleetRecordsRead = new Map<string, unknown>();
    fleetKeys.forEach((key, i) => fleetRecordsRead.set(String(key), fleetValues[i]));
    const index = fleetRecordsRead.get(INDEX) as FleetIndex | undefined;
    this.fleetIndex = index ?? null;
    const fleet = fleetOf(index, fleetRecordsRead);
    // a fleet saved before the server gave repos colours has no `colours`; it starts empty and the stream's colour map,
    // which comes on every connection, fills it
    return { cursor: meta?.cursor ?? null, counters: meta?.counters ?? null, fleet: fleet ? { ...fleet, colours: fleet.colours ?? {} } : null, heads };
  }

  /** a thread's messages from its pages, or null when a page the head counts is missing (the thread is read from the daemon) */
  async loadPages(head: Pick<Cold, "key" | "pages">): Promise<Message[] | null> {
    const tx = this.db.transaction("threads", "readonly");
    const store = tx.objectStore("threads");
    const pages = await Promise.all(Array.from({ length: head.pages }, (_, page) => done(store.get(pageKey(head.key, page))) as Promise<Message[] | undefined>));
    const messages: Message[] = [];
    const starts: number[] = [];
    for (const page of pages) {
      if (!page) return null;
      starts.push(messages.length);
      messages.push(...page);
    }
    starts.push(messages.length);
    // the pages as they lie, whichever layout wrote them: the next save of this thread rewrites only what changes
    this.layouts.set(head.key, starts);
    return messages;
  }

  /** writes the cursor with everything `dirty` names, from one state, in one transaction. the meta is read first, in the same
      transaction: when another writer (a second tab, or a page reloading over the last save of the one before) wrote since
      this cache last read or wrote it, what this cache remembers of the disk (page layouts, the fleet's index) may be
      stale, so the fleet and every thread named are written whole, as the disk is, and nothing is skipped on memory's word.
      the cursor is put last, and a save that throws part way aborts, so a cursor is never kept without its data */
  async save(state: SyncState, dirty: Dirty): Promise<SaveStats> {
    const tx = this.db.transaction(["meta", "fleet", "threads"], "readwrite");
    const stats: SaveStats = { puts: 0, bytes: 0 };
    const commit = committed(tx);
    const after: { kept?: () => void } = {};
    const read = tx.objectStore("meta").get("sync");
    read.onsuccess = () => {
      const meta = read.result as SyncMeta | undefined;
      const foreign = meta?.writer !== this.seen.writer || meta?.generation !== this.seen.generation;
      // after another writer, a cold thread's pages on disk are that writer's: its head on disk is read first, in this
      // transaction, so the head written still counts the pages that are there (`write`)
      const coldKeys = foreign ? [...dirty.threads.keys()].filter((key) => !state.threads[key] && state.cold[key]) : [];
      const disk = new Map<string, Partial<ThreadHead> | undefined>();
      const go = () => {
        try {
          after.kept = this.write(tx, state, dirty, meta, foreign, disk, stats);
        } catch {
          tx.abort();
        }
      };
      if (coldKeys.length === 0) return go();
      let left = coldKeys.length;
      for (const key of coldKeys) {
        const head = tx.objectStore("threads").get(headKey(key));
        head.onsuccess = () => {
          disk.set(key, head.result as Partial<ThreadHead> | undefined);
          if (--left === 0) go();
        };
      }
    };
    await commit;
    // what this save left on disk is what this cache remembers, once it committed: a write that fails leaves both as they were
    after.kept?.();
    return stats;
  }

  /** the puts of one save, in its transaction, once the meta was read; returns what to remember once it commits */
  private write(
    tx: IDBTransaction,
    state: SyncState,
    dirty: Dirty,
    meta: SyncMeta | undefined,
    foreign: boolean,
    disk: ReadonlyMap<string, Partial<ThreadHead> | undefined>,
    stats: SaveStats,
  ): () => void {
    const threads = tx.objectStore("threads");
    const put = (store: IDBObjectStore, value: unknown, key: string) => {
      store.put(value, key);
      stats.puts++;
      stats.bytes += weight(value);
    };
    const fleetIndex = this.saveFleet(tx.objectStore("fleet"), state.fleet, dirty, put, foreign);
    const layouts = new Map<string, number[] | null>();
    for (const [key, from] of dirty.threads) {
      const thread = state.threads[key];
      if (!thread) {
        const cold = state.cold[key];
        // a cold thread's pages stay as they are; only its head changed (recency, or the journal passed it)
        if (cold) {
          put(threads, foreign ? strangerHead(cold, disk.get(key)) : headRecord(cold), headKey(key));
          continue;
        }
        threads.delete(IDBKeyRange.bound(`${key}#`, `${key}#\uffff`));
        layouts.set(key, null);
        continue;
      }
      const starts = layout(thread.messages.length);
      const pages = starts.length - 1;
      const old = foreign ? undefined : this.layouts.get(key);
      // pages laid out in a way this cache does not know go first, every one, so none is left past the new last page
      if (!old) threads.delete(IDBKeyRange.bound(`${key}#`, `${key}#\uffff`));
      // a page is kept when it holds the same messages as the one on disk and none of them changed
      for (let page = 0; page < pages; page++) {
        const start = starts[page] ?? 0;
        const end = starts[page + 1] ?? start;
        if (old && old[page] === start && old[page + 1] === end && end <= from) continue;
        put(threads, thread.messages.slice(start, end), pageKey(key, page));
      }
      if (old) for (let page = pages; page < old.length - 1; page++) threads.delete(pageKey(key, page));
      put(
        threads,
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
      layouts.set(key, starts);
    }
    const generation = (meta?.generation ?? 0) + 1;
    put(tx.objectStore("meta"), { cursor: state.cursor, counters: state.counters, writer: this.writer, generation } satisfies SyncMeta, "sync");
    return () => {
      this.seen = { writer: this.writer, generation };
      if (fleetIndex) this.fleetIndex = fleetIndex;
      // another writer may have rewritten any thread: only what this save wrote is known now
      if (foreign) this.layouts.clear();
      for (const [key, starts] of layouts) {
        if (starts === null) this.layouts.delete(key);
        else this.layouts.set(key, starts);
      }
    };
  }

  /** the fleet's records `dirty` names: every one when the fleet changed whole, none is on disk yet or another writer wrote
      last, else the entries and fields that changed, and the index when a key came, went or moved. returns the index when
      it was written */
  private saveFleet(store: IDBObjectStore, fleet: Fleet, dirty: Dirty, put: (store: IDBObjectStore, value: unknown, key: string) => void, foreign: boolean): FleetIndex | null {
    if (dirty.fleet || !this.fleetIndex || foreign) {
      store.clear();
      const records = fleetRecords(fleet);
      for (const [key, value] of records) put(store, value, key);
      return records[0]?.[1] as FleetIndex; // fleetRecords puts the index first
    }
    const fields = fleet as unknown as Record<string, unknown>;
    for (const field of dirty.fields) {
      if (field in fields) put(store, fields[field], fieldKey(field));
      else store.delete(fieldKey(field));
    }
    let keysChanged = dirty.fields.size > 0;
    for (const field of ENTRIES) {
      const map: Record<string, unknown> = fleet[field];
      for (const key of dirty.entries[field]) {
        keysChanged = true;
        const value = map[key];
        if (value === undefined) store.delete(entryKey(field, key));
        else put(store, value, entryKey(field, key));
      }
    }
    if (!keysChanged) return null;
    const index = indexOf(fleet);
    if (sameIndex(index, this.fleetIndex)) return null;
    put(store, index, INDEX);
    return index;
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
    this.layouts.clear();
    this.fleetIndex = null;
    this.seen = { writer: undefined, generation: undefined };
    await committed(tx);
  }

  close(): void {
    this.db.close();
  }
}

/** the worker's writes to the cache: what the reducer changed is marked as it happens, and saved on a timer or at once
    (`save`, when the page hides or leaves). one save is in flight at most: a save asked for while one commits waits for
    it, and then writes everything marked by then, from the state as it is then, so a disk that commits slowly costs fewer
    and larger writes, never a queue of them each holding a state of its own. the cursor is written with the data it covers
    in every save, as `Cache.save` writes it */
export class Saver {
  private dirty = cleanDirty();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** the save committing now */
  private running: Promise<void> | null = null;
  /** the save that follows it, which every save asked for meanwhile shares */
  private next: Promise<void> | null = null;
  /** the meta the last save wrote, so a save with nothing marked and the same cursor and counters writes nothing */
  private written: { cursor: Cursor | null; counters: Counters } | null = null;

  constructor(
    private readonly cache: () => Cache | null,
    private readonly state: () => SyncState,
    private readonly delayMs: number,
    /** told what each save that committed wrote */
    private readonly saved: (stats: SaveStats) => void = () => {},
  ) {}

  mark(patches: readonly Patch[]): void {
    markPatches(this.dirty, patches);
  }

  /** a thread's records from message `from` on (0: all; Infinity: its head alone) */
  markThread(key: string, from: number): void {
    markThread(this.dirty, key, from);
  }

  /** a save in `delayMs`, unless one is due already */
  schedule(): void {
    if (this.timer === undefined && this.cache()) this.timer = setTimeout(() => void this.save(), this.delayMs);
  }

  /** writes everything marked; resolves once it is on disk, or the write failed and what it held is marked again */
  save(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.next) return this.next;
    if (this.running) {
      this.next = this.running.then(() => {
        this.next = null;
        return this.save();
      });
      return this.next;
    }
    const cache = this.cache();
    if (!cache) return Promise.resolve();
    const state = this.state();
    if (isClean(this.dirty) && this.written?.cursor === state.cursor && this.written.counters === state.counters) return Promise.resolve();
    const dirty = this.dirty;
    this.dirty = cleanDirty();
    const running = cache
      .save(state, dirty)
      .then(
        (stats) => {
          this.written = { cursor: state.cursor, counters: state.counters };
          // a listener that throws must not leave this save rejected, which every later save would wait on
          try {
            this.saved(stats);
          } catch {
            /* the count is lost, nothing else */
          }
        },
        () => {
          mergeDirty(this.dirty, dirty);
          this.schedule();
        },
      )
      .finally(() => {
        this.running = null;
      });
    this.running = running;
    return running;
  }

  /** settles when no save is committing or waiting to */
  async idle(): Promise<void> {
    while (this.running || this.next) await (this.next ?? this.running);
  }

  /** saves in flight carry on; the timer for the next one stops */
  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** saves committing or waiting to, at most two: the one in flight and the one that follows it */
  get pending(): number {
    return (this.running ? 1 : 0) + (this.next ? 1 : 0);
  }
}

