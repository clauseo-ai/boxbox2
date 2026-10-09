/* the telemetry cli: the surface an agent queries the log through.

   run: bun scripts/telemetry.ts <command>

   there is no server and no daemon. every command rebuilds sqlite from
   the ndjson in $BOXBOX_DATA_DIR/telemetry, in memory, in a second or
   two, then answers. the log is the truth; the database is a view of it
   that gets thrown away when the process exits (`ingest --file` keeps
   one on disk when you are going to ask a hundred questions in a row).

   the contract with whoever reads this: `schema` and `examples` are
   enough to write correct sql. no documentation, no source reading, no
   guessing at column names. if that stops being true, the fix belongs
   in telemetry/schema.ts, not in a doc. */

import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import {
  assertSelect,
  buildDb,
  type RelationReport,
  schemaReport,
  viewError,
} from "../telemetry/db";
import { dictionaryJson } from "../telemetry/dictionary";
import { EXAMPLES } from "../telemetry/views";

/* ——— args ——— */

type Flags = Record<string, string | true>;

function parse(argv: string[]): { cmd: string; args: string[]; flags: Flags } {
  const [cmd = "help", ...rest] = argv;
  const args: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { cmd, args, flags };
}

function str(value: string | true | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function fail(message: string): never {
  console.error(`telemetry: ${message}`);
  process.exit(1);
}

/* ——— output shapes ——— */

type Row = Record<string, unknown>;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
  }
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  return String(value).replace(/\s*\n\s*/g, " ");
}

/** aligned text table. numeric columns go right, everything else left,
    so a column of counts reads as a column of counts. */
