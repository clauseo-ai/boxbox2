/* what lands when something is dropped or pasted on the composer or dropped on the stage around it (docs/composer.md,
   attachments; the ios app's composerdrop): each kind goes the way the composer already takes it. an image is a photo (the
   same clamp as a picked one), a pdf, text or json file is a file the agent reads (`files.ts`), both under the same four
   on a message; any other file is mentioned after an `@` by its name (the host's file list finds it when it is in the
   repo, as a typed mention does) and the composer says the agent does not take it; words join the draft. the kinds are
   pure; `fileDrop` wires a drop target, and its owner's cleanup takes its listeners away. */

import { onCleanup } from "solid-js";
import { fileKind } from "./files";

/** what a drop brought: the photos and files the draft takes, in the order they came; the names of the files it does not;
    and words */
export type Dropped = { taken: File[]; others: string[]; words: string };

/** the image types the composer takes as photos, as its picker does (`image/*`, and heic by its extension when the browser
    gives no type) */
export const isPhoto = (file: { type: string; name: string }) => file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name);

/** a photo or a file the agent takes */
export const takes = (file: { type: string; name: string }) => isPhoto(file) || fileKind(file) !== null;

/** what a drop holds, sorted the way the composer takes it */
export function sortDrop(files: readonly { type: string; name: string }[], words: string): { taken: number[]; others: string[]; words: string } {
  const taken: number[] = [];
  const others: string[] = [];
  files.forEach((file, at) => {
    if (takes(file)) taken.push(at);
    else if (file.name) others.push(file.name);
  });
  // a drop that brought files brings their names as text too (a finder drag offers its paths): the files are what it means
  return { taken, others, words: files.length ? "" : words.trim() };
}

const joined = (text: string, more: string) => (text === "" || /\s$/.test(text) ? text + more : `${text} ${more}`);

/** the draft with a file mentioned at its end, after an `@`: a mention is one word, so the name's spaces go (the host's file
    list finds it by what is left, as the ios app's mention does) */
export function withMention(text: string, name: string): string {
  const word = name.replace(/\s+/g, "");
  return word ? joined(text, `@${word}`) : text;
}

/** the draft with dropped words at its end */
export function withWords(text: string, words: string): string {
  return words ? joined(text, words) : text;
}

/** a drag carries something the composer could take: files, or words */
export function carriesDrop(types: readonly string[]): boolean {
  return types.includes("Files") || types.includes("text/plain");
}

/** makes `el` a drop target: `over` says whether a drag the composer can take is over it, `take` gets what was dropped. the
    drag's enter and leave fire for every child it crosses, so it is counted, and a drop or a drag that ends anywhere
    resets it. call inside a reactive owner (a component, an effect): its cleanup removes the listeners */
export function fileDrop(el: HTMLElement, over: (on: boolean) => void, take: (dropped: Dropped) => void): void {
  let depth = 0;
  const reset = () => {
    depth = 0;
    over(false);
  };
  const enter = (event: DragEvent) => {
    if (!event.dataTransfer || !carriesDrop([...event.dataTransfer.types])) return;
    event.preventDefault();
    depth++;
    over(true);
  };
  const hover = (event: DragEvent) => {
    if (!event.dataTransfer || !carriesDrop([...event.dataTransfer.types])) return;
    // a target that does not cancel dragover is no drop target to the browser
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const leave = () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) over(false);
  };
  const drop = (event: DragEvent) => {
    const data = event.dataTransfer;
    if (!data || !carriesDrop([...data.types])) return;
    // a drop on the composer inside a stage that is a target too is taken once, by the composer, which sees it first. the
    // stage still hears it, to stop saying a drag is over it: a drag of files from outside the page ends with no dragend
    if (event.defaultPrevented) return reset();
    event.preventDefault();
    reset();
    const files = Array.from(data.files);
    const sorted = sortDrop(files, data.getData("text/plain"));
    take({ taken: sorted.taken.map((at) => files[at] as File), others: sorted.others, words: sorted.words });
  };
  el.addEventListener("dragenter", enter);
  el.addEventListener("dragover", hover);
  el.addEventListener("dragleave", leave);
  el.addEventListener("drop", drop);
  window.addEventListener("dragend", reset);
  onCleanup(() => {
    el.removeEventListener("dragenter", enter);
    el.removeEventListener("dragover", hover);
    el.removeEventListener("dragleave", leave);
    el.removeEventListener("drop", drop);
    window.removeEventListener("dragend", reset);
  });
}
