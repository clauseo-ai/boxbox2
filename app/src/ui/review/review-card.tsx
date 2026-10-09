/* the review card (docs/design.md, the needs table and the earned moments): an
   agent in a checkout asked to be merged. it sits at the live edge of the
   thread, where an ask would, and says what the change is: the agent's note,
   the branch and where it goes, the commits, the totals, every file with its
   counts, the patch when asked for. merge and discard are its two controls; a
   discard asks once, in words, before it acts. a refusal is said on the card.
   when the server has merged, the card folds into one line with a tick that
   draws itself, once, in front of the reader (never from a reload or a cache).
   the control (control.ts) owns every state; this paints them. */

import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch } from "solid-js";
import type { play } from "../../motion/animate";
import type { Curve } from "../../motion/springs";
import type { ReviewControl } from "./control";
import { discardQuestion, n, patchLines, routeOf, sizeLine, statusOf, totalsOf, warningsOf } from "./card-words";
import "./review.css";

/** the motion law's one entry (motion/animate.ts) and its curves, handed in by the stage rather than imported: a module
    the card shared with the first load would be hoisted out of the first load's chunk (stage.tsx) */
export type ReviewMotion = { play: typeof play; fade: Curve; tick: Curve & { delay: number } };

export function ReviewCard(props: { control: ReviewControl; motion: ReviewMotion }) {
  const c = () => props.control;
  const { play, fade, tick: draw } = props.motion;
  const [patchOpen, setPatchOpen] = createSignal(false);
  let folded: HTMLParagraphElement | undefined;
  let keepButton: HTMLButtonElement | undefined;
  let discardButton: HTMLButtonElement | undefined;

  const review = () => c().review();
  const patch = createMemo(() => (patchOpen() && review() ? patchLines(review()?.diff ?? "") : null));
  const busy = () => c().phase() === "merging" || c().phase() === "discarding";
  const into = () => review()?.base ?? "the base";

  /* the card folds into its line: the line fades in and the tick draws, once, when the reader watched it happen. the
     control that was pressed went with the card's body, so the keyboard lands on the line */
  createEffect(on(() => c().fold(), (fold) => {
    if (!fold) return;
    requestAnimationFrame(() => {
      if (!folded) return;
      const live = c().earned();
      play(folded, [{ opacity: 0 }, { opacity: 1 }], fade, { live });
      const tick = folded.querySelector("svg");
      if (tick) play(tick, [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], draw, { live, delay: draw.delay, fill: "backwards" });
      if (c().pressed() && document.activeElement === document.body) folded.focus({ preventScroll: true });
    });
  }, { defer: true }));

  /* the question replaces the control, so focus goes with it: to "keep it" when asked, back to "discard" when declined */
  const ask = () => { c().askDiscard(); queueMicrotask(() => keepButton?.focus({ preventScroll: true })); };
  const keep = () => { c().keep(); queueMicrotask(() => discardButton?.focus({ preventScroll: true })); };

  return (
    <Show when={c().need()}>
      {(need) => (
        <Switch>
          <Match when={c().fold()}>
            {(fold) => (
              <p ref={folded} class="review-folded" tabIndex={-1} role="status" data-kind={fold().kind}>
                <Show when={fold().kind === "merged"}>
                  <svg class="review-tick" viewBox="0 0 22 22" aria-hidden="true">
                    <path d="M4 11.5l4.5 4.5L18 6.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </Show>
                {fold().line}
              </p>
            )}
          </Match>
          <Match when={true}>
            <section class="review-card" tabIndex={-1} aria-label={`review: ${need().title}`} aria-busy={busy() ? "true" : undefined} data-phase={c().phase()}>
              <h3 class="review-title">{need().title}</h3>
              <Show when={need().body && need().body !== review()?.branch}>
                <p class="review-note">{need().body}</p>
              </Show>
              <Show when={review()} fallback={<Show when={!c().problem()}><p class="review-quiet-line">reading the checkout.</p></Show>}>
                {(r) => (
                  <>
                    <p class="review-route">
                      <span class="review-name">{routeOf(r()).from}</span>
                      <span class="review-arrow" aria-label="into">{"\u2192"}</span>
                      <span class="review-name">{routeOf(r()).to}</span>
                    </p>
                    <p class="review-size">
                      {sizeLine(r())}
                      <span class="review-totals">
                        <span class="add">{totalsOf(r().additions, r().deletions).add}</span> <span class="del">{totalsOf(r().additions, r().deletions).del}</span>
                      </span>
                    </p>
                    <For each={warningsOf(r())}>{(warning) => <p class="review-warning" role="status">{warning}</p>}</For>
                    <Show when={r().files.length}>
                      <ul class="review-files" aria-label="files changed">
                        <For each={r().files}>
                          {(file) => {
                            const cut = file.path.lastIndexOf("/") + 1;
                            return (
                              <li class="review-file">
                                <span class="review-status" data-mark={statusOf(file.status).mark} role="img" aria-label={statusOf(file.status).word}>{statusOf(file.status).mark}</span>
                                <span class="review-path">
                                  <Show when={cut > 0}><span class="review-dir" title={file.path}><bdi>{file.path.slice(0, cut)}</bdi></span></Show>
                                  <span class="review-base">{file.path.slice(cut)}</span>
                                </span>
                                <span class="review-counts">
                                  <span class="add">+{n(file.additions)}</span> <span class="del">-{n(file.deletions)}</span>
                                </span>
                              </li>
                            );
                          }}
                        </For>
                      </ul>
                    </Show>
                    <Show when={r().diff}>
                      <button type="button" class="review-quiet" aria-expanded={patchOpen() ? "true" : "false"} onClick={() => setPatchOpen(!patchOpen())}>
                        {patchOpen() ? "hide the patch" : "show the patch"}
                      </button>
                    </Show>
                    <Show when={patch()}>
                      {(shown) => (
                        <>
                          <pre class="review-patch" tabIndex={0} aria-label="the patch">
                            <For each={shown().lines}>{(line) => <span class="pl" data-kind={line.kind}>{line.text}{"\n"}</span>}</For>
                          </pre>
                          <Show when={shown().left > 0 || r().truncated}>
                            <p class="review-cut">{shown().left > 0 ? `${n(shown().left)} more lines are not shown here. ` : ""}{r().truncated ? `the patch is cut where the server stops reading it; the rest is in the checkout.` : ""}</p>
                          </Show>
                        </>
                      )}
                    </Show>
                  </>
                )}
              </Show>
              <Show when={c().problem()}>
                {(problem) => (
                  <div class="review-problem" role="alert" data-kind={problem().kind}>
                    <p>{problem().text}</p>
                    <Show when={problem().files.length}>
                      <ul class="review-clash" aria-label="files in conflict">
                        <For each={problem().files}>{(file) => <li>{file}</li>}</For>
                      </ul>
                    </Show>
                  </div>
                )}
              </Show>
              <Show when={!review() && c().problem()}>
                <div class="review-actions">
                  <button type="button" class="review-discard" onClick={() => c().retry()}>try again</button>
                </div>
              </Show>
              <Show when={review()}>
                <Show
                  when={c().confirming()}
                  fallback={
                    <div class="review-actions">
                      <button type="button" class="review-merge" disabled={busy()} onClick={() => c().merge()} aria-label={`merge into ${into()}`}>
                        {c().phase() === "merging" ? "merging" : `merge into ${into()}`}
                      </button>
                      <button ref={discardButton} type="button" class="review-discard" disabled={busy()} onClick={ask} aria-label="discard this checkout">
                        {c().phase() === "discarding" ? "discarding" : "discard"}
                      </button>
                    </div>
                  }
                >
                  <div class="review-ask" role="group" aria-label="discard this checkout">
                    <p>{discardQuestion(review())}</p>
                    <div class="review-actions">
                      <button ref={keepButton} type="button" class="review-merge" onClick={keep}>keep it</button>
                      <button type="button" class="review-discard" onClick={() => c().discard()}>discard it</button>
                    </div>
                  </div>
                </Show>
              </Show>
            </section>
          </Match>
        </Switch>
      )}
    </Show>
  );
}
