/* the pixels of an image the server sent, for plate.ts to read: drawn into a small canvas (same origin, so they are
   readable). the only dom in the probe, kept here so probe.ts and its tests hold none */

import { SAMPLE } from "./plate";
import type { Sampled } from "./probe";

/** the pixels of an image the server sent, or null when the bytes are not one it can draw */
export async function sampleImage(blob: Blob, abort: AbortSignal): Promise<Sampled | null> {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  const gone = () => {
    image.src = "";
  };
  abort.addEventListener("abort", gone, { once: true });
  try {
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
    const aspect = image.naturalWidth > 0 && image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : 1;
    return { pixels: context.getImageData(0, 0, SAMPLE, SAMPLE).data, aspect };
  } catch {
    return null;
  } finally {
    abort.removeEventListener("abort", gone);
    URL.revokeObjectURL(url);
  }
}

