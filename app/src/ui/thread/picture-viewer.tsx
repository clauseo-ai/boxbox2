/* an image a tool returned, full size (docs/design.md, pictures): the modal dialog a thumbnail in an open row opens. it
   opens only at a press, so it is a chunk of its own (ui/later.ts), warmed with the other surfaces; the thumbnails and the
   dialog's look stay with the thread. */

import { createSignal, onMount } from "solid-js";
import { Close } from "../close";
import type { Picture } from "./model";

export function PictureViewer(props: { pic: Picture; name: string; onClose: () => void }) {
  let dialog!: HTMLDialogElement;
  const [actual, setActual] = createSignal(false);
  onMount(() => dialog.showModal());
  return (
    /* the dialog's own box is the backdrop's edge: a press whose target is the dialog itself landed outside the card. escape closes
       it (the dialog's own cancel) and goes no further: the stage's escape goes back to home */
    <dialog ref={dialog} class="pv" aria-label={`${props.name}, full size`} on:keydown={(e) => e.key === "Escape" && e.stopPropagation()} on:close={() => props.onClose()} onClick={(e) => e.target === dialog && dialog.close()}>
      <div class="pv-card">
        <header class="pv-hd">
          <span class="pv-name">{props.pic.filename || props.pic.mime}</span>
          <Close label={`close ${props.name}`} onClick={() => dialog.close()} />
        </header>
        <div class="pv-view">
          <button class="pv-zoom" aria-pressed={actual() ? "true" : "false"} aria-label={`${props.name} at its own size`} onClick={() => setActual(!actual())}>
            <img class="pv-img" src={props.pic.url} alt="" decoding="async" draggable={false} />
          </button>
        </div>
      </div>
    </dialog>
  );
}
