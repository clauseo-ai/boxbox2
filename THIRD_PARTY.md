# third-party code, data and fonts

every dependency boxbox takes, what it is for, and its licence. a new one
lands here in the same change that adds it (AGENTS.md, dependencies).

## the rust server (`server/Cargo.toml`)

| crate | why | licence |
|---|---|---|
| aws-lc-rs (`aws-lc-sys` only) | the openclaw device identity: ed25519 key generation, pkcs#8 load and signing (`server/src/openclaw/identity.rs`, docs/openclaw.md 3.2). already in the tree as rustls' crypto provider, taken directly at the same version, so no second copy | ISC AND (Apache-2.0 OR ISC) |
| axum (with `ws`) | http routing, extractors, the server loop, the terminal websocket | MIT |
| bytes | shared byte buffers | MIT |
| data-encoding | base64 for the host credential on the pty websocket dial (already in the tree through tungstenite) | MIT |
| flate2 (rust backend), tar | `boxbox upgrade` reads a release tarball in-process, checked against `SHA256SUMS`, instead of shelling out to `tar`; pure rust (miniz_oxide), no xattr support compiled in | MIT OR Apache-2.0 |
| futures-util | stream combinators for the upstream reader | MIT OR Apache-2.0 |
| hmac, sha2 | the session cookie's signature | MIT OR Apache-2.0 |
| image (`png` and `webp` only; pulls in png, fdeflate, image-webp, quick-error, bytemuck, byteorder-lite and num-traits, MIT OR Apache-2.0 or looser, and moxcms and pxfm, BSD-3-Clause OR Apache-2.0) | decoding and encoding media thumbnails (`server/src/media/thumbs.rs`); the scaling itself is written there, since the pixel check picked chromium's own mip chain over every filter a crate offers (`docs/verification.md`, thumbnails). tests add `jpeg` (zune-jpeg, MIT OR Apache-2.0 OR Zlib) to measure jpeg | MIT OR Apache-2.0 |
| jiff | the local day a telemetry row belongs to | MIT OR Unlicense |
| rand | backoff jitter, the cookie secret, minted ids | MIT OR Apache-2.0 |
| reqwest (rustls, gzip) | requests to the cmx2 daemons, taking gzip and decoding it by `Content-Encoding` (the decompression it builds from tower-http and async-compression, already in the tree) | MIT OR Apache-2.0 |
| rpassword | `boxbox init` asks for passwords without echoing them | Apache-2.0 |
| rust-embed | the app inside the binary | MIT |
| rusqlite (bundled sqlite) | `boxbox.db`, on the store writer's thread; `boxbox doctor` reads it read-only | MIT (sqlite: public domain) |
| web-push-native | web push encryption (rfc 8291), transport-agnostic so it rides reqwest | MIT OR Apache-2.0 |
| p256 | the vapid key and its es256 signature (rfc 8292) | MIT OR Apache-2.0 |
| base64ct | base64url for push keys and the vapid token | MIT OR Apache-2.0 |
| rustls, rustls-platform-verifier | tls for `wss://` hosts, trusting what the system trusts (the versions reqwest already builds) | Apache-2.0 OR ISC OR MIT, MIT OR Apache-2.0 |
| serde, serde_json | every wire format | MIT OR Apache-2.0 |
| subtle | constant-time comparison | BSD-3-Clause |
| thiserror | typed errors | MIT OR Apache-2.0 |
| tokio, tokio-util | the async runtime, cancellation, the relays' task tracker | MIT |
| tokio-tungstenite | the relay's websocket to each host's pty (the version axum's `ws` uses, so one copy) | MIT |
| toml | `boxbox.toml` | MIT OR Apache-2.0 |
| tower-http (`compression-gzip` only; pulls in async-compression, compression-codecs and compression-core, MIT OR Apache-2.0, and zlib-rs, Zlib, pure rust) | gzip for the api's json answers, the transcript above all (`server/src/http/compress.rs`); the event stream and everything not json is left alone. already in the tree through reqwest | MIT |
| tracing, tracing-subscriber | structured logs | MIT |
| utoipa | boxbox's own openapi document | MIT OR Apache-2.0 |

build only (`build/`):

| crate | why | licence |
|---|---|---|
| typify, schemars | rust types from cmx2's openapi schemas and openclaw's vendored protocol schema | Apache-2.0, MIT |
| syn, quote, proc-macro2, prettyplease | generating and formatting that code | MIT OR Apache-2.0 |
| heck | naming generated types | MIT OR Apache-2.0 |

## the board daemon (`board/daemon/Cargo.toml`)

a separate binary, only on the macs the board is plugged into (docs/board.md);
linux builds only the first four. release builds compile `-p boxbox` alone.

| crate | why | licence |
|---|---|---|
| serde, serde_json | the board channel's frames and acts, telemetry | MIT OR Apache-2.0 |
| thiserror | typed errors | MIT OR Apache-2.0 |
| toml (parse only) | `board.toml` | MIT OR Apache-2.0 |
| async-hid (macos) | the keypad: macos's hid add and remove notifications on a dispatch queue (no polling), and a non-exclusive open split into a reader thread and the main loop's writer. hidapi offers no hotplug, and its device cannot be read on one thread while written on another | MIT |
| futures-lite (macos) | `block_on` for async-hid's futures on plain threads, so the daemon has no async runtime | Apache-2.0 OR MIT |
| cpal (macos) | the mic meter's input through coreaudio, opened only while talking | Apache-2.0 |
| ureq (macos, native-tls only) | the posts (acts, login, telemetry), pooled and blocking, on the system's tls. its full `native-tls` feature, since 3.4 compiles its tls connector only under it | MIT OR Apache-2.0 |
| webpki-root-certs (macos, through ureq's native-tls feature) | compiled in by that feature and unused: the daemon asks for the platform's roots | CDLA-Permissive-2.0 |
| native-tls (macos) | tls for the stream, through security framework: the system's roots and verifier, no tls stack compiled in (a 1.9 mib stripped binary) | MIT OR Apache-2.0 |
| signal-hook (macos, iterator only) | sigterm and sigint as a message to the main loop, so a stop posts the gone and darkens the board; a thread blocked on its pipe, nothing while idle, and no unsafe code in the daemon | MIT OR Apache-2.0 |
| if-addrs (macos) | this mac's addresses for the stream's `addrs` (decision 81) | MIT OR BSD-3-Clause |
| jiff (macos, system tz only) | the local hour for the night curve | MIT OR Unlicense |

## the app and the tooling (`package.json`, `app/package.json`)

| package | why | licence |
|---|---|---|
| solid-js | the ui (decision 15) | MIT |
| openapi-fetch | the typed client for boxbox's api | MIT |
| @xterm/xterm | the terminal emulator, loaded only when a terminal opens (docs/terminal.md) | MIT |
| @xterm/addon-fit | sizes the terminal's grid to its pane | MIT |
| marked | the agent's markdown (answers, reports, the compaction summary) | MIT |
| dompurify | sanitises that markdown's html before it is set (nothing from an agent runs in the app) | Apache-2.0 OR MPL-2.0 |
| highlight.js 11.12.0 (`highlight.js/lib/core` and 22 of its language files, no auto-detection, none of its themes) | syntax colours for fenced code in that markdown (`app/src/ui/thread/highlight-engine.ts`). a chunk of its own (about 28 kb compressed) fetched when a thread first shows a fence, so the first load stays inside its script budget | BSD-3-Clause |
| vite, vite-plugin-solid | dev server and build | MIT |
| @ladle/react, react, react-dom, @types/react, @types/react-dom, @vitejs/plugin-react | the thread's and home's stories (`app/.ladle`); ladle is react-only, so the solid components are mounted from react hosts. development only | MIT |
| @resvg/resvg-js | rasterises `app/public/icon.svg` into the home-screen icons (`scripts/icons.ts`), the same pixels on every machine; the pngs are committed, so the build never runs it. development only | MPL-2.0 |
| openapi-typescript | app types from both openapi documents | MIT |
| fake-indexeddb | a real indexeddb implementation in memory, so the worker's cache (`app/src/sync/cache.test.ts`) is tested against the api it uses, key ranges and transactions included, with no browser. development only | Apache-2.0 |
| typescript | the type checker | Apache-2.0 |
| playwright-core | drives webkit for `bench/window.ts` (agent-browser drives chrome only, and the scroll law has to hold where webkit has no scroll anchoring), and attaches to agent-browser's chrome over cdp so both engines run the same checks; the core alone, no test runner and no bundled browsers (webkit comes from `bunx playwright-core install webkit`). development only | Apache-2.0 |
| @types/bun, @types/node | types for scripts and the board | MIT |

## fonts (`app/src/fonts/`)

| font | from | licence |
|---|---|---|
| Boxbox Sans | Mona Sans 2.0.27 (github), subset to latin, optical size pinned, renamed because "Mona" is a reserved font name (`scripts/fonts.sh`) | SIL OFL 1.1, `OFL-mona-sans.txt` |
| Martian Mono | Martian Mono 1.1.0 (evil martians), subset to latin | SIL OFL 1.1, `OFL-martian-mono.txt` |
| Lexend | Lexend 1.007 (google fonts), subset to latin, weight 300 to 800; keeps its name, as the reserved font name is "RevReading Lexend" (`scripts/fonts.sh`) | SIL OFL 1.1, `OFL-lexend.txt` |

## provider marks (`app/src/ui/composer/marks-data.ts`)

the composer's model menu shows each provider's mark. the svg paths are copied as data into `marks-data.ts` (no package is installed), written into `index.html` by the build as one inline svg sprite and drawn in one flat colour. a provider with no mark gets a monogram. the brand marks remain their owners' trademarks and are used only to identify the provider whose model a row is.

| from | version | marks | licence |
|---|---|---|---|
| simple-icons (`icons/<slug>.svg`) | 16.33.0 | anthropic, gemini, google, mistral, meta, deepseek, openrouter, ollama, perplexity, huggingface, lmstudio, moonshot, qwen, nvidia, cloudflare, copilot, vercel | CC0-1.0 |
| @lobehub/icons-static-svg (`icons/<slug>.svg`) | 1.95.1 | openai, xai, groq, cohere, together, fireworks, cerebras, azure | MIT (copyright 2023 LobeHub), the whole notice in `app/src/ui/composer/MIT-lobehub-icons.txt`, which sits beside the paths it covers |

## vendored and carried files

| path | from | licence |
|---|---|---|
| `vendor/cmx2/openapi.json`, `vendor/cmx2/manifest.ts` | cmx2 at the commit in `cmx2.pin`, byte for byte | MIT |
| `vendor/openclaw/protocol.schema.json` | the published `@openclaw/gateway-protocol` npm tarball at the version in `openclaw.pin`, byte for byte (its sha512 is the pin's `schema`) | MIT (OpenClaw Foundation) |
| `server/tests/fixtures/openclaw/*.json` | recorded from the openclaw dev gateway (`bench/openclaw-record.ts`), scrubbed of machine names | MIT, as this repo |
| `board/`, `telemetry/schema.ts`, `telemetry/db.ts`, `telemetry/views.ts`, `scripts/telemetry.ts` | boxbox v1 at `18df8bd`, by the same author, carried under this repo's licence | MIT |

## dev tools run from source, never shipped

| what | how | licence |
|---|---|---|
| openclaw at the commit in `openclaw.pin` | `just openclaw` fetches it into `~/.cache/boxbox/openclaw.git`, exports it into the gitignored `.openclaw/<commit>/` and builds it with its own pnpm; its `scripts/e2e/mock-openai-server.mjs` is the scripted model. nothing of it is committed or embedded | MIT (OpenClaw Foundation) |
| corepack 0.36.0 | runs the tree's pinned pnpm through `npx` (node 25 and later ship none) | MIT |
