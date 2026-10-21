/* notifications against a browser that is only a stub: a service worker container that counts its registrations, a push
   manager that keeps one subscription, a server that keeps its device list, and a clock that the tests move. the page's
   one registration (the first test) and the launch's check (the rest) are what these pin (push/notifications.ts,
   push/saved.ts, shell/worker.ts). the worker's registration is memoized for the page, so the stub lives for the whole
   file, and the first test to ask for the registration is the one that counts it. */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { api, type PushKind } from "../api/client";
import { registerServiceWorker } from "../shell/worker";
import { state } from "../store";
import { startNotifications, turnOnNotifications } from "./notifications";
import { CHECK_EVERY_MS } from "./saved";

/** a p-256 public key as the server sends it (base64url, 65 bytes) */
const PUBLIC_KEY = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ps1XbjhazAkj7I99e8QcYP7DkM";
const ALL: PushKind[] = ["ask", "done", "fault", "ready"];

type Subscription = { endpoint: string; keys: { p256dh: string; auth: string } };
type Listed = { device: string; deviceClass: string; kinds: PushKind[]; since: number };

/** what the browser holds for this page: one subscription at a time */
const page = {
  registers: 0,
  subscription: null as Subscription | null,
  subscribes: 0,
  permission: "granted" as "granted" | "default" | "denied",
};
/** what the server holds: its key, the devices it lists, and what each call was asked */
const server = {
  devices: [] as Listed[],
  gets: 0,
  posts: [] as { device: string; endpoint: string; kinds?: PushKind[] }[],
  down: false,
};
/** the clock the tests move, in place of Date.now */
let clock = 1_790_000_000_000;

const registration = {
  pushManager: {
    getSubscription: async () => {
      const held = page.subscription;
      if (!held) return null;
      return { ...held, options: { applicationServerKey: Buffer.from(PUBLIC_KEY, "base64url") }, toJSON: () => held, unsubscribe: async () => true };
    },
    subscribe: async () => {
      page.subscribes++;
      page.subscription = { endpoint: `https://push.example/${page.subscribes}`, keys: { p256dh: "p256dh-key", auth: "auth-key" } };
      const held = page.subscription;
      return { ...held, options: { applicationServerKey: null }, toJSON: () => held, unsubscribe: async () => true };
    },
  },
};

const GLOBALS = ["navigator", "window", "Notification", "localStorage", "Date"] as const;
const originals = new Map<string, PropertyDescriptor | undefined>();
const realNow = Date.now;
const store = new Map<string, string>();

