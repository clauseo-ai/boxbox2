/* bench item 2: FRAME at 60fps, sustained.

     cd board && bun bench/stress.ts

   the bitbang ws2812 driver holds interrupts off ~790us per flush, and
   the flush runs every 16ms. this pushes a full-board frame 60 times a
   second for 30 seconds, worst-case content (every led changes every
   frame), while counting how many writes actually landed.

   pass = the board renders smooth motion with no flicker, no stalls,
   no usb drops, and the report rate holds near 60/s. fail = apply the
   pwm/dma block in scope-board.md §5.

   phases, 10s each:
     1 the sweep: a violet wave orbiting the ring — is motion smooth?
     2 the strobe: whole board alternating two frames — worst case for
       the flush, any dropped frame is visible as a rhythm hiccup
     3 the shimmer: every key a different level each frame — quantifies
       the level curve under motion */

import HID from "node-hid";

const VID = 0x3a54;
const PID = 0x4f5d;
const USAGE_PAGE = 0xff60;

const OP_PALETTE = 0x02;
const OP_FRAME = 0x03;
const OP_HELLO = 0x01;
const REPORT_LEN = 32;
const KEY_COUNT = 17;

const FPS = 60;
const PHASE_MS = 10_000;

/* wire indices around the perimeter, clockwise — same ring as the sim */
const RING = [0, 1, 2, 3, 7, 14, 16, 15, 11, 8, 4];

function report(op: number, ...rest: number[]): number[] {
  return [0, op, ...rest, ...Array(REPORT_LEN - 1 - rest.length).fill(0)];
}

const devices = await HID.devicesAsync();
const board = devices.find(
  (d) => d.vendorId === VID && d.productId === PID && d.usagePage === USAGE_PAGE,
);
if (!board?.path) {
  console.error("no board. run bench/hello.ts first.");
  process.exit(1);
}

const dev = await HID.HIDAsync.open(board.path);
dev.on("error", (e: Error) => {
  console.error("hid error mid-stress:", e.message);
  process.exit(1);
});

await dev.write(report(OP_HELLO, 1));
/* slot 1 = you (violet), slot 7 = live (green) */
await dev.write(report(OP_PALETTE, 1, 180, 122, 255));
await dev.write(report(OP_PALETTE, 7, 95, 163, 114));

let writes = 0;
let failures = 0;

async function frame(cells: number[]) {
  try {
    await dev.write(report(OP_FRAME, ...cells));
    writes++;
  } catch {
    failures++;
  }
}

function sweep(tick: number): number[] {
  const cells = Array(KEY_COUNT).fill(0);
  const head = tick % RING.length;
  cells[RING[head]] = (1 << 4) | 15;
  cells[RING[(head + RING.length - 1) % RING.length]] = (1 << 4) | 10;
  cells[RING[(head + RING.length - 2) % RING.length]] = (1 << 4) | 6;
  return cells;
}

function strobe(tick: number): number[] {
  const on = tick % 2 === 0;
  return Array.from({ length: KEY_COUNT }, (_, i) =>
    (i % 2 === 0) === on ? (7 << 4) | 13 : (1 << 4) | 4,
  );
}

function shimmer(tick: number): number[] {
  return Array.from({ length: KEY_COUNT }, (_, i) => {
    const level = 1 + ((tick + i * 3) % 15);
    return (1 << 4) | level;
  });
}

const phases: Array<[string, (t: number) => number[]]> = [
  ["sweep — watch for smooth motion", sweep],
  ["strobe — watch for rhythm hiccups", strobe],
  ["shimmer — watch the low levels", shimmer],
];

for (const [name, gen] of phases) {
  console.log(`\nphase: ${name} (10s)`);
  writes = 0;
  failures = 0;
  const started = Date.now();
  let tick = 0;
  while (Date.now() - started < PHASE_MS) {
    const frameStart = Date.now();
    await frame(gen(tick++));
    const elapsed = Date.now() - frameStart;
    const wait = Math.max(0, 1000 / FPS - elapsed);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  const secs = (Date.now() - started) / 1000;
  console.log(
    `  ${writes} frames in ${secs.toFixed(1)}s = ${(writes / secs).toFixed(1)}/s, ${failures} write failures`,
  );
}

await dev.write(report(OP_FRAME, ...Array(KEY_COUNT).fill(0)));
await dev.close();
console.log(
  "\ndone. pass = all three phases looked smooth and the rate held near 60/s.",
);
console.log("watchdog check: the board should be a numpad again in ~2s.");
