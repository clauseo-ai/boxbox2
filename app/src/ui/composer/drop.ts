/* what lands when something is dropped on the composer or on the stage around it (docs/composer.md, attachments; the ios
   app's composerdrop): each kind goes the way the composer already takes it. an image is a photo (the same clamp and the
   same four as a picked one), any other file is mentioned after an `@` by its name (the host's file list finds it, as a
   typed mention does), and words join the draft. the kinds are pure; `fileDrop` wires a drop target, and its owner's
   cleanup takes its listeners away. */

import { onCleanup } from "solid-js";

export type Dropped = { photos: File[]; mentions: string[]; words: string };

/** the image types the composer takes as photos, as its picker does (`image/*`, and heic by its extension when the browser
    gives no type) */
const isPhoto = (file: { type: string; name: string }) => file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name);

/** what a drop holds, sorted the way the composer takes it */
export function sortDrop(files: readonly { type: string; name: string }[], words: string): { photos: number[]; mentions: string[]; words: string } {
  const photos: number[] = [];
  const mentions: string[] = [];
  files.forEach((file, at) => {
    if (isPhoto(file)) photos.push(at);
    else if (file.name) mentions.push(file.name);
  });
  // a drop that brought files brings their names as text too (a finder drag offers its paths): the files are what it means
  return { photos, mentions, words: files.length ? "" : words.trim() };
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
    event.preventDefault();
    // a drop on the composer inside a stage that is a target too is taken once
    event.stopPropagation();
    reset();
    const files = Array.from(data.files);
    const sorted = sortDrop(files, data.getData("text/plain"));
    take({ photos: sorted.photos.map((at) => files[at] as File), mentions: sorted.mentions, words: sorted.words });
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
