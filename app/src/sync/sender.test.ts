import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { FromWorker } from "./messages";
import { type Draft, type DraftMessage, entryOf, type Photo, REISSUE_MS } from "./outbox";
import type { Frame, Message, MessageInfo } from "./protocol";
import { type OutboxStore, Sender } from "./sender";
import type { Telemetry } from "./telemetry";

type Row = { kind: string; props: unknown; ok: unknown; ms: unknown };

/** a sender with no cache and no stream: nothing it does here touches the network */
function offline() {
  const rows: Row[] = [];
  const telemetry: Pick<Telemetry, "emit"> = { emit: (kind, props, envelope = {}) => void rows.push({ kind, props, ok: envelope.ok, ms: envelope.ms }) };
  const sender = new Sender(() => null, { device: "d", deviceClass: "phone" }, telemetry, (_: FromWorker) => undefined, new AbortController().signal);
  const outbox = () => sender.views();
  return { sender, rows, outbox };
}

const message = (over: Partial<MessageInfo>): Message => ({ info: { id: "msg_1", sessionID: "ses_a", role: "user", time: { created: 0 }, ...over } as MessageInfo, parts: [] });
const outgoing = { clientID: "c1", verb: "prompt" as const, target: { kind: "session" as const, host: "desk", session: "ses_a", directory: "/repo" }, text: "ok push", photos: [], model: null, effort: null, at: Date.now() };

/** a sender that says what it posts to the page, and a way to read it */
function talking() {
  const said: FromWorker[] = [];
  const sender = new Sender(() => null, { device: "d", deviceClass: "phone" }, { emit: () => undefined }, (m) => void said.push(m), new AbortController().signal);
  const of = <T extends FromWorker["type"]>(type: T) => said.filter((m): m is Extract<FromWorker, { type: T }> => m.type === type);
  return { sender, said, of };
}

