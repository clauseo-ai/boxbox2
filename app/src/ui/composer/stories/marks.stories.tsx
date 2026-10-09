/* the provider marks' contact sheet: every mark as a tile (22px) and as the bare glyph (16px) with its
   key beside it, then three providers with no mark on the monogram, on a repo-coloured window.
   this file is react (ladle's host) and the project's jsx is solid's, so the solid components are
   mounted with createComponent and the sheet's own markup is plain dom. */

import { createElement, type ReactElement, useEffect, useRef } from "react";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { colourOf, colourStyle } from "../../window/repo";
import { MarkGlyph, ProviderMark } from "../mark";
import { MARK_NAMES } from "../marks-data";
import { DIRECTORY, HOST } from "./fixtures";
import "./marks.css";

const UNKNOWN = ["Acme Labs", "bonsai", "Zeta"];

function node(tag: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}

function list(el: HTMLElement, heading: string, names: ReadonlyArray<string>, glyph: boolean, disposers: Array<() => void>): void {
  el.append(node("h2", heading));
  const ul = node("ul");
  for (const name of names) {
    const li = node("li");
    const tile = node("span");
    const bare = node("span");
    li.append(tile, ...(glyph ? [bare] : []), node("code", name));
    ul.append(li);
    disposers.push(render(() => createComponent(ProviderMark, { provider: name }), tile));
    if (glyph) disposers.push(render(() => createComponent(MarkGlyph, { provider: name }), bare));
  }
  el.append(ul);
}

function mount(host: HTMLElement): () => void {
  const root = node("div");
  root.className = "cz-story-marks plane-window";
  root.setAttribute("data-ready", "");
  for (const [key, value] of Object.entries(colourStyle(colourOf({ host: HOST, root: DIRECTORY })))) root.style.setProperty(key, value);
  const disposers: Array<() => void> = [];
  list(root, "marks", MARK_NAMES, true, disposers);
  list(root, "no mark", UNKNOWN, false, disposers);
  host.append(root);
  return () => {
    for (const dispose of disposers) dispose();
    root.remove();
  };
}

function Host(): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    return el ? mount(el) : undefined;
  }, []);
  return createElement("div", { ref, className: "story" });
}

export const ProviderMarks = () => createElement(Host);

export default { title: "composer" };
