// The composer's cards for the visualize feedback queued for the next message,
// in the shape of attachment cards: a pin shows the crop of what it is about
// (the pane kind's registry entry says which icon stands in when there is
// none) under its note; picked choices and tweaked values get one small card
// each. `visualizeFeedbackCards` is the model; the component only draws it.
import { Check, Code, File, FileText, Film, Image, Shapes, SlidersHorizontal, X } from 'lucide-react';
import type { ComponentType } from 'react';

import {
  formatVisualizeTime,
  type VisualizeCommentIcon,
  visualizeCommentIcon,
} from '../shared/visualize-comment-kinds';
import { t } from './i18n';
import {
  clearVisualizeChoices,
  clearVisualizeTweaks,
  removeVisualizePin,
  requestVisualizePinOpen,
  useVisualizeFeedback,
  type VisualizeFeedback,
  visualizeFeedbackPending,
} from './visualize-feedback-store';
import { revealVisualizeTab } from './visualize-store';
import './visualize-feedback.css';

export type VisualizeFeedbackCard =
  | {
      type: 'pin';
      id: string;
      tabId: string;
      /** The pin's number, the same as in the panel. */
      n: number;
      label: string;
      note: string;
      /** Data URL of the crop; absent: the icon and label stand in. */
      image?: string;
      icon: VisualizeCommentIcon;
      /** A video pin's time on the thumbnail. */
      time?: string;
    }
  | { type: 'choices'; value: string; bar: string }
  | { type: 'tweaks'; value: string; color?: string; bar: string };

const COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([^)]*\))$/i;

/** The cards for the queue: its pins in order, then one for the choices and one for the tweaks. */
export function visualizeFeedbackCards(value: VisualizeFeedback): VisualizeFeedbackCard[] {
  const cards: VisualizeFeedbackCard[] = value.pins.map((pin, index) => ({
    type: 'pin',
    id: pin.id,
    tabId: pin.tabId,
    n: index + 1,
    label: pin.label,
    note: pin.note,
    ...(pin.image ? { image: `data:${pin.image.mimeType};base64,${pin.image.data}` } : {}),
    icon: visualizeCommentIcon(pin.paneKind),
    ...(pin.target.type === 'region' && pin.target.time !== undefined
      ? { time: formatVisualizeTime(pin.target.time) }
      : {}),
  }));
  if (value.choices.length) {
    const groups = [...new Set(value.choices.map((choice) => choice.group).filter(Boolean))];
    cards.push({
      type: 'choices',
      value: value.choices.map((choice) => choice.label || choice.choice).join(', '),
      bar: groups.join(', '),
    });
  }
  const changes = value.tweaks.flatMap((set) => set.changes);
  if (changes.length) {
    const first = changes[0].value.trim();
    cards.push({
      type: 'tweaks',
      value: changes.length > 1 ? `${first} +${changes.length - 1}` : first,
      ...(COLOR.test(first) ? { color: first } : {}),
      bar: changes.map((change) => change.id).join(', '),
    });
  }
  return cards;
}

const ICONS: Record<VisualizeCommentIcon, ComponentType<{ size?: number; 'aria-hidden'?: boolean }>> = {
  code: Code,
  'file-text': FileText,
  file: File,
  image: Image,
  shapes: Shapes,
  film: Film,
};

function RemoveButton({ label, onClick }: { label: string; onClick(): void }) {
  return (
    <button type="button" className="attachment-card-remove" aria-label={label} onClick={onClick}>
      <X size={12} aria-hidden={true} />
    </button>
  );
}

/** The composer's cards for the session's queued pins, picks and tweaks. */
export function VisualizeFeedbackCards({ sessionId }: { sessionId?: string }) {
  const value = useVisualizeFeedback(sessionId);
  if (!sessionId || !visualizeFeedbackPending(value)) return null;
  const open = (card: Extract<VisualizeFeedbackCard, { type: 'pin' }>) => {
    revealVisualizeTab(sessionId, card.tabId);
    requestVisualizePinOpen(sessionId, card.id);
  };
  return (
    <div className="composer-attachments visualize-feedback-cards" role="group" aria-label={t('Visualize feedback')}>
      {visualizeFeedbackCards(value).map((card) => {
        if (card.type === 'pin') {
          const Icon = ICONS[card.icon];
          return (
            <div
              key={card.id}
              className="attachment-card visualize-card"
              data-tooltip={`${card.label}\n${card.note}`}
              data-visualize-card="pin"
            >
              <span className="visualize-card-number">{card.n}</span>
              <button
                type="button"
                className="attachment-card-file visualize-card-open"
                aria-label={t('Open pin {{number}}', { number: String(card.n) })}
                onClick={() => open(card)}
              >
                <span className={`visualize-card-clip${card.image ? '' : ' is-fallback'}`}>
                  {card.image ? (
                    <img src={card.image} alt="" draggable={false} />
                  ) : (
                    <>
                      <Icon size={18} aria-hidden={true} />
                      <span className="visualize-card-label">{card.label}</span>
                    </>
                  )}
                  {card.time ? <span className="visualize-card-time">{card.time}</span> : null}
                </span>
                <span className="attachment-card-bar">
                  <span className="attachment-card-name">{card.note}</span>
                </span>
              </button>
              <RemoveButton
                label={t('Remove pin {{number}}', { number: String(card.n) })}
                onClick={() => removeVisualizePin(sessionId, card.id)}
              />
            </div>
          );
        }
        const isChoices = card.type === 'choices';
        return (
          <div
            key={card.type}
            className="attachment-card visualize-card is-mini"
            data-tooltip={[card.value, card.bar].filter(Boolean).join('\n')}
            data-visualize-card={card.type}
          >
            <div className="attachment-card-file">
              <span className="visualize-card-clip is-mini">
                <span className="visualize-card-kind">
                  {isChoices ? (
                    <Check size={12} aria-hidden={true} />
                  ) : (
                    <SlidersHorizontal size={12} aria-hidden={true} />
                  )}
                  {isChoices ? t('Chosen design') : t('Tweaks')}
                </span>
                <span className="visualize-card-value">
                  {card.type === 'tweaks' && card.color ? (
                    <span className="visualize-card-swatch" style={{ background: card.color }} />
                  ) : null}
                  {card.value}
                </span>
              </span>
              <span className="attachment-card-bar">
                <span className="attachment-card-name">{card.bar}</span>
              </span>
            </div>
            <RemoveButton
              label={isChoices ? t('Clear choices') : t('Clear tweaks')}
              onClick={() => (isChoices ? clearVisualizeChoices(sessionId) : clearVisualizeTweaks(sessionId))}
            />
          </div>
        );
      })}
    </div>
  );
}
