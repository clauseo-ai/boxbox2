import { describe, expect, test } from "bun:test";
import { parseMessages, type ReadPlan, type ReadTrouble, readTranscript } from "./read";

/* the transcript read's rules, with the answers of the wire put in by hand: wire fixtures, never a daemon */

const SEQ = { "x-boxbox-seq": "j1:40", "x-boxbox-upstream": "u1:10" };
const ONE = [{ info: { id: "msg_1", thread: "ses_1", role: "user", created: 1 }, parts: [] }];
const MESSAGES = JSON.stringify({ messages: ONE, older: null, total: 1, turns: 1 });

/** a response whose body reads are counted */
function answer(body: string, init: ResponseInit = { headers: SEQ }) {
  const response = new Response(body, init);
  const reads = { text: 0, cancelled: 0 };
  const text = response.text.bind(response);
  response.text = () => {
    reads.text++;
    return text();
  };
  const cancel = response.body?.cancel.bind(response.body);
  if (response.body && cancel) response.body.cancel = (reason?: unknown) => (reads.cancelled++, cancel(reason));
  return { response, reads };
}

function plan(answers: (Response | null)[], wanted: () => boolean = () => true): ReadPlan & { waits: number[]; asked: () => number; troubles: ReadTrouble[]; sent: Record<string, string>[] } {
  let asked = 0;
  const waits: number[] = [];
  const troubles: ReadTrouble[] = [];
  const sent: Record<string, string>[] = [];
  return {
    path: "/api/agents/bench/threads/ses_1/messages",
    get: (_path, headers) => {
      sent.push(headers);
      return Promise.resolve(answers[asked++] ?? null);
    },
    sent,
    wanted,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    nextDelay: () => 1000 * (waits.length + 1),
    failed: (trouble) => troubles.push(trouble),
    waits,
    troubles,
    asked: () => asked,
  };
}

