/* the worker's indexeddb cache (docs/architecture.md, indexeddb layout):
   database `boxbox` v6 with `meta` (the cursor and counters), `fleet` (the
   model, a record per thread, ask and agent plus one per other field and an
   index of their keys in order, `fleetRecords`), `threads` (per thread a
   head record with its `left` and `etag`, its baseline in a record of its
   own, its pages (`layout`) and the words streamed onto them since they
   were written, as chunks (`Chunk`), and its btws whole in `${key}#btw`,
   rewritten when any of them changes),
   `drafts` (the composer's words, one per target), `draftPhotos` (the same
   targets' photos, written only when the set changes), `outbox` (sends
   the daemon has not echoed yet, by client id; telemetry rows under
   `row:` and this device's replies to asks under `ask:` share it),
   `prefs`, and `media` (image bytes by media id, filled by a later build;
   v6 makes it empty).

   v6 is protocol 3's (docs/protocol.md, the app's indexeddb): the upgrade
   from any earlier version clears `fleet`, `threads` and the meta's
   `sync` record, whose contract 1 and cmx2 shapes nothing reads now, so the
   first connect gets a reset and each thread reads its newest page when it
   is next opened; drafts, their photos, the outbox and prefs are kept.

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
   so a thread rewrites the messages that changed, not its last fifty. text
   that only grew at its end (the reducer's appends) is not rewritten at
   all: the words added since the last save go into a chunk record, which a
   read folds back into its message, so a streaming answer costs each save
   what it added, not what it has grown to. the chunks are folded into their
   pages, and dropped, by the first save that writes any page of the thread
   (a part settling, a message joining), that would pass `CHUNKS`, or that
   would leave the chunks holding more words than the texts they grow held
   when their pages were written (and `FOLD_FLOOR`): each fold at least
   doubles the words the next one waits for, so a stream writes what it
   streamed a few times over however long it runs, never its whole length
   once per so many saves. the worker's `Saver` keeps one save in flight at most: what changes while it
   commits waits for the next, which writes all of it. */

import type { Cold, Counters, Fleet, Patch, SyncState, Thread } from "./reducer";
import { type Draft, joinDraft, type OutboxEntry, type Photo } from "./outbox";
import type { RawEvent } from "./telemetry";
import type { AskReply } from "./replies";
import type { Btw, Cursor, Message } from "./protocol";

const NAME = "boxbox";
/** v6 holds protocol 3's shapes (the neutral fleet, heads with `left` and `etag`) and a `media` store. a build before it
    cannot open it (its open fails on the newer version) and runs without its cache, which suits it: it could not speak
    protocol 3 anyway */
const VERSION = 6;
/** a telemetry row's key in the outbox store; a send's key is its client id, a uuid, which never starts with this */
const ROW = "row:";
/** a reply's record's key in the outbox store (replies.ts): `ask:` and its book key */
const ASK = "ask:";
const STORES = ["meta", "fleet", "threads", "drafts", "draftPhotos", "outbox", "prefs", "media"] as const;
/** the stores an upgrade from before v6 empties: what they hold is contract 1's and cmx2's */
const CLEARED_BY_V6 = ["fleet", "threads"] as const;
export const PAGE = 50;
/** the most chunk records a thread keeps before a save folds them into its pages: a read stays a thousand small records at
    worst (one key range), and a slow stream that never settles rewrites its message once per this many saves (17 minutes at
    one save a second), not once per save */
export const CHUNKS = 1024;
/** the words a thread's chunks may hold before a fold however short the texts they grow: below it a new part's first words
    would fold at every save. above it, chunks fold once they hold more words than those texts held on their pages, so the
    folds write a stream's words about twice in all, not its whole length once per `CHUNKS` saves */
export const FOLD_FLOOR = 64 * 1024;

/** the fleet's fields kept as a record per entry; every other field is a record of its own */
const ENTRIES = ["threads", "asks", "agents"] as const;
type EntryField = (typeof ENTRIES)[number];
const isEntryField = (field: unknown): field is EntryField => ENTRIES.some((name) => name === field);

