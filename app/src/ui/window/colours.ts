/* the one place a surface asks what colour a repo wears (docs/design.md, colour): what the server gave it or the person
   chose (`state.fleet.colours`), with the picker's preview over it. components call `repoColour`; the pure modules that
   derive a view (window/view.ts, history/rows.ts) take `colourMap()` from their reactive callers, so every surface reads
   the same map and repaints when a `colour` frame lands or the preview moves. */

import { state } from "../../store";
import { type ColourMap, colourOf, hashColour, type Repo, type RepoColour, repoColourNamed, repoKey } from "./repo";

/** the fleet's colours with the picker's preview in place of its repo's choice. a preview naming a colour this build does
    not know changes nothing, as an unknown choice from the server would not */
export function colourMap(): ColourMap {
  const colours = state.fleet.colours;
  const preview = state.colourPreview;
  if (!preview || !repoColourNamed(preview.name)) return colours;
  const key = repoKey(preview);
  // automatic stays what it was (the hash colour when the server has not spoken), so the picker can still mark it
  const auto = colours[key]?.auto ?? hashColour(preview).name;
  return { ...colours, [key]: { auto, chosen: preview.name } };
}

/** the colour `repo` wears on screen now */
export function repoColour(repo: Repo): RepoColour {
  return colourOf(repo, colourMap());
}