describe("reading a transcript", () => {
  test("a read gives the messages, the seq they reflect and the size of the body", async () => {
    const read = await readTranscript(plan([answer(MESSAGES).response]));
    expect(read).toMatchObject({ at: { epoch: "u1", seq: 10 }, seq: { epoch: "j1", seq: 40 }, bytes: MESSAGES.length });
    expect(read !== "signed-out" && read?.messages?.map((m) => m.info.id)).toEqual(["msg_1"]);
  });

  test("a 200 whose body is not a transcript (a proxy's page) is a failed try: it waits, asks again, and takes the next answer", async () => {
    const p = plan([answer("<html>bad gateway</html>").response, answer('{"not":"a list"}').response, answer(MESSAGES).response]);
    const read = await readTranscript(p);
    expect(read !== "signed-out" && read?.messages).toHaveLength(1);
    expect(p.waits).toEqual([1000, 2000]);
    expect(p.asked()).toBe(3);
  });

  test("no answer, an error status and an answer missing either stamp are failed tries too", async () => {
    const p = plan([
      null,
      answer("x", { status: 502, headers: SEQ }).response,
      answer(MESSAGES, { headers: {} }).response,
      answer(MESSAGES, { headers: { "x-boxbox-seq": "j1:40" } }).response,
      answer(MESSAGES, { headers: { "x-boxbox-upstream": "u1:10" } }).response,
      // the contract 1 stamp is not read
      answer(MESSAGES, { headers: { "x-cmx2-seq": "u1:10" } }).response,
      answer(MESSAGES).response,
    ]);
    expect(await readTranscript(p)).toMatchObject({ bytes: MESSAGES.length });
    expect(p.waits).toHaveLength(6);
  });

  test("an answer that is not a transcript (an error status, or no seq to read it against) is not downloaded either, and one that is is read", async () => {
    const failed = answer("<html>bad gateway</html>", { status: 502, headers: SEQ });
    const seqless = answer(MESSAGES, { headers: {} });
    const good = answer(MESSAGES);
    expect(await readTranscript(plan([failed.response, seqless.response, good.response]))).toMatchObject({ bytes: MESSAGES.length });
    expect([failed.reads, seqless.reads, good.reads]).toEqual([
      { text: 0, cancelled: 1 },
      { text: 0, cancelled: 1 },
      { text: 1, cancelled: 0 },
    ]);
  });

  test("a thread that is gone once the answer's headers are in has its body neither read nor parsed", async () => {
    let wanted = true;
    const { response, reads } = answer(MESSAGES);
    const p = plan([response], () => wanted);
    p.get = () => {
      wanted = false;
      return Promise.resolve(response);
    };
    expect(await readTranscript(p)).toBeNull();
    expect(reads.text).toBe(0);
    expect(reads.cancelled).toBe(1);
  });

  test("a thread that is gone while its body is read gives nothing", async () => {
    let wanted = true;
    const { response } = answer(MESSAGES);
    const text = response.text.bind(response);
    response.text = async () => {
      const body = await text();
      wanted = false;
      return body;
    };
    expect(await readTranscript(plan([response], () => wanted))).toBeNull();
  });

  test("a read that is not wanted from the start asks for nothing", async () => {
    const p = plan([answer(MESSAGES).response], () => false);
    expect(await readTranscript(p)).toBeNull();
    expect(p.asked()).toBe(0);
  });

  test("each failed try says why before its wait: no answer, the server's own words, its status, a 404 as gone, a body that is not a transcript", async () => {
    const json = { "content-type": "application/json", ...SEQ };
    const p = plan([
      null,
      answer(JSON.stringify({ error: { message: "vm-a is not answering" } }), { status: 502, headers: json }).response,
      answer("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }).response,
      answer("", { status: 404 }).response,
      answer("<html>login</html>").response,
      answer(MESSAGES).response,
    ]);
    expect(await readTranscript(p)).toMatchObject({ bytes: MESSAGES.length });
    expect(p.troubles).toEqual([
      { gone: false, problem: null },
      { gone: false, problem: "vm-a is not answering" },
      { gone: false, problem: "the server answered 502" },
      { gone: true, problem: null },
      { gone: false, problem: "the server sent something that is not this thread" },
    ]);
    expect(p.waits).toHaveLength(5);
  });

  test("a read that succeeds first time says no trouble", async () => {
    const p = plan([answer(MESSAGES).response]);
    await readTranscript(p);
    expect(p.troubles).toEqual([]);
  });

  test("a 401 ends the read: the session is over", async () => {
    expect(await readTranscript(plan([answer("", { status: 401 }).response]))).toBe("signed-out");
  });
});

describe("versions (docs/protocol.md, versions and 304)", () => {
  test("a read sends If-None-Match only when the thread holds an etag, and keeps the etag the answer gives", async () => {
    const bare = plan([answer(MESSAGES).response]);
    expect(await readTranscript(bare)).not.toHaveProperty("etag");
    expect(bare.sent).toEqual([{}]);
    const versioned = plan([answer(MESSAGES, { headers: { ...SEQ, etag: '"3.e1.40.q"' } }).response]);
    versioned.etag = '"3.e1.30.q"';
    expect(await readTranscript(versioned)).toMatchObject({ etag: '"3.e1.40.q"', bytes: MESSAGES.length });
    expect(versioned.sent).toEqual([{ "if-none-match": '"3.e1.30.q"' }]);
  });

  test("a 304 to a read that sent an etag stands as the read: no messages, its stamps, the etag kept", async () => {
    const p = plan([answer("", { status: 304, headers: SEQ }).response]);
    p.etag = '"3.e1.30.q"';
    expect(await readTranscript(p)).toEqual({ messages: null, at: { epoch: "u1", seq: 10 }, seq: { epoch: "j1", seq: 40 }, bytes: 0, etag: '"3.e1.30.q"' });
  });

  test("a 304 to a read that sent none, or without its stamps, is a failed try", async () => {
    const p = plan([answer("", { status: 304, headers: SEQ }).response, answer(MESSAGES).response]);
    expect(await readTranscript(p)).toMatchObject({ bytes: MESSAGES.length });
    expect(p.troubles).toEqual([{ gone: false, problem: "the server sent something that is not this thread" }]);
    const stampless = plan([answer("", { status: 304 }).response, answer(MESSAGES).response]);
    stampless.etag = '"x"';
    expect(await readTranscript(stampless)).toMatchObject({ bytes: MESSAGES.length });
    expect(stampless.waits).toHaveLength(1);
  });

  test("an answer from another journal epoch is not taken: the stream is told, nothing is said on the thread, and the read asks again", async () => {
    let told = 0;
    const p = plan([answer(MESSAGES, { headers: { ...SEQ, "x-boxbox-seq": "j0:90" } }).response, answer(MESSAGES).response]);
    p.epoch = () => "j1";
    p.otherEpoch = () => told++;
    expect(await readTranscript(p)).toMatchObject({ seq: { epoch: "j1", seq: 40 } });
    expect([told, p.troubles.length, p.waits.length, p.asked()]).toEqual([1, 0, 1, 2]);
  });
});

describe("a body that may be a transcript", () => {
  test("only an object holding a list of messages is one; a bare list (the contract 1 read) is not", () => {
    expect(parseMessages(JSON.stringify({ messages: [], older: null, total: 0, turns: 0 }))).toEqual([]);
    expect(parseMessages(MESSAGES)).toHaveLength(1);
    for (const body of ["", "{}", "[]", JSON.stringify(ONE), "null", "not json", "<html>", '{"messages":{}}']) expect(parseMessages(body)).toBeNull();
  });
});
