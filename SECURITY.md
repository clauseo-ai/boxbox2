# security

report vulnerabilities privately through GitHub's private vulnerability
reporting: open the repository's Security tab and choose "report a
vulnerability". do not open a public issue for one. the maintainer must
keep private vulnerability reporting enabled in the repository settings
(Settings, Code security, Private vulnerability reporting) for this to work.

## what boxbox guarantees today

- **one password gates everything but sign-in.** it is exchanged at
  `POST /api/login` for an http-only, `SameSite=Lax` cookie signed with
  hmac-sha256 under a random secret the server creates in its data dir
  (mode 0600) on first start. sessions last 180 days. deleting the secret
  signs every device out.
- **a wrong password is answered after a flat 600 ms**, however wrong it
  was, and the password is compared by mac in constant time.
- **host credentials never reach a browser.** each daemon's credential lives
  in `boxbox.toml` for hosts in the config, and in `boxbox.db` for hosts
  paired from the app. the server refuses to read the config unless only its
  owner can, and uses the credential only on its own requests to the daemon.
- **bodies are capped.** requests are limited to 64 kb, a telemetry batch to
  1 mb and 500 events, and every upstream frame to 4 mb.
- **boxbox binds `127.0.0.1` by default.** it is meant to sit behind an
  https front on a private network (`docs/deploy.md`). the password is a
  second layer, and the network is the perimeter.

## what it does not guarantee

boxbox has one user per install. there are no accounts, roles or audit
logs. anyone who holds the gate password can read every thread on every
paired daemon and run commands through them, so treat it like an ssh key.
