/* the boxbox client: one origin, one cookie, the same wire the browser
   drives. login mints a bb_session cookie valid 180 days with no server
   table, so it persists to disk and survives daemon restarts; a 401
   anywhere means re-login once and retry (docs/scope-board.md §2).

   telemetry rides POST /api/telemetry with deviceClass "board" and NO ua
   — that is the explicit-class path C2 built. every serving keypress
   emits TWO events (board.key + the generic verb) or the bet is
   unmeasurable — §10's rule, enforced in controller.ts, transported here. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BoardSeatMap } from "../../lib/board/contract";
import { createSSEParser } from "../../lib/fleet/sse";
import type { BrainEvent } from "../../lib/server/brain";
import type { Logger } from "./log";

export type ClientConfig = {
  origin: string;
  password: string;
  stateDir: string;
};

type PersistedState = { cookie?: string; deviceId?: string };

const FLUSH_MS = 5000;
const FLUSH_AT = 40;
/** the origin heartbeats every 25s (app/api/stream/route.ts). a stream
    that is silent for 3.6 heartbeats is not idle, it is dead — a tcp
    connection that survives a laptop sleep stays ESTABLISHED forever
    while delivering nothing (the 21-hour zombie of 2026-07-27). */
const STREAM_IDLE_MS = 90_000;

type QueuedEvent = {
  id: string;
  at: number;
  kind: string;
  host?: string;
  session?: string;
  ok?: number;
  ms?: number;
  props?: Record<string, unknown>;
};

function nano(size = 12): string {
  const alphabet = "useandom26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
  let id = "";
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  for (let i = 0; i < size; i++) id += alphabet[bytes[i] & 63];
  return id;
}

export class BoxboxClient {
  private cookie: string | null = null;
  private deviceId: string;
  private telemetry: QueuedEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private focusUnsupported = false;
  private composeUnsupported = false;
  private promptAsyncUnsupported = false;
  private seatsUnsupported = false;

  constructor(
    private cfg: ClientConfig,
    private log: Logger,
  ) {
    mkdirSync(cfg.stateDir, { recursive: true });
    const persisted = this.loadState();
    this.cookie = persisted.cookie ?? null;
    this.deviceId = persisted.deviceId ?? `board-${nano(8)}`;
    if (!persisted.deviceId) this.saveState();
  }

  device(): string {
    return this.deviceId;
  }

  private stateFile(): string {
    return join(this.cfg.stateDir, "state.json");
  }

  private loadState(): PersistedState {
    try {
      if (existsSync(this.stateFile())) {
        return JSON.parse(readFileSync(this.stateFile(), "utf8")) as PersistedState;
      }
    } catch {
      /* a corrupt state file costs a login, never the process */
    }
    return {};
  }

