import { describe, expect, test } from "bun:test";
import { answered, DRAFT_TROUBLE_AFTER, draftRetryMs, echoed, entryOf, hostAcceptMs, joinDraft, MAX_ATTEMPTS, mergePhotos, nextWaiting, orphaned, OUTBOX_PHOTO_BYTES, overdue, PHOTO_WAIT_MS, type Photo, perfVerb, photoBytes, photosNotFitted, postBudgetMs, REISSUE_MS, removed, splitDraft, takeBackDraft, targetKey, type Target, viewOfEntry } from "./outbox";
import type { MessageInfo } from "./protocol";
import { type RawEvent, type RowStore, Telemetry } from "./telemetry";

const thread: Target = { kind: "session", host: "desk", session: "ses_a", directory: "/repo" };
const fresh: Target = { kind: "new", host: "desk", directory: "/repo", place: "fresh" };
const make = (target: Target = thread, live = true, at = 1000) => entryOf({ clientID: "c1", verb: "prompt", target, text: "ok push", photos: [], model: null, effort: null, at }, live);
const info = (over: Partial<MessageInfo>): MessageInfo => ({ id: "msg_1", sessionID: "ses_a", role: "user", time: { created: 0 }, ...over }) as MessageInfo;

describe("an outbox entry", () => {
  test("waits on the device while the stream is down, and is posted when it is live", () => {
    expect(make(thread, false).state).toBe("waiting");
    expect(make(thread, true).state).toBe("sending");
  });

  test("is not sent until the daemon echoes its client id, whatever the http answer said", () => {
    const taken = answered(make(), { kind: "taken" }, 1100);
    expect(taken.state).toBe("sending");
    expect(taken.ackAt).toBeNull();
    const landed = echoed(taken, "desk:ses_a", info({ clientID: "c1" }), 1300);
    expect(landed.state).toBe("landed");
    expect(landed.ackAt).toBe(1300);
  });

  test("an echo for another client id or another thread changes nothing", () => {
    const entry = make();
    expect(echoed(entry, "desk:ses_a", info({ clientID: "c2" }), 1)).toBe(entry);
    expect(echoed(entry, "desk:ses_b", info({ clientID: "c1" }), 1)).toBe(entry);
  });

  test("a queued echo keeps the provisional id unsend needs, and the landing that follows settles it", () => {
    const queued = echoed(make(), "desk:ses_a", info({ id: "msg_q1", clientID: "c1", queued: true }), 1200);
    expect(queued.state).toBe("queued");
    expect(queued.provisional).toBe("msg_q1");
    // the daemon removes the provisional message, then reissues it under its transcript id
    const stillThere = removed(queued, "desk:ses_a", "msg_q1", 1300);
    expect(stillThere).toEqual({ ...queued, removedAt: 1300 });
    const landed = echoed(stillThere ?? queued, "desk:ses_a", info({ id: "msg_9", clientID: "c1" }), 9000);
    expect(landed.state).toBe("landed");
    expect(landed.removedAt).toBeUndefined();
    expect(landed.ackAt).toBe(1200);
    expect(perfVerb(queued)).toBe("queue");
  });

  test("an unsend in flight ends the entry when the provisional message is removed", () => {
    const queued = { ...echoed(make(), "desk:ses_a", info({ id: "msg_q1", clientID: "c1", queued: true }), 1200), unsending: true };
    expect(removed(queued, "desk:ses_a", "msg_q1", 1300)).toBeNull();
  });

  test("a removal this device did not ask for, with no reissue while the stream is live, was another device's unsend", () => {
    const queued = echoed(make(), "desk:ses_a", info({ id: "msg_q1", clientID: "c1", queued: true }), 1200);
    expect(orphaned(queued, 0, 1_000_000)).toBe(false);
    const gone = removed(queued, "desk:ses_a", "msg_q1", 2000);
    if (!gone) throw new Error("kept");
    // a second removal frame does not restart the wait
    expect(removed(gone, "desk:ses_a", "msg_q1", 5000)).toBe(gone);
    expect(orphaned(gone, 0, 2000 + REISSUE_MS)).toBe(false);
    expect(orphaned(gone, 0, 2001 + REISSUE_MS)).toBe(true);
    // the wait counts only time the stream was live, from when it came back
    expect(orphaned(gone, null, 1_000_000)).toBe(false);
    expect(orphaned(gone, 50_000, 50_000 + REISSUE_MS)).toBe(false);
    // a reissue that came under a new provisional id clears the mark
    const requeued = echoed(gone, "desk:ses_a", info({ id: "msg_q2", clientID: "c1", queued: true }), 3000);
    expect(orphaned(requeued, 0, 1_000_000)).toBe(false);
  });

  test("a network failure retries with the same client id until the last attempt, then says so", () => {
    let entry = { ...make(), attempts: 1 };
    entry = answered(entry, { kind: "unreachable", message: "the desk host did not answer" }, 2000);
    expect(entry.state).toBe("sending");
    entry = answered({ ...entry, attempts: MAX_ATTEMPTS }, { kind: "unreachable", message: "the desk host did not answer" }, 3000);
    expect(entry.state).toBe("failed");
    expect(entry.error).toBe("the desk host did not answer");
    expect(entry.clientID).toBe("c1");
  });

  test("a refusal fails at once with the server's words", () => {
    const entry = answered(make(), { kind: "refused", message: "write something, or add a photo" }, 2000);
    expect(entry.state).toBe("failed");
  });

  test("a shell line's answer is its echo", () => {
    const shell = entryOf({ clientID: "c3", verb: "shell", target: thread, text: "git log", photos: [], model: null, effort: null, at: 0 }, true);
    expect(answered(shell, { kind: "taken", landed: true }, 50).state).toBe("landed");
  });

  test("a new thread learns its session from the server and settles on that session's echo", () => {
    const born = answered(make(fresh), { kind: "taken", session: "ses_new" }, 1100);
    expect(targetKey(fresh)).toBe("new:desk:/repo");
    expect(echoed(born, "desk:ses_other", info({ clientID: "c1" }), 1200).state).toBe("sending");
    expect(echoed(born, "desk:ses_new", info({ clientID: "c1", sessionID: "ses_new" }), 1200).state).toBe("landed");
  });

  test("is overdue only after its echo was missing for 30 s of live stream", () => {
    const posted = { ...make(), attempts: 1 };
    expect(overdue(posted, null, 99_999)).toBe(false);
    expect(overdue(posted, 50_000, 70_000)).toBe(false);
    expect(overdue(posted, 50_000, 80_001)).toBe(true);
  });

  test("offline sends go out in the order they were written", () => {
    const a = { ...make(thread, false, 300), clientID: "a" };
    const b = { ...make(thread, false, 100), clientID: "b" };
    expect(nextWaiting([a, b])?.clientID).toBe("b");
  });
});

