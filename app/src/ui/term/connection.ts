/* the pane's socket to the relay (docs/terminal.md). it dials with the
   wire's cursor, feeds every frame to the wire, sends heartbeats and
   input, finds a dead socket after 45 s of silence, and redials by what
   the close code means. the first dial replays everything retained; a
   redial passes the cursor (scars.md: the resume cursor only for dropped
   sockets). one per open pane; dispose() clears every timer and listener
   it set. */

import { deviceClass, deviceId } from "../../push/device";
import { Backoff } from "../../sync/backoff";
import type { Link } from "./types";
import { type Effect, HEARTBEAT, Wire } from "./wire";

/** the relay's close codes; 1000 is cmx2's own, passed through */
export const CLOSE = {
  exited: 1000,
  stopping: 1001,
  refused: 4401,
  gone: 4404,
  inputBackedUp: 4413,
  unreachable: 4502,
} as const;

const HEARTBEAT_MS = 15_000;
const SILENCE_MS = 45_000;
/** input goes out in frames of at most this many characters, so a big paste never meets the relay's 256 kb cap as one */
const INPUT_CHUNK = 8 * 1024;

export type Ended = { code: number; reason: string };

export type Listener = {
  effects(effects: Effect[]): void;
  link(state: Link, detail: string | null): void;
  ended(ended: Ended): void;
};

export class TermConnection {
  private socket: WebSocket | null = null;
  private readonly wire = new Wire();
  private readonly backoff = new Backoff(250, 10_000);
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private silence: ReturnType<typeof setTimeout> | undefined;
  private redial: ReturnType<typeof setTimeout> | undefined;
  private over = false;

  constructor(
    private readonly host: string,
    private readonly id: string,
    private readonly listener: Listener,
  ) {
    document.addEventListener("visibilitychange", this.onReturn);
    window.addEventListener("online", this.onReturn);
    this.dial();
  }

  /** where the painted output ends, in utf-16 units */
  get cursor(): number | null {
    return this.wire.cursor;
  }

  get open(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /** types into the terminal. nothing is kept for later while the socket is down: a keystroke sent late can answer a
      prompt it was never meant for */
  send(text: string): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.over) return false;
    for (let at = 0; at < text.length; at += INPUT_CHUNK) socket.send(text.slice(at, at + INPUT_CHUNK));
    return true;
  }

  dispose(): void {
    this.over = true;
    document.removeEventListener("visibilitychange", this.onReturn);
    window.removeEventListener("online", this.onReturn);
    clearTimeout(this.redial);
    this.stopTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      detach(socket);
      socket.close(1000, "the pane closed");
    }
  }

  private dial() {
    clearTimeout(this.redial);
    this.redial = undefined;
    if (this.over) return;
    const url = new URL(`/api/hosts/${encodeURIComponent(this.host)}/pty/${encodeURIComponent(this.id)}/connect`, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const cursor = this.wire.cursor;
    if (cursor !== null) url.searchParams.set("cursor", String(cursor));
    // the relay's telemetry rows name the device as every other surface does
    url.searchParams.set("device", deviceId());
    url.searchParams.set("class", deviceClass());
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      this.wire.opened();
      this.heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(new Uint8Array([HEARTBEAT]));
      }, HEARTBEAT_MS);
      this.armSilence(socket);
    };
    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      this.armSilence(socket);
      const effects = typeof event.data === "string" ? this.wire.text(event.data) : this.wire.binary(new Uint8Array(event.data));
      if (effects.length === 0) return;
      if (effects.some((e) => e.type === "live")) {
        this.backoff.reset();
        this.listener.link("live", null);
      }
      this.listener.effects(effects);
    };
    socket.onclose = (event: CloseEvent) => this.closed(socket, event.code, event.reason);
  }

  /** the socket has gone quiet for too long: it is dead even if the browser has not noticed */
  private armSilence(socket: WebSocket) {
    clearTimeout(this.silence);
    this.silence = setTimeout(() => {
      detach(socket);
      socket.close(4000, "silent for 45 s");
      this.closed(socket, 1006, `no bytes for ${SILENCE_MS / 1000} s`);
    }, SILENCE_MS);
  }

  private stopTimers() {
    clearInterval(this.heartbeat);
    clearTimeout(this.silence);
    this.heartbeat = undefined;
    this.silence = undefined;
  }

  private closed(socket: WebSocket, code: number, reason: string) {
    if (socket !== this.socket) return;
    this.socket = null;
    this.stopTimers();
    if (this.over) return;
    switch (code) {
      case CLOSE.exited:
      case CLOSE.gone:
      case CLOSE.refused:
        this.over = true;
        this.listener.ended({ code, reason });
        return;
      case CLOSE.inputBackedUp:
        this.listener.effects([{ type: "note", text: "the terminal stopped reading, so the last input was dropped" }]);
        this.dial();
        return;
      default:
        this.listener.link("down", code === CLOSE.unreachable ? reason : null);
        this.redial = setTimeout(() => this.dial(), this.backoff.nextDelay());
    }
  }

  /** back from the background or back online: a socket the platform killed is redialled now, not after the backoff */
  private onReturn = () => {
    if (document.visibilityState !== "visible" || this.over || this.socket) return;
    this.dial();
  };
}

function detach(socket: WebSocket) {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
}
