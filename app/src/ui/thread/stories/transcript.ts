/* the open thread as the worker would hold it, for the stories that put a
   thread on the stage over a recorded fleet (home at the ipad and mac
   widths, the shell's thread): the native session the thread's stories
   read (../fixtures/notes-asks.json), at its last recorded moment. */

import type { Message } from "../../../sync/protocol";
import type { ThreadView } from "../../../sync/reducer";
import notesUrl from "../fixtures/notes-asks.json?url";

/** the notes session's transcript under `key`, live; fetched, never imported, so the type checker never reads the json */
export async function notesTranscript(key: string): Promise<ThreadView> {
  const file = (await (await fetch(notesUrl)).json()) as { snapshots: Array<{ messages: unknown[] }> };
  // the fixture is the daemon's message list, recorded through the same contract the worker reads
  const messages = (file.snapshots.at(-1)?.messages ?? []) as Message[];
  return { key, status: "live", messages };
}
