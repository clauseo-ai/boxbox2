/* the images a tool returned (docs/thread.md, the images a tool returned): the model reads them off the part's state through the
   loose readers (the contract does not name `attachments` yet), keeps only the ones a browser draws, and passes the data url
   string on by reference; the rows group them under their file, cap what is drawn and say the rest */

import { describe, expect, test } from "bun:test";
import { type PartMemo, type Step, picturesOf, turnsOf } from "./model";
import { MAX_PICTURES, type RowCtx, capPictures, foldModel, modelOf, pictureNames, rowsOf, stepModel } from "./rows";
import { withoutPictureBytes } from "./turns";
import type { WireMessage, WirePart } from "./wire";
import { neutral } from "./fixtures/wire";

const T0 = 1_790_000_000_000;
const PNG = (n: number | string = 0) => `data:image/png;base64,iVBORw0KGgo${n}`;
const attach = (filename: string, url: string = PNG(filename), mime = "image/png") => ({ type: "file", mime, filename, url });

const tool = (id: string, name: string, input: Record<string, unknown>, state: Record<string, unknown> = {}): WirePart =>
  ({ id, type: "tool", callID: `c_${id}`, tool: name, state: { status: "completed", input, output: "", metadata: {}, time: { start: T0 + 200, end: T0 + 300 }, ...state } }) as unknown as WirePart;
const messages = (parts: WirePart[]): WireMessage[] => [
  neutral({ info: { id: "u", role: "user", time: { created: T0 } }, parts: [{ id: "u_p", type: "text", text: "go" } as WirePart] }),
  neutral({ info: { id: "a", role: "assistant", time: { created: T0 + 100, completed: T0 + 5000 } }, parts }),
];
const stepsOf = (parts: WirePart[], memo?: PartMemo): Step[] => turnsOf(messages(parts), "/p", new Set(), memo).flatMap((t) => t.items.filter((x): x is Step => x.k === "step"));
const ctx = (): RowCtx => ({ reports: [], children: new Map(), thinking: "rows", now: T0 + 3000 });
const read = (id: string, file: string, attachments: unknown[], extra: Record<string, unknown> = {}) => tool(id, "read", { filePath: `/p/${file}` }, { attachments, ...extra });

describe("a step's images, read off the part's state", () => {
  test("a read with attachments is a step with images, the data url the same string the wire held", () => {
    const a = attach("shot.png");
    const [step] = stepsOf([read("r", "shot.png", [a])]);
    expect(step?.images).toEqual([{ mime: "image/png", filename: "shot.png", url: a.url }]);
    expect(step?.images?.[0]?.url).toBe(a.url);
    expect(step?.imagesDropped).toBeUndefined();
  });

  test("only the images a browser draws are kept: png, jpeg, gif and webp, by mime and by the url's own", () => {
    const good = [attach("a.png"), attach("b.jpg", "data:image/jpeg;base64,/9j/4AAQ", "image/jpeg"), attach("c.gif", "data:image/gif;base64,R0lGOD", "image/gif"), attach("d.webp", "data:image/webp;base64,UklGR", "image/webp")];
    const bad = [
      attach("e.svg", "data:image/svg+xml;base64,PHN2Zz4=", "image/svg+xml"),
      attach("f.pdf", "data:application/pdf;base64,JVBERi0", "application/pdf"),
      attach("g.png", "data:text/html;base64,PHNjcmlwdD4=", "image/png"),
      attach("h.png", "https://example.com/h.png", "image/png"),
      attach("i.png", "javascript:alert(1)", "image/png"),
      attach("j.heic", "data:image/heic;base64,AAAA", "image/heic"),
      { type: "file", mime: "image/png", filename: "k.png" },
      { type: "file", filename: "l.png", url: PNG("l") },
      "not an attachment",
      null,
    ];
    const [step] = stepsOf([read("r", "x.png", [...bad.slice(0, 5), good[0], ...bad.slice(5), ...good.slice(1)])]);
    expect(step?.images?.map((i) => i.filename)).toEqual(["a.png", "b.jpg", "c.gif", "d.webp"]);
  });

  test("an uppercase mime or url still draws; a missing filename is empty, not invented", () => {
    const [step] = stepsOf([read("r", "x.png", [{ type: "file", mime: "IMAGE/PNG", url: "DATA:IMAGE/PNG;base64,AAAA" }])]);
    expect(step?.images).toEqual([{ mime: "IMAGE/PNG", filename: "", url: "DATA:IMAGE/PNG;base64,AAAA" }]);
  });

  test("how many the daemon dropped is kept, with images or without", () => {
    const [one] = stepsOf([read("r", "x.png", [attach("a.png")], { attachmentsDropped: 2 })]);
    expect(one?.imagesDropped).toBe(2);
    const [none] = stepsOf([read("r", "x.png", [], { attachmentsDropped: 3 })]);
    expect(none?.images).toBeUndefined();
    expect(none?.imagesDropped).toBe(3);
    const [junk] = stepsOf([read("r", "x.png", [], { attachmentsDropped: "many" })]);
    expect(junk?.imagesDropped).toBeUndefined();
  });

  test("a step whose state does not name them has none, and so does one that has not completed", () => {
    expect(stepsOf([tool("r", "read", { filePath: "/p/a.ts" }, { output: "x" })])[0]?.images).toBeUndefined();
    expect(stepsOf([read("r", "a.png", [attach("a.png")], { status: "running" })])[0]?.images).toBeUndefined();
    expect(stepsOf([read("r", "a.png", "nope" as unknown as unknown[])])[0]?.images).toBeUndefined();
  });

  test("any family can carry them: a command that wrote a picture", () => {
    const [step] = stepsOf([tool("s", "bash", { command: "screencapture x.png" }, { attachments: [attach("x.png")], metadata: { exit: 0 } })]);
    expect(step?.family).toBe("shell");
    expect(step?.images?.map((i) => i.filename)).toEqual(["x.png"]);
  });

  test("the same part sent again as an equal copy keeps its step, and so its row; a changed picture does not", () => {
    const a = attach("a.png", PNG("same"));
    const memo: PartMemo = new Map();
    const first = stepsOf([read("r", "a.png", [a])], memo)[0];
    const again = stepsOf([read("r", "a.png", [{ ...a, url: `${PNG("sa")}me` }])], memo)[0];
    expect(again).toBe(first as Step);
    const changed = stepsOf([read("r", "a.png", [attach("a.png", PNG("other"))])], memo)[0];
    expect(changed).not.toBe(first as Step);
    expect(changed?.images?.[0]?.url).toBe(PNG("other"));
  });

  test("picturesOf is the one reader: nothing in, nothing out", () => {
    expect(picturesOf(undefined)).toEqual({ images: [], dropped: 0 });
    expect(picturesOf({ status: "completed" })).toEqual({ images: [], dropped: 0 });
  });
});

