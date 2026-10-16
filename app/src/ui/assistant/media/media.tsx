/* pictures and files in the thread (docs/thread.md, pictures and files; docs/design.md, the new rows): an image is a card
   at its own ratio whose box is fixed from `width` and `height` before a byte arrives, a file is a card with its type
   tile, its name and its size, and an audio file that is not a voice note is a file card with a play disc for a tile.
   every one keeps its box through pending (a still quarter arc, no tap), missing (the gateway lost it) and evicted (boxbox's
   store let it go, the media route's 410): none of those is a button, and the name and the size stay. an upload in flight
   carries a determinate ring over the box; a refused one a red edge and the reason under it. */

import { Show } from "solid-js";
import { Ring } from "../voice/note";
import { usePlayer } from "../voice/player";
import { clockOf, goneWords, isHashName, type MediaGone, sizeOf, timeOf, typeWord } from "../words";
import type { AudioPart, FilePart, ImagePart } from "../wire";
import "./media.css";

/** an attachment you send, while it goes up or after it was refused */
export type Upload = { state: "sending"; progress: number } | { state: "failed"; reason: string };

const MAX_W = 300;
const MAX_H = 190;
const TALLEST = 360;

/** the card's box from the image's own size: landscape inside 300 x 190; a portrait may stand up to 360 tall; no size, 300 x 190 */
export function boxOf(width: number | undefined, height: number | undefined): { w: number; h: number; known: boolean } {
  if (!width || !height) return { w: MAX_W, h: MAX_H, known: false };
  const ratio = width / height;
  if (ratio >= MAX_W / MAX_H) {
    const w = Math.min(MAX_W, width);
    return { w: Math.round(w), h: Math.round(w / ratio), known: true };
  }
  // taller than the landscape box: grow down to 360, never wider than 300, never narrower than reads as a picture
  const h = Math.min(TALLEST, height, MAX_W / ratio);
  return { w: Math.max(96, Math.round(h * ratio)), h: Math.round(h), known: true };
}

/** the image card's accessible name: "image <file>", or "image from <name>, 11:34" when it has no name worth saying */
export function imageName(part: Pick<ImagePart, "filename">, agent: string, at: number): string {
  return part.filename && !isHashName(part.filename) ? `image ${part.filename}` : `image from ${agent}, ${timeOf(at)}`;
}

/** the caption: the file's name when it has one that is not a generated hash; a generated image has none by default */
export const captionOf = (part: Pick<ImagePart, "filename" | "flavour">): string | null => (part.filename && part.flavour !== "generated" && !isHashName(part.filename) ? part.filename : null);

function goneOfPart(media: { state: string } | undefined, evicted: boolean | undefined): MediaGone {
  if (evicted) return "evicted";
  if (media?.state === "pending") return "pending";
  if (media?.state === "missing") return "missing";
  return null;
}

export type ImageCardProps = {
  part: ImagePart;
  /** where the picture's bytes are (the media route, or a `data:` url); none while there are none */
  src?: string;
  agent: string;
  machine: string;
  at: number;
  evicted?: boolean;
  upload?: Upload;
  onOpen?: (el: HTMLElement) => void;
  /** a refused upload: the same bytes under the same clientID */
  onRetry?: () => void;
};

