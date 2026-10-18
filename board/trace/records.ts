/* what a traced run records at the daemon's process boundary, timestamped.
   both ways of attaching to a daemon produce these records: preload.ts inside
   v1's bun daemon, and native.ts around the native one (a socket board, a
   recording proxy, a say recorder and a meter log). */

export type Record =
  /** a host to board write, report id 0 first, then the protocol's 32 bytes */
  | { ch: "hid"; t: number; bytes: number[] }
  /** a board to host report, the 32 bytes, opcode first */
  | { ch: "board"; t: number; bytes: number[] }
  /** a switch moved under the harness's finger */
  | { ch: "key"; t: number; wire: number; down: boolean }
  | {
      ch: "http";
      t: number;
      id: number;
      method: string;
      path: string;
      directory: string | null;
      body: unknown;
    }
  | { ch: "http-done"; t: number; id: number; status: number | null }
  /** one `data:` frame on the board stream, as the daemon received it. the
      normalizer reads asks from it (a reply names an option by index); the
      diff never compares it */
  | { ch: "sse"; t: number; data: unknown }
  | { ch: "exec"; t: number; cmd: string; args: string[] }
  | { ch: "exec-end"; t: number; cmd: string };
