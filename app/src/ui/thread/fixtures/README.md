# fixtures for the thread's stories

excerpts of three real sessions, recorded from a daemon and cut to the turns the stories need. every name, machine, home directory, address and job label in them was replaced with a neutral stand-in before they were committed. the public check (`scripts/check-public.sh`) runs over these files like any other.

- `northstar-heavy.json`: an imported cmx session on a tvos client project. it holds a long first prompt (clamped), a 32 minute turn with 89 steps and a subagent, that agent's report turn with tests, a turn with a push, a compaction, a stopped turn, and a turn with a failed edit and an answer.
- `cmx-deploy.json`: an imported cmx session on an agent runtime project. it holds a report turn with 109 steps, 77 thoughts, twelve test runs and one failure, a deploy turn with a commit, two pushes, two asks and an abort, and a short turn with a failed step and an answer.
- `notes-asks.json`: a native cmx2 session recorded against the pinned dev daemon and the bench model. it has 23 snapshots of the message list, the pending permissions and questions, and the status map, through a permission (one denied), a question (one dismissed), two queued prompts, a steer between steps, a real abort, a park and a wake.

the two imported sessions have the shape `GET /session/:id/message` serves for `source: cmx` history, with the child sessions the excerpt's agents started. their long strings are cut to 4,000 characters, since the parent only reads a child's timing and counts. imported pages carry `step-start`, `step-finish`, `patch` and `compaction` parts outside the contract's part union (ask a15, `docs/cmx2-asks.md`), and the stories read them as the decoder will, dropping what it does not know. the native session has no reasoning parts, because the bench model has none, and its edits carry no diff (ask a16).

to refresh a fixture, record a new session and replace every personal string by hand or with a script of your own before committing.