function textTable(columns: string[], rows: Row[]): string {
  if (columns.length === 0) return "";
  const body = rows.map((row) => columns.map((c) => cell(row[c])));
  const numeric = columns.map((c) =>
    rows.some((r) => typeof r[c] === "number") &&
    rows.every((r) => r[c] === null || r[c] === undefined || typeof r[c] === "number"),
  );
  const width = columns.map((c, i) =>
    Math.max(c.length, ...body.map((line) => (line[i] ?? "").length), 1),
  );
  const line = (cells: string[]) =>
    cells
      .map((text, i) => (numeric[i] ? text.padStart(width[i] ?? 0) : text.padEnd(width[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [
    line(columns),
    width.map((w) => "-".repeat(w)).join("  "),
    ...body.map(line),
  ].join("\n");
}

function csv(columns: string[], rows: Row[]): string {
  const quote = (value: unknown) => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    columns.map(quote).join(","),
    ...rows.map((row) => columns.map((c) => quote(row[c])).join(",")),
  ].join("\n");
}

function wrap(text: string, width: number, indent: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line.length > 0) out.push(line);
  return out.map((l, i) => (i === 0 ? l : " ".repeat(indent) + l));
}

/* ——— the db ——— */

function open(flags: Flags): Database {
  const file = str(flags.db);
  if (file) {
    if (!existsSync(file)) fail(`no such db file: ${file} (build one with: ingest --file ${file})`);
    return new Database(file, { readonly: true });
  }
  const since = str(flags.since);
  return buildDb(since === undefined ? {} : { since });
}

/** every read goes through here: the sql has to be a single select, and
    the connection is put in query_only so even a clever one cannot
    write. the database is disposable, but a silent mutation would make
    the NEXT answer wrong, and nobody would know to distrust it. */
function read(db: Database, sql: string): { columns: string[]; rows: Row[] } {
  db.exec("PRAGMA query_only = ON");
  const statement = db.query(assertSelect(sql));
  const rows = statement.all() as Row[];
  const columns = statement.columnNames ?? (rows[0] ? Object.keys(rows[0]) : []);
  return { columns, rows };
}

/* ——— schema ——— */

function printSchema(db: Database, json: boolean) {
  const report = schemaReport(db);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const span =
    report.first === null
      ? "no events yet"
      : `${report.rows} events, ${report.days} day${report.days === 1 ? "" : "s"}, ${stamp(report.first)} to ${stamp(report.last as number)}`;
  console.log(`telemetry schema  (${span})`);
  console.log(
    "every name below is derived from telemetry/schema.ts and telemetry/views.ts.",
  );
  console.log("--json for the same thing as data. `examples` for sql worth stealing.\n");

  const columnLines = (relation: RelationReport, only?: ColumnSource[]) => {
    for (const column of relation.columns) {
      if (only && !only.includes(column.source)) continue;
      const tags = [
        column.required ? "required" : "",
        column.renamedFrom ? `renamed from prop "${column.renamedFrom}", the envelope owns that name` : "",
      ].filter(Boolean);
      const values = column.values ? ` (one of: ${column.values.join(" | ")})` : "";
      const doc = `${tags.length ? `[${tags.join("] [")}] ` : ""}${column.doc}${values}`.trim();
      const head = `    ${column.name.padEnd(16)} ${column.type.padEnd(8)}`;
      /* a curated view's own columns have no dictionary doc. the name and
         the type are still the answer to "what can i select", so the line
         prints either way. */
      const lines = doc.length > 0 ? wrap(doc, 62, head.length) : [""];
      for (const [i, line] of lines.entries()) {
        console.log(i === 0 ? `${head}${line}`.trimEnd() : line);
      }
    }
  };

  for (const relation of report.relations.filter((r) => r.sort === "table")) {
    console.log(`TABLE ${relation.name}   ${relation.rows} rows`);
    for (const line of wrap(relation.doc, 84, 0)) console.log(`  ${line}`);
    columnLines(relation);
    console.log("");
  }

  console.log("EVENT VIEWS  one per kind in the dictionary. each carries every envelope");
  console.log("             column above, its own props, and day / hour / weekday off at.\n");
  for (const relation of report.relations.filter((r) => r.sort === "event")) {
    console.log(`  ${relation.name.padEnd(22)} kind = ${relation.kind}   ${relation.rows} rows`);
    for (const line of wrap(relation.doc, 80, 0)) console.log(`    ${line}`);
    columnLines(relation, ["prop", "computed"]);
    console.log("");
  }

  console.log("CURATED VIEWS  the derivations that take real sql. reach for these first.\n");
  for (const relation of report.relations.filter((r) => r.sort === "curated")) {
    console.log(`  ${relation.name}`);
    for (const line of wrap(relation.doc, 80, 0)) console.log(`    ${line}`);
    if (relation.broken) {
      console.log(`    BROKEN: ${relation.broken}`);
      console.log("    the sql in views.ts names a column the dictionary does not declare.");
      console.log("");
      continue;
    }
    columnLines(relation);
    console.log("");
  }
}

type ColumnSource = "envelope" | "prop" | "computed" | "derived";

/* ——— time ——— */

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function midnight(ms: number, plusDays = 0): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + plusDays).getTime();
}

type Window = { from: number; to: number; days: number; label: string };

/** monday 00:00 local of an iso week, the YYYY-Www the digest takes. */
function isoWeekStart(year: number, week: number): number {
  const jan4 = new Date(year, 0, 4);
  const isoDow = (jan4.getDay() + 6) % 7; /* monday = 0 */
  return new Date(year, 0, 4 - isoDow + (week - 1) * 7).getTime();
}

function digestWindow(flags: Flags): { now: Window; prev: Window } {
  const week = str(flags.week);
  if (week) {
    const m = /^(\d{4})-[Ww](\d{1,2})$/.exec(week);
    if (!m) fail(`--week wants YYYY-Www, got "${week}"`);
    const number = Number(m[2]);
    if (number < 1 || number > 53) fail(`--week wants a week from 1 to 53, got ${number}`);
    const from = isoWeekStart(Number(m[1]), number);
    const to = midnight(from, 7);
    return {
      now: { from, to, days: 7, label: `${week} (${dayKey(from)} to ${dayKey(midnight(to, -1))})` },
      prev: { from: midnight(from, -7), to: from, days: 7, label: "the week before" },
    };
  }
  const days = Number(str(flags.days) ?? 7);
  if (!Number.isFinite(days) || days < 1) fail(`--days wants a positive number, got "${str(flags.days)}"`);
  const to = midnight(Date.now(), 1);
  const from = midnight(to, -days);
  return {
    now: { from, to, days, label: `${dayKey(from)} to ${dayKey(midnight(to, -1))}` },
    prev: { from: midnight(from, -days), to: from, days, label: "the period before" },
  };
}