/** text that grew at its end since the last save: message `at`'s part `part`, its field `field`, from character `from` on,
    where `from` is how long the text was when the last save read the state, so what the disk holds of it */
export type Append = { at: number; part: number; field: string; from: number };

/** what changed since the last save. `fleet`: the whole fleet (a reset, or a map replaced whole); `entries`: per map, the
    keys whose entry changed or went; `fields`: the fleet's other fields that changed; `threads`: per thread the first
    message index that changed (Infinity when only the head record did); `appends`: per thread, the texts that only grew,
    by message, part and field, which a message rewritten anyway (at or past its thread's index) leaves unused */
export type Dirty = {
  fleet: boolean;
  entries: Record<EntryField, Set<string>>;
  fields: Set<string>;
  threads: Map<string, number>;
  appends: Map<string, Map<string, Append>>;
  /** the threads whose btws changed: their `#btw` record is written whole (it is at most 64 records, BTW_CAP) */
  btws: Set<string>;
};

export const cleanDirty = (): Dirty => ({
  fleet: false,
  entries: { threads: new Set(), asks: new Set(), agents: new Set() },
  fields: new Set(),
  threads: new Map(),
  appends: new Map(),
  btws: new Set(),
});

const isClean = (dirty: Dirty): boolean =>
  !dirty.fleet && dirty.fields.size === 0 && dirty.threads.size === 0 && dirty.appends.size === 0 && dirty.btws.size === 0 && ENTRIES.every((field) => dirty.entries[field].size === 0);

/** a thread's records are to be written from message `from` on (0: all of them; Infinity: the head alone) */
export function markThread(dirty: Dirty, key: string, from: number): void {
  dirty.threads.set(key, Math.min(from, dirty.threads.get(key) ?? from));
}

/** a text of a thread grew at its end: its head is written (its size grew) and the words past the earliest `from` marked */
export function markAppend(dirty: Dirty, key: string, append: Append): void {
  markThread(dirty, key, Number.POSITIVE_INFINITY);
  let texts = dirty.appends.get(key);
  if (!texts) dirty.appends.set(key, (texts = new Map()));
  const id = textId(append);
  const had = texts.get(id);
  if (!had || append.from < had.from) texts.set(id, append);
}

/** what the reducer's patches changed, from their paths alone, at whatever depth they name: `["fleet", "threads", key, ...]`
    is that thread's record, `["threads", key, "messages", at, ...]` the thread's pages from message `at`, and an append to
    `["threads", key, "messages", at, "parts", i, field]` that text's growth alone */
export function markPatches(dirty: Dirty, patches: readonly Patch[]): void {
  for (const patch of patches) {
    const { path } = patch;
    const [root, field, key] = path;
    if (root === "fleet") {
      if (field === undefined) dirty.fleet = true;
      else if (!isEntryField(field)) dirty.fields.add(String(field));
      else if (typeof key === "string") dirty.entries[field].add(key);
      else dirty.fleet = true;
    } else if (root === "threads" && typeof field === "string") {
      const [, , part, at, parts, index, name] = path;
      if ("append" in patch && path.length === 7 && part === "messages" && typeof at === "number" && parts === "parts" && typeof index === "number" && typeof name === "string") {
        markAppend(dirty, field, { at, part: index, field: name, from: patch.from });
        continue;
      }
      // its btws are a record of their own, and their bytes are the head's
      if (part === "btws") dirty.btws.add(field);
      // the head's own fields (status, trouble) leave every page as it was
      const from = part === undefined ? 0 : part !== "messages" ? Number.POSITIVE_INFINITY : typeof at === "number" ? at : 0;
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
  for (const [key, texts] of from.appends) for (const append of texts.values()) markAppend(into, key, append);
  for (const key of from.btws) into.btws.add(key);
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
  keys: { threads: Object.keys(fleet.threads), asks: Object.keys(fleet.asks), agents: Object.keys(fleet.agents) },
});

const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key, i) => key === b[i]);
const sameIndex = (a: FleetIndex, b: FleetIndex) => sameKeys(a.fields, b.fields) && ENTRIES.every((field) => sameKeys(a.keys[field], b.keys[field]));

