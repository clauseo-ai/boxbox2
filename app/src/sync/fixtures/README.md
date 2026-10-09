# fixtures for the sync reducer

- `think-turn.json`: the message, part and delta events of one `[bench:think 40 100]` turn, recorded from a real cmx2 0.8.3 dev daemon at the pin through its `/event` stream, as the daemon sent them (`seq` is the daemon's, which the server's journal carries as `upstream`). a thinking step, a `git status` tool call, a second thinking step and a streamed answer. what it shows: reasoning arrives once, whole, when its step lands; text streams by deltas whose first one (offset 0) is the part's birth; the final parts of the answer message arrive after its text has streamed, reasoning first by id.

only the working directory (`/work`) and the host name (`bench-host`) were substituted. the test that reads it (`reducer.test.ts`) turns each event into the journal entry the server writes for it.