describe("a read row with images", () => {
  test("the body's file line carries them, and the closed row says how many images it holds", () => {
    const a = attach("shot.png");
    const [step] = stepsOf([read("r", "shot.png", [a])]);
    const m = stepModel(step as Step, ctx());
    expect(m.body).toMatchObject({ k: "read", files: [{ path: "shot.png", note: "1 image", images: [{ filename: "shot.png" }] }] });
    expect(m.body?.k === "read" && m.body.files[0]?.images?.[0]?.url).toBe(a.url);
    expect(m.result.text).toBe("1 image");
    expect(m.label).toBe("read shot.png, 1 image");
  });

  test("a read that also counted lines keeps its line count as the result", () => {
    const [step] = stepsOf([read("r", "a.png", [attach("a.png")], { output: "one\ntwo", metadata: { startLine: 1, endLine: 2, totalLines: 2 } })]);
    const m = stepModel(step as Step, ctx());
    expect(m.result.text).toBe("2 lines");
    expect(m.body?.k === "read" && m.body.files[0]?.images).toHaveLength(1);
  });

  test("a read with no images has none, and a row that dropped them says so", () => {
    const [plain] = stepsOf([tool("r", "read", { filePath: "/p/a.ts" }, { output: "x" })]);
    expect(stepModel(plain as Step, ctx()).body).toMatchObject({ k: "read", files: [{ path: "a.ts" }] });
    expect((stepModel(plain as Step, ctx()).body as { files: Array<{ images?: unknown }> }).files[0]?.images).toBeUndefined();
    const [dropped] = stepsOf([read("r", "a.png", [attach("a.png")], { attachmentsDropped: 3 })]);
    const m = stepModel(dropped as Step, ctx());
    expect(m.result.text).toBe("4 images");
    expect(m.body).toMatchObject({ k: "read", more: 3 });
  });

  test("a failed read has no images to show", () => {
    const [step] = stepsOf([tool("r", "read", { filePath: "/p/a.png" }, { status: "error", error: "no such file", attachments: [attach("a.png")] })]);
    expect(step?.images).toBeUndefined();
  });
});

