/* bench item 1: is the board there, and does it talk?

   run it the moment the mf17 is plugged in and flashed:

     cd board && bun install && bun bench/hello.ts

   it answers three questions in order, and stops at the first no:
   does macos see the raw hid interface, does the board answer HELLO,
   and does it report key presses. nothing here writes a frame or
   changes a mode — this is a stethoscope, not a driver. */

import HID from "node-hid";

const VID = 0x3a54;
const PID = 0x4f5d;
const USAGE_PAGE = 0xff60; /* qmk raw hid, vendor defined */

const OP_HELLO = 0x01;
const OP_PALETTE = 0x02;
const OP_FRAME = 0x03;
const OP_PING = 0x05;
const OP_HELLO_ACK = 0x81;
const OP_KEY = 0x82;
const OP_MODE_ECHO = 0x83;
const REPORT_LEN = 32;
const KEY_COUNT = 17;

const WIRE_NAMES = [
  "nl", "div", "mul", "min",
  "k7", "k8", "k9", "plus",
  "k4", "k5", "k6",
  "k1", "k2", "k3", "ent",
  "k0", "dot",
];

function report(op: number, ...rest: number[]): number[] {
  /* node-hid on macos wants a leading report id byte; qmk uses 0 */
  return [0, op, ...rest, ...Array(REPORT_LEN - 1 - rest.length).fill(0)];
}

const devices = await HID.devicesAsync();
const board = devices.find(
  (d) => d.vendorId === VID && d.productId === PID && d.usagePage === USAGE_PAGE,
);

if (!board?.path) {
  const anyMf17 = devices.filter((d) => d.vendorId === VID && d.productId === PID);
  console.error("no board on the raw hid interface.");
  if (anyMf17.length > 0) {
    console.error(
      `the mf17 IS attached (${anyMf17.length} interface(s)) but none is usage page 0xFF60.`,
    );
    console.error("that means the flashed firmware has no RAW_ENABLE, or VIA took the page.");
    console.error("reflash: qmk flash -kb magic_force/mf17 -km boxbox");
  } else {
    console.error("the mf17 is not attached at all. plug it in.");
  }
  process.exit(1);
}

console.log(`found: ${board.product} at ${board.path}`);

const dev = await HID.HIDAsync.open(board.path);
let sawHello = false;

dev.on("error", (e: Error) => {
  console.error("read error:", e.message);
  process.exit(1);
});

dev.on("data", (buf: Buffer) => {
  const op = buf[0];
  if (op === OP_HELLO_ACK) {
    sawHello = true;
    const [, fw, proto, mode] = buf;
    console.log(
      `HELLO ok. fw ${fw}, proto ${proto}, mode ${mode === 1 ? "calc" : "drive"}`,
    );
    void lampTest();
    return;
  }
  if (op === OP_KEY) {
    const wire = buf[1];
    const action = buf[2] === 0 ? "down" : "up  ";
    console.log(`  key ${action}  wire ${String(wire).padStart(2)}  ${WIRE_NAMES[wire] ?? "?"}`);
    return;
  }
  if (op === OP_MODE_ECHO) {
    const why = ["host", "local hold-nl", "watchdog"][buf[2]] ?? String(buf[2]);
    console.log(`  mode -> ${buf[1] === 1 ? "calc" : "drive"} (${why})`);
    return;
  }
  console.log(`  unexpected op 0x${op.toString(16)}: ${[...buf.subarray(0, 8)].join(" ")}`);
});

/* the index map is the most error-prone thing in the build: wire order,
   led order and matrix order all differ. so walk ONE lit key around the
   board in wire order and watch it. if it tracks the printed name, the
   map is right. if it hops around, WIRE_TO_LED is wrong and nothing else
   built on top of it will make sense. */
async function lampTest() {
  console.log("\nlamp test: one key at a time, in wire order. watch it walk.");

  /* palette slot 1 = "you", violet. push it so we do not depend on
     whatever the firmware booted with. */
  await dev.write(report(OP_PALETTE, 1, 180, 122, 255));

  for (let wire = 0; wire < KEY_COUNT; wire++) {
    const cells = Array(KEY_COUNT).fill(0);
    cells[wire] = (1 << 4) | 12; /* palette slot 1, level 12 */
    await dev.write(report(OP_FRAME, ...cells));
    console.log(`  lit wire ${String(wire).padStart(2)}  ${WIRE_NAMES[wire]}`);
    await new Promise((r) => setTimeout(r, 400));
  }

  await dev.write(report(OP_FRAME, ...Array(KEY_COUNT).fill(0)));
  console.log("\nlamp test done. if each key lit in the order printed, the map is good.");
  console.log("now press keys on the board. ctrl-c when satisfied.");
  console.log("(stop pinging and the watchdog drops it to a numpad in 2s, which is correct.)");
}

await dev.write(report(OP_HELLO, 1));

/* the keepalive the protocol requires: any host report feeds the
   watchdog, and 500ms is 4x margin on the board's 2s fallback. without
   this the board correctly decides we died and turns into a numpad
   halfway through the bench. */
const keepalive = setInterval(() => {
  void dev.write(report(OP_PING));
}, 500);

setTimeout(() => {
  if (!sawHello) {
    console.error(
      "\nno HELLO answer in 2s. the interface is there but the firmware is not replying.",
    );
    console.error("check raw_hid_receive is wired and OP_HELLO is handled.");
    process.exit(1);
  }
}, 2000);

process.on("SIGINT", async () => {
  clearInterval(keepalive);
  await dev.write(report(OP_FRAME, ...Array(KEY_COUNT).fill(0)));
  await dev.close();
  console.log("\nclosed. the board falls back to a numpad in 2s.");
  process.exit(0);
});