/* ——— digest ——— */

function digest(db: Database, flags: Flags) {
  const { now, prev } = digestWindow(flags);
  const out: string[] = [];
  const say = (line = "") => out.push(line);

  const all = (sql: string, w: Window, extra: Row = {}) =>
    db.query(sql).all({ $from: w.from, $to: w.to, $day_from: dayKey(w.from), $day_to: dayKey(w.to), ...extra }) as Row[];
  const num = (sql: string, w: Window, extra: Row = {}): number => {
    const row = all(sql, w, extra)[0];
    const value = row ? Object.values(row)[0] : null;
    return typeof value === "number" ? value : 0;
  };
  const maybe = (sql: string, w: Window): number | null => {
    const row = all(sql, w)[0];
    const value = row ? Object.values(row)[0] : null;
    return typeof value === "number" ? value : null;
  };

  const fleetBroken = viewError(db, "v_daily_fleet");

  /* every headline number is a query, run once per period so the deltas
     cannot drift from the tables above them */
  const headline = (w: Window) => ({
    visits: num(`SELECT COUNT(*) FROM v_stints WHERE started_at >= $from AND started_at < $to`, w),
    minutes: num(`SELECT COALESCE(SUM(seconds), 0) / 60 FROM v_stints WHERE started_at >= $from AND started_at < $to`, w),
    events: num(`SELECT COUNT(*) FROM events WHERE at >= $from AND at < $to`, w),
    verbs: num(`SELECT COUNT(*) FROM e_verb WHERE at >= $from AND at < $to`, w),
    verb_fails: num(`SELECT COUNT(*) FROM e_verb WHERE ok = 0 AND at >= $from AND at < $to`, w),
    friction: num(`SELECT COUNT(*) FROM v_friction WHERE at >= $from AND at < $to`, w),
    needs_raised: num(`SELECT COUNT(*) FROM v_needs WHERE raised_at >= $from AND raised_at < $to`, w),
    needs_served: num(`SELECT COUNT(*) FROM v_needs WHERE served_at IS NOT NULL AND raised_at >= $from AND raised_at < $to`, w),
    needs_unserved: num(`SELECT COUNT(*) FROM v_needs WHERE served_at IS NULL AND raised_at >= $from AND raised_at < $to`, w),
    serve_s: maybe(`SELECT ROUND(AVG(served_ms) / 1000.0, 1) FROM v_needs WHERE served_at IS NOT NULL AND raised_at >= $from AND raised_at < $to`, w),
    prompts: num(`SELECT COUNT(*) FROM e_agent_prompt WHERE at >= $from AND at < $to`, w),
    usd_driven: num(`SELECT ROUND(COALESCE(SUM(usd), 0), 2) FROM v_agent_runs WHERE started_at >= $from AND started_at < $to`, w),
    usd_total: num(`SELECT ROUND(COALESCE(SUM(usd), 0), 2) FROM e_agent_bill WHERE at >= $from AND at < $to`, w),
  });

  const a = headline(now);
  const b = headline(prev);

  say(`# telemetry digest, ${now.label}`);
  say();
  if (a.events === 0) {
    const span = db.query(`SELECT MIN(at) AS first, MAX(at) AS last, COUNT(*) AS n FROM events`).get() as {
      first: number | null;
      last: number | null;
      n: number;
    };
    say(
      span.n === 0
        ? "the log is empty. nothing has been written to $BOXBOX_DATA_DIR/telemetry yet."
        : `nothing in this window. the log holds ${span.n} events, ${stamp(span.first as number)} to ${stamp(span.last as number)}.`,
    );
    console.log(out.join("\n"));
    return;
  }
  say(
    `${a.events} events, ${a.visits} visits, ${a.minutes} minutes of attention, ${a.needs_raised} needs raised, $${a.usd_total.toFixed(2)} spent.`,
  );
  say(
    `every number is a query against the log. deltas compare ${prev.label}, ${dayKey(prev.from)} to ${dayKey(midnight(prev.to, -1))}.`,
  );
  if (fleetBroken) {
    say();
    say(`> v_daily_fleet does not resolve (\`${fleetBroken}\`), so the fleet numbers below`);
    say("> come straight from e_agent_bill, e_push_sent and e_push_tapped instead.");
  }
  say();

  /* —— reach —— */
  say("## reach");
  say();
  const stints = all(
    `SELECT device_class AS device,
            COUNT(*) AS visits,
            COALESCE(SUM(seconds), 0) / 60 AS minutes,
            ROUND(AVG(seconds) / 60.0, 1) AS avg_min,
            SUM(events) AS events,
            MAX(started_at) AS last_seen
     FROM v_stints
     WHERE started_at >= $from AND started_at < $to
     GROUP BY device_class
     ORDER BY minutes DESC`,
    now,
  );
  say(
    mdTable(
      ["device", "visits", "minutes", "avg visit", "events", "last seen"],
      stints.map((r) => [
        cell(r.device),
        cell(r.visits),
        cell(r.minutes),
        `${cell(r.avg_min)} min`,
        cell(r.events),
        stamp(r.last_seen as number),
      ]),
    ),
  );
  say();
  const byHour = all(
    `SELECT start_hour AS hour, COUNT(*) AS n FROM v_stints
     WHERE started_at >= $from AND started_at < $to GROUP BY start_hour`,
    now,
  );
  say(`when: ${sparkline(byHour, "hour", "n", 24)}`);
  say(`      ${"0h".padEnd(12)}${"12h".padEnd(11)}23h`);
  say();

  /* —— needs —— */
  say("## needs, the thesis metric");
  say();
  const needs = all(
    `SELECT need,
            COUNT(*) AS raised,
            SUM(outcome = 'served') AS served,
            SUM(outcome = 'swept') AS swept,
            SUM(outcome IN ('agent', 'expired')) AS unserved,
            ROUND(AVG(seen_ms) / 1000.0, 1) AS seen_s,
            ROUND(AVG(served_ms) / 1000.0, 1) AS serve_s,
            ROUND(MAX(served_ms) / 1000.0, 1) AS worst_s
     FROM v_needs
     WHERE raised_at >= $from AND raised_at < $to
     GROUP BY need
     ORDER BY raised DESC`,
    now,
  );
  say(
    needs.length === 0
      ? "no needs raised in this window."
      : mdTable(
          ["need", "raised", "served", "swept", "ignored", "raised->seen", "raised->served", "worst"],
          needs.map((r) => [
            cell(r.need),
            cell(r.raised),
            cell(r.served),
            cell(r.swept),
            cell(r.unserved),
            secs(r.seen_s),
            secs(r.serve_s),
            secs(r.worst_s),
          ]),
        ),
  );
  say();
  say(
    "swept = cleared in bulk with the sweep control, which is him dealing with a pile, not reading a thread. ignored = the loop moved on or it aged out.",
  );
  say();
  const needsByDevice = all(
    `SELECT need, served_device_class AS device, COUNT(*) AS served,
            ROUND(AVG(served_ms) / 1000.0, 1) AS avg_s,
            ROUND(AVG(act_ms) / 1000.0, 1) AS seen_to_served_s
     FROM v_needs
     WHERE served_at IS NOT NULL AND raised_at >= $from AND raised_at < $to
     GROUP BY need, served_device_class
     ORDER BY need, avg_s`,
    now,
  );
  if (needsByDevice.length > 0) {
    say("served from where, and how fast:");
    say();
    say(
      mdTable(
        ["need", "device", "served", "raised->served", "seen->served"],
        needsByDevice.map((r) => [
          cell(r.need),
          cell(r.device),
          cell(r.served),
          secs(r.avg_s),
          secs(r.seen_to_served_s),
        ]),
      ),
    );
    say();
  }

  /* —— verbs —— */
  say("## verbs");
  say();
  const verbs = all(
    `SELECT name, COUNT(*) AS calls, SUM(ok = 0) AS fails,
            ROUND(AVG(ms)) AS avg_ms, MAX(ms) AS worst_ms
     FROM e_verb
     WHERE at >= $from AND at < $to
     GROUP BY name
     ORDER BY calls DESC
     LIMIT 15`,
    now,
  );
  say(
    verbs.length === 0
      ? "no verbs fired in this window."
      : mdTable(
          ["verb", "calls", "fails", "avg ms", "worst ms"],
          verbs.map((r) => [cell(r.name), cell(r.calls), cell(r.fails), cell(r.avg_ms), cell(r.worst_ms)]),
        ),
  );
  say();
  const breakage = all(
    `SELECT name, COALESCE(error, 'no message') AS error, COUNT(*) AS n, MAX(at) AS last_at
     FROM e_verb
     WHERE ok = 0 AND at >= $from AND at < $to
     GROUP BY name, error
     ORDER BY n DESC
     LIMIT 8`,
    now,
  );
  if (breakage.length > 0) {
    say("what broke:");
    say();
    say(
      mdTable(
        ["verb", "error", "n", "last"],
        breakage.map((r) => [cell(r.name), cell(r.error), cell(r.n), stamp(r.last_at as number)]),
      ),
    );
    say();
  }

  /* —— friction —— */
  say("## friction");
  say();
  say("proxies, not proof. each one is quoted with the events around it so the");
  say("finding can be read instead of trusted.");
  say();
  const friction = all(
    `SELECT sort, detail, COUNT(*) AS n, MAX(at) AS last_at
     FROM v_friction
     WHERE at >= $from AND at < $to
     GROUP BY sort, detail
     ORDER BY n DESC, last_at DESC
     LIMIT 5`,
    now,
  );
  if (friction.length === 0) say("nothing fired in this window.");
  for (const [i, f] of friction.entries()) {
    const worst = all(
      `SELECT id, at, device, device_class, surface, session FROM v_friction
       WHERE sort = $sort AND detail = $detail AND at = $at AND at >= $from AND at < $to LIMIT 1`,
      now,
      { $sort: f.sort, $detail: f.detail, $at: f.last_at },
    )[0];
    say(`### ${i + 1}. ${f.sort} x${f.n}  ${String(f.detail).slice(0, 70)}`);
    say();
    if (!worst) {
      say("(no instance rows, which should not happen: v_friction disagrees with itself)");
      say();
      continue;
    }
    say(
      `${cell(worst.device_class)} on ${cell(worst.surface)}, ${stamp(worst.at as number)}${worst.session ? `, session ${cell(worst.session)}` : ""}`,
    );
    say();
    say("```");
    for (const line of sequence(db, worst.device as string, worst.at as number, worst.id as string)) {
      say(line);
    }
    say("```");
    say();
  }

  /* —— agents —— */
  say("## agents");
  say();
  const models = all(
    `SELECT COALESCE(model, '(none sent)') AS model, COUNT(*) AS runs,
            ROUND(SUM(usd), 2) AS usd, ROUND(AVG(usd), 3) AS avg_usd,
            ROUND(AVG(elapsed_ms) / 1000.0) AS avg_s,
            SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out
     FROM v_agent_runs
     WHERE started_at >= $from AND started_at < $to
     GROUP BY model
     ORDER BY usd DESC`,
    now,
  );
  say(
    models.length === 0
      ? "no prompts driven from boxbox in this window."
      : mdTable(
          ["model", "runs", "usd", "avg usd", "avg s", "tokens in", "tokens out"],
          models.map((r) => [
            cell(r.model),
            cell(r.runs),
            `$${Number(r.usd ?? 0).toFixed(2)}`,
            `$${Number(r.avg_usd ?? 0).toFixed(3)}`,
            cell(r.avg_s),
            cell(r.tokens_in),
            cell(r.tokens_out),
          ]),
        ),
  );
  say();
  const drivenFrom = all(
    `SELECT device_class AS device, COUNT(*) AS runs, ROUND(SUM(usd), 2) AS usd,
            SUM(queued = 1) AS queued, SUM(fresh = 1) AS fresh
     FROM v_agent_runs
     WHERE started_at >= $from AND started_at < $to
     GROUP BY device_class
     ORDER BY usd DESC`,
    now,
  );
  if (drivenFrom.length > 0) {
    say("driven from:");
    say();
    say(
      mdTable(
        ["device", "runs", "usd", "queued", "fresh sessions"],
        drivenFrom.map((r) => [
          cell(r.device),
          cell(r.runs),
          `$${Number(r.usd ?? 0).toFixed(2)}`,
          cell(r.queued),
          cell(r.fresh),
        ]),
      ),
    );
    say();
  }
  const pushes = num(`SELECT COUNT(*) FROM e_push_sent WHERE at >= $from AND at < $to`, now);
  const tapped = fleetBroken
    ? num(
        `SELECT COUNT(*) FROM e_push_sent s
         WHERE s.at >= $from AND s.at < $to
           AND EXISTS (SELECT 1 FROM e_push_tapped t WHERE t.tag = s.tag AND t.at >= s.at)`,
        now,
      )
    : num(
        `SELECT COALESCE(SUM(pushes_tapped), 0) FROM v_daily_fleet WHERE day >= $day_from AND day < $day_to`,
        now,
      );
  const share = a.usd_total > 0 ? (100 * a.usd_driven) / a.usd_total : 0;
  say(
    `fleet: $${a.usd_total.toFixed(2)} billed, $${a.usd_driven.toFixed(2)} of it driven from boxbox (${share.toFixed(0)}%). ` +
      `${pushes} pushes sent, ${tapped} tapped${pushes > 0 ? ` (${((100 * tapped) / pushes).toFixed(0)}%)` : ""}.`,
  );
  say();
  if (!fleetBroken) {
    /* the day by day spine: what the fleet raised and what it cost,
       whether or not he was looking */
    const spine = all(
      `SELECT day, needs_raised, needs_served, needs_unserved, avg_serve_s, pushes,
              pushes_tapped, usd_total, usd_driven, drive_share
       FROM v_daily_fleet
       WHERE day >= $day_from AND day < $day_to
       ORDER BY day DESC`,
      now,
    );
    if (spine.length > 0) {
      say(
        mdTable(
          ["day", "raised", "served", "never", "avg serve", "pushes", "tapped", "usd", "driven", "share"],
          spine.map((r) => [
            cell(r.day),
            cell(r.needs_raised),
            cell(r.needs_served),
            cell(r.needs_unserved),
            secs(r.avg_serve_s),
            cell(r.pushes),
            cell(r.pushes_tapped),
            `$${Number(r.usd_total ?? 0).toFixed(2)}`,
            `$${Number(r.usd_driven ?? 0).toFixed(2)}`,
            r.drive_share === null ? "-" : `${Math.round(Number(r.drive_share) * 100)}%`,
          ]),
        ),
      );
      say();
    }
  }

  /* —— deltas —— */
  say("## vs the period before");
  say();
  const rows: [string, number | null, number | null, boolean][] = [
    ["visits", a.visits, b.visits, false],
    ["minutes", a.minutes, b.minutes, false],
    ["events", a.events, b.events, false],
    ["verbs", a.verbs, b.verbs, false],
    ["verb failures", a.verb_fails, b.verb_fails, true],
    ["friction signals", a.friction, b.friction, true],
    ["needs raised", a.needs_raised, b.needs_raised, false],
    ["needs served", a.needs_served, b.needs_served, false],
    ["needs never served", a.needs_unserved, b.needs_unserved, true],
    ["avg serve seconds", a.serve_s, b.serve_s, true],
    ["prompts", a.prompts, b.prompts, false],
    ["usd driven", a.usd_driven, b.usd_driven, false],
    ["usd billed (fleet)", a.usd_total, b.usd_total, false],
  ];
  say(
    mdTable(
      ["metric", "this period", "before", "delta"],
      rows.map(([name, x, y]) => [name, cell(x), cell(y), delta(x, y)]),
    ),
  );
  say();
  say("lower is better for failures, friction, never-served and serve seconds.");

  console.log(out.join("\n"));
}

