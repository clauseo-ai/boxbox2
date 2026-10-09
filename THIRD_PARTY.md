# third-party code, data and fonts

every dependency boxbox takes, what it is for, and its licence. a new one
lands here in the same change that adds it (AGENTS.md, rule 15).

## the rust server (`server/Cargo.toml`)

| crate | why | licence |
|---|---|---|
| axum (with `ws`) | http routing, extractors, the server loop, the terminal websocket | MIT |
| bytes | shared byte buffers | MIT |
| data-encoding | base64 for the host credential on the pty websocket dial (already in the tree through tungstenite) | MIT |
| flate2 (rust backend), tar | `boxbox upgrade` reads a release tarball in-process, checked against `SHA256SUMS`, instead of shelling out to `tar`; pure rust (miniz_oxide), no xattr support compiled in | MIT OR Apache-2.0 |
| futures-util | stream combinators for the upstream reader | MIT OR Apache-2.0 |
| hmac, sha2 | the session cookie's signature | MIT OR Apache-2.0 |
| jiff | the local day a telemetry row belongs to | MIT OR Unlicense |
| rand | backoff jitter, the cookie secret, minted ids | MIT OR Apache-2.0 |
| reqwest (rustls) | requests to the cmx2 daemons | MIT OR Apache-2.0 |
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
| typify, schemars | rust types from cmx2's openapi schemas | Apache-2.0, MIT |
| syn, quote, proc-macro2, prettyplease | generating and formatting that code | MIT OR Apache-2.0 |
| heck | naming generated types | MIT OR Apache-2.0 |

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

the board daemon keeps its own lockfile (`board/daemon/bun.lock`, from v1):

| package | why | licence |
|---|---|---|
| node-hid | talks to the board over usb hid | MIT OR X11 |

## fonts (`app/src/fonts/`)

| font | from | licence |
|---|---|---|
| Boxbox Sans | Mona Sans 2.0.27 (github), subset to latin, optical size pinned, renamed because "Mona" is a reserved font name (`scripts/fonts.sh`) | SIL OFL 1.1, `OFL-mona-sans.txt` |
| Martian Mono | Martian Mono 1.1.0 (evil martians), subset to latin | SIL OFL 1.1, `OFL-martian-mono.txt` |

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
| `board/`, `telemetry/schema.ts`, `telemetry/db.ts`, `telemetry/views.ts`, `scripts/telemetry.ts` | boxbox v1 at `18df8bd`, by the same author, carried under this repo's licence | MIT |
