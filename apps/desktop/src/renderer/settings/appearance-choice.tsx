// The one appearance choice shared by Settings → Theme and onboarding: System /
// Dark / White (skin off + the app theme) and the skins (skin on). Exactly one
// tile is selected; every click applies at once and is stored on this device.
// The theme setter keeps its value while a skin is on, so turning the skin off
// (or picking a theme tile) returns to a known theme.
import { Plus } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  BUILTIN_SKINS,
  CUSTOM_MEDIA_ACCEPT,
  CUSTOM_MEDIA_MAX_BYTES,
  CUSTOM_VIDEO_MAX_SECONDS,
  CustomSkinMediaError,
  getCustomSkinFocal,
  getCustomSkinImage,
  getSkinId,
  prepareCustomSkin,
  setSkin,
  subscribeSkin,
  type PreparedSkinImage,
} from '../desktop-skin';
import { getDesktopThemePreference, setDesktopThemePreference } from '../desktop-theme';
import { HOST_DISPLAY_ADOPTED_EVENT } from '../host-display-sync';
import { t } from '../i18n';
import { SkinCustomDialog } from './skin-custom-dialog';
import './skin-panel.css';

const THEME_TILES = ['system', 'dark', 'white'] as const;
type ThemeTile = (typeof THEME_TILES)[number];

function isThemeTile(id: string): id is ThemeTile {
  return (THEME_TILES as readonly string[]).includes(id);
}

/** The tile for the stored theme: anything but System / White shows as Dark (the app default). */
function themeTile(): ThemeTile {
  const preference = getDesktopThemePreference();
  return preference === 'system' ? 'system' : preference === 'white' ? 'white' : 'dark';
}

/** The selected tile id (the skin while one is on, else the theme) and the setter for a local theme pick. */
function useAppearanceTile(): [string, (tile: ThemeTile) => void] {
  const skin = useSyncExternalStore(subscribeSkin, getSkinId, getSkinId);
  const [theme, setTheme] = useState<ThemeTile>(themeTile);
  useEffect(() => {
    const refresh = () => setTheme(themeTile());
    refresh();
    // The host PC's theme replaced this device's while the page was open.
    window.addEventListener(HOST_DISPLAY_ADOPTED_EVENT, refresh);
    return () => window.removeEventListener(HOST_DISPLAY_ADOPTED_EVENT, refresh);
  }, []);
  return [skin !== 'none' ? skin : theme, setTheme];
}

function Card({
  id,
  label,
  tone,
  image,
  position,
  dot,
  checked,
  focusable,
  onPreview,
  onFocusCard,
  onChoose,
}: {
  id: string;
  label: string;
  tone?: ThemeTile;
  image?: string | null;
  position?: string;
  dot?: string;
  checked: boolean;
  focusable: boolean;
  onPreview(id: string): void;
  onFocusCard(id: string): void;
  onChoose(id: string): void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={focusable ? 0 : -1}
      className="skin-card"
      data-skin={id}
      onClick={() => onChoose(id)}
      onPointerEnter={() => onPreview(id)}
      onPointerLeave={() => onPreview('')}
      onFocus={() => {
        onPreview(id);
        onFocusCard(id);
      }}
      onBlur={() => onPreview('')}
    >
      <span
        className="skin-card-thumb"
        data-tone={tone}
        style={image ? { backgroundImage: `url("${image}")`, backgroundPosition: position } : undefined}
      >
        {dot && <span className="skin-card-dot" style={{ background: dot }} />}
      </span>
      <span className="skin-card-label">{label}</span>
    </button>
  );
}

