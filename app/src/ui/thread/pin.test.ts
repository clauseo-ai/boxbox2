/* the pin: the stage follows the end until the reader scrolls away, and only their scroll lets go (pin.ts) */

import { describe, expect, test } from "bun:test";
import { BOTTOM_SLACK, ECHO_FRAMES, READER_MS, type Scroller, createPin, endRoom } from "./pin";

/** a scroller whose content can grow and shrink, with a clock and frames the test moves; a write clamps the way a browser does */
function rig(height = 5000, view = 700) {
  const queued: Array<() => void> = [];
  const box = { content: height, top: height - view, clock: 0, writes: 0, frames(n = 1) { for (let i = 0; i < n; i++) queued.splice(0).forEach((run) => run()); } };
  const scroller: Scroller = {
    get scrollTop() { return box.top; },
    set scrollTop(v: number) { box.writes++; box.top = Math.max(0, Math.min(v, box.content - view)); },
    get scrollHeight() { return box.content; },
    get clientHeight() { return view; },
  };
  const pin = createPin(scroller, () => box.clock, (run) => { queued.push(run); });
  return { box, scroller, pin, view };
}

describe("a reader at the end", () => {
  test("is followed as the content grows, by the one write the stage makes for it", () => {
    const { box, pin } = rig();
    box.content += 300;
    pin.follow();
    expect(box.top).toBe(box.content - 700);
    expect(box.writes).toBe(1);
  });

  test("is not written to again while the end is already under the view", () => {
    const { box, pin } = rig();
    pin.follow();
    pin.follow();
    expect(box.writes).toBe(0);
  });
});

describe("the reader's own scroll", () => {
  test("lets go of the end, and then nothing moves however much arrives", () => {
    const { box, pin } = rig();
    pin.input();
    box.top -= 400;
    expect(pin.scrolled()).toBe(true);
    expect(pin.pinned()).toBe(false);
    box.content += 500;
    pin.resized();
    pin.follow();
    expect(box.top).toBe(5000 - 700 - 400);
    expect(box.writes).toBe(0);
  });

  test("takes the end back when they scroll to within the slack of it", () => {
    const { box, pin } = rig();
    pin.input();
    box.top -= 400;
    pin.scrolled();
    box.clock += 100;
    box.top = box.content - 700 - (BOTTOM_SLACK - 1);
    pin.scrolled();
    expect(pin.pinned()).toBe(true);
  });

  test("goes on being theirs while a fling keeps the events coming, though the finger is long gone", () => {
    const { box, pin } = rig();
    pin.input();
    for (let i = 0; i < 10; i++) {
      box.clock += READER_MS - 100;
      box.top -= 80;
      expect(pin.scrolled()).toBe(true);
    }
    expect(pin.pinned()).toBe(false);
  });
});

describe("a finger on the glass", () => {
  test("a thumb that rests longer than the window and then drags is the reader's the whole way down", () => {
    const { box, pin } = rig();
    pin.touch(true);
    box.clock += READER_MS * 3;
    for (let i = 0; i < 10; i++) {
      box.clock += 16;
      box.top -= 20;
      expect(pin.scrolled()).toBe(true);
    }
    expect(pin.pinned()).toBe(false);
    expect(box.writes).toBe(0);
  });

  test("momentum after the lift is theirs for the window that starts at the lift, not at the touch", () => {
    const { box, pin } = rig();
    pin.touch(true);
    box.clock += READER_MS * 2;
    pin.touch(false);
    box.clock += READER_MS - 100;
    box.top -= 300;
    expect(pin.scrolled()).toBe(true);
    expect(pin.pinned()).toBe(false);
  });

  test("once the window after the lift has run out, a snap is not theirs", () => {
    const { box, pin } = rig();
    pin.touch(true);
    pin.touch(false);
    box.clock += READER_MS + 1;
    pin.follow();
    box.content += 300;
    pin.resized();
    box.top -= 427;
    expect(pin.scrolled()).toBe(false);
    expect(pin.pinned()).toBe(true);
  });
});

describe("a tap on send, which is a lift that is not the reader's scroll", () => {
  test("the dock growing under the send and webkit's restore four frames later: the end is put back and the stage stays pinned", () => {
    const { box, pin } = rig();
    const from = box.top;
    // the stage opened the reader's window by mistake, as a lift anywhere on the page used to (the lift is no longer told to the pin)
    pin.touch(false);
    pin.pin();
    box.content += 150;
    pin.resized();
    pin.follow();
    box.frames(ECHO_FRAMES + 2);
    box.clock += 73;
    box.top = from;
    expect(pin.scrolled()).toBe(false);
    expect(pin.pinned()).toBe(true);
    expect(box.top).toBe(box.content - 700);
    box.content += 40;
    pin.resized();
    pin.follow();
    expect(box.top).toBe(box.content - 700);
  });

  test("a reader who began on the scroller and let momentum carry them back onto a place the stage had written from is not put back", () => {
    const { box, pin } = rig();
    const from = box.top;
    box.content += 150;
    pin.resized();
    pin.follow();
    box.frames(ECHO_FRAMES);
    pin.touch(true);
    box.top -= 900;
    expect(pin.scrolled()).toBe(true);
    expect(pin.pinned()).toBe(false);
    pin.touch(false);
    const wrote = box.writes;
    box.clock += 300;
    box.top = from;
    expect(pin.scrolled()).toBe(true);
    expect(box.top).toBe(from);
    expect(box.writes).toBe(wrote);
    expect(pin.pinned()).toBe(false);
  });
});

