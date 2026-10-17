/* the composer's stories (docs/composer.md, every state): one per state,
   painted from the fixtures through the real store and component.
   `bun .ladle/shots.ts --prefix composer--` screenshots them at 390, 820
   and 1512 with the craft check. written with createElement: this file is
   react (ladle's host) and the project's jsx is solid's. */

import { createElement, type ReactElement, useEffect, useRef } from "react";
import { type ComposerStory, mountComposer } from "./mount";
import "./stories.css";

function Host(props: { story: ComposerStory }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    return el ? mountComposer(el, props.story) : undefined;
  }, [props.story]);
  return createElement("div", { ref, className: "story" });
}

const story = (name: ComposerStory) => () => createElement(Host, { story: name });

export const EmptyAgentDone = story("empty-done");
export const EmptyAgentWorking = story("empty-working");
export const EmptyWantsYou = story("empty-wants");
export const MarkdownInTheLiveLine = story("live-markdown");
export const Draft = story("draft");
export const DraftOneLine = story("draft-line");
export const LongDraft = story("long");
export const FullStage = story("full");
export const Shell = story("shell");
export const PhotoAttached = story("photo");
export const PhotoHeicAttached = story("photo-heic");
export const FileAttached = story("file");
export const FilesLongNames = story("file-long");
export const FileRefused = story("file-refused");
export const Sending = story("sending");
export const TwoQueued = story("queued");
export const SteerWhileWorking = story("steer");
export const SteerRunNow = story("steer-run-now");
export const SendFailed = story("failed");
export const GlassOverTheLog = story("glass");
export const GlassWithTheQueue = story("glass-queue");
export const GlassShellLine = story("glass-shell");
export const GlassAtRest = story("glass-rest");
export const GlassAtRestFocused = story("glass-rest-focus");
export const GlassAtRestOneLine = story("glass-rest-line");
export const GlassAtRestEmpty = story("glass-rest-empty");
export const GlassAtRestWorking = story("glass-rest-working");
export const GlassAtRestVioletEmpty = story("glass-rest-violet");
export const GlassAtRestVioletEmptyFocused = story("glass-rest-violet-focus");
export const GlassAtRestVioletOneLine = story("glass-rest-violet-line");
export const GlassAtRestOliveEmpty = story("glass-rest-olive");
export const DropOver = story("drop-over");
export const Dropped = story("dropped");
export const QueueThree = story("queue-three");
export const QueueFailedLeads = story("queue-failed-lead");
export const QueueList = story("queue-list");
export const QueueListWithDraft = story("queue-list-draft");
export const QueueVerbs = story("queue-verbs");
export const OfflineWaiting = story("offline");
export const ModelAndEffort = story("model");
export const SlashCommands = story("slash");
export const AtFiles = story("at");
export const KeyboardUp = story("keyboard");
export const EffortDial = story("dial");
export const EffortDialNamedVariants = story("dial-named");
export const EffortDialKeyboard = story("dial-keys");
export const AddToTheMessageKeyboard = story("tools-keys");
export const AddToTheMessage = story("tools");
export const AddToTheMessageContext = story("tools-context");
export const AddToTheMessageBusy = story("tools-busy");
export const ContextNearlyFull = story("context-full");
export const CompactRunning = story("compact-running");
export const CompactFailed = story("compact-failed");
export const CompactDone = story("compact-done");
export const SlashCompact = story("slash-compact");
export const ModelsFavorites = story("models-favorites");
export const ModelsInUseNotFavorite = story("models-pinned");
export const ModelsAllByProvider = story("models-all");
export const ModelsNoFavorites = story("models-none");
export const ModelsSearch = story("models-search");
export const ModelsLongNames = story("models-long");
export const ModelsStarRefused = story("models-star-refused");
export const ModelsHostListsNone = story("models-empty");
export const ModelsLoading = story("models-loading");
export const ModelsFailed = story("models-failed");
export const ModelsFailedEffort = story("models-failed-dial");
export const HomeDock = story("dock");
export const HomeDockNowhere = story("dock-nowhere");
export const NewThreadSheet = story("sheet");
export const NewThreadSheetTwoMachines = story("sheet-hosts");
export const NewThreadSheetFilter = story("sheet-finder");
export const NewThreadSheetFolders = story("sheet-browse");
export const NewThreadSheetStarting = story("sheet-starting");
export const NewThreadSheetFailed = story("sheet-failed");
export const NewThreadSheetFresh = story("sheet-fresh");
export const NewThreadSheetModel = story("sheet-model");
export const NewThreadSheetEffort = story("sheet-dial");
export const NewThreadSheetPlace = story("sheet-place");
export const NewThreadSheetLetsGo = story("sheet-away");

export default { title: "composer" };
