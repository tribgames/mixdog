// "Add my picture": after choosing a file the user marks the picture's subject
// (the app keeps chat text off it) and picks the accent, then applies. Rides
// the shared settings-confirm dialog skin.
import { X } from 'lucide-react';
import { type PointerEvent, useEffect, useId, useState } from 'react';
import { commitCustomSkin, type PreparedSkinImage } from '../desktop-skin';
import { t } from '../i18n';
import { focalOfPoint } from '../skin-color';
import { useMobileBack } from '../mobile-back';
import { scrimDismiss } from '../scrim-dismiss';
import { acquireTitleBarDim } from '../titlebar-dim';
import './skin-panel.css';

/** One axis of the subject point, 0–100% of the picture. */
function FocalAxis({ label, value, onChange }: { label: string; value: number; onChange(value: number): void }) {
  const labelId = useId();
  const percent = Math.round(value * 100);
  return (
    <div className="skin-focal-axis">
      <span id={labelId}>{label}</span>
      <span className="skin-slider">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={percent}
          aria-labelledby={labelId}
          aria-valuetext={`${percent}%`}
          onChange={(event) => onChange(Number(event.currentTarget.value) / 100)}
        />
        <output className="skin-slider-value" aria-hidden="true">
          {percent}%
        </output>
      </span>
    </div>
  );
}

export function SkinCustomDialog({
  prepared,
  onClose,
  onApplied,
}: {
  prepared: PreparedSkinImage;
  onClose(): void;
  onApplied(): void;
}) {
  const titleId = `${useId()}-title`;
  const [point, setPoint] = useState({ x: 0.5, y: 0.5 });
  const [accent, setAccent] = useState(prepared.accent);
  const [failed, setFailed] = useState(false);
  useMobileBack(true, onClose);
  useEffect(() => acquireTitleBarDim(), []);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => opener?.focus();
  }, []);
  const mark = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    setPoint({ x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height });
  };
  const [focalX, focalY] = focalOfPoint(point.x, point.y).split(' ');
  return (
    // A backdrop press closes the dialog; Escape and the close button are the keyboard routes.
    <div className="settings-confirm-layer" {...scrimDismiss(onClose)}>
      <section
        className="settings-confirm-dialog skin-custom-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-settings-nested-dialog
      >
        <header>
          <h3 id={titleId}>{t('Make a skin from my picture')}</h3>
          <button type="button" aria-label={t('Close')} data-settings-nested-close onClick={onClose}>
            <X aria-hidden="true" size={16} />
          </button>
        </header>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the body scrolls under a tall picture; a tab stop lets the keyboard scroll it */}
        <section className="skin-custom-body" tabIndex={0} aria-labelledby={titleId}>
          <p>{t('Click the part of the picture to keep in view when the window crops it.')}</p>
          {/* The pointer marks a point on the picture; the two sliders below set
              the same point one axis at a time, for the keyboard and screen readers. */}
          <div className="skin-focal" aria-hidden="true" data-focal={`${focalX} ${focalY}`} onPointerDown={mark}>
            <img src={prepared.dataUrl} alt="" draggable={false} />
            <div className="skin-focal-safe">
              <span>{t('Where the chat sits')}</span>
            </div>
            <div className="skin-focal-pin" style={{ left: focalX, top: focalY }} />
          </div>
          <fieldset className="skin-focal-axes" aria-label={t('Subject position')}>
            <FocalAxis
              label={t('Horizontal position')}
              value={point.x}
              onChange={(x) => setPoint((p) => ({ ...p, x }))}
            />
            <FocalAxis
              label={t('Vertical position')}
              value={point.y}
              onChange={(y) => setPoint((p) => ({ ...p, y }))}
            />
          </fieldset>
          <div className="skin-picked">
            <span>{t('Accent colors from the picture')}</span>
            {prepared.swatches.map((color) => (
              <button
                type="button"
                key={color}
                className="skin-swatch"
                style={{ background: color }}
                aria-label={color}
                aria-pressed={accent === color}
                onClick={() => setAccent(color)}
              />
            ))}
          </div>
          {failed && <p role="alert">{t('The skin could not be applied. Try a smaller image.')}</p>}
        </section>
        <footer>
          <button type="button" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => {
              setFailed(false);
              // A moving pick is stored first; a full store keeps the dialog open.
              commitCustomSkin({ ...prepared, accent }, point).then(onApplied, () => setFailed(true));
            }}
          >
            {t('Use as skin')}
          </button>
        </footer>
      </section>
    </div>
  );
}
