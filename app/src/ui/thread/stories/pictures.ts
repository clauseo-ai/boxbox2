/* the images the stories' tools return: drawn on a canvas when the story builds, so no picture is a file in the repo. each is a
   data url like the one the daemon sends (png, a gradient with its own name written across it) */

import type { Picture } from "../model";

export function picture(filename: string, hue: number, width = 640, height = 400, mime: "image/png" | "image/jpeg" = "image/png"): Picture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("no canvas to draw the sample picture on");
  const fill = g.createLinearGradient(0, 0, width, height);
  fill.addColorStop(0, `hsl(${hue} 70% 55%)`);
  fill.addColorStop(1, `hsl(${(hue + 70) % 360} 65% 30%)`);
  g.fillStyle = fill;
  g.fillRect(0, 0, width, height);
  g.fillStyle = "rgb(255 255 255 / 0.85)";
  g.fillRect(width * 0.08, height * 0.12, width * 0.84, 10);
  g.fillRect(width * 0.08, height * 0.2, width * 0.5, 10);
  g.font = `${Math.round(height / 9)}px monospace`;
  g.fillText(filename, width * 0.08, height * 0.9);
  return { mime, filename, url: canvas.toDataURL(mime) };
}
