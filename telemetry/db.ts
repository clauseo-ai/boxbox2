/* the query side: the jsonl log, rebuilt into sqlite on demand.

   BUN ONLY. this file imports bun:sqlite, so app code must NEVER import
   it: next would try to bundle a bun builtin and the route dies. the
   only caller is scripts/telemetry.ts, which runs under bun.

   the shape of the database is DERIVED, never hand written:
     - `events`, one real column per ENVELOPE entry, id as the primary
       key so replaying a day file is idempotent.
     - one view per kind in EVENTS, named `e_` + the kind with dots
       swapped for underscores, every declared prop flattened into a
       typed column with the dictionary's exact camelCase name, plus
       day / hour / weekday off the stamp.
     - the curated VIEWS from views.ts on top, in array order.
   add an event to schema.ts and the next build has its view. that is
   the whole point: an agent reads the dictionary and knows the columns,
   with no documentation in between.

   the log is the truth, this database is disposable. it is rebuilt from
   the ndjson every run, which is why durability pragmas are off and why
   ingest re-checks every row against the dictionary: a kind or a prop
   that schema.ts no longer declares does not get to live on in the db
   just because an old day file remembers it. */

import { Database } from "bun:sqlite";
import { dayFiles, readDay } from "./files";
import {
  type ColumnType,
  ENVELOPE,
  EVENTS,
  type EventKind,
  type PropSpec,
} from "./schema";
import { VIEWS } from "./views";

export const KINDS = Object.keys(EVENTS) as EventKind[];

const ENVELOPE_COLUMNS = Object.keys(ENVELOPE) as (keyof typeof ENVELOPE)[];

/** the three columns every generated view computes off `at`. local time
    on purpose: the question is always "which of MY days was that". */
const COMPUTED = [
  {
    name: "day",
    type: "TEXT" as ColumnType,
    sql: "date(at / 1000, 'unixepoch', 'localtime')",
    doc: "local YYYY-MM-DD of at. group by this, never by the raw stamp.",
  },
  {
    name: "hour",
    type: "INTEGER" as ColumnType,
    sql: "CAST(strftime('%H', at / 1000, 'unixepoch', 'localtime') AS INTEGER)",
    doc: "local hour, 0 to 23. the daily rhythm lives here.",
  },
  {
    name: "weekday",
    type: "INTEGER" as ColumnType,
    sql: "CAST(strftime('%w', at / 1000, 'unixepoch', 'localtime') AS INTEGER)",
    doc: "local weekday, 0 = sunday.",
  },
];

/** names the generated views already own. a prop that collides with one
    of these would create a second column of the same name (sqlite calls
    it `kind:1` and a bare reference silently picks the envelope one), so
    it gets a prefix instead and the schema report says so. */
const TAKEN = new Set<string>([
  ...ENVELOPE_COLUMNS,
  ...COMPUTED.map((c) => c.name),
]);

/** prop names become sql identifiers and json paths, so they have to be
    plain. the dictionary is checked at build time rather than trusted. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** how far outside its own day file a stamp may sit before ingest calls
    it absurd (ENVELOPE.at promises this). one day of slack absorbs a
    machine changing timezone or a batch flushed across midnight; a
    client whose clock is a year out gets pinned to the file's edge
    instead of tearing v_stints into nonsense visits. */
const CLAMP_SLACK_MS = 24 * 60 * 60_000;

export function eventView(kind: string): string {
  return `e_${kind.replace(/\./g, "_")}`;
}

/** the column a prop is exposed as: its own name, unless the envelope
    already owns that name. */
export function propColumn(name: string): string {
  return TAKEN.has(name) ? `prop_${name}` : name;
}

function propsOf(kind: EventKind): [string, PropSpec][] {
  return Object.entries(EVENTS[kind].props as Record<string, PropSpec>);
}

/* ——— the table ——— */

function createTable(db: Database) {
  const columns = ENVELOPE_COLUMNS.map((name) => {
    const type = ENVELOPE[name].type;
    return name === "id" ? `${name} ${type} PRIMARY KEY NOT NULL` : `${name} ${type}`;
  });
  db.exec(`CREATE TABLE IF NOT EXISTS events (\n  ${columns.join(",\n  ")}\n)`);

  const present = (
    db.query(`PRAGMA table_info(events)`).all() as { name: string }[]
  ).map((c) => c.name);
  const expected = ENVELOPE_COLUMNS.join(",");
  if (present.join(",") !== expected) {
    throw new Error(
      `events table has columns [${present.join(", ")}] but the dictionary declares [${expected.split(",").join(", ")}]. ` +
        `this db file was built from a different schema.ts, delete it and ingest again.`,
    );
  }

  /* the five slices every question starts from: when, what, whose,
     which conversation, and what-when together for per-kind timelines. */
  db.exec(`CREATE INDEX IF NOT EXISTS events_at ON events(at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS events_kind ON events(kind)`);
  db.exec(`CREATE INDEX IF NOT EXISTS events_device ON events(device)`);
  db.exec(`CREATE INDEX IF NOT EXISTS events_session ON events(session)`);
  db.exec(`CREATE INDEX IF NOT EXISTS events_kind_at ON events(kind, at)`);
}

