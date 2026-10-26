// The comment the Comment layer's card is writing, and what it is called.
import type { VisualizePaneView } from '../shared/visualize';
import { visualizeCommentLabel } from '../shared/visualize-comment-kinds';
import type { VisualizeFeedbackRect, VisualizePagePick } from '../shared/visualize-feedback';
import { t } from './i18n';
import { MAX_VISUALIZE_PINS, type VisualizePin, type VisualizeRegionAnchor } from './visualize-feedback-store';

/** A comment being written (fractions of the layer): a new pin, on the
 *  element the page described or a dragged region (on HTML, with the element
 *  it lies in), or a queued pin reopened. */
export type CommentDraft =
  | {
      mode: 'new';
      rect: VisualizeFeedbackRect;
      pick?: VisualizePagePick;
      time?: number;
      elements?: number;
      anchor?: VisualizeRegionAnchor;
    }
  | { mode: 'edit'; pinId: string; rect: VisualizeFeedbackRect };

/** The page element a pin is drawn on: an element pin's own, an anchored
 *  region's anchor (null: the panel draws it). */
export const pinElement = (pin: VisualizePin): string | null =>
  pin.target.type === 'element' ? pin.target.selector : (pin.target.anchor?.selector ?? null);

export const fullNotice = () =>
  t('Up to {{count}} pins per message. Send or remove some first.', { count: MAX_VISUALIZE_PINS });

/** The card's title: a reopened pin keeps its own label; a new one is named
 *  after its element, or its region (with its time and element count). */
export function commentDraftLabel(
  draft: CommentDraft,
  editedPin: VisualizePin | undefined,
  pane: VisualizePaneView
): string {
  if (draft.mode === 'edit') return editedPin?.label ?? '';
  return draft.pick
    ? visualizeCommentLabel({ type: 'element', role: draft.pick.role, name: draft.pick.name }, pane, t)
    : visualizeCommentLabel({ type: 'region', time: draft.time, elements: draft.elements }, pane, t);
}
