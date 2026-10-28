// Settings → Theme (page id 'skin'): a live preview, one tile grid (System /
// Dark / Light / skins), the skin fine-tuning rows, color theme files and fonts.
// Everything applies at once (no save button) and is stored
// on this device only, like the theme. The preview paints with the same
// --mx-skin-* variables the real app gets (desktop-skin.ts skinVars), so the
// two cannot drift; hovering or focusing a card changes only the preview.
import { type CSSProperties, type ReactNode, useState, useSyncExternalStore } from 'react';
import {
  currentSkinTheme,
  defaultSkinPlate,
  getCustomSkinImage,
  getSkinAccent,
  getSkinId,
  getSkinPhoto,
  getSkinPlate,
  getSkinMainTransparency,
  getSkinOuterTransparency,
  resetSkin,
  setSkinAccent,
  setSkinPhoto,
  setSkinPlate,
  setSkinMainTransparency,
  setSkinOuterTransparency,
  skinVars,
  subscribeSkin,
  type SkinId,
  type SkinPlate,
} from '../desktop-skin';
import { t } from '../i18n';
import { ACCENT_SWATCHES } from '../skin-manifest';
import { ActionButton, CompactSwitch, Group } from './capability-controls';
import type { PanelContext } from './capability-data';
import { AppearanceChoice } from './appearance-choice';
import { FontsGroup, ThemeFilesGroup } from './appearance-panel';
import './skin-panel.css';

/** One bundle of everything the skin page shows, so one subscription re-renders it. */
function useSkinState() {
  const read = () =>
    [
      getSkinId(),
      getSkinOuterTransparency(),
      getSkinMainTransparency(),
      getSkinPlate(),
      getSkinAccent() ?? '',
      getSkinPhoto(),
      getCustomSkinImage() ?? '',
    ].join('|');
  useSyncExternalStore(subscribeSkin, read, read);
  return {
    skin: getSkinId(),
    outerTransparency: getSkinOuterTransparency(),
    mainTransparency: getSkinMainTransparency(),
    plate: getSkinPlate(),
    accent: getSkinAccent(),
    photo: getSkinPhoto(),
    customImage: getCustomSkinImage(),
  };
}

function SkinPreview({
  id,
  previewing,
  state,
}: {
  id: SkinId;
  previewing: boolean;
  state: ReturnType<typeof useSkinState>;
}) {
  // A previewed skin shows with its own default plate: choosing it would too.
  const plate: SkinPlate = previewing ? defaultSkinPlate(id) : state.plate;
  const vars = skinVars(
    id,
    {
      outerTransparency: state.outerTransparency,
      mainTransparency: state.mainTransparency,
      plate,
      accent: state.accent,
    },
    currentSkinTheme()
  );
  return (
    <div
      className="skin-preview"
      role="img"
      aria-label={t('Skin preview')}
      style={vars as CSSProperties}
      data-photo={state.photo && id !== 'none' ? 'on' : 'off'}
      data-skin-preview={id}
    >
      {previewing && <span className="skin-preview-tag">{t('Previewing')}</span>}
      <div className="skin-preview-side">
        <div className="skin-preview-new">＋ {t('New task')}</div>
        <div className="skin-preview-item" data-on="true">
          {t('Sessions')}
        </div>
        <div className="skin-preview-item" />
        <div className="skin-preview-item" />
      </div>
      <div className="skin-preview-main">
        <div className="skin-preview-bubble" />
        <div className="skin-preview-bubble" data-me="true" />
        <div className="skin-preview-composer">
          <span />
          <span className="skin-preview-send">↑</span>
        </div>
      </div>
    </div>
  );
}

function SkinRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="mixdog-settings__row skin-row">
      <div className="mixdog-settings__copy">
        <span className="mixdog-settings__row-title">{title}</span>
        {description && <span className="skin-row-desc">{description}</span>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange(value: T): void;
}) {
  return (
    <div className="skin-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          aria-pressed={option.value === value}
          data-value={option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function TransparencySlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
}) {
  return (
    <div className="skin-slider">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        aria-label={label}
        aria-valuetext={`${value}%`}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      <output className="skin-slider-value">{value}%</output>
    </div>
  );
}

export function SkinPanel(_props: Partial<PanelContext>) {
  const state = useSkinState();
  const [hover, setHover] = useState<string | null>(null);
  const previewId = hover ?? state.skin;
  const previewing = hover !== null && hover !== state.skin;

  const active = state.skin !== 'none';

  return (
    <>
      <SkinPreview id={previewId} previewing={previewing} state={state} />
      <Group
        title={t('Appearance')}
        description={t('Saved on this device only. Other devices keep their own skin.')}
        actions={<ActionButton onClick={resetSkin}>{t('Reset to defaults')}</ActionButton>}
      >
        <AppearanceChoice onPreview={setHover} />
      </Group>
      {active && (
        <Group title={t('Fine tuning')}>
          <SkinRow
            title={t('Panel color')}
            description={t('Color of the sidebar and message panels. Light glass suits bright pictures.')}
          >
            <Segmented<SkinPlate>
              label={t('Panel color')}
              value={state.plate}
              options={[
                { value: 'light', label: t('Light glass') },
                { value: 'dark', label: t('Dark glass') },
                { value: 'tint', label: t('Picture color') },
              ]}
              onChange={setSkinPlate}
            />
          </SkinRow>
          <SkinRow
            title={t('Outer panels transparency')}
            description={t('How much of the picture shows through the window frame, sidebar and side dock.')}
          >
            <TransparencySlider
              label={t('Outer panels transparency')}
              value={state.outerTransparency}
              onChange={setSkinOuterTransparency}
            />
          </SkinRow>
          <SkinRow
            title={t('Main panel transparency')}
            description={t('How much of the picture shows through the conversation area and its cards.')}
          >
            <TransparencySlider
              label={t('Main panel transparency')}
              value={state.mainTransparency}
              onChange={setSkinMainTransparency}
            />
          </SkinRow>
          <SkinRow
            title={t('Accent color')}
            description={t('Colors the New task and send buttons and the message box outline.')}
          >
            <div className="skin-swatches" role="group" aria-label={t('Accent color')}>
              <button
                type="button"
                className="skin-swatch-auto"
                aria-pressed={state.accent === null}
                onClick={() => setSkinAccent(null)}
              >
                {t('From the picture')}
              </button>
              {ACCENT_SWATCHES.map((swatch) => (
                <button
                  type="button"
                  key={swatch.color}
                  className="skin-swatch"
                  style={{ background: swatch.color }}
                  aria-label={t(swatch.label)}
                  aria-pressed={state.accent === swatch.color}
                  data-color={swatch.color}
                  onClick={() => setSkinAccent(swatch.color)}
                />
              ))}
            </div>
          </SkinRow>
          <SkinRow title={t('Background photo')} description={t('Turn off to keep the colors and hide the picture.')}>
            <CompactSwitch
              label={t('Background photo')}
              checked={state.photo}
              optimistic={false}
              onChange={setSkinPhoto}
            />
          </SkinRow>
        </Group>
      )}
      <ThemeFilesGroup />
      <FontsGroup />
    </>
  );
}
