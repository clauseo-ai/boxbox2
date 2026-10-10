# changelog

all notable changes, newest first. versions follow semver. the release
workflow publishes the section whose heading matches the version in
`server/Cargo.toml`, so every release needs a `## <version>` heading here.

## unreleased

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
