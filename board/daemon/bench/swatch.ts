/* the time capsule test: render the 2023 rgb_layer_mode keymap's layer 2
   EXACTLY, key for key, colors verbatim from the donor's
   rgb_matrix_indicators_user. his memory already graded these colors on
   this exact board under these exact caps — if this frame looks like
   2023, the render pipe (rom curve + palette path + full-send levels) is
   proven, and the boxbox voices just need values from the same
   vocabulary.

   stop the daemon first (it repaints on its heartbeat):

     pkill -INT -f "bun src/main.ts"
     bun bench/swatch.ts            # the 2023 time capsule
     bun bench/swatch.ts voices     # the proposed boxbox palette, rest+hot

   photograph, ctrl-c, verdict. */

import HID from "node-hid";

const VID = 0x3a54;
const PID = 0x4f5d;
const USAGE_PAGE = 0xff60;
const OP_HELLO = 0x01;
const OP_PALETTE = 0x02;
const OP_FRAME = 0x03;
const OP_PING = 0x05;
const REPORT_LEN = 32;
const KEY_COUNT = 17;

function report(op: number, ...rest: number[]): number[] {
  return [0, op, ...rest, ...Array(REPORT_LEN - 1 - rest.length).fill(0)];
}

const NAMES = [
  "nl ", "div", "mul", "min", "k7 ", "k8 ", "k9 ", "plus",
  "k4 ", "k5 ", "k6 ", "k1 ", "k2 ", "k3 ", "ent", "k0 ", "dot",
];

/* ——— the 2023 layer 2, from the donor keymap.c, colors verbatim ——— */

const CAPSULE_SLOTS: [number, number, number][] = [
  [75, 110, 130],  /* 0 muted blue gray — the old base flood */
  [255, 128, 0],   /* 1 orange (P1-P4) */
  [0, 170, 255],   /* 2 light blue (react keys) */
  [255, 0, 160],   /* 3 purple (PENT, PPLS) */
  [75, 0, 255],    /* 4 indigo (k0, SP_FEYNCHAT) */
  [180, 255, 0],   /* 5 lime (dot, SP_LOCALHOST) */
  [255, 50, 0],    /* 6 orange-red (div, FRMT_JS) */
  [255, 0, 255],   /* 7 magenta (nl, TG) */
  [0, 0, 255],     /* 8 blue (min, TG(3)) */
];

/* wire → slot, the donor's own layout:
   nl=magenta div=orange-red mul=lightblue min=blue
   k7,k8,k9=lightblue plus=purple k4=orange k5,k6=lightblue
   k1,k2,k3=orange ent=purple k0=indigo dot=lime */
const CAPSULE_LAYOUT = [7, 6, 2, 8, 2, 2, 2, 3, 1, 2, 2, 1, 1, 1, 3, 4, 5];

/* ——— the proposed boxbox voices, rest and hot side by side ——— */

const VOICE_SLOTS: [number, number, number][] = [
  [150, 0, 255],   /* 0 you — THE CORNE PURPLE, green channel dead */
  [255, 0, 115],   /* 1 needs rose, zero green */
  [255, 20, 147],  /* 2 needsHot — corne hot pink */
  [255, 200, 0],   /* 3 perm gold, zero blue */
  [255, 215, 0],   /* 4 permHot */
  [255, 0, 0],     /* 5 fault — pure red */
  [0, 255, 60],    /* 6 live — real green */
  [0, 140, 255],   /* 7 info — clear blue */
  [255, 255, 255], /* 8 white reference */
];

/* top row: you, perm, permHot, fault | 3x3 left col rest / mid hot:
   needs, needsHot, live | bottom: info, white */
const VOICE_LAYOUT = [0, 3, 4, 5, 1, 2, 6, 8, 1, 2, 6, 1, 2, 6, 7, 0, 7];

const voices = process.argv[2] === "voices";
const slots = voices ? VOICE_SLOTS : CAPSULE_SLOTS;
const layout = voices ? VOICE_LAYOUT : CAPSULE_LAYOUT;

const devices = await HID.devicesAsync();
const board = devices.find(
  (d) => d.vendorId === VID && d.productId === PID && d.usagePage === USAGE_PAGE,
);
if (!board?.path) {
  console.error("no board. is the daemon still holding it, or is it unplugged?");
  process.exit(1);
}
const dev = await HID.HIDAsync.open(board.path);
await dev.write(report(OP_HELLO, 1));
for (const [slot, rgb] of slots.entries()) {
  await dev.write(report(OP_PALETTE, slot, ...rgb));
}
await dev.write(report(OP_FRAME, ...layout.map((slot) => (slot << 4) | 15)));

console.log(voices ? "the boxbox voices, full send:\n" : "2023, full send:\n");
for (const [wire, slot] of layout.entries()) {
  const [r, g, b] = slots[slot];
  console.log(`  ${NAMES[wire]}  rgb(${r}, ${g}, ${b})`);
}
console.log("\nphotograph it, then ctrl-c (the board goes numpad 2s later).");

const keepalive = setInterval(() => void dev.write(report(OP_PING)), 500);
process.on("SIGINT", async () => {
  clearInterval(keepalive);
  await dev.write(report(OP_FRAME, ...Array(KEY_COUNT).fill(0)));
  await dev.close();
  process.exit(0);
});
