// Settings → Appearance (the lower sections): user JSON color themes and fonts. Everything applies
// at once and is stored on this device only, like the skin. Theme files are
// read by appearance/theme-file.ts; fonts by appearance/font-settings.ts.
import { type ReactNode, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { OpenSelect } from '../OpenSelect';
import {
  CODE_SIZE_RANGE,
  type FontSettings,
  getFontSettings,
  resetFontSettings,
  sanitizeFontFamily,
  setFontSettings,
  subscribeFontSettings,
  UI_SCALE_RANGE,
} from '../appearance/font-settings';
import type { ThemeProblem } from '../appearance/theme-file';
import {
  activeUserThemeAppearance,
  exportThemeFile,
  getActiveUserThemeId,
  importUserTheme,
  listUserThemes,
  removeUserTheme,
  resolvedUserTheme,
  setActiveUserTheme,
  subscribeUserTheme,
  userThemeReport,
} from '../appearance/user-theme';
import {
  type ChatTextSize,
  getChatTextSize,
  setChatTextSize,
  subscribeChatTextSize,
} from '../chat-text-size-preference';
import { t } from '../i18n';
import { isNativeDesktopWindow } from '../remote-ui-projection';
import { ActionButton, CompactSwitch, Group, SelectRow } from './capability-controls';
import './skin-panel.css';
import './appearance-panel.css';

const BUILTIN = 'builtin';
/** Code sample under the font rows: ligature pairs and look-alike glyphs. */
const CODE_SAMPLE = 'const ok = (a) => a !== 0 && a <= 10; // 0O il1|';

export function themeProblemText(problem: ThemeProblem): string {
  const detail = problem.detail ?? '';
  switch (problem.code) {
    case 'json':
      return t('This file is not valid JSON.');
    case 'shape':
      return t('A theme file must be a JSON object.');
    case 'section':
      return t('"{{path}}" must be an object.', { path: detail });
    case 'version':
      return t('This theme uses an unsupported format ({{schema}}). Mixdog reads mixdog-theme/v1.', { schema: detail });
    case 'name':
      return t('The theme needs a name (up to 64 characters).');
    case 'appearance':
      return t('"appearance" must be "dark" or "light".');
    case 'color':
      return t('{{path}} is not a color. Use #rgb, #rrggbb or #rrggbbaa, or a defs name.', { path: detail });
    case 'reference':
      return t('{{path}} refers to a defs entry that does not exist.', { path: detail });
    case 'cycle':
      return t('The defs entries refer to each other in a loop: {{path}}.', { path: detail });
    case 'pair':
      return t('{{path}} needs a dark or light color.', { path: detail });
    case 'unknown-keys':
      return t('Ignored unknown keys: {{keys}}', { keys: detail });
  }
}

function useThemeState() {
  const read = () => [getActiveUserThemeId() ?? '', ...listUserThemes().map((entry) => entry.id)].join('|');
  useSyncExternalStore(subscribeUserTheme, read, read);
  return { active: getActiveUserThemeId(), themes: listUserThemes(), report: userThemeReport() };
}

function useFonts(): FontSettings {
  const read = () => JSON.stringify(getFontSettings());
  return JSON.parse(useSyncExternalStore(subscribeFontSettings, read, read)) as FontSettings;
}

function Row({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
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

function Message({ tone, children }: { tone: 'error' | 'note'; children: ReactNode }) {
  return (
    <p className="appearance-message" data-tone={tone} role={tone === 'error' ? 'alert' : undefined}>
      {children}
    </p>
  );
}

export function ThemeFilesGroup() {
  const { active, themes, report } = useThemeState();
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const resolved = resolvedUserTheme();
  const appearance = activeUserThemeAppearance();

  const importFile = async (file: File) => {
    let text: string;
    try {
      text = await file.text();
    } catch {
      setError(themeProblemText({ code: 'json' }));
      return;
    }
    const result = importUserTheme(text);
    setError(result.ok ? '' : themeProblemText(result.error));
  };
  const exportFile = () => {
    const { name, text } = exportThemeFile();
    void window.mixdogDesktop?.saveFileAs?.(`data:application/json;charset=utf-8,${encodeURIComponent(text)}`, name);
  };

  return (
    <Group
      title={t('Color theme')}
      description={t(
        'A theme file colors the app and follows your light or dark setting. A skin keeps its picture and plates on top.'
      )}
    >
      <SelectRow
        title={t('Color theme')}
        value={active ?? BUILTIN}
        options={[
          { value: BUILTIN, label: t('Built-in') },
          ...themes.map((entry) => ({ value: entry.id, label: entry.name })),
        ]}
        onChange={(value) => {
          setError('');
          setActiveUserTheme(value === BUILTIN ? null : value);
        }}
      />
      <Row
        title={t('Theme files')}
        description={t(
          'Export writes the current theme, or the built-in one as a starter file that editors can check.'
        )}
      >
        <div className="appearance-actions">
          <ActionButton onClick={() => fileInput.current?.click()}>{t('Import theme file')}</ActionButton>
          <ActionButton onClick={exportFile}>{t('Export theme file')}</ActionButton>
          {active && (
            <ActionButton danger onClick={() => removeUserTheme(active)}>
              {t('Remove theme')}
            </ActionButton>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importFile(file);
          }}
        />
      </Row>
      {(error ||
        report.error ||
        report.warnings.length > 0 ||
        report.adjustments.length > 0 ||
        appearance ||
        resolved) && (
        <div className="appearance-theme-notes">
          {error && <Message tone="error">{error}</Message>}
          {report.error && (
            <Message tone="error">
              {t('The theme could not be read, so the built-in theme is shown: {{reason}}', {
                reason: themeProblemText(report.error),
              })}
            </Message>
          )}
          {report.warnings.map((warning) => (
            <Message key={warning.code} tone="note">
              {themeProblemText(warning)}
            </Message>
          ))}
          {report.adjustments.length > 0 && (
            <Message tone="note">
              {t('Adjusted for readability: {{list}}', {
                list: report.adjustments.map((entry) => `${entry.role} ${entry.from} → ${entry.to}`).join(', '),
              })}
            </Message>
          )}
          {appearance === 'dark' && (
            <Message tone="note">{t('This theme is dark only: the app stays dark while it is on.')}</Message>
          )}
          {appearance === 'light' && (
            <Message tone="note">{t('This theme is light only: the app stays light while it is on.')}</Message>
          )}
          {resolved && (
            <div className="appearance-swatches" aria-hidden="true">
              {(['background', 'surface', 'sidebar', 'text', 'accent', 'danger', 'warning', 'success'] as const).map(
                (role) => (
                  <span key={role} style={{ background: resolved.colors[role] }} data-role={role} />
                )
              )}
            </div>
          )}
        </div>
      )}
    </Group>
  );
}

/** Per-device scale of the conversation and the message box; applies live. */
function ChatTextSizeRow() {
  const size = useSyncExternalStore(subscribeChatTextSize, getChatTextSize, () => 'default');
  return (
    <SelectRow
      title={t('Chat text size')}
      description={t('Changes the size of chat messages and the message box on this device.')}
      value={size}
      options={[
        { value: 'small', label: t('Small') },
        { value: 'default', label: t('Default') },
        { value: 'large', label: t('Large') },
        { value: 'extra-large', label: t('Extra large') },
      ]}
      onChange={(next) => setChatTextSize(next as ChatTextSize)}
    />
  );
}

function FontField({
  label,
  value,
  fonts,
  onCommit,
}: {
  label: string;
  value: string;
  fonts: string[];
  onCommit(name: string): void;
}) {
  // '' is the built-in font. A stored font that is not installed here (another
  // device's, or one since removed) stays selectable as its own entry. OpenSelect
  // bounds and wheel-scrolls its menu (a body portal), so thousands of fonts are fine;
  // typing a first letters jumps to a match.
  const options = useMemo(
    () => [
      { value: '', label: t('Default') },
      ...(value && !fonts.includes(value) ? [{ value, label: value }] : []),
      ...fonts.map((name) => ({ value: name, label: name })),
    ],
    [fonts, value]
  );
  return (
    <OpenSelect
      className="settings-select"
      ariaLabel={label}
      value={value}
      options={options}
      onChange={(name) => {
        if (name !== value) onCommit(name);
      }}
    />
  );
}

export function FontsGroup() {
  const fonts = useFonts();
  const [installed, setInstalled] = useState<string[]>([]);
  useEffect(() => {
    // Only this computer's own window lists its fonts; a browser or phone
    // (whose fonts differ from the host's) keeps free-text entry.
    if (!isNativeDesktopWindow()) return;
    let live = true;
    void window.mixdogDesktop
      ?.listSystemFonts?.()
      .then((names) => {
        if (live) setInstalled(names.filter((name) => sanitizeFontFamily(name) === name));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  const uiPercent = Math.round(fonts.uiScale * 100);
  const codePx = `${fonts.codeSize}px`;
  return (
    <Group
      title={t('Fonts')}
      description={t('Pick an installed font. Characters it lacks still use the built-in fonts.')}
    >
      <Row title={t('UI font')}>
        <FontField label={t('UI font')} value={fonts.ui} fonts={installed} onCommit={(ui) => setFontSettings({ ui })} />
      </Row>
      <Row title={t('Code font')}>
        <FontField
          label={t('Code font')}
          value={fonts.mono}
          fonts={installed}
          onCommit={(mono) => setFontSettings({ mono })}
        />
      </Row>
      <Row title={t('UI size')} description={t('Scales all text in the app.')}>
        <div className="skin-slider">
          <input
            type="range"
            min={Math.round(UI_SCALE_RANGE.min * 100)}
            max={Math.round(UI_SCALE_RANGE.max * 100)}
            step={Math.round(UI_SCALE_RANGE.step * 100)}
            value={uiPercent}
            aria-label={t('UI size')}
            aria-valuetext={`${uiPercent}%`}
            onChange={(event) => setFontSettings({ uiScale: Number(event.currentTarget.value) / 100 })}
          />
          <output className="skin-slider-value">{uiPercent}%</output>
        </div>
      </Row>
      <Row title={t('Code size')}>
        <div className="skin-slider">
          <input
            type="range"
            min={CODE_SIZE_RANGE.min}
            max={CODE_SIZE_RANGE.max}
            step={1}
            value={fonts.codeSize}
            aria-label={t('Code size')}
            aria-valuetext={codePx}
            onChange={(event) => setFontSettings({ codeSize: Number(event.currentTarget.value) })}
          />
          <output className="skin-slider-value">{codePx}</output>
        </div>
      </Row>
      <Row
        title={t('Code ligatures')}
        description={t('Joins symbols such as => and != into one glyph, in fonts that have them.')}
      >
        <CompactSwitch
          label={t('Code ligatures')}
          checked={fonts.ligatures}
          optimistic={false}
          onChange={(ligatures) => setFontSettings({ ligatures })}
        />
      </Row>
      <ChatTextSizeRow />
      <div className="appearance-sample">
        <p>{t('The quick brown fox jumps over the lazy dog.')}</p>
        <code>{CODE_SAMPLE}</code>
      </div>
      <div className="skin-foot appearance-foot">
        <ActionButton
          onClick={() => {
            resetFontSettings();
          }}
        >
          {t('Reset to defaults')}
        </ActionButton>
      </div>
    </Group>
  );
}
