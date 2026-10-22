/* the surfaces that open only after a person acts, split from the first load (architecture.md, the script budget): the
   new-thread sheet, home's answer sheet, the composer's model menu, effort dial, plus menu, suggestions (a `/`, `@` or
   `!` draft), queue list and queue verbs, an agent's report in its sheet, a file in the reader, the details' spend
   dialog, a tool's picture full size, an opened row's file bed, slip, diff or agent's, search's, plan's, files or thoughts body, and a settled question's record. each is a chunk of its own. the shell warms them all once the launch
   has painted and the page is idle (the machines, history, settings and the terminal load when first asked for), and a trigger warms its own
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
export const Suggestions = lazy(() => import("./composer/suggestions").then((m) => ({ default: m.Suggestions })));
export const QueueList = lazy(() => import("./composer/queue-list").then((m) => ({ default: m.QueueList })));
export const QueueVerbs = lazy(() => import("./composer/queue-verbs").then((m) => ({ default: m.QueueVerbs })));
export const ReportSheet = lazy(() => import("./thread/report-sheet").then((m) => ({ default: m.ReportSheet })));
export const FileReader = lazy(() => import("./thread/reader").then((m) => ({ default: m.FileReader })));
export const SpendDialog = lazy(() => import("./thread/spend-dialog").then((m) => ({ default: m.SpendDialog })));
export const PictureViewer = lazy(() => import("./thread/picture-viewer").then((m) => ({ default: m.PictureViewer })));
/* what an opened row holds when it is a file's lines or an agent's words (a read's bed, a brief's or a message's slip): drawn only in a
   row someone opened, so split as the surfaces are and warmed with them; the row's press opens it at once once warmed */
export const FileBed = lazy(() => import("./thread/code").then((m) => ({ default: m.FileBed })));
export const Slip = lazy(() => import("./thread/code").then((m) => ({ default: m.Slip })));
/* an opened agent's, search's, plan's, files, edit's or thought row's body (thread/bodies.tsx): drawn in a row someone opened, or one open on
   its own that is not a pending ask (a failure, a settled permission, thoughts under "show thinking"), which waits on the warmed chunk */
export const AgentBody = lazy(() => import("./thread/bodies").then((m) => ({ default: m.AgentBody })));
export const HitsBody = lazy(() => import("./thread/bodies").then((m) => ({ default: m.HitsBody })));
export const PlanBody = lazy(() => import("./thread/bodies").then((m) => ({ default: m.PlanBody })));
export const FilesBody = lazy(() => import("./thread/bodies").then((m) => ({ default: m.FilesBody })));
export const DiffBed = lazy(() => import("./thread/bodies").then((m) => ({ default: m.DiffBed })));
export const ThoughtsBody = lazy(() => import("./thread/bodies").then((m) => ({ default: m.ThoughtsBody })));
/* a settled question's record (asks/ask-record.tsx): drawn only in a settled ask's row, closed until it is opened, or in a card that
   settles in place; a pending ask's card, words and options stay in the first load */
export const AskRecord = lazy(() => import("./asks/ask-record").then((m) => ({ default: m.AskRecord })));
/* the line a settled permission leaves above its tool's body (same chunk): a settled row, open on it, waits on the warmed chunk */
export const PermitRecord = lazy(() => import("./asks/ask-record").then((m) => ({ default: m.PermitRecord })));

type Surface = Component<never> & { preload: () => Promise<unknown> };
const surfaces = { NewThreadSheet, AskSheet, ModelMenu, EffortDial, ToolsMenu, Suggestions, QueueList, QueueVerbs, ReportSheet, FileReader, SpendDialog, PictureViewer, FileBed, Slip, AskRecord, PermitRecord, AgentBody, HitsBody, PlanBody, FilesBody, DiffBed, ThoughtsBody } satisfies Record<string, Surface>;
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

/* the stars on the model menu's rows (composer/favorites.ts) save and refresh only once the menu is open, so they are
   split the same way: the composer asks for them as the menu opens (a refresh) and at a star, and they are warmed with
   the surfaces. a star is a press inside the open menu, so its module is in by then and the star lands in the same frame */
let stars: Promise<typeof import("./composer/favorites")> | undefined;

/** the stars' saving and refreshing, loaded once */
export const starring = (): Promise<typeof import("./composer/favorites")> =>
  (stars ??= import("./composer/favorites").catch((error: unknown) => {
    // a chunk that did not come (a page from before a deploy) is asked for again next time
    stars = undefined;
    throw error;
  }));

/** loads every surface here, the edge's motion and the stars, for the shell's idle moment after the launch */
export const warmLater = (): Promise<unknown> => Promise.all([...Object.keys(surfaces).map((name) => warm(name as SurfaceName)), warmEdge(), starring()]);
