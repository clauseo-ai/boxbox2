/* the surfaces that open only after a person acts, split from the first load (architecture.md, the script budget): the
   new-thread sheet, home's answer sheet, the composer's model menu, effort dial, plus menu and queue list, an agent's
   report in its sheet and a file in the reader. each is a chunk of its own. the shell warms them all once the launch
   has painted and the page is idle (with the machines, history, settings and the terminal), and a trigger warms its own
   at the first touch (pointerdown). a surface never opens onto nothing: its trigger opens it through `whenLoaded`,
   which opens at once when the chunk is in (solid's `lazy` then renders it in the same pass, as when it was in the
   first load) and, for a press that beat the warming, opens it the moment the chunk lands (a read from the worker's
   precache). their styles stay in the first load, imported by their hosts, so a chunk arriving never reorders the
   cascade. */

import { type Component, lazy } from "solid-js";

export const NewThreadSheet = lazy(() => import("./composer/sheet").then((m) => ({ default: m.NewThreadSheet })));
export const AskSheet = lazy(() => import("./asks/sheet").then((m) => ({ default: m.AskSheet })));
export const ModelMenu = lazy(() => import("./composer/model-menu").then((m) => ({ default: m.ModelMenu })));
export const EffortDial = lazy(() => import("./composer/effort-dial").then((m) => ({ default: m.EffortDial })));
export const ToolsMenu = lazy(() => import("./composer/tools-menu").then((m) => ({ default: m.ToolsMenu })));
export const QueueList = lazy(() => import("./composer/queue-list").then((m) => ({ default: m.QueueList })));
export const ReportSheet = lazy(() => import("./thread/report-sheet").then((m) => ({ default: m.ReportSheet })));
export const FileReader = lazy(() => import("./thread/reader").then((m) => ({ default: m.FileReader })));

type Surface = Component<never> & { preload: () => Promise<unknown> };
const surfaces = { NewThreadSheet, AskSheet, ModelMenu, EffortDial, ToolsMenu, QueueList, ReportSheet, FileReader } satisfies Record<string, Surface>;
export type SurfaceName = keyof typeof surfaces;

const loaded = new Set<SurfaceName>();

/** loads one surface's chunk ahead of its opening */
export const warm = (name: SurfaceName): Promise<void> =>
  surfaces[name].preload().then(() => {
    loaded.add(name);
  });

/** warms a surface from its trigger's pointerdown; a chunk that does not come is left to its opening */
export const warmOn = (name: SurfaceName) => (): void => void warm(name).catch(() => undefined);

/** opens a surface through `open`: at once when its chunk is in, else when it lands. a chunk that does not come (a page
    from before a deploy) still opens, so the failure shows where the surface would have */
export function whenLoaded(name: SurfaceName, open: () => void): void {
  if (loaded.has(name)) return open();
  void warm(name).then(open, open);
}

/* the stage card's edge in motion (home/edge.ts) is not a surface but runs only when a person folds or opens a column
   beside the stage, so it is split the same way: warmed with the surfaces and at a fold toggle's pointerdown. home asks
   for it with `edgeIfLoaded` and starts the move in the same task when it is in, as when it was in the first load */
export type Edge = typeof import("./home/edge");
let edge: Edge | undefined;

/** loads the edge's motion ahead of a fold */
export const warmEdge = (): Promise<Edge> =>
  import("./home/edge").then((m) => {
    edge = m;
    return m;
  });

/** warms the edge's motion from a fold toggle's pointerdown; a chunk that does not come is left to the fold */
export const warmEdgeOn = (): void => void warmEdge().catch(() => undefined);

/** the edge's motion, once its chunk is in */
export const edgeIfLoaded = (): Edge | undefined => edge;

/** loads every surface here, and the edge's motion, for the shell's idle moment after the launch */
export const warmLater = (): Promise<unknown> => Promise.all([...Object.keys(surfaces).map((name) => warm(name as SurfaceName)), warmEdge()]);