/** a fleet as the records the fleet store keeps it in: the index, one per entry of each map, one per other field */
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
    lives in memory only, so a page that is reloaded starts with every place of the held reserve free, and the baseline,
    which has a record of its own (v5): it is a number per part, as large as the thread has parts, and the head is
    written with every save of its thread, the baseline only when it changed */
type ThreadHead = Omit<Cold, "leased" | "baseline">;
type Baseline = Cold["baseline"];
/** a head as it may be read: one written before v5 carried its baseline (the upgrade moves it, `splitBaselines`) */
type SavedHead = Partial<ThreadHead> & { baseline?: Baseline };

/** the words a save added to a text that only grew at its end since its page was written: what follows its first `from`
    characters. a read folds them into the message in key order (`fold`) */
type Chunk = Append & { text: string };

/** what this cache knows of a thread's records on disk: where its pages start (`layout`), how many chunks follow them, the
    messages they grow, the words the chunks hold (`words`), and how long the texts they grow were on their pages (`under`,
    each text's first chunk's `from`), which together decide the next fold */
type OnDisk = { starts: number[]; chunks: number; chunked: Set<number>; words: number; under: number; texts: Set<string> };

const textId = (append: Append) => `${append.at}/${append.part}/${append.field}`;

export type Booted = { cursor: Cursor | null; counters: Counters | null; fleet: Fleet | null; heads: Cold[] };

const HEAD = "#head";
const headKey = (key: string) => `${key}${HEAD}`;
const baseKey = (key: string) => `${key}#base`;
/** a thread's btws, oldest first (reducer.ts, `Thread.btws`) */
const btwKey = (key: string) => `${key}#btw`;
const pageKey = (key: string, page: number) => `${key}#${page}`;
/** a chunk's key sorts by its number, so a read of the range gets them in the order they were written */
const chunkKey = (key: string, seq: number) => `${key}#+${String(seq).padStart(6, "0")}`;
const chunkRange = (key: string) => IDBKeyRange.bound(`${key}#+`, `${key}#+\uffff`);
/** every record of a thread: head, baseline, pages and chunks */
const threadRange = (key: string) => IDBKeyRange.bound(`${key}#`, `${key}#\uffff`);

/** the text an append names in a thread's messages, as it is now */
const textAt = (messages: readonly Message[], append: Append): unknown => (messages[append.at]?.parts[append.part] as Record<string, unknown> | undefined)?.[append.field];

/** the chunks, in order, onto the messages their pages hold; false when one does not fit (its text is not there, or not as
    long as it starts from), which no save writes, and the thread is then read from the daemon */
function fold(messages: Message[], chunks: readonly Chunk[]): boolean {
  for (const chunk of chunks) {
    const part = messages[chunk.at]?.parts[chunk.part] as Record<string, unknown> | undefined;
    if (!part) return false;
    const text = part[chunk.field];
    // a text that was not there yet is created, at the end of its part's keys or where an undefined one stood, as the
    // reducer's spread created it
    if (text === undefined && chunk.from === 0) part[chunk.field] = chunk.text;
    else if (typeof text === "string" && text.length === chunk.from) part[chunk.field] = text + chunk.text;
    else return false;
  }
  return true;
}

/** what the records read hold: their pages' starts, and the chunks after them as the next fold weighs them */
function onDiskOf(starts: number[], chunks: readonly Chunk[]): OnDisk {
  const disk: OnDisk = { starts, chunks: chunks.length, chunked: new Set(), words: 0, under: 0, texts: new Set() };
  for (const chunk of chunks) addChunk(disk, chunk, chunk.text.length);
  return disk;
}

/** a chunk of `words` written onto `disk`'s count; the first one of a text says how long that text was on its page */
function addChunk(disk: OnDisk, append: Append, words: number): void {
  disk.chunks++;
  disk.chunked.add(append.at);
  disk.words += words;
  const id = textId(append);
  if (disk.texts.has(id)) return;
  disk.texts.add(id);
  disk.under += append.from;
}