/** answers every fetch the way a server would, for as long as `run` takes */
async function withAnswers(answer: (path: string, init?: RequestInit) => Response | Promise<Response>, run: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = ((path: string, init?: RequestInit) => Promise.resolve(answer(path, init))) as unknown as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the sender holding photos", () => {
  const MB = 1024 * 1024;
  const heavy = (clientID: string, megabytes: number) => ({ ...outgoing, clientID, photos: [{ mime: "image/heic", filename: "a.heic", url: "x".repeat(megabytes * MB), width: null, height: null }] });

  test("keeps messages with photos while they are under the outbox's bytes, and refuses one that would pass them", () => {
    const { sender, outbox } = offline();
    sender.send(heavy("c1", 24));
    sender.send(heavy("c2", 24));
    sender.send(heavy("c3", 24));
    expect(outbox().map((e) => e.state)).toEqual(["waiting", "waiting", "waiting"]);
    sender.send(heavy("c4", 1));
    const refused = outbox().find((e) => e.clientID === "c4");
    expect(refused?.state).toBe("failed");
    expect(refused?.error).toBe("too many photos are waiting to go, so this message did not go. its photo is back in the draft. edit it back there too, and send it when the others have gone");
  });

  test("the cap holds in bytes, and what it keeps out goes back to the draft whole: the message keeps its words alone", () => {
    const { sender, of } = talking();
    for (const id of ["c1", "c2", "c3"]) sender.send(heavy(id, 24));
    sender.send({ ...heavy("c4", 8), text: "look at this" });
    const kept = sender.views();
    expect(kept.reduce((sum, e) => sum + e.photoBytes, 0)).toBe(3 * 24 * MB);
    const refused = kept.find((e) => e.clientID === "c4");
    expect([refused?.text, refused?.photos, refused?.photoBytes, refused?.photosReturned]).toEqual(["look at this", 0, 0, 1]);
    // the photos are not thrown away: they are on their way back to the draft they came from, and the words stay on the card
    expect(of("returned")).toEqual([{ type: "returned", key: "desk:ses_a", photos: heavy("c4", 8).photos, text: null }]);
  });

  test("a message that fits the outbox hands nothing back", () => {
    const { sender, of } = talking();
    sender.send(heavy("c1", 24));
    sender.send(outgoing);
    expect(of("returned")).toEqual([]);
  });

  test("a refused message is not sent again by a retry, which would send its words alone", () => {
    const { sender, outbox } = offline();
    for (const id of ["c1", "c2", "c3"]) sender.send(heavy(id, 24));
    sender.send(heavy("c4", 1));
    sender.retry("c4");
    expect(outbox().find((e) => e.clientID === "c4")).toEqual(expect.objectContaining({ state: "failed", attempts: 0 }));
  });

  test("an unsend the daemon took brings back the message's words and photos together, before it says it took it", async () => {
    const { sender, said, of } = talking();
    const entry = { ...entryOf({ ...heavy("c1", 1), text: "ship it with the photo" }, false), state: "queued" as const, provisional: "msg_q1" };
    sender.restore([entry]);
    await withAnswers(() => json(200, {}), () => sender.unsend("desk:ses_a", "msg_q1", "c1", true));
    expect(of("returned")).toEqual([{ type: "returned", key: "desk:ses_a", photos: entry.photos, text: "ship it with the photo" }]);
    expect(of("unsent")).toEqual([expect.objectContaining({ ok: true, returned: true })]);
    // the words and the photos arrive in one message, ahead of the answer the composer waits on
    expect(said.findIndex((m) => m.type === "returned")).toBeLessThan(said.findIndex((m) => m.type === "unsent"));
  });

  test("an unsend of a message with words alone brings them back the same way", async () => {
    const { sender, of } = talking();
    sender.restore([{ ...entryOf({ ...outgoing, text: "only words" }, false), state: "queued", provisional: "msg_q1" }]);
    await withAnswers(() => json(200, {}), () => sender.unsend("desk:ses_a", "msg_q1", "c1", true));
    expect(of("returned")).toEqual([{ type: "returned", key: "desk:ses_a", photos: [], text: "only words" }]);
  });

  test("an unsend the daemon refused brings nothing back", async () => {
    const { sender, of } = talking();
    sender.restore([{ ...entryOf(heavy("c2", 1), false), state: "queued", provisional: "msg_q2" }]);
    await withAnswers(() => json(409, { error: { message: "no" } }), () => sender.unsend("desk:ses_a", "msg_q2", "c2", true));
    expect(of("returned")).toEqual([]);
    expect(of("unsent")).toEqual([expect.objectContaining({ ok: false, returned: false })]);
  });

  test("an unsend that is the first half of something else (a steer now) brings nothing back: the words go again from there", async () => {
    const { sender, of } = talking();
    sender.restore([{ ...entryOf(heavy("c1", 1), false), state: "queued", provisional: "msg_q1" }]);
    await withAnswers(() => json(200, {}), () => sender.unsend("desk:ses_a", "msg_q1", "c1"));
    expect(of("returned")).toEqual([]);
    expect(of("unsent")).toEqual([expect.objectContaining({ ok: true, returned: false })]);
  });

  test("an unsend answered 404 (it went, or another device took it back) ends the card instead of leaving it stuck", async () => {
    const { sender, of } = talking();
    sender.restore([{ ...entryOf(heavy("c2", 1), false), state: "queued", provisional: "msg_q2" }]);
    await withAnswers(() => json(404, { error: { message: "not found" } }), () => sender.unsend("desk:ses_a", "msg_q2", "c2", true));
    expect(sender.views()).toEqual([]);
    expect(of("returned")).toEqual([]);
    expect(of("unsent")).toEqual([expect.objectContaining({ ok: false, returned: false })]);
  });

  test("a message of another device's, which this outbox does not hold, brings nothing back", async () => {
    const { sender, of } = talking();
    await withAnswers(() => json(200, {}), () => sender.unsend("desk:ses_a", "msg_other", null, true));
    expect(of("returned")).toEqual([]);
    expect(of("unsent")).toEqual([expect.objectContaining({ ok: true, returned: false })]);
  });

  test("a failed message taken back to its draft hands its photos back, and one discarded without that hands none", () => {
    const { sender, of } = talking();
    const entry = (clientID: string) => ({ ...entryOf(heavy(clientID, 1), false), state: "failed" as const });
    sender.restore([entry("c1"), entry("c2")]);
    sender.discard("c1", true);
    sender.discard("c2");
    expect(of("returned")).toEqual([expect.objectContaining({ type: "returned", key: "desk:ses_a", text: null, photos: [expect.objectContaining({ filename: "a.heic" })] })]);
    expect(sender.views()).toEqual([]);
  });

  test("words go in whatever the photos hold", () => {
    const { sender, outbox } = offline();
    sender.send(heavy("c1", 24));
    sender.send(heavy("c2", 24));
    sender.send(heavy("c3", 24));
    sender.send({ ...outgoing, clientID: "c5" });
    expect(outbox().find((e) => e.clientID === "c5")?.state).toBe("waiting");
  });
});

