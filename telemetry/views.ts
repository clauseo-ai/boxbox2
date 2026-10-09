/* the query layer: what the database is FOR.

   two tiers, both built by db.ts:

   1. generated per-kind views (`e_*`) — one per entry in EVENTS, with
      every prop flattened into a real column plus day/hour/weekday.
      nobody ever writes json_extract. these come straight off the
      dictionary, so they cannot drift from the producers.

   2. curated analytical views (`v_*`, below) — the derivations that take
      real sql to express: sessionizing visits, closing the
      raised → seen → served interval on a need, pairing a prompt with
      the bills it caused. an agent should reach for these before writing
      window functions from scratch.

   the views are ordered: later ones select from earlier ones. prop
   columns keep the dictionary's exact camelCase names so there is no
   translation step between reading schema.ts and writing a query. */

import { SERVING_VERBS, STINT_GAP_MS } from "./schema";

export type ViewSpec = {
  name: string;
  doc: string;
  sql: string;
};

const servingVerbs = SERVING_VERBS.map((v) => `'${v}'`).join(", ");

export const VIEWS: ViewSpec[] = [
  {
    name: "v_stints",
    doc: "one row per VISIT: a contiguous run of activity on one device, split wherever the gap exceeds five minutes. this is the answer to 'how much am i using boxbox, from where, and when' — count rows for visits, sum minutes for time, group by start_hour for a daily rhythm.",
    sql: `
WITH ordered AS (
  SELECT
    device,
    device_class,
    at,
    CASE
      WHEN LAG(at) OVER (PARTITION BY device ORDER BY at) IS NULL
        OR at - LAG(at) OVER (PARTITION BY device ORDER BY at) > ${STINT_GAP_MS}
      THEN 1 ELSE 0
    END AS is_start
  FROM events
  WHERE device <> 'server'
),
grouped AS (
  SELECT
    device,
    device_class,
    at,
    SUM(is_start) OVER (PARTITION BY device ORDER BY at ROWS UNBOUNDED PRECEDING) AS stint_no
  FROM ordered
)
SELECT
  device,
  device_class,
  stint_no,
  MIN(at) AS started_at,
  MAX(at) AS ended_at,
  (MAX(at) - MIN(at)) / 1000 AS seconds,
  COUNT(*) AS events,
  date(MIN(at) / 1000, 'unixepoch', 'localtime') AS day,
  CAST(strftime('%H', MIN(at) / 1000, 'unixepoch', 'localtime') AS INTEGER) AS start_hour,
  CAST(strftime('%w', MIN(at) / 1000, 'unixepoch', 'localtime') AS INTEGER) AS weekday
FROM grouped
GROUP BY device, stint_no`,
  },

  {
    name: "v_needs",
    doc: "THE thesis metric. one row per need the brain raised, with the two intervals that matter: seen_ms (raised → a client actually rendered it: delivery, push, his pocket) and served_ms (raised → he acted on it). served_device_class tells you whether the couch is slower than the desk. rows with served_at IS NULL are needs boxbox raised and he never answered — count them by need kind before adding another badge.",
    sql: `
WITH raised AS (
  SELECT
    r.*,
    LEAD(r.at) OVER (PARTITION BY r.session ORDER BY r.at) AS next_raise_at,
    LEAD(r.at) OVER (PARTITION BY r.session, r.need ORDER BY r.at) AS next_same_need_at
  FROM e_need_raised r
),
first_seen AS (
  /* pair a sighting to a raise by TIME, never by a stamp the two sides
     would have to agree on: the raise is stamped by the server (or by
     the tracker re-stamping a client signal) and the sighting by a
     device, so any shared-id join silently produces nothing. found on
     real data 2026-07-25 — every seen_ms was null. */
  SELECT raise_id, seen_at, seen_device, seen_device_class
  FROM (
    SELECT
      ra.id AS raise_id,
      s.at AS seen_at,
      s.device AS seen_device,
      s.device_class AS seen_device_class,
      ROW_NUMBER() OVER (PARTITION BY ra.id ORDER BY s.at) AS rn
    FROM raised ra
    JOIN e_need_seen s
      ON s.session = ra.session
     AND s.need = ra.need
     AND s.at >= ra.at
     AND (ra.next_same_need_at IS NULL OR s.at < ra.next_same_need_at)
  )
  WHERE rn = 1
),
served AS (
  SELECT raise_id, at AS served_at, device AS served_device, device_class AS served_device_class, name AS served_verb, surface AS served_surface
  FROM (
    SELECT
      ra.id AS raise_id,
      v.at, v.device, v.device_class, v.name, v.surface,
      ROW_NUMBER() OVER (PARTITION BY ra.id ORDER BY v.at) AS rn
    FROM raised ra
    JOIN e_verb v
      ON v.session = ra.session
     AND v.at >= ra.at
     AND (ra.next_raise_at IS NULL OR v.at < ra.next_raise_at)
     AND v.ok = 1
     AND v.name IN (${servingVerbs})
  )
  WHERE rn = 1
),
cleared AS (
  /* the clear belongs to THIS raise, not to the first one ever: a need
     that raises, clears, and raises again on the same thread would
     otherwise show the second occurrence as never cleared. bounded by
     the next raise OF THE SAME NEED, since another kind raising in
     between says nothing about this one. */
  SELECT raise_id, cleared_at, cleared_by, ageMs
  FROM (
    SELECT
      ra.id AS raise_id,
      c.at AS cleared_at,
      c.by AS cleared_by,
      c.ageMs,
      ROW_NUMBER() OVER (PARTITION BY ra.id ORDER BY c.at) AS rn
    FROM raised ra
    JOIN e_need_cleared c
      ON c.session = ra.session
     AND c.need = ra.need
     AND c.at >= ra.at
     AND (ra.next_same_need_at IS NULL OR c.at < ra.next_same_need_at)
  )
  WHERE rn = 1
)
SELECT
  r.id AS raise_id,
  r.at AS raised_at,
  r.day,
  r.hour,
  r.weekday,
  r.session,
  r.host,
  r.repo,
  r.need,
  r.child,
  s.seen_at,
  s.seen_device,
  s.seen_device_class,
  d.served_at,
  d.served_device,
  d.served_device_class,
  d.served_verb,
  d.served_surface,
  c.cleared_at,
  c.cleared_by,
  s.seen_at - r.at AS seen_ms,
  d.served_at - r.at AS served_ms,
  d.served_at - s.seen_at AS act_ms,
  /* the honest four-way outcome. a SWEEP is not a serve: clearing the
     lot with one control is him dealing with the pile, not him reading
     the thread, and counting it as a fast serve would flatter the
     latency numbers. it is not "never answered" either. */
  CASE
    WHEN d.served_at IS NOT NULL THEN 'served'
    WHEN c.cleared_by = 'him' THEN 'swept'
    WHEN c.cleared_by IN ('agent', 'expired') THEN c.cleared_by
    ELSE 'standing'
  END AS outcome
FROM raised r
LEFT JOIN first_seen s ON s.raise_id = r.id
LEFT JOIN served d ON d.raise_id = r.id
LEFT JOIN cleared c ON c.raise_id = r.id`,
  },

  {
    name: "v_friction",
    doc: "every signal that something went wrong or felt wrong, normalized into one stream: rage taps, dead-end navigations, abandoned typing, client errors, and failed verbs. `sort` says which. read it ordered by at and the story is legible — these are proxies, so quote the sequence before believing the count.",
    sql: `
SELECT 'rage' AS sort, id, at, day, hour, device, device_class, surface, session,
       control AS detail, taps AS n, NULL AS ms
FROM e_friction_rage
UNION ALL
SELECT 'deadend', id, at, day, hour, device, device_class, surface, session,
       "to", NULL, backMs
FROM e_friction_deadend
UNION ALL
SELECT 'abandon', id, at, day, hour, device, device_class, surface, session,
       what, chars, heldMs
FROM e_friction_abandon
UNION ALL
SELECT 'error', id, at, day, hour, device, device_class, surface, session,
       message, status, NULL
FROM e_error_client
UNION ALL
SELECT 'verb_failed', id, at, day, hour, device, device_class, surface, session,
       name || ': ' || COALESCE(error, 'no message'), NULL, ms
FROM e_verb
WHERE ok = 0`,
  },

  {
    name: "v_agent_runs",
    doc: "the second axis: one row per prompt HE sent, with the powertrain as driven and the bills that landed before the next prompt in that session. this is cost-per-intent — 'what does a turn on this repo, this model, from this device actually cost'. turns driven from the tui have no prompt row here on purpose: v_agent_runs is the slice boxbox drove, e_agent_bill is the whole fleet's spend.",
    sql: `
WITH p AS (
  SELECT *, LEAD(at) OVER (PARTITION BY session ORDER BY at) AS next_prompt_at
  FROM e_agent_prompt
)
SELECT
  p.id AS prompt_id,
  p.at AS started_at,
  p.day,
  p.hour,
  p.weekday,
  p.device,
  p.device_class,
  p.surface,
  p.session,
  p.host,
  p.repo,
  p.model,
  p.provider,
  p.agent,
  p.variant,
  p.workspace,
  p.fresh,
  p.chars,
  p.files,
  p.queued,
  COUNT(b.id) AS messages,
  ROUND(COALESCE(SUM(b.usd), 0), 4) AS usd,
  COALESCE(SUM(b.tokensIn), 0) AS tokens_in,
  COALESCE(SUM(b.tokensOut), 0) AS tokens_out,
  COALESCE(SUM(b.tokensReasoning), 0) AS tokens_reasoning,
  COALESCE(SUM(b.cacheRead), 0) AS cache_read,
  MAX(b.at) - p.at AS elapsed_ms
FROM p
LEFT JOIN e_agent_bill b
  ON b.session = p.session
 AND b.at >= p.at
 AND (p.next_prompt_at IS NULL OR b.at < p.next_prompt_at)
GROUP BY p.id`,
  },

  {
    name: "v_push",
    doc: "the pocket funnel: sent → tapped → replied-from-the-banner, joined on tag. tap_ms is how long the notification sat there. a need kind with a high send count and a low tap rate is a push that is not worth sending.",
    sql: `
SELECT
  s.id AS sent_id,
  s.at AS sent_at,
  s.day,
  s.hour,
  s.session,
  s.host,
  s.need,
  s.tag,
  s.subs,
  t.at AS tapped_at,
  t.device AS tapped_device,
  t.device_class AS tapped_device_class,
  t.at - s.at AS tap_ms,
  r.at AS replied_at,
  r.action AS replied_action
FROM e_push_sent s
LEFT JOIN e_push_tapped t ON t.tag = s.tag AND t.at >= s.at
LEFT JOIN e_push_replied r ON r.tag = s.tag AND r.at >= s.at`,
  },

  {
    name: "v_surfaces",
    doc: "per surface per device class: how often he opens it, how long it takes to show something, and how often he bounces straight back out. a surface with high views and high deadends is a wrong door; one with no views at all is a candidate for the kill list.",
    sql: `
SELECT
  v.surface,
  v.device_class,
  COUNT(*) AS views,
  (SELECT COUNT(*) FROM e_friction_deadend d WHERE d."to" = v.surface AND d.device_class = v.device_class) AS deadends,
  (SELECT ROUND(AVG(r.ms)) FROM e_surface_ready r WHERE r.surface = v.surface AND r.device_class = v.device_class AND r.cached = 0) AS avg_cold_ms,
  (SELECT ROUND(AVG(r.ms)) FROM e_surface_ready r WHERE r.surface = v.surface AND r.device_class = v.device_class AND r.cached = 1) AS avg_warm_ms,
  MAX(v.at) AS last_view_at
FROM e_surface_view v
GROUP BY v.surface, v.device_class`,
  },

  {
    name: "v_daily",
    doc: "the digest's spine: one row per day per device class. visits, minutes, verbs, failures, friction, needs served and how fast, and the dollars boxbox drove from that device. this is the table to diff week over week when checking whether a change actually moved anything.",
    sql: `
WITH base AS (
  SELECT date(at / 1000, 'unixepoch', 'localtime') AS day, device_class
  FROM events
  WHERE device <> 'server'
  GROUP BY 1, 2
)
SELECT
  b.day,
  b.device_class,
  (SELECT COUNT(*) FROM v_stints s WHERE s.day = b.day AND s.device_class = b.device_class) AS visits,
  (SELECT COALESCE(SUM(s.seconds), 0) / 60 FROM v_stints s WHERE s.day = b.day AND s.device_class = b.device_class) AS minutes,
  (SELECT COUNT(*) FROM e_verb v WHERE v.day = b.day AND v.device_class = b.device_class) AS verbs,
  (SELECT COUNT(*) FROM e_verb v WHERE v.day = b.day AND v.device_class = b.device_class AND v.ok = 0) AS verb_failures,
  (SELECT COUNT(*) FROM v_friction f WHERE f.day = b.day AND f.device_class = b.device_class) AS friction,
  (SELECT COUNT(*) FROM v_needs n WHERE n.day = b.day AND n.served_device_class = b.device_class) AS needs_served,
  (SELECT ROUND(AVG(n.served_ms) / 1000.0, 1) FROM v_needs n WHERE n.day = b.day AND n.served_device_class = b.device_class) AS avg_serve_s,
  (SELECT COUNT(*) FROM e_agent_prompt p WHERE p.day = b.day AND p.device_class = b.device_class) AS prompts,
  (SELECT ROUND(COALESCE(SUM(r.usd), 0), 2) FROM v_agent_runs r WHERE r.day = b.day AND r.device_class = b.device_class) AS usd_driven
FROM base b`,
  },

  {
    name: "v_daily_fleet",
    doc: "the device-independent half of the day: what the fleet raised and what it cost, whether or not he was looking. drive_share is the fraction of the day's spend that boxbox actually initiated — the rest is tui and agent churn.",
    sql: `
WITH base AS (
  SELECT date(at / 1000, 'unixepoch', 'localtime') AS day FROM events GROUP BY 1
)
SELECT
  b.day,
  (SELECT COUNT(*) FROM v_needs n WHERE n.day = b.day) AS needs_raised,
  (SELECT COUNT(*) FROM v_needs n WHERE n.day = b.day AND n.served_at IS NOT NULL) AS needs_served,
  (SELECT COUNT(*) FROM v_needs n WHERE n.day = b.day AND n.served_at IS NULL) AS needs_unserved,
  (SELECT ROUND(AVG(n.served_ms) / 1000.0, 1) FROM v_needs n WHERE n.day = b.day) AS avg_serve_s,
  (SELECT COUNT(*) FROM e_push_sent p WHERE p.day = b.day) AS pushes,
  (SELECT COUNT(*) FROM v_push p WHERE p.day = b.day AND p.tapped_at IS NOT NULL) AS pushes_tapped,
  (SELECT ROUND(COALESCE(SUM(x.usd), 0), 2) FROM e_agent_bill x WHERE x.day = b.day) AS usd_total,
  (SELECT ROUND(COALESCE(SUM(r.usd), 0), 2) FROM v_agent_runs r WHERE r.day = b.day) AS usd_driven,
  ROUND(
    COALESCE((SELECT SUM(r.usd) FROM v_agent_runs r WHERE r.day = b.day), 0)
    / NULLIF((SELECT SUM(x.usd) FROM e_agent_bill x WHERE x.day = b.day), 0), 3
  ) AS drive_share
FROM base b`,
  },
];