/* telemetry rows ride the same outbox (telemetry.ts): kept from the moment they are written until the server takes
   their batch, sent again by the next start when a page closed first. the server here is a real http server on a
   free port; the store is the outbox's shape held in memory, as indexeddb would hold it across a close */
describe("a telemetry row in the outbox", () => {
  type Seen = { status: number; batches: string[][] };
  function server(status: () => number) {
    const seen: Seen = { status: 0, batches: [] };
    const http = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { events: RawEvent[] };
        seen.batches.push(body.events.map((e) => e.id));
        seen.status = status();
        return new Response(null, { status: seen.status });
      },
    });
    return { url: `http://127.0.0.1:${http.port}/api/telemetry`, seen, stop: () => http.stop(true) };
  }
  function memoryStore() {
    const rows = new Map<string, RawEvent>();
    const store: RowStore = {
      put: async (list) => {
        for (const row of list) rows.set(row.id, row);
      },
      forget: async (ids) => {
        for (const id of ids) rows.delete(id);
      },
    };
    return { rows, store };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  test("is kept until the server takes its batch, then forgotten", async () => {
    const http = server(() => 204);
    const kept = memoryStore();
    const telemetry = new Telemetry("dev_1", "mac", () => {}, () => kept.store, http.url);
    telemetry.emit("perf.send", { verb: "prompt" }, { id: "r1", ok: true, ms: 12 });
    await settle();
    expect([...kept.rows.keys()]).toEqual(["r1"]);
    await telemetry.flush();
    await settle();
    expect(http.seen.batches).toEqual([["r1"]]);
    expect(kept.rows.size).toBe(0);
    telemetry.stop();
    http.stop();
  });

  test("written before a page closed, it is delivered by the next start", async () => {
    let up = false;
    const http = server(() => (up ? 204 : 503));
    const kept = memoryStore();
    const before = new Telemetry("dev_1", "mac", () => {}, () => kept.store, http.url);
    before.emit("friction.abandon", { what: "compose", chars: 40 }, { id: "r2" });
    await before.flush(); // the server could not take it, then the page went away with the worker
    before.stop();
    await settle();
    expect([...kept.rows.keys()]).toEqual(["r2"]);

    up = true;
    const flushed: string[][] = [];
    const after = new Telemetry("dev_1", "mac", (ids) => flushed.push(ids), () => kept.store, http.url);
    after.restore([...kept.rows.values()]);
    await settle();
    expect(http.seen.batches.at(-1)).toEqual(["r2"]);
    expect(flushed).toEqual([["r2"]]);
    expect(kept.rows.size).toBe(0);
    after.stop();
    http.stop();
  });

  test("one the server refuses outright is not kept to be refused again", async () => {
    const http = server(() => 400);
    const kept = memoryStore();
    const telemetry = new Telemetry("dev_1", "mac", () => {}, () => kept.store, http.url);
    telemetry.emit("perf.send", { verb: "reply" }, { id: "r3", ok: false, ms: 900 });
    await telemetry.flush();
    await settle();
    expect(kept.rows.size).toBe(0);
    telemetry.stop();
    http.stop();
  });

  test("a row already sent by the closed page is not queued twice by the next start", async () => {
    const http = server(() => 204);
    const kept = memoryStore();
    const telemetry = new Telemetry("dev_1", "mac", () => {}, () => kept.store, http.url);
    telemetry.emit("perf.send", { verb: "queue" }, { id: "r4", ok: true, ms: 30 });
    telemetry.restore([...kept.rows.values()]);
    await settle();
    expect(http.seen.batches.flat().filter((id) => id === "r4")).toHaveLength(1);
    telemetry.stop();
    http.stop();
  });
});