describe("a server that waited for room for a message's photos and had none", () => {
  test("is an answer, not a connection to try again: three tries would be six minutes of waiting", async () => {
    const { sender } = talking();
    let posts = 0;
    sender.stream("live");
    await withAnswers(() => {
      posts += 1;
      return json(503, { error: { code: "photos-busy", message: "other photos kept boxbox busy for two minutes, so it could not take this message" } });
    }, async () => {
      sender.send(outgoing);
      await Bun.sleep(60);
    });
    expect(posts).toBe(1);
    expect(sender.views().map((e) => [e.state, e.error])).toEqual([["failed", "other photos kept boxbox busy for two minutes, so it could not take this message"]]);
  });

  test("while any other 503 (a server stopping) is still tried again", async () => {
    const { sender } = talking();
    let posts = 0;
    sender.stream("live");
    await withAnswers(() => {
      posts += 1;
      return json(503, { error: { code: "stopping", message: "the server is stopping; try again in a moment" } });
    }, async () => {
      sender.send(outgoing);
      await Bun.sleep(1300);
    });
    expect(posts).toBeGreaterThan(1);
  });
});

describe("the sender reading a transcript whole", () => {
  test("a send whose echo went by while the stream was away settles on its message in the transcript", () => {
    const { sender, rows, outbox } = offline();
    sender.send(outgoing);
    expect(outbox().map((e) => e.state)).toEqual(["waiting"]);
    sender.read("desk:ses_a", [message({ id: "msg_0" }), message({ clientID: "c1" })]);
    expect(outbox()).toEqual([]);
    expect(rows).toEqual([expect.objectContaining({ kind: "perf.send", ok: true })]);
  });

  test("a card already called not sent is cleared when the transcript shows it landed", () => {
    const { sender, outbox } = offline();
    sender.restore([{ ...entryOf(outgoing, false), state: "failed", attempts: 3, error: "the daemon did not confirm it. retry sends it once, never twice" }]);
    expect(outbox().map((e) => e.state)).toEqual(["failed"]);
    sender.read("desk:ses_a", [message({ clientID: "c1" })]);
    expect(outbox()).toEqual([]);
  });

  test("another thread's message with the same client id settles nothing", () => {
    const { sender, rows, outbox } = offline();
    sender.send(outgoing);
    sender.read("desk:ses_b", [message({ sessionID: "ses_b", clientID: "c1" })]);
    expect(outbox().map((e) => e.state)).toEqual(["waiting"]);
    expect(rows).toEqual([]);
  });
});

describe("a draft thrown away", () => {
  const draft = (text: string, photos = 0) => ({ text, photos: Array.from({ length: photos }, () => ({ mime: "image/jpeg", filename: "a.jpg", url: "data:", width: 1, height: 1 })), model: null, effort: null, at: Date.now() });

  test("is one friction.abandon row with the most it held, and no words from it", () => {
    const { sender, rows } = offline();
    sender.draft("desk:ses_a", draft("ok pu"));
    sender.draft("desk:ses_a", draft("ok push it", 1));
    sender.draft("desk:ses_a", draft("ok"));
    sender.draft("desk:ses_a", null, true);
    expect(rows).toEqual([expect.objectContaining({ kind: "friction.abandon", props: expect.objectContaining({ what: "compose", chars: 10, files: 1 }) })]);
    expect(JSON.stringify(rows)).not.toContain("push");
  });

  test("a draft cleared by its send is not abandoned", () => {
    const { sender, rows } = offline();
    sender.draft("desk:ses_a", draft("ok push"));
    sender.draft("desk:ses_a", null);
    expect(rows).toEqual([]);
  });
});

