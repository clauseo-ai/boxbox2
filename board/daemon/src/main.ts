/* the board daemon. wiring only — every behavior lives in a module that
   tests can hold without hardware. SIGTERM blanks the frame and lets the
   watchdog return the board to a numpad, which is the polite way for a
   daemon to die. */

import { RESERVED_RGB } from "./protocol";
import { BoardDevice } from "./device";
import { BoxboxClient } from "./client";
import { Controller } from "./controller";
import { FleetState } from "./state";
import { RenderLoop } from "./render";
import { Radio } from "./radio";
import { createLogger } from "./log";
import { loadConfig } from "./config";

const log = createLogger();
const cfg = loadConfig(log, (next) => {
  controller.reconfigure(next);
  render.reconfigure(next);
  radio.retune(next.voice, next.micMeter);
  log.info("daemon.reconfigured", {});
});

const state = new FleetState();
const client = new BoxboxClient(
  { origin: cfg.origin, password: cfg.password, stateDir: cfg.stateDir },
  log,
);
const radio = new Radio(cfg.voice, cfg.micMeter, log);

const device = new BoardDevice(
  {
    onConnect: async (fw, proto, mode) => {
      log.info("board.connected", { fw, proto, mode });
      /* the hello ack carries the board's CURRENT layer — honor it. the
         old daemon ignored this byte, connected believing "drive", and
         composed drive scenes for a board sitting in calc. */
      controller.onModeEcho(mode);
      /* push the palette before anything renders: rom staleness must
         never show. liveries follow from bindings. */
      for (const [slot, rgb] of Object.entries(RESERVED_RGB)) {
        await device.palette(Number(slot), rgb);
      }
      for (const l of controller.syncLiveries()) {
        await device.palette(l.slot, l.color);
      }
      controller.onBoardConnect();
    },
    onKey: (wire, down, at) => controller.onKey(wire, down, at),
    onMode: (mode, reason) => {
      log.info("board.mode", { mode, reason });
      if (reason === "watchdog") {
        /* the board decided we were dead. we were not. log loudly — a
           recurring trip is a real bug in the keepalive, not noise. */
        log.error("board.watchdog_tripped", {});
      }
      controller.onModeEcho(mode);
    },
    onDisconnect: () => log.info("board.gone", {}),
  },
  log,
);

const controller = new Controller(state, client, device, radio, cfg, log);
const render = new RenderLoop(state, controller, device, radio, client, cfg);

/* state in: the one stream + the same reconcile the browser runs */
void client.stream(
  (event) => {
    state.applyBrain(event);
    /* the pairing ritual rides the same stream: the app armed a key */
    if (event.kind === "pinArm") controller.armPin(event.session, event.color);
  },
  () => {
    controller.onSnapshot(Date.now());
    for (const host of state.hosts) {
      void client
        .refreshSessions(host.id, host.liveDirectories ?? [])
        .then((rows) => state.setSessions(host.id, rows));
    }
    void client.spendToday().then((usd) => {
      state.spend = { totalUsd: usd };
    });
  },
);

/* spend refresh: the odometer's fuel, same 60s the app uses */
const spendTimer = setInterval(() => {
  void client.spendToday().then((usd) => {
    state.spend = { totalUsd: usd };
  });
}, 60_000);
spendTimer.unref?.();

/* backfill: sessions busy on the wire we hold no row for. the reconcile
   is project-scoped, so a working agent in another project would
   otherwise never seat. by-id, unscoped, never spawns — and it is how
   the daemon learns parentID, without which a subagent would take a
   seat meant for a thread. tried once each; a failure retries next tick. */
const tried = new Set<string>();
const backfillTimer = setInterval(() => {
  for (const { host, sessionID } of state.unknownBusy().slice(0, 8)) {
    const key = `${host}:${sessionID}`;
    if (tried.has(key)) continue;
    tried.add(key);
    void client.fetchSession(host, sessionID).then((row) => {
      if (row) state.setSessions(host, [row]);
      else tried.delete(key);
    });
  }
  if (tried.size > 500) tried.clear();
}, 2000);
backfillTimer.unref?.();

void device.start();
void render.run();

log.info("daemon.up", { origin: cfg.origin, device: client.device() });

async function shutdown(signal: string) {
  log.info("daemon.down", { signal });
  render.stop();
  await device.frame(Array(17).fill(0));
  device.stop();
  client.stop();
  await client.flushTelemetry();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("sigterm"));
process.on("SIGINT", () => void shutdown("sigint"));
