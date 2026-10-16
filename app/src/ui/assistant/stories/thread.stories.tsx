/* the assistant thread's stories for pictures, files, the viewer, quotes, reactions, the reply strip and the small rows
   (docs/thread.md, an assistant's thread). `bun .ladle/shots.ts --prefix assistant-thread--` shoots them. */

import { story } from "./host";
import * as m from "./thread-mount";

export default { title: "assistant-thread" };

export const ImageLandscape = story(m.imageLandscape);
export const ImagePortrait = story(m.imagePortrait);
export const ImageNoSize = story(m.imageNoSize);
export const ImagePendingMissingEvicted = story(m.imageStates);
export const ImageUploads = story(m.imageUploads);
export const Files = story(m.files);
export const FilePendingMissingEvictedUploads = story(m.fileStates);
export const AudioFile = story(m.audioFile);
export const ViewerOpen = story(m.viewerOpen);
export const ViewerNamed = story(m.viewerNamed);
export const ViewerZoomed = story(m.viewerZoomed);
export const OriginLines = story(m.originLines);
export const Quotes = story(m.quotes);
export const QuoteJump = story(m.quoteJump);
export const RowControls = story(m.rowControls);
export const Reactions = story(m.reactions);
export const ReactionBar = story(m.reactionBar);
export const ReactionBarHere = story(m.reactionBarHere);
export const ReplyStrip = story(m.replyStrip);
export const Unconfirmed = story(m.unconfirmed);
export const UnknownPart = story(m.unknownPart);
export const ScheduledAndThinking = story(m.scheduledAndThinking);
export const GroupSender = story(m.groupSender);
export const Conversation = story(m.conversation);