function secs(value: unknown): string {
  return value === null || value === undefined ? "-" : `${cell(value)}s`;
}

function delta(now: number | null, before: number | null): string {
  if (now === null || before === null) return "-";
  const diff = Math.round((now - before) * 100) / 100;
  if (diff === 0) return "same";
  const pct = before === 0 ? null : Math.round((100 * diff) / before);
  return `${diff > 0 ? "+" : ""}${diff}${pct === null ? "" : ` (${pct > 0 ? "+" : ""}${pct}%)`}`;
}

/** 24 blocks, one per hour, scaled to the busiest. an hour he never
    touched is a dot, not a gap, so a quiet hour and a missing one do not
    look the same. the daily rhythm in one line, which is the only form
    anyone actually reads. */
function sparkline(rows: Row[], key: string, value: string, slots: number): string {
  const ticks = "▁▂▃▄▅▆▇█";
  const counts = new Array<number>(slots).fill(0);
  for (const row of rows) {
    const slot = Number(row[key]);
    if (Number.isFinite(slot) && slot >= 0 && slot < slots) counts[slot] = Number(row[value]) || 0;
  }
  const peak = Math.max(...counts, 1);
  return counts
    .map((n) => (n === 0 ? "·" : ticks[Math.min(ticks.length - 1, Math.round((n / peak) * (ticks.length - 1)) || 0)]))
    .join("");
}