describe("an entry's photos", () => {
  const photo = (length: number, mime = "image/jpeg"): Photo => ({ mime, filename: "a", url: "x".repeat(length), width: null, height: null });
  const MB = 1024 * 1024;

  test("the ui sees how many and how many bytes, never the photos themselves", () => {
    const entry = entryOf({ clientID: "c1", verb: "prompt", target: thread, text: "", photos: [photo(100), photo(250)], model: null, effort: null, at: 1 }, true);
    const view = viewOfEntry(entry);
    expect(view.photos).toBe(2);
    expect(view.files).toBe(0);
    expect(view.photoBytes).toBe(350);
    // a file rides in the same list, and the view counts it apart for the card's words
    const mixed = entryOf({ clientID: "c2", verb: "prompt", target: thread, text: "", photos: [photo(100), photo(30, "application/pdf")], model: null, effort: null, at: 1 }, true);
    expect(viewOfEntry(mixed).files).toBe(1);
    expect(photoBytes(entry.photos)).toBe(350);
  });

  test("the outbox holds three messages at the server's limit for one, and no more", () => {
    expect(OUTBOX_PHOTO_BYTES).toBe(3 * (24 * MB + 56));
  });
});

describe("how long a post may take", () => {
  const photo = (length: number, mime = "image/jpeg"): Photo => ({ mime, filename: "a", url: "x".repeat(length), width: 1, height: 1 });
  const MB = 1024 * 1024;

  test("words get the server's 15 s and the margin, the 20 s a post always had, and wait for no room", () => {
    expect(postBudgetMs([], 5_000)).toBe(20_000);
  });

  test("a message with photos is given the wait for room in the server's photo budget as well, whatever it weighs", () => {
    expect(PHOTO_WAIT_MS).toBe(120_000);
    expect(postBudgetMs([photo(100)], 5_000)).toBe(5_000 + PHOTO_WAIT_MS + 1 + hostAcceptMs([photo(100)]));
  });

  test("the host's time to take a message is the server's: 15 s, bytes at 256 KiB a second, 75 s for each heic or heif", () => {
    expect(hostAcceptMs([photo(1.5 * MB)])).toBe(15_000 + 6_000);
    expect(hostAcceptMs([photo(12 * MB, "image/heic")])).toBe(15_000 + 48_000 + 75_000);
    expect(hostAcceptMs([photo(12 * MB, "image/heic"), photo(12 * MB, "image/heif")])).toBe(15_000 + 2 * (48_000 + 75_000));
  });

  test("a post outlasts the upload and everything the server waits for, with the margin to spare", () => {
    for (const photos of [[photo(1.5 * MB)], [photo(12 * MB, "image/heic")], [photo(12 * MB, "image/heic"), photo(12 * MB, "image/heif")], [photo(1.5 * MB), photo(1.5 * MB), photo(1.5 * MB), photo(1.5 * MB)]]) {
      const upload = (photoBytes(photos) / 200_000) * 1000;
      expect(postBudgetMs(photos, 5_000)).toBeGreaterThanOrEqual(PHOTO_WAIT_MS + upload + hostAcceptMs(photos) + 5_000);
    }
  });

  test("two heics at the limit are given about eight and a half minutes: the wait for room, the upload, the conversions", () => {
    const two = [photo(12 * MB, "image/heic"), photo(12 * MB, "image/heif")];
    expect(Math.round(postBudgetMs(two, 5_000) / 1000)).toBe(5 + 120 + 126 + 261);
  });
});