/** the page of `starts` that holds message `at` */
function pageOf(starts: readonly number[], at: number): number {
  let page = 0;
  while (page + 2 < starts.length && (starts[page + 1] ?? 0) <= at) page++;
  return page;
}

/** two baselines alike down to the order of their keys */
function sameBaseline(a: Baseline | undefined, b: Baseline): boolean {
  if (a === b) return true;
  if (!a) return false;
  const keys = Object.keys(a);
  const others = Object.keys(b);
  return sameKeys(keys, others) && keys.every((key) => a[key] === b[key]);
}

/** a cold head as the record it was read from: one that never had a size is written without one, so it still reads as unsized */
function headRecord(head: Cold): Partial<ThreadHead> {
  const { leased: _lease, baseline: _own, ...record } = head;
  if (record.sized) return record;
  const { bytes: _unknown, ...rest } = record;
  return rest;
}

/** a cold thread's head after another writer saved: the pages are that writer's, so the head keeps what the disk's head says
    of them (their count and size) and this page's recency, and is marked stale, so the thread is read again from the daemon
    when it is opened, as one the journal passed while it was cold. with no head on disk the pages are gone, and its
    restore finds a page missing and reads it afresh */
function strangerHead(cold: Cold, disk: SavedHead | undefined): Partial<ThreadHead> {
  const mine = headRecord(cold);
  if (!disk) return { ...mine, stale: true };
  return { ...disk, openedAt: cold.openedAt, heldAt: cold.heldAt, stale: true };
}

/** a head as it was saved, with its baseline and what heads written before this build lack filled in; null for a record
    that is no head */