describe("a draft with photos on every keystroke", () => {
  type Write = { key: string; words: Draft | null; photos: readonly Photo[] | undefined };
  /** a sender whose cache records what each draft write carried */
  function recording() {
    const writes: Write[] = [];
    /** the writes the store refuses (the quota): while it is above zero, each putDraft rejects and counts one off */
    const refusing = { count: 0 };
    const store: OutboxStore = {
      putDraft: (key, words, photos) => {
        writes.push({ key, words, photos });
        if (refusing.count > 0) {
          refusing.count -= 1;
          return Promise.reject(new Error("QuotaExceededError"));
        }
        return Promise.resolve();
      },
      putEntry: () => Promise.resolve(),
    };
    const telemetry: Pick<Telemetry, "emit"> = { emit: () => undefined };
    const said: FromWorker[] = [];
    const sender = new Sender(() => store, { device: "d", deviceClass: "phone" }, telemetry, (m: FromWorker) => void said.push(m), new AbortController().signal);
    return { sender, writes, refusing, said };
  }
  const photo = (name: string): Photo => ({ mime: "image/heic", filename: name, url: "data:image/heic;base64,AAAA", width: null, height: null });
  const words = (text: string, photos: Photo[] | "kept"): DraftMessage => ({ text, photos, model: null, effort: null, at: 1 });
  const key = "desk:ses_a";

  test("writes the photos when the set changes, and only the words on the keystrokes after", async () => {
    const { sender, writes } = recording();
    sender.draft(key, words("", [photo("a.heic")]));
    await sender.flush();
    sender.draft(key, words("w", "kept"));
    sender.draft(key, words("wh", "kept"));
    await sender.flush();
    expect(writes).toHaveLength(2);
    expect(writes[0]?.photos).toEqual([photo("a.heic")]);
    expect(writes[1]?.photos).toBeUndefined();
    expect(writes[1]?.words).toEqual({ text: "wh", photos: [], model: null, effort: null, at: 1 });
  });

  test("a words record never holds photos, so the keystrokes cannot rewrite them", async () => {
    const { sender, writes } = recording();
    sender.draft(key, words("look", [photo("a.heic"), photo("b.heic")]));
    await sender.flush();
    expect(writes[0]?.words?.photos).toEqual([]);
  });

  test("removing the last photo writes an empty set, which forgets them", async () => {
    const { sender, writes } = recording();
    sender.draft(key, words("look", [photo("a.heic")]));
    await sender.flush();
    sender.draft(key, words("look", []));
    await sender.flush();
    expect(writes[1]?.photos).toEqual([]);
    sender.draft(key, words("look at it", "kept"));
    await sender.flush();
    expect(writes[2]?.photos).toBeUndefined();
  });

  test("forgetting a draft forgets its photos, and the next keystroke has none to keep", async () => {
    const { sender, writes } = recording();
    sender.draft(key, words("look", [photo("a.heic")]));
    sender.draft(key, null);
    await sender.flush();
    expect(writes).toEqual([{ key, words: null, photos: undefined }]);
  });

  test("a restored draft writes its photos with its first edit, once, whichever record they were read from", async () => {
    const { sender, writes } = recording();
    // a draft from before the photos had a record of their own: the words record held them
    sender.restore([], { [key]: { text: "look", photos: [photo("a.heic"), photo("b.jpg")], model: null, effort: null, at: 1 } });
    await sender.flush();
    expect(writes).toEqual([]);
    sender.draft(key, words("look at", "kept"));
    await sender.flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.words?.photos).toEqual([]);
    expect(writes[0]?.photos).toEqual([photo("a.heic"), photo("b.jpg")]);
    sender.draft(key, words("look at it", "kept"));
    await sender.flush();
    expect(writes[1]?.photos).toBeUndefined();
  });

  test("a write that failed is tried again with the photo set, and a keystroke between cannot lose it", async () => {
    const { sender, writes, refusing } = recording();
    refusing.count = 1;
    sender.draft(key, words("look", [photo("a.heic"), photo("b.jpg")]));
    await sender.flush();
    sender.draft(key, words("look at it", "kept"));
    await sender.flush();
    expect(writes).toHaveLength(2);
    expect(writes[1]?.words?.text).toBe("look at it");
    expect(writes[1]?.photos).toEqual([photo("a.heic"), photo("b.jpg")]);
  });

  test("a failed write comes back on its own after a pause, with nothing typed", async () => {
    const { sender, writes, refusing } = recording();
    refusing.count = 1;
    sender.draft(key, words("look", [photo("a.heic")]));
    await sender.flush();
    expect(writes).toHaveLength(1);
    await Bun.sleep(3200);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.photos).toEqual([photo("a.heic")]);
  });

  test("a failed write does not bring back words a newer edit replaced, or a draft that was cleared since", async () => {
    const { sender, writes, refusing } = recording();
    refusing.count = 2;
    sender.draft(key, words("look", [photo("a.heic")]));
    sender.draft("desk:ses_b", words("other", "kept"));
    await sender.flush();
    sender.draft(key, null);
    sender.draft("desk:ses_b", words("other still", "kept"));
    await sender.flush();
    expect(writes.slice(2)).toEqual([
      { key, words: null, photos: undefined },
      { key: "desk:ses_b", words: expect.objectContaining({ text: "other still" }), photos: undefined },
    ]);
  });

  test("one draft's write does not spend another's photo mark", async () => {
    const { sender, writes } = recording();
    sender.restore([], { "desk:ses_b": { text: "", photos: [photo("b.heic")], model: null, effort: null, at: 1 } });
    sender.draft(key, words("hello", "kept"));
    await sender.flush();
    sender.draft("desk:ses_b", words("later", "kept"));
    await sender.flush();
    expect(writes.map((w) => [w.key, w.photos])).toEqual([[key, undefined], ["desk:ses_b", [photo("b.heic")]]]);
  });

  test("a slow write that fails does not put its older words over a newer write that landed", async () => {
    const writes: Write[] = [];
    const slow: Array<(error: Error) => void> = [];
    const store: OutboxStore = {
      putDraft: (k, words, photos) => {
        writes.push({ key: k, words, photos });
        // the first write is slow, and ends in an error after the next one has landed
        return writes.length === 1 ? new Promise((_, reject) => void slow.push(reject)) : Promise.resolve();
      },
      putEntry: () => Promise.resolve(),
    };
    const sender = new Sender(() => store, { device: "d", deviceClass: "phone" }, { emit: () => undefined }, (_: FromWorker) => undefined, new AbortController().signal);
    sender.draft(key, words("one", [photo("a.heic")]));
    const first = sender.flush();
    sender.draft(key, words("two", "kept"));
    await sender.flush();
    slow[0]?.(new Error("QuotaExceededError"));
    await first;
    await sender.flush();
    // the retry is made from the newest words, with the photo set the slow write was to carry
    expect(writes.map((w) => w.words?.text)).toEqual(["one", "two", "two"]);
    expect(writes[2]?.photos).toEqual([photo("a.heic")]);
  });

  test("a write that keeps failing tells the person after a few rounds, once, and again when it lands", async () => {
    const { sender, writes, refusing, said } = recording();
    const drafts = () => said.filter((m) => m.type === "drafts");
    refusing.count = 5;
    sender.draft(key, words("look", [photo("a.heic")]));
    await sender.flush();
    await sender.flush();
    expect(drafts()).toEqual([]);
    await sender.flush();
    expect(drafts()).toEqual([{ type: "drafts", kept: false }]);
    await sender.flush();
    await sender.flush();
    expect(drafts()).toEqual([{ type: "drafts", kept: false }]);
    await sender.flush();
    expect(drafts()).toEqual([{ type: "drafts", kept: false }, { type: "drafts", kept: true }]);
    expect(writes).toHaveLength(6);
    // every try carried the photo set until one landed, and none after
    expect(writes.map((w) => w.photos?.length)).toEqual([1, 1, 1, 1, 1, 1]);
    sender.draft(key, words("look at it", "kept"));
    await sender.flush();
    expect(writes[6]?.photos).toBeUndefined();
  });

  test("a draft that never failed says nothing about room", async () => {
    const { sender, said } = recording();
    sender.draft(key, words("look", [photo("a.heic")]));
    await sender.flush();
    expect(said.filter((m) => m.type === "drafts")).toEqual([]);
  });

  test("an edit while writes are failing waits for the retry, which is not made sooner by typing", async () => {
    const { sender, writes, refusing } = recording();
    refusing.count = 1;
    sender.draft(key, words("look", [photo("a.heic")]));
    await sender.flush();
    expect(writes).toHaveLength(1);
    sender.draft(key, words("look at it", "kept"));
    await Bun.sleep(500);
    // past the 300 ms a pause in typing normally waits, and nothing was written: the retry's own time stands
    expect(writes).toHaveLength(1);
    await sender.flush();
    expect(writes[1]?.words?.text).toBe("look at it");
    expect(writes[1]?.photos).toEqual([photo("a.heic")]);
  });

  test("edits that come in while a write is in flight are written after it, on their own pause", async () => {
    const { sender, writes } = recording();
    sender.draft(key, words("one", "kept"));
    await sender.flush();
    sender.draft(key, words("two", "kept"));
    await Bun.sleep(450);
    expect(writes.map((w) => w.words?.text)).toEqual(["one", "two"]);
  });

  test("the abandon row counts the photos a keystroke did not carry", () => {
    const rows: Array<{ kind: string; props: unknown }> = [];
    const telemetry: Pick<Telemetry, "emit"> = { emit: (kind, props) => void rows.push({ kind, props }) };
    const sender = new Sender(() => null, { device: "d", deviceClass: "phone" }, telemetry, (_: FromWorker) => undefined, new AbortController().signal);
    sender.draft(key, words("", [photo("a.heic"), photo("b.heic")]));
    sender.draft(key, words("hm", "kept"));
    sender.draft(key, null, true);
    expect(rows).toEqual([expect.objectContaining({ kind: "friction.abandon", props: expect.objectContaining({ chars: 2, files: 2 }) })]);
  });
});