/* ——— ingest ——— */

export type IngestStats = {
  files: number;
  lines: number;
  inserted: number;
  /** rows the dictionary does not declare, or that carry no usable id */
  dropped: number;
  /** stamps pinned back into their day file's window */
  clamped: number;
};

/** local midnight either side of a YYYY-MM-DD day file name. */
function dayWindow(day: string): { start: number; end: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  return { start: new Date(y, mo, d).getTime(), end: new Date(y, mo, d + 1).getTime() };
}

function asText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : String(value);
}

function asNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** one jsonl line to one row, or null when the dictionary disowns it.
    the write path already gates on schema.ts; doing it again here is
    what keeps a retired kind from resurrecting itself out of an old day
    file, and it is why the tests can feed raw ndjson. */
function toRow(
  raw: Record<string, unknown>,
  window: { start: number; end: number } | null,
  stats: IngestStats,
): (string | number | null)[] | null {
  const kind = raw.kind;
  if (typeof kind !== "string" || !(kind in EVENTS)) {
    stats.dropped++;
    return null;
  }
  const id = typeof raw.id === "string" && raw.id.length > 0 ? raw.id : null;
  const stamped = asNumber(raw.at);
  if (id === null || stamped === null) {
    stats.dropped++;
    return null;
  }

  let at = Math.round(stamped);
  if (window) {
    const floor = window.start - CLAMP_SLACK_MS;
    const ceil = window.end + CLAMP_SLACK_MS;
    if (at < floor) {
      at = floor;
      stats.clamped++;
    } else if (at > ceil) {
      at = ceil;
      stats.clamped++;
    }
  }

  const declared = EVENTS[kind as EventKind].props as Record<string, PropSpec>;
  const rawProps = (raw.props ?? {}) as Record<string, unknown>;
  const props: Record<string, string | number> = {};
  for (const [name, spec] of Object.entries(declared)) {
    const value = rawProps[name];
    if (value === undefined || value === null) continue;
    const coerced = spec.type === "TEXT" ? asText(value) : asNumber(value);
    if (coerced === null) continue;
    props[name] = spec.type === "INTEGER" ? Math.round(coerced as number) : coerced;
  }

  return ENVELOPE_COLUMNS.map((column) => {
    if (column === "id") return id;
    if (column === "at") return at;
    if (column === "kind") return kind;
    if (column === "props") {
      return Object.keys(props).length > 0 ? JSON.stringify(props) : null;
    }
    if (column === "ok") {
      const ok = asNumber(raw.ok);
      return ok === null ? null : ok === 0 ? 0 : 1;
    }
    return ENVELOPE[column].type === "TEXT" ? asText(raw[column]) : asNumber(raw[column]);
  });
}

/** every day file at or after `since`, appended into `events`. INSERT OR
    IGNORE plus the id primary key makes a replay a no-op, so re-running
    the ingest over a day that is still being written costs nothing. one
    transaction per file keeps a year of events in the seconds range. */