describe("a draft write that keeps failing", () => {
  test("is tried again after 3 s, then 6, 12, 24, 48, and never less often than every minute", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(draftRetryMs)).toEqual([3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000, 60_000]);
  });

  test("tells the person after a few rounds in a row, not after one", () => {
    expect(DRAFT_TROUBLE_AFTER).toBe(3);
  });
});

describe("what a message the person took back leaves in the draft it came from", () => {
  const photo = (name: string, length = 10): Photo => ({ mime: "image/heic", filename: name, url: "x".repeat(length), width: null, height: null });
  const held = (text: string, photos: Photo[] = []) => ({ text, photos, model: "p/m", effort: null, at: 1 });

  test("is its words and its photos together, in a draft that held nothing", () => {
    const back = takeBackDraft(undefined, { photos: [photo("a")], text: "fix this" }, 9);
    expect(back.draft).toEqual({ text: "fix this", photos: [photo("a")], model: null, effort: null, at: 9 });
    expect(back.lost).toBe(0);
    expect(back.kept).toBe(false);
  });

  test("judges the draft before the photos come: words with photos coming back are not a draft being written", () => {
    // the failure this prevents: photos joined the draft first, so the words, which the daemon had already deleted, were dropped
    const back = takeBackDraft(held(""), { photos: [photo("a"), photo("b")], text: "fix this" }, 9);
    expect(back.draft.text).toBe("fix this");
    expect(back.draft.photos).toHaveLength(2);
    expect(back.draft.model).toBe("p/m");
  });

  test("leaves the words being written alone, and adds the photos after the ones held", () => {
    const back = takeBackDraft(held("another thing", [photo("held")]), { photos: [photo("a")], text: "fix this" }, 9);
    expect(back.draft.text).toBe("another thing");
    expect(back.draft.photos.map((p) => p.filename)).toEqual(["held", "a"]);
  });

  test("counts photos already in the draft as a draft being written, so the words stay out", () => {
    const back = takeBackDraft(held("", [photo("held")]), { photos: [], text: "fix this" }, 9);
    expect(back.draft.text).toBe("");
  });

  test("brings no words when it carries none (the ui puts a failed send's words back itself)", () => {
    const back = takeBackDraft(held(""), { photos: [photo("a")], text: null }, 9);
    expect(back.draft.text).toBe("");
    expect(back.draft.photos).toHaveLength(1);
  });

  test("says the draft's own photos were not changed when none came back, so they are not sent to the worker again", () => {
    const back = takeBackDraft(held("", [photo("held")]), { photos: [], text: null }, 9);
    expect(back.kept).toBe(true);
    expect(takeBackDraft(held(""), { photos: [], text: "words only" }, 9).kept).toBe(true);
  });

  test("counts the photos that did not fit", () => {
    const back = takeBackDraft(held("", [photo("1"), photo("2"), photo("3")]), { photos: [photo("a"), photo("b")], text: null }, 9);
    expect(back.draft.photos).toHaveLength(4);
    expect(back.lost).toBe(1);
  });
});