/** the events either side of a friction signal, on the same device, so
    the finding reads as a story rather than a count. a minute before is
    enough to see what he was trying to do, twenty seconds after is
    enough to see whether he gave up. */
function sequence(db: Database, device: string, at: number, id: string): string[] {
  const rows = db
    .query(
      `SELECT id, at, kind, surface, ok, ms, props FROM events
       WHERE device = $device AND at >= $from AND at <= $to
       ORDER BY at LIMIT 16`,
    )
    .all({ $device: device, $from: at - 60_000, $to: at + 20_000 }) as Row[];
  return rows.map((row) => {
    const offset = ((row.at as number) - at) / 1000;
    const mark = row.id === id ? ">" : " ";
    const outcome = row.ok === null || row.ok === undefined ? "" : row.ok === 1 ? " ok" : " FAILED";
    const took = row.ms === null || row.ms === undefined ? "" : ` ${row.ms}ms`;
    const props = row.props ? ` ${String(row.props).slice(0, 90)}` : "";
    return `${mark} ${(offset >= 0 ? `+${offset.toFixed(1)}` : offset.toFixed(1)).padStart(6)}s  ${String(row.kind).padEnd(16)} ${String(row.surface ?? "-").padEnd(9)}${outcome}${took}${props}`;
  });
}