export function ingest(db: Database, since?: string): IngestStats {
  const stats: IngestStats = { files: 0, lines: 0, inserted: 0, dropped: 0, clamped: 0 };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events (${ENVELOPE_COLUMNS.join(", ")}) VALUES (${ENVELOPE_COLUMNS.map(() => "?").join(", ")})`,
  );
  const writeAll = db.transaction((rows: (string | number | null)[][]) => {
    let n = 0;
    for (const row of rows) n += insert.run(...row).changes;
    return n;
  });

  for (const file of dayFiles(since)) {
    const window = dayWindow(file.day);
    const rows: (string | number | null)[][] = [];
    for (const raw of readDay(file.path)) {
      stats.lines++;
      const row = toRow(raw as unknown as Record<string, unknown>, window, stats);
      if (row) rows.push(row);
    }
    stats.files++;
    stats.inserted += writeAll(rows) as number;
  }
  if (stats.dropped > 0 || stats.clamped > 0) {
    console.warn(
      `[telemetry ingest] ${stats.dropped} line(s) the dictionary does not declare, ${stats.clamped} stamp(s) clamped into their day`,
    );
  }
  return stats;
}

/* ——— the views ——— */

function eventViewSql(kind: EventKind): string {
  const parts = ENVELOPE_COLUMNS.map((c) => `  ${c}`);
  for (const [name, spec] of propsOf(kind)) {
    if (!IDENT.test(name)) {
      throw new Error(
        `prop "${name}" on ${kind} is not a plain identifier; props become sql columns and json paths, rename it in schema.ts`,
      );
    }
    /* every prop identifier is quoted: harmless for `name`, required for
       `to` and `from`, and it means views.ts can quote or not as it
       likes (a quoted definition does not change the column's name). */
    parts.push(
      `  CAST(json_extract(props, '$.${name}') AS ${spec.type}) AS "${propColumn(name)}"`,
    );
  }
  for (const c of COMPUTED) parts.push(`  ${c.sql} AS ${c.name}`);
  /* kind comes from the dictionary's own keys, never from data */
  return `SELECT\n${parts.join(",\n")}\nFROM events\nWHERE kind = '${kind}'`;
}

/** sqlite does not resolve a view's body until something selects from
    it, so a curated view can create cleanly and then blow up on first
    use. this is that check: null when the view answers, the sqlite
    message when it cannot. a broken view is kept, never dropped, so the
    schema report can name it and the fix is obvious. */
export function viewError(db: Database, name: string): string | null {
  try {
    db.query(`SELECT * FROM ${name} LIMIT 0`).all();
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

/** broken views already complained about. a run that builds the db
    twenty times should say it once. */
const warnedViews = new Set<string>();

function createViews(db: Database) {
  for (const kind of KINDS) {
    const name = eventView(kind);
    db.exec(`DROP VIEW IF EXISTS ${name}`);
    db.exec(`CREATE VIEW ${name} AS\n${eventViewSql(kind)}`);
  }
  /* order matters: the curated views select from each other */
  for (const view of VIEWS) {
    db.exec(`DROP VIEW IF EXISTS ${view.name}`);
    db.exec(`CREATE VIEW ${view.name} AS ${view.sql}`);
  }
  for (const view of VIEWS) {
    const error = viewError(db, view.name);
    if (!error || warnedViews.has(`${view.name}:${error}`)) continue;
    warnedViews.add(`${view.name}:${error}`);
    console.warn(`[telemetry db] view ${view.name} does not resolve: ${error}`);
  }
}

/* ——— the build ——— */

export type BuildOptions = {
  /** inclusive YYYY-MM-DD floor on day files */
  since?: string;
  /** where to materialize; omit for an in-memory db */
  file?: string;
};

export function buildDb(opts: BuildOptions = {}): Database {
  const db = new Database(opts.file ?? ":memory:", { create: true });
  /* the log is the truth and this file is a rebuildable view of it, so
     fsyncs buy nothing: a torn db is deleted and rebuilt in seconds. */
  db.exec("PRAGMA journal_mode = MEMORY");
  db.exec("PRAGMA synchronous = OFF");
  createTable(db);
  ingest(db, opts.since);
  createViews(db);
  return db;
}

/* ——— the schema, as data ——— */

export type ColumnReport = {
  name: string;
  type: string;
  doc: string;
  /** where the column came from. `derived` = a curated view's own sql. */
  source: "envelope" | "prop" | "computed" | "derived";
  values?: readonly string[];
  required?: true;
  /** set when a prop had to be renamed to avoid shadowing the envelope */
  renamedFrom?: string;
};

export type RelationReport = {
  name: string;
  sort: "table" | "event" | "curated";
  kind?: EventKind;
  doc: string;
  /** rows present for this kind, null when counting would mean running
      the curated view */
  rows: number | null;
  columns: ColumnReport[];
  /** the sqlite error when this view does not resolve. present means the
      view cannot be queried at all: the sql in views.ts references a
      column the dictionary does not declare. */
  broken?: string;
};

export type SchemaReport = {
  rows: number;
  first: number | null;
  last: number | null;
  days: number;
  relations: RelationReport[];
};

/** every name in the dictionary that could document a curated view's
    column, but only where the name means ONE thing: `need` is documented
    differently on need.raised and push.sent, so it stays undocumented
    rather than documented wrongly. the view's own doc covers the rest. */
function unambiguousDocs(): Map<string, ColumnReport> {
  const seen = new Map<string, ColumnReport | null>();
  const offer = (column: ColumnReport) => {
    const prior = seen.get(column.name);
    if (prior === undefined) seen.set(column.name, column);
    else if (prior === null || prior.doc !== column.doc) seen.set(column.name, null);
  };
  for (const name of ENVELOPE_COLUMNS) {
    offer({ name, type: ENVELOPE[name].type, doc: ENVELOPE[name].doc, source: "envelope" });
  }
  for (const c of COMPUTED) {
    offer({ name: c.name, type: c.type, doc: c.doc, source: "computed" });
  }
  for (const kind of KINDS) {
    for (const [name, spec] of propsOf(kind)) {
      offer({
        name: propColumn(name),
        type: spec.type,
        doc: spec.doc,
        source: "prop",
        ...(spec.values ? { values: spec.values } : {}),
      });
    }
  }
  const out = new Map<string, ColumnReport>();
  for (const [name, column] of seen) if (column) out.set(name, { ...column, source: "derived" });
  return out;
}

function envelopeColumns(): ColumnReport[] {
  return ENVELOPE_COLUMNS.map((name) => ({
    name,
    type: ENVELOPE[name].type,
    doc: ENVELOPE[name].doc,
    source: "envelope" as const,
  }));
}

/** the built database described as plain data: every relation, every
    column, every doc, all of it read back off the dictionary and the db
    itself. this is what `bun scripts/telemetry.ts schema --json` prints,
    and it is the only thing an agent should need before writing sql. */
export function schemaReport(db: Database): SchemaReport {
  const span = db
    .query(`SELECT COUNT(*) AS rows, MIN(at) AS first, MAX(at) AS last FROM events`)
    .get() as { rows: number; first: number | null; last: number | null };
  const days = (
    db.query(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT date(at / 1000, 'unixepoch', 'localtime') FROM events)`).get() as {
      n: number;
    }
  ).n;
  const perKind = new Map(
    (
      db.query(`SELECT kind, COUNT(*) AS n FROM events GROUP BY kind`).all() as {
        kind: string;
        n: number;
      }[]
    ).map((r) => [r.kind, r.n]),
  );

  const relations: RelationReport[] = [
    {
      name: "events",
      sort: "table",
      doc: "every event ever logged, one row per line of ndjson. query the per-kind views instead unless you want a raw timeline; props is json and json_extract is what the views already did for you.",
      rows: span.rows,
      columns: envelopeColumns(),
    },
  ];

  for (const kind of KINDS) {
    const columns = envelopeColumns();
    for (const [name, spec] of propsOf(kind)) {
      const exposed = propColumn(name);
      columns.push({
        name: exposed,
        type: spec.type,
        doc: spec.doc,
        source: "prop",
        ...(spec.values ? { values: spec.values } : {}),
        ...(spec.required ? { required: spec.required } : {}),
        ...(exposed === name ? {} : { renamedFrom: name }),
      });
    }
    for (const c of COMPUTED) {
      columns.push({ name: c.name, type: c.type, doc: c.doc, source: "computed" });
    }
    relations.push({
      name: eventView(kind),
      sort: "event",
      kind,
      doc: EVENTS[kind].doc,
      rows: perKind.get(kind) ?? 0,
      columns,
    });
  }

  const docs = unambiguousDocs();
  for (const view of VIEWS) {
    const broken = viewError(db, view.name);
    const columns = broken
      ? []
      : (
          db.query(`PRAGMA table_info(${view.name})`).all() as {
            name: string;
            type: string;
          }[]
        ).map((c) => {
          const known = docs.get(c.name);
          return {
            name: c.name,
            type: c.type || known?.type || "",
            doc: known?.doc ?? "",
            source: "derived" as const,
            ...(known?.values ? { values: known.values } : {}),
          };
        });
    relations.push({
      name: view.name,
      sort: "curated",
      doc: view.doc,
      rows: null,
      columns,
      ...(broken ? { broken } : {}),
    });
  }

  return { rows: span.rows, first: span.first, last: span.last, days, relations };
}

/* ——— the read-only gate ——— */

/** strip string literals and comments so the guard reads the statement,
    not its contents. */
function bareSql(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < sql.length && sql[i] !== quote) i++;
      out += " ";
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i++;
      out += " ";
      continue;
    }
    out += c;
  }
  return out.trim();
}

/** the db is disposable, but an agent still must not be able to mutate
    what it is reading: a query that quietly deleted rows would make the
    next answer wrong and nobody would know. one statement, and it has to
    be a read. the caller also sets PRAGMA query_only, so this gate is
    the readable half of the belt and braces. */
export function assertSelect(sql: string): string {
  const bare = bareSql(sql).replace(/;\s*$/, "");
  if (bare.length === 0) throw new Error("empty query");
  if (bare.includes(";")) throw new Error("one statement per query, no semicolons inside it");
  if (!/^(select|with)\b/i.test(bare)) {
    const verb = /^\s*(\w+)/.exec(bare)?.[1] ?? "that";
    throw new Error(`read-only: ${verb.toLowerCase()} is not allowed, queries must start with SELECT or WITH`);
  }
  return sql.replace(/;\s*$/, "");
}