/* ——— the questions this database exists to answer ———

   canned pairs of question → sql. `bun scripts/telemetry.ts examples`
   prints them, `--json` emits them as data. an agent that reads these
   plus the generated schema can write anything else it needs. when a
   brainstorm produces a new question worth tracking, it belongs here. */

export const EXAMPLES: { question: string; sql: string }[] = [
  {
    question: "how much am i using boxbox, from which device, over the last 30 days?",
    sql: `SELECT device_class, COUNT(*) AS visits, SUM(seconds)/60 AS minutes, ROUND(AVG(seconds)/60.0, 1) AS avg_visit_min
FROM v_stints
WHERE started_at > (strftime('%s','now') - 30*86400) * 1000
GROUP BY device_class
ORDER BY minutes DESC;`,
  },
  {
    question: "what time of day do i reach for it, and on what?",
    sql: `SELECT start_hour, device_class, COUNT(*) AS visits
FROM v_stints
GROUP BY start_hour, device_class
ORDER BY start_hour;`,
  },
  {
    question: "how fast do i serve each kind of need, and is the couch slower than the desk?",
    sql: `SELECT need, served_device_class,
       COUNT(*) AS served,
       ROUND(AVG(served_ms)/1000.0, 1) AS avg_s,
       ROUND(MIN(served_ms)/1000.0, 1) AS best_s,
       ROUND(MAX(served_ms)/1000.0, 1) AS worst_s
FROM v_needs
WHERE served_at IS NOT NULL
GROUP BY need, served_device_class
ORDER BY need, avg_s;`,
  },
  {
    question: "which needs does boxbox raise that i never deal with? (candidates for not being a need at all)",
    sql: `SELECT need,
       COUNT(*) AS raised,
       SUM(outcome = 'served') AS served,
       SUM(outcome = 'swept') AS swept,
       SUM(outcome IN ('agent', 'expired')) AS ignored,
       ROUND(100.0 * SUM(outcome IN ('agent', 'expired')) / COUNT(*), 1) AS pct_ignored
FROM v_needs
GROUP BY need
ORDER BY pct_ignored DESC;`,
  },
  {
    question: "what do i actually DO in boxbox? (verb mix, and what breaks)",
    sql: `SELECT name,
       COUNT(*) AS calls,
       SUM(ok = 0) AS failures,
       ROUND(AVG(ms)) AS avg_ms
FROM e_verb
GROUP BY name
ORDER BY calls DESC;`,
  },
  {
    question: "which surfaces are dead weight?",
    sql: `SELECT surface, SUM(views) AS views, SUM(deadends) AS deadends, MAX(last_view_at) AS last_seen
FROM v_surfaces
GROUP BY surface
ORDER BY views ASC;`,
  },
  {
    question: "where is the app fighting me this week?",
    sql: `SELECT sort, detail, COUNT(*) AS n, MAX(at) AS last_at
FROM v_friction
WHERE at > (strftime('%s','now') - 7*86400) * 1000
GROUP BY sort, detail
ORDER BY n DESC
LIMIT 20;`,
  },
  {
    question: "what does a turn cost me, by repo and model?",
    sql: `SELECT repo, model,
       COUNT(*) AS runs,
       ROUND(SUM(usd), 2) AS usd,
       ROUND(AVG(usd), 3) AS avg_usd,
       ROUND(AVG(elapsed_ms)/1000.0) AS avg_s
FROM v_agent_runs
GROUP BY repo, model
ORDER BY usd DESC;`,
  },
  {
    question: "how much of the fleet's spend does boxbox actually drive?",
    sql: `SELECT day, usd_total, usd_driven, drive_share FROM v_daily_fleet ORDER BY day DESC LIMIT 30;`,
  },
  {
    question: "is push worth it? (funnel by need kind)",
    sql: `SELECT need,
       COUNT(*) AS sent,
       SUM(tapped_at IS NOT NULL) AS tapped,
       ROUND(100.0 * SUM(tapped_at IS NOT NULL) / COUNT(*), 1) AS pct_tapped,
       ROUND(AVG(tap_ms)/1000.0) AS avg_tap_s
FROM v_push
GROUP BY need
ORDER BY sent DESC;`,
  },
  {
    question: "did last week's change move anything? (day over day spine)",
    sql: `SELECT day, device_class, visits, minutes, verbs, verb_failures, friction, needs_served, avg_serve_s
FROM v_daily
ORDER BY day DESC, device_class
LIMIT 40;`,
  },
  {
    question: "how bad is the stream on ios? (reconnect churn per device class)",
    sql: `SELECT device_class,
       SUM(state = 'reopen') AS reopens,
       SUM(state = 'error') AS errors,
       ROUND(AVG(downMs)/1000.0, 1) AS avg_down_s
FROM e_app_stream
GROUP BY device_class;`,
  },
];
