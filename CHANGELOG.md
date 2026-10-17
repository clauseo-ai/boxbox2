# changelog

all notable changes, newest first. versions follow semver. the release
workflow publishes the section whose heading matches the version in
`server/Cargo.toml`, so every release needs a `## <version>` heading here.

## unreleased

- **what each machine is, and how it is doing.** the agents screen's machine
  card shows the os (a drawn mark), the machine's model and os version, cpu
  load, memory and disk as meters, and the host's uptime beside the daemon's.
  the cmx2 pin moves from 0bf2ba2 (the pre-public line) to 05e029c (cmx2
  0.8.14 on its public line, the first with `GET /global/system`; the
  vendored files are those of abfde5b, where the move was made, byte for byte). what changed in the
  contract, all additive, contract 7 still: the new route `GET /global/system`
  (`SystemResponse`: os, machine, cpu with its three load averages, memory,
  the data volume's disk or null, host uptime, the daemon's rss and uptime);
  `waiting` on a busy session status (why a turn has not started: a directory
  that does not answer); `cold` on `session.compacted` (required there; boxbox
  reads it as optional so a 0.8.8 daemon's compactions still decode, see
  `docs/gotchas.md`) and `refresh` on `compaction.prefire`. the server samples
  the route every 30 s while a host
  is connected and carries it on `GET /api/hosts` as `system`, with
  `reportsSystem` false for an older cmx2, whose card shows what it can
  without meters.

- **the openclaw dev gateway.** `openclaw.pin` pins openclaw e178c39 (2026.10.1,
  protocol 4), `vendor/openclaw/protocol.schema.json` is vendored from the
  published `@openclaw/gateway-protocol@2026.10.1` and held by `just check`,
  and `just openclaw` builds the pinned gateway and runs it with a scripted
  model (docs/openclaw.md, section 11). recorded wire fixtures live in
  `server/tests/fixtures/openclaw/`.

- **images in read rows.** a tool call that read images opens to thumbnails,
  and a thumbnail opens the image full size. the cmx2 pin moves from 2364633
  to 0bf2ba2, which adds `attachments` and `attachmentsDropped` to a completed
  tool state (additive: at most 8 images and 4 mb of data urls a part). the
  server's upstream frame cap goes from 4 mb to 8 mb so such a part is not
  skipped.

## 0.1.0

first version. it is a pre-release: everything below is built and tested, and
`docs/open.md` lists the known problems.

- **server.** one rust binary that watches every cmx2 daemon, builds one model
  of the fleet and serves it to devices over a resumable event stream with a
  cursor at every hop. it gates itself with a password and a signed cookie,
  keeps read state and push subscriptions in sqlite, and relays terminals.
- **web app.** a home-screen app with one live window per thread, a thread
  view with a row for each step, a composer that sends, queues and steers, an
  inbox for questions and permissions, a machines screen with pairing and
  terminals, light and dark themes, and a code review card.
- **push.** web push notifications for asks, faults and finished turns. boxbox
  stays quiet while you are looking at the thread on any device.
- **board.** support for the 17-key usb board, with its daemon ported to the
  boxbox api and a replay harness that holds its behaviour to recorded sessions.
- **install and operate.** `boxbox init`, `doctor`, `service` and `upgrade`,
  a linux release for x86_64 and aarch64 with `install.sh` and checksums, a
  launchd agent for macos, and a systemd user unit.
- **telemetry.** a documented event dictionary, an append-only log per day and
  a query tool.
- **cmx2 pin.** built against the commit in cmx2.pin (cmx2 0.8.8, contract 7).
  the vendored contract files are checked against the pin on every
  `just check`.
