/* the stories' server: the answers a real boxbox gave, played back. the
   machines, settings and the terminal ask the api when they mount, and a
   story has no server, so this answers `/api/...` from `fixtures/api.json`
   and a terminal's socket from `fixtures/terminal.json`, both recorded
   from the release binary against the pinned daemon by
   `app/.ladle/record-shell.ts`. it is for looking at the shell, never for
   proving it: the real loop is the proof (docs/verification.md).

   it must load before the api client is created (openapi-fetch keeps the
   `fetch` it found then), so the story file imports it first. */

import api from "./fixtures/api.json";
import terminal from "./fixtures/terminal.json";

/** a recorded answer: the status and the json body */
type Answer = { status: number; body: unknown };
/** a recorded frame from the relay: text as it came, or a binary frame's bytes */
type Frame = { text: string } | { bytes: number[] };

const ANSWERS = api as unknown as Record<string, Answer>;
const FRAMES = (terminal as unknown as { frames: Frame[] }).frames;

/** history is a query, so a story answers it from code rather than from one recording: the story sets what it holds */
let historyAnswer: ((query: URLSearchParams) => Answer) | undefined;
export function answerHistory(answer: ((query: URLSearchParams) => Answer) | undefined): void {
  historyAnswer = answer;
}

/** the machines' story of several: the host list answered from code, and each made-up host's own routes answered with
    the recorded host's (`alias`, made-up name to recorded one). a made-up host left out of `alias` answers as a host
    that is down does */
type HostsAnswer = { hosts: () => Answer; alias: Record<string, string> };
let hostsAnswer: HostsAnswer | undefined;
export function answerHosts(answer: HostsAnswer | undefined): void {
  hostsAnswer = answer;
}

/** the review routes, answered from code by the story that has a review waiting */
type ReviewAnswer = (method: string, tail: string) => Answer | undefined;
let reviewAnswer: ReviewAnswer | undefined;
export function answerReview(answer: ReviewAnswer | undefined): void {
  reviewAnswer = answer;
}

/** the repo colour route, answered from code by the colour sheet's stories (ui/colour/stories): the choice as the body
    sent it, and the answer to give */
type ColoursAnswer = (choice: { host: string; root: string; chosen: string | null }) => Answer;
let coloursAnswer: ColoursAnswer | undefined;
export function answerColours(answer: ColoursAnswer | undefined): void {
  coloursAnswer = answer;
}

const realFetch = globalThis.fetch.bind(globalThis);
const RealWebSocket = globalThis.WebSocket;

async function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return realFetch(input, init);
  if (request.method === "GET" && url.pathname === "/api/history" && historyAnswer) {
    const made = historyAnswer(url.searchParams);
    return Response.json(made.body, { status: made.status });
  }
  const review = /^\/api\/hosts\/[^/]+\/sessions\/[^/]+\/review(\/merge|\/discard)?$/.exec(url.pathname);
  if (review && reviewAnswer) {
    const made = reviewAnswer(request.method, review[1] ?? "");
    if (made) return Response.json(made.body, { status: made.status });
  }
  if (request.method === "PUT" && url.pathname === "/api/prefs/colours" && coloursAnswer) {
    const made = coloursAnswer((await request.json()) as { host: string; root: string; chosen: string | null });
    return Response.json(made.body, { status: made.status });
  }
  let path = url.pathname;
  if (hostsAnswer) {
    if (request.method === "GET" && path === "/api/hosts") {
      const made = hostsAnswer.hosts();
      return Response.json(made.body, { status: made.status });
    }
    const own = /^\/api\/hosts\/([^/]+)(\/.*)$/.exec(path);
    const host = own?.[1] ?? "";
    const recordedAs = hostsAnswer.alias[host];
    if (own && recordedAs) path = `/api/hosts/${recordedAs}${own[2] ?? ""}`;
    else if (own && !ANSWERS[`${request.method} ${path}`])
      return Response.json({ error: { message: `the host "${host}" did not answer (connection refused). check its daemon is running` } }, { status: 502 });
  }
  const recorded = ANSWERS[`${request.method} ${path}`];
  if (!recorded) return Response.json({ error: `the stories have no recorded answer for ${request.method} ${url.pathname}` }, { status: 404 });
  return Response.json(recorded.body, { status: recorded.status });
}

// the browser's fetch is a plain function; bun's types add a `preconnect` the page never calls
globalThis.fetch = answer as typeof fetch;

/** a terminal's socket that plays the recorded session, then stays open and quiet, as a shell waiting at its
    prompt does. anything else (vite's hot reload) gets the real socket */
class RecordedSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly url: string;
  readyState = RecordedSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string | URL, protocols?: string | string[]) {
    super();
    this.url = String(url);
    if (!/\/api\/hosts\/[^/]+\/pty\/[^/]+\/connect/.test(this.url)) {
      // a constructor that hands back another object is how this stands in for the terminal's sockets only
      return new RealWebSocket(url, protocols) as unknown as RecordedSocket;
    }
    setTimeout(() => {
      this.readyState = RecordedSocket.OPEN;
      this.onopen?.(new Event("open"));
      for (const frame of FRAMES) {
        const data = "text" in frame ? frame.text : new Uint8Array(frame.bytes).buffer;
        this.onmessage?.(new MessageEvent("message", { data }));
      }
    }, 0);
  }

  send(): void {
    /* typing goes nowhere: the story is a picture */
  }

  close(): void {
    this.readyState = RecordedSocket.CLOSED;
  }
}

globalThis.WebSocket = RecordedSocket as unknown as typeof WebSocket;