function install(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeAll(() => {
  for (const name of GLOBALS) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  const notification = { requestPermission: async () => "granted" as const };
  Object.defineProperty(notification, "permission", { get: () => page.permission, enumerable: true });
  install("navigator", {
    serviceWorker: {
      register: async () => {
        page.registers++;
        return registration;
      },
      getRegistration: async () => registration,
      ready: Promise.resolve(registration),
    },
    userAgent: "boxbox test",
    maxTouchPoints: 0,
    webdriver: false,
  });
  install("window", { PushManager: class {}, Notification: notification, matchMedia: () => ({ matches: false }) });
  install("Notification", notification);
  install("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  Date.now = () => clock;
});

afterAll(() => {
  Date.now = realNow;
  for (const name of GLOBALS) {
    const descriptor = originals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

beforeEach(() => {
  page.subscription = null;
  page.subscribes = 0;
  page.permission = "granted";
  page.registers = 0;
  server.devices = [];
  server.gets = 0;
  server.posts = [];
  server.down = false;
  store.clear();
  clock = 1_790_000_000_000;
  api.GET = (async () => {
    server.gets++;
    if (server.down) return { data: undefined, error: {}, response: reply(503) };
    return { data: { publicKey: PUBLIC_KEY, devices: server.devices.map((d) => ({ ...d })) }, error: undefined, response: reply(200) };
  }) as never;
  api.POST = (async (_path: string, init: { body: { device: string; endpoint: string; kinds?: PushKind[] } }) => {
    if (server.down) return { data: undefined, error: {}, response: reply(503) };
    const body = init.body;
    server.posts.push({ device: body.device, endpoint: body.endpoint, ...(body.kinds ? { kinds: body.kinds } : {}) });
    const existing = server.devices.find((d) => d.device === body.device);
    const kinds = body.kinds ?? existing?.kinds ?? ALL;
    server.devices = [...server.devices.filter((d) => d.device !== body.device), { device: body.device, deviceClass: "mac", kinds, since: clock }];
    return { data: {}, error: undefined, response: reply(200, {}) };
  }) as never;
});

/** one launch: the shell's boot registration, then the launch's check, as the page runs them */
async function launch(): Promise<void> {
  await registerServiceWorker();
  await startNotifications();
}

const day = CHECK_EVERY_MS;

describe("the page's one service worker registration", () => {
  test("the shell's boot registration is the one notifications rides on: boot, a launch and turning on register once", async () => {
    await registerServiceWorker();
    await startNotifications();
    await turnOnNotifications();
    expect(page.registers).toBe(1);
  });
});

describe("the launch's check against the server", () => {
  test("a first launch with permission granted asks, and posts once", async () => {
    await launch();
    expect(server.gets).toBe(1);
    expect(server.posts).toHaveLength(1);
  });

  test("a launch soon after, on the same subscription, asks nothing", async () => {
    await launch();
    server.gets = 0;
    server.posts = [];
    clock += 60_000;
    await launch();
    expect({ gets: server.gets, posts: server.posts.length }).toEqual({ gets: 0, posts: 0 });
  });

  test("a check a day old asks the server, and posts nothing when its copy holds", async () => {
    await launch();
    server.gets = 0;
    server.posts = [];
    clock += day;
    await launch();
    expect({ gets: server.gets, posts: server.posts.length }).toEqual({ gets: 1, posts: 0 });
  });

  test("a check a day old heals a copy the server no longer holds, and posts", async () => {
    await launch();
    server.devices = [];
    server.posts = [];
    clock += day;
    await launch();
    expect(server.posts).toHaveLength(1);
  });

  test("a new subscription posts at once, however recent the check", async () => {
    await launch();
    server.posts = [];
    clock += 60_000;
    page.subscription = null;
    await launch();
    expect(server.posts).toHaveLength(1);
    // the browser made a second subscription, and the server was told its endpoint
    expect(server.posts[0]?.endpoint).toBe("https://push.example/2");
  });

  test("turning notifications on always posts, even when the copy is fresh", async () => {
    await launch();
    server.posts = [];
    await turnOnNotifications();
    expect(server.posts).toHaveLength(1);
  });

  test("a check the server does not answer leaves the copy alone, so the next launch asks again", async () => {
    await launch();
    server.down = true;
    clock += day;
    await launch();
    server.down = false;
    server.gets = 0;
    clock += 60_000;
    await launch();
    expect(server.gets).toBe(1);
  });

  test("granting permission again after it was not granted posts at once", async () => {
    await launch();
    page.permission = "default";
    await launch();
    page.permission = "granted";
    server.posts = [];
    clock += 60_000;
    await launch();
    expect(server.posts).toHaveLength(1);
  });

  test("the kinds the settings page saved are what the next launch shows, with no ask", async () => {
    await launch();
    const { rememberPushKinds } = await import("./notifications");
    server.devices = server.devices.map((d) => ({ ...d, kinds: ["ask"] }));
    rememberPushKinds({ endpoint: page.subscription?.endpoint ?? "", p256dh: "p256dh-key", auth: "auth-key" }, ["ask"]);
    server.gets = 0;
    server.posts = [];
    clock += 60_000;
    await launch();
    expect({ gets: server.gets, posts: server.posts.length }).toEqual({ gets: 0, posts: 0 });
    expect(state.push.kinds).toEqual(["ask"]);
  });
});
