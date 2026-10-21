/* the spend of a thread with agents, part by part (docs/design.md, the thread menu and details): a modal dialog the
   details' spend tile opens. it opens only at a press, so it is a chunk of its own (ui/later.ts), warmed with the other
   surfaces; its look is ./details.css, which the details import. */

import { createUniqueId, For, Show } from "solid-js";
import { Close } from "../close";
import { percentWords, type Spend, spend } from "./details-model";
import { plural } from "./rows";

/** the spend, part by part: drawn beside the tiles, not among them, so the grid counts only tiles */
export function SpendDialog(props: { spend: Spend; openAgent: (id: string) => void; ref: (el: HTMLDialogElement) => void }) {
  let dialog!: HTMLDialogElement;
  const titleId = createUniqueId();
  const s = () => props.spend;
  /* a share of the whole as a whole percent, "under 1%" for a trace */
  const share = (cost: number) => `${percentWords(cost, s().total)} of the total`;
  const close = () => dialog.close();
  const go = (id: string) => { close(); props.openAgent(id); };
  return (
    <>
      {/* the dialog's own box is the backdrop's edge: a press whose target is the dialog itself landed outside the card */}
      <dialog ref={(el) => { dialog = el; props.ref(el); }} class="dt-spend" aria-labelledby={titleId} onClick={(e) => e.target === dialog && close()}>
        <div class="sp-card">
          <header class="sp-hd">
            <h2 id={titleId}>spend<small>this thread and every agent under it</small></h2>
            <Close label="close spend" onClick={close} />
          </header>
          <div class="sp-body">
            <p class="sp-total"><b>{spend(s().total)}</b><span>{s().unknown ? `without ${plural(s().unknown, "agent")} whose spend is not known` : "in all"}</span></p>
            <ul class="dt-list">
              <li class="dt-row">
                <span class="dt-main">this thread</span>
                <span class="dt-figure">{spend(s().own)}</span>
                <span class="dt-sub">{share(s().own)}</span>
              </li>
            </ul>
            <div class="dt-sh sp-sh"><h3>agents</h3><span class="dt-sum">{spend(s().agents)}</span></div>
            <ul class="dt-list">
              <For each={s().rows}>{(r) => {
                const cost = () => (r.cost === null ? "not known" : spend(r.cost));
                const sub = () => [r.gone ? "archived" : "", r.cost === null ? "" : share(r.cost)].filter(Boolean).join(", ");
                // fresh nodes per use: the two branches below never share dom
                const inner = () => (
                  <>
                    <span class="dt-main">{r.name}<Show when={r.type}><em>{r.type}</em></Show></span>
                    <span class="dt-figure">{cost()}</span>
                    <Show when={sub()}><span class="dt-sub">{sub()}</span></Show>
                  </>
                );
                /* an agent's row is indented under the agent that started it; an archived one has no thread to open */
                return (
                  <li style={{ "--depth": r.depth }}>
                    <Show when={!r.gone} fallback={<div class="dt-row sp-row gone">{inner()}</div>}>
                      <button class="dt-row sp-row sp-door" aria-label={`open ${r.name}'s thread, ${cost()}${r.depth ? ", started by another agent" : ""}`} onClick={() => go(r.id)}>{inner()}</button>
                    </Show>
                  </li>
                );
              }}</For>
            </ul>
            <Show when={s().unknown}>
              <p class="sp-note">the fleet no longer holds {s().unknown === 1 ? "one archived agent, so its spend is" : `${s().unknown} archived agents, so their spend is`} left out of the total.</p>
            </Show>
          </div>
        </div>
      </dialog>
    </>
  );
}