function decodeHead(record: SavedHead | undefined, base: Baseline | undefined): Cold | null {
  if (!record || typeof record.key !== "string") return null;
  const pages = record.pages ?? 0;
  return {
    key: record.key,
    status: record.status ?? "hydrating",
    hydration: record.hydration ?? 1,
    upstreamEpoch: record.upstreamEpoch ?? null,
    hydratedAt: record.hydratedAt ?? 0,
    lastUpstream: record.lastUpstream ?? 0,
    baseline: base ?? record.baseline ?? {},
    refetching: record.refetching ?? [],
    openedAt: record.openedAt ?? 0,
    heldAt: record.heldAt ?? 0,
    leased: false,
    // a head written before heads carried a size has none: it counts for nothing until its pages are read and measured
    bytes: record.bytes ?? 0,
    sized: record.bytes !== undefined,
    pages,
    stale: record.stale ?? false,
    ...(typeof record.left === "number" ? { left: record.left } : {}),
    ...(typeof record.etag === "string" ? { etag: record.etag } : {}),
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

/** v6's upgrade, in the upgrade's own transaction: the fleet and the threads go, and the cursor with them (the meta's `sync`
    record), so nothing is resumed from a cursor whose data is gone */
function clearForV6(upgrade: IDBTransaction): void {
  for (const store of CLEARED_BY_V6) upgrade.objectStore(store).clear();
  upgrade.objectStore("meta").delete("sync");
}

/** what opening the database reports to its owner */
export type OpenEvents = { blocked(): void; unblocked(): void; superseded(): void };

export class Cache {
  /** what this cache knows of each thread's pages and chunks on disk (`OnDisk`), for the threads whose records it wrote or
      read, so a save rewrites only the pages that changed and chunks what only grew; a thread missing here is written
      whole. an entry goes with its thread's records, and all of them when another writer saved */
  private readonly known = new Map<string, OnDisk>();
  /** each thread's baseline as its record on disk holds it, for the threads whose baseline this cache wrote or read; a
      baseline missing here or unlike this is written */
  private readonly bases = new Map<string, Baseline>();
  /** the threads whose records on disk are this cache's own: read at boot, or written by it since another writer was last
      seen. another writer's save clears it, and a thread joins again only when this cache writes it whole: until then its
      cold head is written from the head on disk (`strangerHead`, read in the save's transaction) and its pages are not
      read (`loadPages`), since the count this cache holds may not be theirs. an entry goes with its thread's records */
  private readonly mine = new Set<string>();
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
        const upgrade = request.transaction;
        if (event.oldVersion > 0 && event.oldVersion < 6 && upgrade) clearForV6(upgrade);
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
    const ids = keys.map(String);
    const present = new Set(ids);
    const records = await Promise.all(
      ids
        .filter((id) => id.endsWith(HEAD))
        .map(async (id) => {
          const base = baseKey(id.slice(0, -HEAD.length));
          const [head, baseline] = await Promise.all([
            done(threads.get(id)) as Promise<SavedHead | undefined>,
            present.has(base) ? (done(threads.get(base)) as Promise<Baseline | undefined>) : undefined,
          ]);
          return { head, baseline };
        }),
    );
    const heads: Cold[] = [];
    // the heads are read in the transaction that reads the meta, so every one is the disk's as of the writer it names
    this.mine.clear();
    for (const { head: record, baseline } of records) {
      const head = decodeHead(record, baseline);
      if (!head) continue;
      heads.push(head);
      this.mine.add(head.key);
      // the baseline the head was given is the one on disk, so a save of the same one writes nothing for it
      if (baseline) this.bases.set(head.key, head.baseline);
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

  /** a thread's messages from its pages, with the chunks streamed onto them folded in, or null when a page the head counts
      is missing, a chunk does not fit, or the records may be another writer's (the thread is read from the daemon): one
      this cache does not own since another writer was seen, or any while the meta, read in the same transaction, names a
      save this cache has not seen, as when a page reloads over the last save of the one before */
  async loadPages(head: Pick<Cold, "key" | "pages">): Promise<Message[] | null> {
    return (await this.loadThread(head, false))?.messages ?? null;
  }

  /** `loadPages`, with the thread's btws read in the same transaction (none when it has no record; `withBtws` false reads
      the pages alone) */
  async loadThread(head: Pick<Cold, "key" | "pages">, withBtws = true): Promise<{ messages: Message[]; btws: Btw[] } | null> {
    if (!this.mine.has(head.key)) return null;
    const tx = this.db.transaction(["meta", "threads"], "readonly");
    const store = tx.objectStore("threads");
    const [meta, pages, chunks, btws] = await Promise.all([
      done(tx.objectStore("meta").get("sync")) as Promise<SyncMeta | undefined>,
      Promise.all(Array.from({ length: head.pages }, (_, page) => done(store.get(pageKey(head.key, page))) as Promise<Message[] | undefined>)),
      done(store.getAll(chunkRange(head.key))) as Promise<Chunk[]>,
      withBtws ? (done(store.get(btwKey(head.key))) as Promise<Btw[] | undefined>) : undefined,
    ]);
    if (meta?.writer !== this.seen.writer || meta?.generation !== this.seen.generation || !this.mine.has(head.key)) return null;
    const messages: Message[] = [];
    const starts: number[] = [];
    for (const page of pages) {
      if (!page) return null;
      starts.push(messages.length);
      messages.push(...page);
    }
    starts.push(messages.length);
    if (!fold(messages, chunks)) return null;
    // the pages and chunks as they lie, whichever layout wrote them: the next save of this thread rewrites only what changes
    this.known.set(head.key, onDiskOf(starts, chunks));
    return { messages, btws: Array.isArray(btws) ? btws : [] };
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
      // after another writer, now or since, a cold thread's pages on disk may be that writer's: its head on disk is read
      // first, in this transaction, so the head written still counts the pages that are there (`write`)
      const coldKeys = [...dirty.threads.keys()].filter((key) => !state.threads[key] && state.cold[key] && (foreign || !this.mine.has(key)));
      const disk = new Map<string, SavedHead | undefined>();
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
          disk.set(key, head.result as SavedHead | undefined);
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
    disk: ReadonlyMap<string, SavedHead | undefined>,
    stats: SaveStats,
  ): () => void {
    const threads = tx.objectStore("threads");
    const put = (store: IDBObjectStore, value: unknown, key: string) => {
      store.put(value, key);
      stats.puts++;
      stats.bytes += weight(value);
    };
    const fleetIndex = this.saveFleet(tx.objectStore("fleet"), state.fleet, dirty, put, foreign);
    /** per thread what is on disk once this commits (null: nothing), and the baseline its record holds then */
    const known = new Map<string, OnDisk | null>();
    const bases = new Map<string, Baseline>();
    /** per thread whether its records on disk are this cache's own once this commits (`mine`) */
    const owned = new Map<string, boolean>();
    for (const [key, from] of dirty.threads) {
      const thread = state.threads[key];
      if (!thread) {
        const cold = state.cold[key];
        // a cold thread's pages stay as they are; only its head changed (recency, or the journal passed it). after another
        // writer, the baseline on disk stays with the head on disk, as the pages do
        if (cold) {
          const strange = foreign || !this.mine.has(key);
          const theirs = strange ? disk.get(key) : undefined;
          put(threads, strange ? strangerHead(cold, theirs) : headRecord(cold), headKey(key));
          owned.set(key, !strange);
          if (!theirs && !sameBaseline(strange ? undefined : this.bases.get(key), cold.baseline)) {
            put(threads, cold.baseline, baseKey(key));
            bases.set(key, cold.baseline);
          }
          continue;
        }
        threads.delete(threadRange(key));
        known.set(key, null);
        owned.set(key, false);
        continue;
      }
      owned.set(key, true);
      const old = foreign ? undefined : this.known.get(key);
      known.set(key, this.saveThread(threads, put, thread, from, dirty.appends.get(key), old));
      // a thread written whole lost its btws record with the rest (`saveThread` clears the range first)
      if (dirty.btws.has(key) || !old) {
        const btws = thread.btws ? Object.values(thread.btws).sort((a, b) => a.created - b.created) : [];
        if (btws.length > 0) put(threads, btws, btwKey(key));
        else if (old) threads.delete(btwKey(key));
      }
      // a thread written whole lost its baseline record with the rest
      if (foreign || !this.known.get(key) || !sameBaseline(this.bases.get(key), thread.baseline)) put(threads, thread.baseline, baseKey(key));
      bases.set(key, thread.baseline);
    }
    const generation = (meta?.generation ?? 0) + 1;
    put(tx.objectStore("meta"), { cursor: state.cursor, counters: state.counters, writer: this.writer, generation } satisfies SyncMeta, "sync");
    return () => {
      this.seen = { writer: this.writer, generation };
      if (fleetIndex) this.fleetIndex = fleetIndex;
      // another writer may have rewritten any thread: only what this save wrote is known now
      if (foreign) {
        this.known.clear();
        this.bases.clear();
        this.mine.clear();
      }
      for (const [key, own] of owned) {
        if (own) this.mine.add(key);
        else this.mine.delete(key);
      }
      for (const [key, onDisk] of known) {
        if (onDisk) this.known.set(key, onDisk);
        else {
          this.known.delete(key);
          this.bases.delete(key);
        }
      }
      for (const [key, baseline] of bases) this.bases.set(key, baseline);
    };
  }

  /** a held thread's records: its pages from message `from` on, and only the words added to texts that only grew when no
      page is written, as chunks; when a page is written the chunks are folded into theirs and go. `old` is what is on disk,
      as far as this cache knows (undefined: nothing is known, and the thread is written whole). returns what is on disk
      once this commits */
  private saveThread(
    threads: IDBObjectStore,
    put: (store: IDBObjectStore, value: unknown, key: string) => void,
    thread: Thread,
    from: number,
    appends: ReadonlyMap<string, Append> | undefined,
    old: OnDisk | undefined,
  ): OnDisk {
    const { key, messages } = thread;
    const starts = layout(messages.length);
    const pages = starts.length - 1;
    // records laid out in a way this cache does not know go first, every one, so none is left past the new last page
    if (!old) threads.delete(threadRange(key));
    // a page is kept when it holds the same messages as the one on disk and none of them changed
    const writes = new Set<number>();
    for (let page = 0; page < pages; page++) {
      const start = starts[page] ?? 0;
      const end = starts[page + 1] ?? start;
      if (!(old && old.starts[page] === start && old.starts[page + 1] === end && end <= from)) writes.add(page);
    }
    // an append to a message at or past `from` is in a page written anyway; before it, no message moved since the last
    // save, so its place still names it
    const below = Math.min(from, messages.length);
    const grown = [...(appends?.values() ?? [])].filter((append) => append.at < below);
    const fits = grown.every((append) => {
      const text = textAt(messages, append);
      return typeof text === "string" && text.length >= append.from;
    });
    const adds = fits ? grown.map((append) => ({ append, words: (textAt(messages, append) as string).length - append.from })).filter((add) => add.words > 0) : [];
    // the chunks on disk once this save adds its own, weighed as the fold rule weighs them (`FOLD_FLOOR`)
    const after: OnDisk = { starts, chunks: old?.chunks ?? 0, chunked: new Set(old?.chunked), words: old?.words ?? 0, under: old?.under ?? 0, texts: new Set(old?.texts) };
    for (const { append, words } of adds) addChunk(after, append, words);
    if (old && writes.size === 0 && fits && after.chunks <= CHUNKS && after.words <= Math.max(after.under, FOLD_FLOOR)) {
      let seq = old.chunks;
      for (const { append } of adds) {
        const text = textAt(messages, append) as string; // `fits` found a string at least `from` long
        put(threads, { ...append, text: text.slice(append.from) } satisfies Chunk, chunkKey(key, seq++));
      }
      return this.putHead(threads, put, thread, starts, after);
    }
    if (old) {
      // the messages chunks grow are rewritten whole, so the chunks go
      for (const at of [...old.chunked, ...grown.map((append) => append.at)]) if (at < below) writes.add(pageOf(starts, at));
      if (old.chunks > 0) threads.delete(chunkRange(key));
    }
    for (const page of [...writes].sort((a, b) => a - b)) {
      const start = starts[page] ?? 0;
      put(threads, messages.slice(start, starts[page + 1] ?? start), pageKey(key, page));
    }
    if (old) for (let page = pages; page < old.starts.length - 1; page++) threads.delete(pageKey(key, page));
    return this.putHead(threads, put, thread, starts, { starts, chunks: 0, chunked: new Set(), words: 0, under: 0, texts: new Set() });
  }

  /** a held thread's head record, written with every save of it; returns `disk`, what is on disk once this commits */
  private putHead(threads: IDBObjectStore, put: (store: IDBObjectStore, value: unknown, key: string) => void, thread: Thread, starts: number[], disk: OnDisk): OnDisk {
    const { key } = thread;
    const pages = starts.length - 1;
    put(
      threads,
      {
        key,
        status: thread.status,
        hydration: thread.hydration,
        upstreamEpoch: thread.upstreamEpoch,
        hydratedAt: thread.hydratedAt,
        lastUpstream: thread.lastUpstream,
        refetching: Object.keys(thread.refetching),
        openedAt: thread.openedAt,
        heldAt: thread.heldAt,
        bytes: thread.bytes,
        sized: true,
        pages,
        stale: false,
        ...(thread.left === undefined ? {} : { left: thread.left }),
        ...(thread.etag === undefined ? {} : { etag: thread.etag }),
      } satisfies ThreadHead,
      headKey(key),
    );
    return disk;
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
      replies to asks as they were written (replies.ts reads them). a draft's photos are read only for `open`, the thread
      the launch shows: every other draft says how many it keeps (`Draft.held`) and its photos are read when its composer
      opens (`loadDraftPhotos`) */
  async loadComposer(open: string | null = null): Promise<{ drafts: Record<string, Draft>; outbox: OutboxEntry[]; rows: RawEvent[]; replies: unknown[] }> {
    const tx = this.db.transaction(["drafts", "draftPhotos", "outbox"], "readonly");
    const photoStore = tx.objectStore("draftPhotos");
    const [keys, values, photoKeys, outboxKeys, outboxValues] = await Promise.all([
      done(tx.objectStore("drafts").getAllKeys()) as Promise<IDBValidKey[]>,
      done(tx.objectStore("drafts").getAll()) as Promise<Draft[]>,
      done(photoStore.getAllKeys()) as Promise<IDBValidKey[]>,
      done(tx.objectStore("outbox").getAllKeys()) as Promise<IDBValidKey[]>,
      done(tx.objectStore("outbox").getAll()) as Promise<unknown[]>,
    ]);
    const withPhotos = new Set(photoKeys.map(String));
    // the photos read now: the open thread's, and a draft's whose words were written before they counted them, which is read
    // as it always was until its next edit writes the count
    const reads = keys.map(String).filter((key, i) => withPhotos.has(key) && (key === open || values[i]?.held === undefined));
    const photoSets = new Map<string, Photo[]>();
    await Promise.all(reads.map(async (key) => photoSets.set(key, ((await done(photoStore.get(key))) as Photo[] | undefined) ?? [])));
    const drafts: Record<string, Draft> = {};
    // a draft written before the photos had a record of their own still holds them in its words: it reads as it was, and the
    // sender writes its photos into their own record with its first edit (`Sender.restore`)
    keys.forEach((key, i) => {
      const words = values[i];
      if (!words) return;
      const name = String(key);
      const draft = joinDraft(words, photoSets.get(name));
      // a count whose photos are gone counts nothing
      if (draft.held && !withPhotos.has(name)) {
        const { held: _gone, ...rest } = draft;
        drafts[name] = rest;
      } else drafts[name] = draft;
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

  /** a thread's pages on disk as this cache knows them, for a thread whose records are its own: how many pages, and how many
      messages they hold. null when this cache does not know (another writer, or never written or read here) */
  pagesOf(key: string): { pages: number; count: number } | null {
    const disk = this.mine.has(key) ? this.known.get(key) : undefined;
    return disk ? { pages: disk.starts.length - 1, count: disk.starts[disk.starts.length - 1] ?? 0 } : null;
  }

  /** a draft's photos, read when its composer opens; none when it keeps none */
  async loadDraftPhotos(key: string): Promise<Photo[]> {
    const tx = this.db.transaction("draftPhotos", "readonly");
    return ((await done(tx.objectStore("draftPhotos").get(key))) as Photo[] | undefined) ?? [];
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
    this.known.clear();
    this.bases.clear();
    this.mine.clear();
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
  /** the last save took words streamed onto a text: a part is streaming, so the next save waits `streamingMs` */
  private streaming = false;
  /** what the save committing now writes */
  private inFlight: Dirty | null = null;

  constructor(
    private readonly cache: () => Cache | null,
    private readonly state: () => SyncState,
    private readonly delayMs: number,
    /** told what each save that committed wrote */
    private readonly saved: (stats: SaveStats) => void = () => {},
    /** the wait while a part streams: its words, the session ticks that come with them and the cursor are written this often.
        a reload replays what came since from the cursor saved with them, so a longer wait costs a longer replay, never a
        word twice or lost */
    private readonly streamingMs = delayMs,
  ) {}

  mark(patches: readonly Patch[]): void {
    markPatches(this.dirty, patches);
  }

  /** a thread's records from message `from` on (0: all; Infinity: its head alone) */
  markThread(key: string, from: number): void {
    markThread(this.dirty, key, from);
  }

  /** nothing of a thread is marked to be written or being written: the disk holds it as the state does */
  clean(key: string): boolean {
    const writing = this.inFlight;
    return !this.dirty.threads.has(key) && !this.dirty.appends.has(key) && !(writing && (writing.threads.has(key) || writing.appends.has(key)));
  }

  /** a save in `delayMs`, or `streamingMs` while a part streams, unless one is due already */
  schedule(): void {
    if (this.timer !== undefined || !this.cache()) return;
    this.timer = setTimeout(() => void this.save(), this.streaming || this.dirty.appends.size > 0 ? this.streamingMs : this.delayMs);
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
    this.streaming = dirty.appends.size > 0;
    this.inFlight = dirty;
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
          // what was marked meanwhile joins what failed, after it: appends that create a field are written, and so folded on
          // a read, in the order they were marked, which is the order of the part's keys in memory
          mergeDirty(dirty, this.dirty);
          this.dirty = dirty;
          this.schedule();
        },
      )
      .finally(() => {
        this.running = null;
        this.inFlight = null;
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