describe("what is said of photos that did not fit the draft they came back to", () => {
  test("says how many, the most a message takes in the same units the composer uses, and that they must be picked again", () => {
    expect(photosNotFitted(1)).toBe("1 photo did not fit the draft (a message takes at most 4 photos and files, 18 mb together) and boxbox no longer holds it. pick it again from your library for another message");
    expect(photosNotFitted(3)).toBe("3 photos did not fit the draft (a message takes at most 4 photos and files, 18 mb together) and boxbox no longer holds them. pick them again from your library for another message");
  });
});

describe("a draft kept in two records", () => {
  const photo: Photo = { mime: "image/heic", filename: "a.heic", url: "data:image/heic;base64,AAAA", width: null, height: null };
  const draft = { text: "look", photos: [photo], model: null, effort: null, at: 5 };

  test("the words record holds no photos and the photos record holds all of them", () => {
    const { words, photos } = splitDraft(draft);
    expect(words).toEqual({ ...draft, photos: [] });
    expect(photos).toEqual([photo]);
  });

  test("the two records read back as the draft", () => {
    const { words, photos } = splitDraft(draft);
    expect(joinDraft(words, photos)).toEqual(draft);
  });

  test("words with no photos record are a draft with none", () => {
    expect(joinDraft({ ...draft, photos: [] }, undefined)).toEqual({ ...draft, photos: [] });
  });

  test("a record written before the split still holds its photos, and reads as them", () => {
    expect(joinDraft(draft, undefined).photos).toEqual([photo]);
  });
});

describe("photos handed back to a draft", () => {
  const photo = (name: string, length = 10): Photo => ({ mime: "image/heic", filename: name, url: "x".repeat(length), width: null, height: null });

  test("go after the ones the draft holds", () => {
    expect(mergePhotos([photo("a")], [photo("b"), photo("c")])).toEqual({ photos: [photo("a"), photo("b"), photo("c")], lost: 0 });
  });

  test("stop at the most a message carries, and count the ones left out", () => {
    const held = [photo("a"), photo("b"), photo("c")];
    expect(mergePhotos(held, [photo("d"), photo("e")])).toEqual({ photos: [...held, photo("d")], lost: 1 });
  });

  test("stop at the bytes a message carries", () => {
    const MB = 1024 * 1024;
    const merged = mergePhotos([photo("a", 12 * MB)], [photo("b", 12 * MB), photo("c", 100)]);
    expect(merged.photos.map((p) => p.filename)).toEqual(["a", "b"]);
    expect(merged.lost).toBe(1);
  });
});
