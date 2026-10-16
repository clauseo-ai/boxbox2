/* a raw gateway client for the bench: one websocket, request/response by
   id, every event handed to listeners. the smoke (bench/openclaw-smoke.ts),
   the chaos client (bench/openclaw-chaos.ts), the fixture recorder and
   `just openclaw`'s readiness wait all use it. boxbox's server has its own
   client in rust; this one exists so the bench can drive and observe the
   dev gateway (docs/openclaw.md, 11.7: the chaos client may call anything).

   frames (packages/gateway-protocol): {type: "req", id, method, params},
   {type: "res", id, ok, payload?, error?}, {type: "event", event, seq?, payload?}. */

import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface EventFrame {
  type: "event";
  event: string;
  seq?: number;
  payload?: Json;
}

export interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: Json;
  error?: Json;
}

export class GatewayError extends Error {
  constructor(
    readonly method: string,
    readonly error: Json | undefined,
  ) {
    super(`${method} failed: ${JSON.stringify(error)}`);
  }
}

export interface ConnectOptions {
  url: string;
  token: string;
  /** `gateway-client`/`backend` is what loopback admits without a device (handshake-auth-helpers.ts:222-244) */
  clientId?: string;
  mode?: string;
  scopes?: string[];
  caps?: string[];
  protocol: number;
  /** every raw text frame, in arrival order, for the fixture recorder */
  onRaw?: (text: string) => void;
  /** connect as a paired device: the connect waits for connect.challenge and signs the v3 payload */
  device?: Device;
}

/** an ed25519 device identity: id is the sha256 of the raw public key, hex (src/infra/device-identity.ts) */
export interface Device {
  id: string;
  publicKey: string;
  privateKey: KeyObject;
}

export function newDevice(): Device {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { id: createHash("sha256").update(raw).digest("hex"), publicKey: raw.toString("base64url"), privateKey };
}

export const OPERATOR_SCOPES = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.questions"];

export class GatewayClient {
  private readonly socket: WebSocket;
  private readonly pending = new Map<string, { resolve: (frame: ResponseFrame) => void; reject: (error: Error) => void; timer: Timer }>();
  private readonly listeners = new Set<(event: EventFrame) => void>();
  private serial = 0;
  closed: { code: number; reason: string } | null = null;
  /** every event since connect, capped at 5000 (the oldest are dropped): the smoke and recorder look back through it */
  readonly events: EventFrame[] = [];
  hello: JsonObject | null = null;

  private constructor(socket: WebSocket, onRaw?: (text: string) => void) {
    this.socket = socket;
    socket.addEventListener("message", (message) => {
      const text = typeof message.data === "string" ? message.data : new TextDecoder().decode(message.data as ArrayBuffer);
      onRaw?.(text);
      let frame: { type?: string } & Record<string, unknown>;
      try {
        frame = JSON.parse(text) as { type?: string } & Record<string, unknown>;
      } catch {
        return;
      }
      if (frame.type === "res") {
        const res = frame as unknown as ResponseFrame;
        const waiter = this.pending.get(res.id);
        if (waiter) {
          this.pending.delete(res.id);
          clearTimeout(waiter.timer);
          waiter.resolve(res);
        }
      } else if (frame.type === "event") {
        const event = frame as unknown as EventFrame;
        this.events.push(event);
        if (this.events.length > 5000) this.events.shift();
        for (const listener of this.listeners) listener(event);
      }
    });
    socket.addEventListener("close", (event) => {
      this.closed = { code: event.code, reason: event.reason };
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`the gateway closed the socket (${event.code} ${event.reason})`));
      }
      this.pending.clear();
    });
  }

  static async connect(options: ConnectOptions): Promise<GatewayClient> {
    const socket = new WebSocket(options.url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no websocket open from ${options.url} in 8 s`)), 8000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`cannot open ${options.url}`));
      });
    });
    const client = new GatewayClient(socket, options.onRaw);
    const clientId = options.clientId ?? "gateway-client";
    const mode = options.mode ?? "backend";
    const scopes = options.scopes ?? OPERATOR_SCOPES;
    let device: JsonObject | undefined;
    if (options.device) {
      const challenge = await client.waitFor((e) => e.event === "connect.challenge", 5000, "connect.challenge");
      const nonce = String(field(challenge.payload, "nonce"));
      const signedAt = Number(field(challenge.payload, "ts"));
      /* packages/gateway-client/src/device-auth.ts buildDeviceAuthPayloadV3; platform and family lowercased */
      const payload = ["v3", options.device.id, clientId, mode, "operator", scopes.join(","), String(signedAt), options.token, nonce, process.platform.toLowerCase(), ""].join("|");
      device = {
        id: options.device.id,
        publicKey: options.device.publicKey,
        signature: sign(null, Buffer.from(payload), options.device.privateKey).toString("base64url"),
        signedAt,
        nonce,
      };
    }
    const params: JsonObject = {
      minProtocol: options.protocol,
      maxProtocol: options.protocol,
      client: { id: clientId, displayName: "boxbox bench", version: "bench", platform: process.platform, mode },
      role: "operator",
      scopes,
      ...(device ? { device } : {}),
      caps: options.caps ?? ["approvals", "tool-events", "chat-only-assistant-text"],
      auth: { token: options.token },
    };
    client.hello = (await client.request("connect", params)) as JsonObject;
    return client;
  }

  /** the payload of an ok response; a refusal throws GatewayError with the gateway's error object */
  async request(method: string, params: Json = {}, timeoutMs = 15_000): Promise<Json> {
    const res = await this.raw(method, params, timeoutMs);
    if (!res.ok) throw new GatewayError(method, res.error);
    return res.payload ?? null;
  }

  /** the whole response frame, refusals included */
  raw(method: string, params: Json = {}, timeoutMs = 15_000): Promise<ResponseFrame> {
    if (this.closed) return Promise.reject(new Error(`the socket is closed (${this.closed.code})`));
    const id = `bench-${++this.serial}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer to ${method} in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  on(listener: (event: EventFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** the first event (already seen since `since`, or still to come) that matches, or a timeout error */
  waitFor(match: (event: EventFrame) => boolean, timeoutMs: number, what: string, since = 0): Promise<EventFrame> {
    const seen = this.events.slice(since).find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`no ${what} within ${timeoutMs} ms`));
      }, timeoutMs);
      const off = this.on((event) => {
        if (match(event)) {
          clearTimeout(timer);
          off();
          resolve(event);
        }
      });
    });
  }

  close() {
    this.socket.close();
  }
}

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** a field of an object, or undefined */
export function field(value: Json | undefined, ...path: string[]): Json | undefined {
  let at: Json | undefined = value;
  for (const key of path) {
    if (!isObject(at)) return undefined;
    at = at[key];
  }
  return at;
}