describe("a fold of reads, grouped by file", () => {
  const fold = (parts: WirePart[]) => {
    const [row] = rowsOf(stepsOf(parts));
    if (row?.k !== "fold") throw new Error("not a fold");
    return foldModel(row, ctx());
  };

  test("each file's line holds the images its reads returned, in order, and the row counts them all", () => {
    const m = fold([read("r1", "a.png", [attach("a1.png"), attach("a2.png")]), read("r2", "b.png", [attach("b1.png")]), read("r3", "a.png", [attach("a3.png")])]);
    expect(m.body?.k).toBe("read");
    const files = m.body?.k === "read" ? m.body.files : [];
    expect(files.map((f) => [f.path, f.note, f.images?.map((i) => i.filename)])).toEqual([
      ["a.png", "3 images", ["a1.png", "a2.png", "a3.png"]],
      ["b.png", "1 image", ["b1.png"]],
    ]);
    expect(m.result.text).toBe("4 images");
    expect(m.label).toBe("read 2 files, 4 images");
  });

  test("a file read without images keeps its line count and no strip", () => {
    const m = fold([read("r1", "a.png", [attach("a1.png")]), tool("r2", "read", { filePath: "/p/b.ts" }, { output: "x\ny", metadata: { startLine: 1, endLine: 2, totalLines: 2 } })]);
    const files = m.body?.k === "read" ? m.body.files : [];
    expect(files[1]).toMatchObject({ path: "b.ts", note: "2 lines" });
    expect(files[1]?.images).toBeUndefined();
  });

  test("past eight thumbnails the rest are counted, with what the daemon dropped, and not drawn", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => attach(`p${i}.png`));
    const m = fold([read("r1", "a.png", eleven.slice(0, 6), { attachmentsDropped: 1 }), read("r2", "b.png", eleven.slice(6))]);
    const files = m.body?.k === "read" ? m.body.files : [];
    expect(files.map((f) => f.images?.length)).toEqual([6, 2]);
    expect(m.body).toMatchObject({ k: "read", more: 4 });
    expect(m.result.text).toBe("12 images");
  });

  test("a one-file fold is the single read's row", () => {
    const m = fold([read("r1", "a.png", [attach("a1.png")]), read("r2", "a.png", [attach("a2.png")])]);
    expect(m.body?.k === "read" && m.body.files).toHaveLength(1);
    expect(m.result.text).toBe("2 images");
  });
});

describe("what a row draws", () => {
  test("capPictures keeps the first eight in order across groups and counts the rest with the daemon's", () => {
    const pic = (n: number) => ({ mime: "image/png", filename: `${n}.png`, url: PNG(n) });
    const first = pic(0);
    const out = capPictures([[first, pic(1), pic(2)], [pic(3), pic(4), pic(5), pic(6), pic(7), pic(8), pic(9)]], 2);
    expect(out.groups.map((g) => g.length)).toEqual([3, 5]);
    expect(out.more).toBe(2 + 2);
    expect(MAX_PICTURES).toBe(8);
    expect(out.groups[0]?.[0]).toBe(first);
    expect(capPictures([[pic(0)]]).more).toBe(0);
    expect(capPictures([]).groups).toEqual([]);
  });

  test("the thumbnails' names are unique in a row: a name that comes twice says its place", () => {
    expect(pictureNames([{ filename: "a.png" }, { filename: "b.png" }])).toEqual(["image a.png", "image b.png"]);
    expect(pictureNames([{ filename: "a.png" }, { filename: "b.png" }, { filename: "a.png" }])).toEqual(["image a.png, 1 of 2", "image b.png", "image a.png, 2 of 2"]);
    expect(pictureNames([{ filename: "" }, { filename: "" }])).toEqual(["image, 1 of 2", "image, 2 of 2"]);
  });

  test("a command's and a script's images ride their bodies, and a tool with no body of its own gets one for them", () => {
    const [shell] = stepsOf([tool("s", "bash", { command: "ls" }, { output: "x", attachments: [attach("x.png")], attachmentsDropped: 1 })]);
    expect(stepModel(shell as Step, ctx()).body).toMatchObject({ k: "shell", images: [{ filename: "x.png" }], more: 1 });
    const [script] = stepsOf([tool("r", "run", { code: "return 1" }, { attachments: [attach("y.png")] })]);
    expect(modelOf({ k: "step", at: T0, end: T0, step: script as Step }, ctx()).body).toMatchObject({ k: "script", code: "return 1", images: [{ filename: "y.png" }] });
    const [other] = stepsOf([tool("o", "browser_screenshot", { url: "https://example.com" }, { attachments: [attach("z.png")] })]);
    const m = modelOf({ k: "step", at: T0, end: T0, step: other as Step }, ctx());
    expect(m.body).toMatchObject({ k: "images", images: [{ filename: "z.png" }] });
  });
});

describe("the digest of a state with images", () => {
  test("a big data url is told by its length and its ends, so it is never hashed whole", () => {
    const big = `data:image/png;base64,${"A".repeat(200_000)}`;
    const told = withoutPictureBytes({ status: "completed", attachments: [attach("a.png", big), attach("b.png")] }) as { attachments: Array<{ url: string }> };
    expect(told.attachments[0]?.url.length).toBeLessThan(10_000);
    expect(told.attachments[0]?.url.startsWith(`${big.length}|`)).toBe(true);
    expect(told.attachments[1]?.url).toBe(PNG("b.png"));
    const state = { status: "completed", output: "x" };
    expect(withoutPictureBytes(state)).toBe(state);
  });
});