describe("a scroll the reader did not make", () => {
  test("is put back when it follows a change of size: the browser clamping, or snapping after the layout moved", () => {
    const { box, pin } = rig();
    box.content += 200;
    pin.resized();
    pin.follow();
    box.top -= 427;
    expect(pin.scrolled()).toBe(false);
    expect(pin.pinned()).toBe(true);
    expect(box.top).toBe(box.content - 700);
  });

  test("is put back when it follows the stage's own write, though no size changed", () => {
    const { box, pin } = rig();
    box.content += 200;
    pin.follow();
    box.top -= 427;
    expect(pin.scrolled()).toBe(false);
    expect(pin.pinned()).toBe(true);
    expect(box.top).toBe(box.content - 700);
  });

  test("a hundred milliseconds late, because the page janked, is still the browser's: what counts is the frames that ran", () => {
    const { box, pin } = rig();
    box.content += 200;
    pin.resized();
    pin.follow();
    box.clock += 112;
    box.top -= 262;
    expect(pin.scrolled()).toBe(false);
    expect(pin.pinned()).toBe(true);
    expect(box.top).toBe(box.content - 700);
  });

  test("webkit restoring the place the view was left from, long after the frames that count, is put back: the dock took a card and the old offset came back", () => {
    const { box, pin } = rig();
    const from = box.top;
    box.content += 200;
    pin.resized();
    pin.follow();
    expect(pin.scrolled()).toBe(false);
    box.frames(ECHO_FRAMES + 3);
    box.clock += 73;
    box.top = from;
    expect(pin.scrolled()).toBe(false);
    expect(pin.pinned()).toBe(true);
    expect(box.top).toBe(box.content - 700);
  });

  test("an event that lands somewhere the view was never left from, after the frames that count, is not a restore", () => {
    const { box, pin } = rig();
    box.content += 200;
    pin.resized();
    pin.follow();
    box.frames(ECHO_FRAMES + 3);
    box.clock += 73;
    box.top -= 262;
    pin.scrolled();
    expect(pin.pinned()).toBe(false);
  });

  test("with no write and no change of size in the last frames (find in page, a focus moving into a row, voiceover) is read for where it left the view", () => {
    const { box, pin } = rig();
    box.content += 200;
    pin.resized();
    pin.follow();
    box.frames(ECHO_FRAMES);
    const wrote = box.writes;
    box.top -= 1200;
    expect(pin.scrolled()).toBe(false);
    expect(pin.pinned()).toBe(false);
    expect(box.writes).toBe(wrote);
  });

  test("a voiceover reader's scroll, which sends no input, can leave the end and stay", () => {
    const { box, pin } = rig();
    for (let i = 0; i < 5; i++) {
      box.clock += 1000;
      box.content += 40;
      pin.resized();
      pin.follow();
      box.frames(ECHO_FRAMES);
    }
    box.clock += 1000;
    box.top -= 600;
    pin.scrolled();
    expect(pin.pinned()).toBe(false);
    box.content += 40;
    pin.resized();
    pin.follow();
    expect(box.top).toBe(box.content - 40 - 700 - 600);
  });

  test("a scroll that lands within the slack of the end still leaves the reader pinned", () => {
    const { box, pin } = rig();
    box.top -= BOTTOM_SLACK - 1;
    pin.scrolled();
    expect(pin.pinned()).toBe(true);
  });

  test("leaves a reader who is further up exactly where they are", () => {
    const { box, pin } = rig();
    pin.input();
    box.top -= 900;
    pin.scrolled();
    box.clock += READER_MS * 5;
    const was = box.top;
    box.content -= 200;
    pin.resized();
    expect(pin.scrolled()).toBe(false);
    expect(box.top).toBe(Math.min(was, box.content - 700));
    expect(pin.pinned()).toBe(false);
  });
});