export function ImageCard(props: ImageCardProps) {
  const box = () => boxOf(props.part.width, props.part.height);
  const gone = () => goneOfPart(props.part.media, props.evicted);
  const cap = () => captionOf(props.part);
  const name = () => imageName(props.part, props.agent, props.at);
  // the box is fixed before a byte arrives: its width and its ratio, so a bubble narrower than 300 shrinks it without a shift
  const style = () => ({ width: `${box().w}px`, "aspect-ratio": `${box().w} / ${box().h}` });
  return (
    <div class="media-item">
      <Show
        when={gone() === null && props.src}
        fallback={
          <div class="media-img media-gone" data-gone={gone() ?? (props.upload?.state === "failed" ? "failed" : "empty")} classList={{ bad: props.upload?.state === "failed" }} style={style()} role="img" aria-label={gone() === "missing" || gone() === "evicted" ? `${name()}, ${goneWords(gone() as "missing" | "evicted", props.machine)}` : name()}>
            <Show when={gone() === "pending"}>
              <svg class="media-arc" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2a8 8 0 0 1 8 8" /></svg>
            </Show>
            <Show when={gone() === "missing" || gone() === "evicted"}>
              <span class="media-gone-words">
                <b>{goneWords(gone() as "missing" | "evicted", props.machine)}</b>
                <Show when={props.part.filename || props.part.size}>
                  <span>{[props.part.filename, props.part.size === undefined ? null : sizeOf(props.part.size)].filter(Boolean).join(" · ")}</span>
                </Show>
              </span>
            </Show>
          </div>
        }
      >
        <button
          type="button"
          class="media-img"
          classList={{ bad: props.upload?.state === "failed" }}
          data-fit={box().known ? undefined : ""}
          data-state={props.upload?.state === "sending" ? "sending" : undefined}
          style={style()}
          aria-label={props.upload?.state === "failed" ? `send ${props.part.filename ?? "the image"} again` : name()}
          disabled={props.upload?.state === "sending"}
          onClick={(e) => (props.upload?.state === "failed" ? props.onRetry?.() : props.onOpen?.(e.currentTarget))}
        >
          <img src={props.src} alt={props.part.alt ?? ""} decoding="async" loading="lazy" draggable={false} />
          <Show when={cap()}>{(c) => <span class="media-cap">{c()}</span>}</Show>
          <Show when={props.upload?.state === "sending" ? (props.upload as { progress: number }).progress : null}>{(p) => <Ring progress={p()} />}</Show>
        </button>
      </Show>
      <Show when={props.upload?.state === "failed" ? (props.upload as { reason: string }).reason : null}>{(r) => <p class="media-why">{r()}</p>}</Show>
    </div>
  );
}

export type FileCardProps = {
  part: FilePart;
  /** the media route for the bytes; inline for image, audio, video and pdf, an attachment for everything else */
  href?: string;
  machine: string;
  evicted?: boolean;
  upload?: Upload;
};

/** a kind the browser shows in its own viewer in a new tab; everything else downloads under its own name */
const opensInline = (mime: string) => /^(image|audio|video)\//.test(mime) || mime === "application/pdf";

/** the file card's accessible name: "open <file>, pdf, 84 kb" */
export function fileName(part: Pick<FilePart, "filename" | "mime" | "size">): string {
  return `open ${part.filename}, ${typeWord(part.mime, part.filename)}${part.size === undefined ? "" : `, ${sizeOf(part.size)}`}`;
}

export function FileCard(props: FileCardProps) {
  const gone = () => goneOfPart(props.part.media, props.evicted);
  const word = () => typeWord(props.part.mime, props.part.filename);
  const video = () => props.part.mime.startsWith("video/");
  const body = () => (
    <>
      <span class="media-tile" aria-hidden="true">
        <Show when={gone() === "pending"} fallback={<Show when={video()} fallback={<PageGlyph word={word()} />}><PlayGlyph /></Show>}>
          <svg class="media-arc" viewBox="0 0 20 20"><path d="M10 2a8 8 0 0 1 8 8" /></svg>
        </Show>
      </span>
      <span class="media-file-text">
        <b class="media-file-name">{breakable(props.part.filename)}</b>
        <span class="media-file-size">
          {gone() === "missing" || gone() === "evicted" ? goneWords(gone() as "missing" | "evicted", props.machine) : props.part.size === undefined ? word() : sizeOf(props.part.size)}
        </span>
      </span>
      <Show when={props.upload?.state === "sending" ? (props.upload as { progress: number }).progress : null}>{(p) => <Ring progress={p()} />}</Show>
    </>
  );
  return (
    <div class="media-item">
      <Show
        when={gone() === null && props.href && props.upload === undefined}
        fallback={
          <div class="media-file" data-gone={gone() ?? undefined} data-state={props.upload?.state} classList={{ bad: props.upload?.state === "failed", "media-gone": gone() === "missing" || gone() === "evicted" }} role="group" aria-label={fileName(props.part).replace(/^open /, "")}>
            {body()}
          </div>
        }
      >
        <a class="media-file" href={props.href} aria-label={fileName(props.part)} {...(opensInline(props.part.mime) ? { target: "_blank", rel: "noopener" } : { download: props.part.filename })}>
          {body()}
        </a>
      </Show>
      <Show when={props.upload?.state === "failed" ? (props.upload as { reason: string }).reason : null}>{(r) => <p class="media-why">{r()}</p>}</Show>
    </div>
  );
}