  private saveState() {
    try {
      const tmp = `${this.stateFile()}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ cookie: this.cookie ?? undefined, deviceId: this.deviceId }, null, 2),
      );
      renameSync(tmp, this.stateFile());
    } catch (e) {
      this.log.warn("client.state_write_failed", { message: String(e) });
    }
  }

  /* ——— auth ——— */

  private async login(): Promise<boolean> {
    try {
      const res = await fetch(`${this.cfg.origin}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: this.cfg.password }),
      });
      if (!res.ok) {
        this.log.error("client.login_rejected", { status: res.status });
        return false;
      }
      const setCookie = res.headers.get("set-cookie") ?? "";
      const match = setCookie.match(/bb_session=([^;]+)/);
      if (!match) {
        this.log.error("client.login_no_cookie", {});
        return false;
      }
      this.cookie = match[1];
      this.saveState();
      this.log.info("client.logged_in", {});
      return true;
    } catch (e) {
      this.log.warn("client.login_failed", { message: String(e) });
      return false;
    }
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.cookie) h.cookie = `bb_session=${this.cookie}`;
    if (json) h["content-type"] = "application/json";
    return h;
  }

  /** fetch with one automatic re-login on 401 */
  private async call(path: string, init?: RequestInit): Promise<Response | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.cookie && !(await this.login())) return null;
      try {
        const res = await fetch(`${this.cfg.origin}${path}`, {
          ...init,
          headers: { ...this.headers(init?.body !== undefined), ...init?.headers },
        });
        if (res.status === 401) {
          this.cookie = null;
          continue;
        }
        return res;
      } catch (e) {
        this.log.warn("client.fetch_failed", { path, message: String(e) });
        return null;
      }
    }
    return null;
  }

  /* ——— the stream ——— */

  /** consume /api/stream forever, feeding brain events out. reconnects
      with capped backoff; every reconnect brings a fresh snapshot, which
      is the whole resync contract. an idle watchdog aborts the read when
      the server heartbeat goes missing — comment frames count as life at
      the byte level even though the parser never surfaces them. */
  async stream(onEvent: (e: BrainEvent) => void, onSnapshot: () => void) {
    let attempt = 0;
    while (!this.stopped) {
      const ctl = new AbortController();
      let lastByteAt = Date.now();
      const idle = setInterval(() => {
        if (Date.now() - lastByteAt >= STREAM_IDLE_MS) {
          this.log.warn("client.stream_stalled", { idleMs: Date.now() - lastByteAt });
          ctl.abort();
        }
      }, 15_000);
      idle.unref?.();
      try {
        const res = await this.call("/api/stream", { signal: ctl.signal });
        if (res?.ok && res.body) {
          attempt = 0;
          this.log.info("client.stream_open", {});
          const parser = createSSEParser();
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              lastByteAt = Date.now();
              for (const evt of parser.feed(decoder.decode(value, { stream: true }))) {
                try {
                  const parsed = JSON.parse(evt.data) as BrainEvent;
                  onEvent(parsed);
                  if (parsed.kind === "snapshot") onSnapshot();
                } catch {
                  /* a torn frame is the stream's problem, not ours */
                }
              }
            }
          } catch (e) {
            this.log.warn("client.stream_broke", { message: String(e) });
          }
          this.log.info("client.stream_closed", {});
        }
      } finally {
        clearInterval(idle);
      }
      const delay = Math.min(500 * 2 ** Math.min(attempt, 6), 30_000) + Math.random() * 500;
      attempt += 1;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  stop() {
    this.stopped = true;
    void this.flushTelemetry();
  }

  /* ——— REST reconcile ——— */

  /** the union: the default instance's project PLUS every proven-live
      directory's project. `scope=project&roots=true` is PROJECT-wide,
      not host-wide (GOTCHAS), so the bare call alone leaves every
      session outside the default project invisible — busy on the wire,
      absent from the board. proven-live dirs never spawn an instance,
      which is the whole reason the widener is safe. */
  async refreshSessions(host: string, directories: string[] = []): Promise<unknown[]> {
    const path = "session?scope=project&roots=true&limit=1000";
    const scopes: (string | undefined)[] = [undefined, ...new Set(directories)];
    const results = await Promise.allSettled(
      scopes.map((directory) =>
        this.call(
          `/api/hosts/${host}/proxy/${path}`,
          directory ? { headers: { "x-opencode-directory": directory } } : undefined,
        ).then(async (res) => (res?.ok ? ((await res.json()) as unknown[]) : [])),
      ),
    );
    /* union by id: a failed scope contributes nothing, never deletes */
    const byId = new Map<string, unknown>();
    for (const r of results) {
      if (r.status !== "fulfilled" || !Array.isArray(r.value)) continue;
      for (const row of r.value) {
        const id = (row as { id?: string }).id;
        if (id) byId.set(id, row);
      }
    }
    return [...byId.values()];
  }

  /** one session row by id. unscoped on purpose — a by-id GET never
      spawns an instance, which is why it is the safe way to learn a
      session the project-scoped list never returned (and, critically,
      its parentID: a subagent must not take a seat). */
  async fetchSession(host: string, sessionID: string): Promise<unknown | null> {
    const res = await this.call(`/api/hosts/${host}/proxy/session/${sessionID}`);
    if (!res?.ok) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  async spendToday(): Promise<number> {
    const res = await this.call("/api/spend");
    if (!res?.ok) return 0;
    try {
      const data = (await res.json()) as { totalUsd?: number };
      return typeof data.totalUsd === "number" ? data.totalUsd : 0;
    } catch {
      return 0;
    }
  }

  /* ——— verbs. the reply is not the truth: the authoritative clear is
     the pending list dropping the id over the stream. callers keep keys
     lit until then. ——— */

  async replyPermission(
    host: string,
    id: string,
    reply: "once" | "always" | "reject",
    directory?: string,
  ): Promise<boolean> {
    const res = await this.call(`/api/hosts/${host}/proxy/permission/${id}/reply`, {
      method: "POST",
      headers: directory ? { "x-opencode-directory": directory } : {},
      body: JSON.stringify({ reply }),
    });
    return res?.ok ?? false;
  }

  async replyQuestion(
    host: string,
    id: string,
    answers: string[][],
    directory?: string,
  ): Promise<boolean> {
    const res = await this.call(`/api/hosts/${host}/proxy/question/${id}/reply`, {
      method: "POST",
      headers: directory ? { "x-opencode-directory": directory } : {},
      body: JSON.stringify({ answers }),
    });
    return res?.ok ?? false;
  }

  async markRead(sessionKey: string, at: number): Promise<boolean> {
    const res = await this.call("/api/read", {
      method: "POST",
      body: JSON.stringify({
        device: this.deviceId,
        marks: [{ session: sessionKey, at }],
      }),
    });
    return res?.ok ?? false;
  }

  /** the focus channel (C4). until it lands, a 404 downgrades this to a
      logged intent — once, not per-press. */
  async focus(sessionKey: string): Promise<boolean> {
    if (this.focusUnsupported) {
      this.log.info("client.focus_intent", { session: sessionKey });
      return false;
    }
    const res = await this.call("/api/board/focus", {
      method: "POST",
      body: JSON.stringify({ session: sessionKey }),
    });
    if (res?.status === 404) {
      this.focusUnsupported = true;
      this.log.warn("client.focus_unsupported", { note: "C4 not deployed yet" });
      return false;
    }
    return res?.ok ?? false;
  }

  /** the machines row's verb: open the compose sheet on the glass with
      this machine picked. same transient channel family as focus, same
      404 downgrade until the origin carries the route. */
  async composeMachine(machineId: string): Promise<boolean> {
    if (this.composeUnsupported) {
      this.log.info("client.compose_intent", { machine: machineId });
      return false;
    }
    const res = await this.call("/api/board/compose", {
      method: "POST",
      body: JSON.stringify({ machine: machineId }),
    });
    if (res?.status === 404) {
      this.composeUnsupported = true;
      this.log.warn("client.compose_unsupported", { note: "origin predates the compose channel" });
      return false;
    }
    return res?.ok ?? false;
  }

  /** queue a prompt without blocking the turn (C5's whitelist line).
      until it lands, a 403 downgrades to a logged intent. */
  async promptAsync(
    host: string,
    sessionID: string,
    text: string,
    directory?: string,
    model?: { providerID: string; modelID: string },
    variant?: string,
  ): Promise<boolean> {
    if (this.promptAsyncUnsupported) {
      this.log.info("client.prompt_intent", { session: `${host}:${sessionID}` });
      return false;
    }
    const res = await this.call(`/api/hosts/${host}/proxy/session/${sessionID}/prompt_async`, {
      method: "POST",
      headers: directory ? { "x-opencode-directory": directory } : {},
      body: JSON.stringify({
        parts: [{ type: "text", text }],
        ...(model ? { model } : {}),
        ...(variant ? { variant } : {}),
      }),
    });
    if (res?.status === 403) {
      this.promptAsyncUnsupported = true;
      this.log.warn("client.prompt_async_unsupported", { note: "C5 not deployed yet" });
      return false;
    }
    return res?.ok ?? false;
  }

  /** the pairing ritual, daemon half: write the binding the arm asked
      for. the bindings event echoing over the stream is the confirmation
      every surface (and this daemon's liveries) reacts to. */
  async postBinding(wire: number, agent: string | null, color?: string): Promise<boolean> {
    const res = await this.call("/api/board/bindings", {
      method: "POST",
      body: JSON.stringify({
        device: this.deviceId,
        binds: [{ wire, agent, ...(color ? { color } : {}) }],
      }),
    });
    return res?.ok ?? false;
  }

  /** the virtual twin's feed: the frame just rendered, palette as hex.
      throttling is the render loop's job; this just ships it. */
  async postFrame(cells: readonly number[], palette: readonly string[]): Promise<boolean> {
    const res = await this.call("/api/board/frame", {
      method: "POST",
      body: JSON.stringify({ cells, palette }),
    });
    return res?.ok ?? false;
  }

  /** the seat map: who sits on which digit, for the glass's key badges.
      change-driven with a slow heartbeat (render loop's job); a 404
      downgrades once, same law as focus. */
  async postSeats(map: BoardSeatMap): Promise<boolean> {
    if (this.seatsUnsupported) return false;
    const res = await this.call("/api/board/seats", {
      method: "POST",
      body: JSON.stringify(map),
    });
    if (res?.status === 404) {
      this.seatsUnsupported = true;
      this.log.warn("client.seats_unsupported", { note: "origin predates the seat map channel" });
      return false;
    }
    return res?.ok ?? false;
  }

  /** box box, box box: kill the lap, run the queued orders — the same
      abort-then-loop the glass's flush fires (lib/store/fleet.tsx
      flushQueued, the tui's ctrl+x enter). loop is a LOOP VERB: it
      rides x-opencode-directory or it lands on the default instance
      (the dual-lap scar), so the session's home travels when known. */
  async flushQueue(host: string, sessionID: string, directory?: string): Promise<boolean> {
    const headers: Record<string, string> = directory ? { "x-opencode-directory": directory } : {};
    await this.call(`/api/hosts/${host}/proxy/session/${sessionID}/abort`, {
      method: "POST",
      headers,
    });
    const res = await this.call(`/api/hosts/${host}/proxy/session/${sessionID}/loop`, {
      method: "POST",
      headers,
    });
    return res?.ok ?? false;
  }

  /* ——— telemetry ——— */

  emit(
    kind: string,
    props: Record<string, unknown>,
    envelope: { host?: string; session?: string; ok?: boolean; ms?: number } = {},
  ) {
    this.telemetry.push({
      id: nano(),
      at: Date.now(),
      kind,
      props,
      ...(envelope.host ? { host: envelope.host } : {}),
      ...(envelope.session ? { session: envelope.session } : {}),
      ...(envelope.ok !== undefined ? { ok: envelope.ok ? 1 : 0 } : {}),
      ...(envelope.ms !== undefined ? { ms: envelope.ms } : {}),
    });
    if (this.telemetry.length >= FLUSH_AT) {
      void this.flushTelemetry();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flushTelemetry(), FLUSH_MS);
      this.flushTimer.unref?.();
    }
  }

  async flushTelemetry() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.telemetry.length === 0) return;
    const batch = this.telemetry.splice(0, this.telemetry.length);
    const res = await this.call("/api/telemetry", {
      method: "POST",
      body: JSON.stringify({
        device: this.deviceId,
        deviceClass: "board",
        events: batch,
      }),
    });
    if (!res?.ok) {
      /* put the batch back, capped — a dead origin must not eat ram */
      this.telemetry = [...batch, ...this.telemetry].slice(-400);
    }
  }
}