/** `onPreview` gets the skin id to preview, 'none' for a theme tile, null when the pointer/focus leaves. */
export function AppearanceChoice({ onPreview }: { onPreview?(id: string | null): void }) {
  const [selected, setTheme] = useAppearanceTile();
  const customImage = useSyncExternalStore(
    subscribeSkin,
    () => getCustomSkinImage() ?? '',
    () => ''
  );
  const [focused, setFocused] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedSkinImage | null>(null);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const radios = useRef<HTMLDivElement>(null);

  const tileIds = [...THEME_TILES, ...BUILTIN_SKINS.map((entry) => entry.id), ...(customImage ? ['custom'] : [])];
  const tabStop = focused && tileIds.includes(focused) ? focused : selected;
  const preview = (id: string) => onPreview?.(id === '' ? null : isThemeTile(id) ? 'none' : id);
  const choose = (id: string) => {
    onPreview?.(null);
    // The current tile is already applied: nothing to change (a re-select
    // would also drop a plate chosen for the skin).
    if (id === selected) return;
    if (isThemeTile(id)) {
      setSkin('none');
      setDesktopThemePreference(id);
      setTheme(id);
    } else setSkin(id);
  };
  const arrow = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    const cards = [...(radios.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    const at = cards.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    cards[(at + step + cards.length) % cards.length]?.focus();
  };
  const pickFile = async (file: File) => {
    setError('');
    try {
      const next = await prepareCustomSkin(file);
      // A hover preview must not linger behind the dialog.
      onPreview?.(null);
      setPrepared(next);
    } catch (failure) {
      const problem = failure instanceof CustomSkinMediaError ? failure.problem : null;
      setError(
        problem === 'size'
          ? t('This file is larger than {{size}} MB. Choose a smaller picture or video.', {
              size: CUSTOM_MEDIA_MAX_BYTES / 1024 / 1024,
            })
          : problem === 'duration'
            ? t('This video is longer than {{seconds}} seconds. Choose a shorter one.', {
                seconds: CUSTOM_VIDEO_MAX_SECONDS,
              })
            : problem === 'type'
              ? t('Choose a picture (PNG, JPEG, WebP or GIF) or a video (MP4 or WebM).')
              : t('The skin could not be applied. Try a smaller image.')
      );
    }
  };
  const card = (id: string, label: string, extra: Partial<Parameters<typeof Card>[0]> = {}) => (
    <Card
      key={id}
      id={id}
      label={label}
      checked={selected === id}
      focusable={tabStop === id}
      onPreview={preview}
      onFocusCard={setFocused}
      onChoose={choose}
      {...extra}
    />
  );

  return (
    <>
      <div className="skin-cards">
        {/* biome-ignore lint/a11y/useSemanticElements: a card grid of picture radios, not form radio inputs. */}
        <div
          ref={radios}
          className="skin-radios"
          role="radiogroup"
          aria-label={t('Choose an appearance')}
          onKeyDown={arrow}
        >
          <div className="skin-tiles" data-row="theme">
            {card('system', t('System'), { tone: 'system' })}
            {card('dark', t('Dark'), { tone: 'dark' })}
            {card('white', t('Light'), { tone: 'white' })}
          </div>
          <div className="skin-tiles" data-row="skin" data-count={BUILTIN_SKINS.length + (customImage ? 2 : 1)}>
            {BUILTIN_SKINS.map((entry) =>
              card(entry.id, t(entry.label), { image: entry.image, position: entry.focal, dot: entry.accent })
            )}
            {customImage && card('custom', t('My image'), { image: customImage, position: getCustomSkinFocal() })}
            <button type="button" className="skin-card skin-card-add" onClick={() => fileInput.current?.click()}>
              <span className="skin-card-thumb">
                <Plus aria-hidden="true" size={20} />
              </span>
              <span className="skin-card-label">{t('Add my picture')}</span>
            </button>
          </div>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept={CUSTOM_MEDIA_ACCEPT}
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void pickFile(file);
          }}
        />
      </div>
      {error && <p role="alert">{error}</p>}
      {prepared && (
        <SkinCustomDialog
          prepared={prepared}
          onClose={() => setPrepared(null)}
          onApplied={() => {
            setPrepared(null);
            onPreview?.(null);
          }}
        />
      )}
    </>
  );
}