function mdTable(headers: string[], rows: string[][]): string {
  /* a pipe inside an error message would split the row into two cells */
  const safe = rows.map((row) => row.map((c) => (c ?? "").replace(/\|/g, "\\|")));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...safe.map((r) => (r[i] ?? "").length), 3),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((c, i) => (c ?? "").padEnd(widths[i] ?? 0)).join(" | ")} |`;
  return [
    line(headers),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...safe.map(line),
  ].join("\n");
}

/* ——— commands ——— */

const USAGE = `telemetry, the query side of the boxbox log

  bun scripts/telemetry.ts <command> [options]

commands
  schema [--json]              every table, view, column and doc, derived from
                               telemetry/schema.ts. read this before writing sql.
  examples [--json]            question -> sql pairs from telemetry/views.ts.
  dictionary --json            the dictionary alone as json (telemetry/schema.json,
                               which the rust server's ingest is generated from).
  query "<sql>" [--json|--csv] run one read-only select. default output is an
                               aligned table with a row count.
  digest [--week YYYY-Www]     a markdown report to stdout: reach, need latency,
         [--days N]            verbs, friction with the sequence around it, agent
                               cost, and deltas against the period before.
                               defaults to the last 7 days.
  ingest --file <path>         materialize the database to a file, then query it
                               with --db <path> instead of rebuilding each time.

options
  --since YYYY-MM-DD           ingest floor, skips older day files. digest sets its
                               own floor unless you pass one.
  --db <path>                  query a file built by ingest instead of rebuilding.

the database
  rebuilt in memory from $BOXBOX_DATA_DIR/telemetry/*.jsonl on every run, so it is
  never stale and never worth backing up. the log is the truth.

  events            one row per logged event. envelope columns only; props is json.
  e_<kind>          one view per event kind, dots swapped for underscores
                    (agent.prompt -> e_agent_prompt). envelope columns, every
                    declared prop as a real typed column with the dictionary's
                    camelCase name, plus day / hour / weekday in LOCAL time.
  v_<name>          the curated derivations: v_stints, v_needs, v_friction,
                    v_agent_runs, v_push, v_surfaces, v_daily, v_daily_fleet.

  group by day, never by the raw at. writes are refused: queries must be a single
  SELECT or WITH, and the connection runs with PRAGMA query_only.`;

function main() {
  const { cmd, args, flags } = parse(process.argv.slice(2));
  const json = flags.json === true;

  if (cmd === "help" || cmd === "--help" || cmd === "-h" || flags.help === true) {
    console.log(USAGE);
    return;
  }

  if (cmd === "dictionary") {
    process.stdout.write(dictionaryJson());
    return;
  }

  if (cmd === "examples") {
    if (json) {
      console.log(JSON.stringify(EXAMPLES, null, 2));
      return;
    }
    console.log(`${EXAMPLES.length} questions this database was built to answer.\n`);
    for (const [i, example] of EXAMPLES.entries()) {
      console.log(`${String(i + 1).padStart(2)}. ${example.question}`);
      for (const line of example.sql.split("\n")) console.log(`    ${line}`);
      console.log("");
    }
    return;
  }

  if (cmd === "ingest") {
    const file = str(flags.file);
    if (!file) fail("ingest wants --file <path>");
    const before = countRows(file);
    const since = str(flags.since);
    const db = buildDb(since === undefined ? { file } : { since, file });
    const after = (db.query(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
    const span = db.query(`SELECT MIN(at) AS first, MAX(at) AS last FROM events`).get() as {
      first: number | null;
      last: number | null;
    };
    db.close();
    const size = (statSync(file).size / 1024 / 1024).toFixed(1);
    console.log(
      `${after} events (${after - before} new) in ${file}, ${size} mb` +
        (span.first === null ? "" : `, ${stamp(span.first)} to ${stamp(span.last as number)}`),
    );
    console.log(`query it: bun scripts/telemetry.ts query --db ${file} "SELECT ..."`);
    return;
  }

  if (cmd === "schema") {
    const db = open(flags);
    printSchema(db, json);
    db.close();
    return;
  }

  if (cmd === "query") {
    const sql = args[0];
    if (!sql) fail(`query wants sql: telemetry.ts query "SELECT ..."`);
    const db = open(flags);
    let result: { columns: string[]; rows: Row[] };
    try {
      result = read(db, sql);
    } catch (error) {
      fail((error as Error).message);
    }
    if (json) {
      console.log(JSON.stringify({ rows: result.rows.length, columns: result.columns, data: result.rows }, null, 2));
    } else if (flags.csv === true) {
      console.log(csv(result.columns, result.rows));
    } else {
      if (result.rows.length > 0) console.log(textTable(result.columns, result.rows));
      console.log(`${result.rows.length} row${result.rows.length === 1 ? "" : "s"}`);
    }
    db.close();
    return;
  }

  if (cmd === "digest") {
    /* the digest only ever looks at two periods, so it does not pay to
       ingest a year of day files to render a week */
    const { prev } = digestWindow(flags);
    const since = str(flags.since) ?? dayKey(prev.from);
    const db = open(str(flags.db) ? flags : { ...flags, since });
    digest(db, flags);
    db.close();
    return;
  }

  fail(`unknown command "${cmd}". try: bun scripts/telemetry.ts help`);
}

function countRows(file: string): number {
  if (!existsSync(file)) return 0;
  try {
    const db = new Database(file, { readonly: true });
    const n = (db.query(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n;
    db.close();
    return n;
  } catch {
    return 0;
  }
}

main();