/** an audio file that is not a voice note (`flavour: attached` or `generated`): a file card with a play disc in place of
    the tile, its duration and size, playing in the app's one player */
export function AudioFileCard(props: { part: AudioPart; filename: string; size?: number; src?: string; machine: string; evicted?: boolean }) {
  const player = usePlayer();
  const gone = () => goneOfPart(props.part.media, props.evicted);
  const playing = () => player?.isPlaying(props.part.id) ?? false;
  const playable = () => gone() === null && props.src !== undefined && player !== null;
  const facts = () =>
    gone() === "missing" || gone() === "evicted"
      ? goneWords(gone() as "missing" | "evicted", props.machine)
      : [props.part.durationMs === undefined ? null : clockOf(playing() ? (player?.positionOf(props.part.id) ?? 0) : props.part.durationMs), props.size === undefined ? null : sizeOf(props.size)].filter(Boolean).join(" · ");
  const toggle = () => {
    if (!player || !props.src) return;
    if (playing()) player.pause();
    else void player.play({ id: props.part.id, src: props.src, durationMs: props.part.durationMs ?? 0, title: props.filename, album: "" });
  };
  return (
    <div class="media-item">
      <div class="media-file media-audio" data-gone={gone() ?? undefined} classList={{ "media-gone": gone() === "missing" || gone() === "evicted" }}>
        <Show
          when={playable()}
          fallback={
            <span class="media-tile media-disc" data-still="" aria-hidden="true">
              <Show when={gone() === "pending"}><svg class="media-arc" viewBox="0 0 20 20"><path d="M10 2a8 8 0 0 1 8 8" /></svg></Show>
            </span>
          }
        >
          <button type="button" class="media-tile media-disc" aria-pressed={playing() ? "true" : "false"} aria-label={`play ${props.filename}${props.part.durationMs === undefined ? "" : `, ${clockOf(props.part.durationMs)}`}`} onClick={toggle}>
            <Show when={playing()} fallback={<PlayGlyph />}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="6" width="3.6" height="12" rx="1.2" /><rect x="13.4" y="6" width="3.6" height="12" rx="1.2" /></svg>
            </Show>
          </button>
        </Show>
        <span class="media-file-text">
          <b class="media-file-name">{breakable(props.filename)}</b>
          <span class="media-file-size">{facts()}</span>
        </span>
      </div>
    </div>
  );
}

/** a file name broken between words, never inside one: a break is offered after each separator */
function breakable(name: string) {
  return name.split(/(?<=[-_.\s])/).flatMap((piece, i) => (i === 0 ? [piece] : [<wbr />, piece]));
}

function PageGlyph(props: { word: string }) {
  return (
    <>
      <svg viewBox="0 0 32 32" class="media-page"><path d="M9 4h10l6 6v16a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM19 4v6h6" /></svg>
      <span class="media-word">{props.word}</span>
    </>
  );
}

function PlayGlyph() {
  return (
    <svg viewBox="0 0 24 24" class="media-play">
      <path d="M8.5 6.2v11.6c0 .8.9 1.3 1.6.9l9-5.8c.6-.4.6-1.3 0-1.7l-9-5.8c-.7-.5-1.6 0-1.6.8z" />
    </svg>
  );
}