describe("a post the network never answers", () => {
  test("ends when the stream drops, and its send waits on the device with the same id", async () => {
    const real = globalThis.fetch;
    const hung: Array<AbortSignal | null | undefined> = [];
    // a fetch that only ever ends by its signal, like one on a network that vanished without a reset
    globalThis.fetch = ((_: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        hung.push(init?.signal);
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    try {
      const { sender, outbox } = offline();
      sender.stream("live");
      sender.send(outgoing);
      await Bun.sleep(5);
      expect(outbox().map((e) => [e.state, e.attempts])).toEqual([["sending", 1]]);
      sender.stream("down");
      await Bun.sleep(5);
      expect(outbox().map((e) => [e.state, e.attempts, e.clientID])).toEqual([["waiting", 0, "c1"]]);
      expect(hung[0]?.aborted).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("photos and files on the wire", () => {
  const pdf: Photo = { mime: "application/pdf", filename: "brief.pdf", url: "data:application/pdf;base64,JVBERg==", width: null, height: null };
  const jpeg: Photo = { mime: "image/jpeg", filename: "gap.jpg", url: "data:image/jpeg;base64,AAAA", width: 2, height: 2 };

  test("one list in the outbox goes as the photos and the files the route takes, each with its kind, name and bytes", async () => {
    const bodies: Record<string, unknown>[] = [];
    await withAnswers(
      (_, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json(202, { messageID: "msg_1" });
      },
      async () => {
        const { sender } = offline();
        sender.stream("live");
        sender.send({ ...outgoing, photos: [jpeg, pdf] });
        sender.send({ ...outgoing, clientID: "c2" });
        await Bun.sleep(10);
      },
    );
    expect(bodies[0]?.["photos"]).toEqual([{ mime: "image/jpeg", filename: "gap.jpg", url: jpeg.url }]);
    expect(bodies[0]?.["files"]).toEqual([{ mime: "application/pdf", filename: "brief.pdf", url: pdf.url }]);
    // words alone carry no files at all, as they always went
    expect(bodies[1]).not.toHaveProperty("files");
  });
});

describe("a new thread's first send", () => {
  const start = { clientID: "n1", verb: "start" as const, target: { kind: "new" as const, host: "desk", directory: "/repo", place: "checkout" as const }, text: "hello", photos: [], model: null, effort: null, at: Date.now() };
  const withPosts = () => {
    const posted: FromWorker[] = [];
    const telemetry: Pick<Telemetry, "emit"> = { emit: () => undefined };
    const sender = new Sender(() => null, { device: "d", deviceClass: "phone" }, telemetry, (m: FromWorker) => void posted.push(m), new AbortController().signal);
    const born = () => posted.filter((m) => m.type === "born");
    return { sender, born };
  };

  test("names its session once the server answers, before the echo can drop the entry", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ session: "ses_mine", directory: "/repo" }), { status: 201, headers: { "content-type": "application/json" } }))) as unknown as typeof fetch;
    try {
      const { sender, born } = withPosts();
      sender.stream("live");
      sender.send(start);
      await Bun.sleep(10);
      expect(born()).toEqual([{ type: "born", clientID: "n1", key: "desk:ses_mine" }]);
      // the echo that lands it does not name it a second time
      sender.read("desk:ses_mine", [message({ sessionID: "ses_mine", clientID: "n1" })]);
      expect(born()).toHaveLength(1);
      expect(sender.views()).toEqual([]);
    } finally {
      globalThis.fetch = real;
    }
  });

  test("names its session from the echo when the answer was missed", () => {
    const { sender, born } = withPosts();
    sender.send(start);
    sender.read("desk:ses_found", [message({ sessionID: "ses_found", clientID: "n1" })]);
    expect(born()).toEqual([{ type: "born", clientID: "n1", key: "desk:ses_found" }]);
    expect(sender.views()).toEqual([]);
  });

  test("a refusal names no session", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ error: { message: "nothing at /repo on desk, so the thread did not start. pick another folder, or make it and retry." } }), { status: 400, headers: { "content-type": "application/json" } }))) as unknown as typeof fetch;
    try {
      const { sender, born } = withPosts();
      sender.stream("live");
      sender.send(start);
      await Bun.sleep(10);
      expect(born()).toEqual([]);
      expect(sender.views().map((e) => [e.state, e.attempts])).toEqual([["failed", 1]]);
    } finally {
      globalThis.fetch = real;
    }
  });

  test("a host's own refusal (422) is answered at once and never posted twice", async () => {
    const real = globalThis.fetch;
    let posts = 0;
    globalThis.fetch = (() => {
      posts += 1;
      return Promise.resolve(new Response(JSON.stringify({ error: { message: "the host \"desk\" refused it: no" } }), { status: 422, headers: { "content-type": "application/json" } }));
    }) as unknown as typeof fetch;
    try {
      const { sender } = withPosts();
      sender.stream("live");
      sender.send(start);
      await Bun.sleep(30);
      expect(posts).toBe(1);
      expect(sender.views().map((e) => e.state)).toEqual(["failed"]);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("a queued send another device took back", () => {
  afterEach(() => setSystemTime());
  const removal = { type: "message.removed", key: "desk:ses_a", sessionID: "ses_a", messageID: "msg_q1", seq: 1, upstream: null } as unknown as Frame;
  const check = (sender: Sender) => (sender as unknown as { check(): void }).check();

  test("leaves the outbox when no reissue follows the removal", () => {
    setSystemTime(new Date(1_000_000));
    const { sender } = talking();
    sender.restore([{ ...entryOf(outgoing, false), state: "queued", provisional: "msg_q1" }]);
    sender.stream("live");
    sender.frame(removal);
    expect(sender.views()).toHaveLength(1);
    setSystemTime(new Date(1_000_000 + REISSUE_MS + 1));
    check(sender);
    expect(sender.views()).toEqual([]);
  });

  test("stays and settles when the removal was the landing's first half", () => {
    setSystemTime(new Date(1_000_000));
    const { sender } = talking();
    sender.restore([{ ...entryOf({ ...outgoing, clientID: "c9" }, false), state: "queued", provisional: "msg_q1" }]);
    sender.stream("live");
    sender.frame(removal);
    sender.frame({ type: "message", key: "desk:ses_a", info: message({ id: "msg_q1b", clientID: "c9", queued: true }).info, seq: 2, upstream: null } as unknown as Frame);
    setSystemTime(new Date(1_000_000 + REISSUE_MS + 1));
    check(sender);
    expect(sender.views().map((e) => [e.state, e.provisional])).toEqual([["queued", "msg_q1b"]]);
  });
});