describe("the echo of the stage's own write", () => {
  test("is neither the reader's nor a change: it does not keep their window open, so a snap a minute after the only touch is put back", () => {
    const { box, pin } = rig();
    pin.input();
    // a minute of streaming, a write and its echo every 100 ms
    for (let i = 0; i < 600; i++) {
      box.clock += 100;
      box.content += 30;
      pin.resized();
      pin.follow();
      expect(pin.scrolled()).toBe(false);
      box.frames();
    }
    box.content += 30;
    pin.resized();
    pin.follow();
    box.top -= 427;
    expect(pin.scrolled()).toBe(false);
    expect(pin.pinned()).toBe(true);
    expect(box.top).toBe(box.content - 700);
  });

  test("an event at the place the stage wrote, give or take a pixel, leaves the pin alone even inside the reader's window", () => {
    const { box, pin } = rig();
    pin.input();
    box.content += 100;
    pin.follow();
    expect(pin.scrolled()).toBe(false);
    expect(pin.pinned()).toBe(true);
  });

  test("a reader who scrolls on past it is the reader's again, and the echo is forgotten", () => {
    const { box, pin } = rig();
    box.content += 100;
    pin.follow();
    pin.input();
    box.top -= 500;
    expect(pin.scrolled()).toBe(true);
    expect(pin.pinned()).toBe(false);
  });
});

describe("the stage's own moves", () => {
  test("leave takes the reader off the end for good, and a send puts them back at it", () => {
    const { box, pin } = rig();
    pin.leave();
    box.content += 200;
    pin.follow();
    expect(box.top).toBe(5000 - 700);
    pin.pin();
    expect(pin.pinned()).toBe(true);
    expect(box.top).toBe(box.content - 700);
  });

  test("derive reads a change the reader made: a row opened at the end that grew past the slack is theirs to leave behind", () => {
    const { box, pin } = rig();
    box.content += BOTTOM_SLACK + 20;
    pin.derive();
    expect(pin.pinned()).toBe(false);
    box.top = box.content - 700;
    pin.derive();
    expect(pin.pinned()).toBe(true);
  });
});

describe("the stage keeping a reader's place (place)", () => {
  test("moves the view where it is told, and the echo of that is not the reader's", () => {
    const { box, pin } = rig();
    pin.input();
    box.top -= 400;
    pin.scrolled();
    box.clock += 2000;
    box.top += 0;
    const before = box.top;
    pin.place(before + 120);
    expect(box.top).toBe(before + 120);
    expect(pin.scrolled()).toBe(false);
    expect(pin.pinned()).toBe(false);
  });

  test("does not move a view that is pinned to the end: the end is followed instead", () => {
    const { box, pin } = rig();
    pin.place(100);
    expect(box.writes).toBe(0);
    expect(box.top).toBe(5000 - 700);
  });

  test("writes a whole px, the nearest to where it is told, so a browser that cuts a fraction does not cut it", () => {
    const { box, pin } = rig();
    pin.input();
    box.top -= 400;
    pin.scrolled();
    box.clock += 2000;
    const before = box.top;
    pin.place(before + 120.6);
    expect(box.top).toBe(before + 121);
    pin.place(before + 120.4 + 200);
    expect(box.top).toBe(before + 320);
  });

  test("writes nothing when the view is already there", () => {
    const { box, pin } = rig();
    pin.input();
    box.top -= 400;
    pin.scrolled();
    pin.place(box.top + 0.2);
    expect(box.writes).toBe(0);
  });

  test("does not read a snap back to the old place as the reader's leaving, as it does for a write to the end", () => {
    const { box, pin } = rig();
    pin.input();
    box.top -= 400;
    pin.scrolled();
    box.clock += 2000;
    pin.place(box.top + 90);
    pin.scrolled();
    box.content += 40;
    pin.resized();
    pin.follow();
    expect(pin.pinned()).toBe(false);
    expect(box.top).toBe(5000 - 700 - 400 + 90);
  });
});

describe("the room a settle leaves under the end", () => {
  const view = 700;
  test("is how far the foot of the view is past the new end: a row that closed leaves its height", () => {
    // the view was at the end of 5,000 px (top 4,300); the end is now 5,000 - 180 = 4,820, and 40 px of the scroller's own padding follows it
    expect(endRoom(4300, view, 4820, 40)).toBe(140);
  });
  test("is none when the end is where it was, or further on", () => {
    expect(endRoom(4300, view, 5000, 40)).toBe(0);
    expect(endRoom(4300, view, 5400, 40)).toBe(0);
  });
  test("is a whole px, rounded up, so nothing above the new end drops by a fraction", () => {
    expect(endRoom(4300, view, 4819.5, 40)).toBe(141);
  });
  test("is none when it would fill the view with padding: that is content that is gone, not a row that closed", () => {
    /* the list was made again between the reading and the settle: 65 turns read at 105,000, 8 of them laid out now. a hold of 98,000 px made the
       scroller 98,000 px tall (padding is part of a flex item's box) with the view in the padding: the thread blank until a reload */
    expect(endRoom(105_000, view, 7_417, 40)).toBe(0);
    // the room and the 40 px under it make the view's height exactly: the box would not be any smaller than that
    expect(endRoom(4300, view, 4300, 40)).toBe(0);
    expect(endRoom(4300, view, 4300 - view, 40)).toBe(0);
  });
  test("a room that leaves the box its height is kept, to the last px", () => {
    // 659 px of room and 40 of padding are 699 px, one under the view
    expect(endRoom(4300, view, 4301, 40)).toBe(659);
  });
});
