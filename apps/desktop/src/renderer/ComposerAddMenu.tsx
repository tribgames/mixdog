import * as React from 'react';
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { ComposerPalette } from './ComposerPalette';
import { ComposerGoalDialog } from './ComposerGoalDialog';
import { CapabilityIcon } from './CapabilityIcon';
import { MxIcon } from './MxIcon';
import { t } from './i18n';
import { selectableComposerSkills, skillTitle, type ComposerSkill } from './composer-skill';
import './desktop/composer-add-menu.css';

// Last skill list per session, kept for the renderer's lifetime. Opening the
// menu paints it at once and refreshes behind it, instead of emptying the list
// and waiting on a renderer → main → daemon control-session round trip every
// time (user: 로딩까지 시간이 엄청 오래 걸림). skillsStatus is already cached
// daemon-side, so the refresh only ever moves the list when skills changed.
const skillCache = new Map<string, ComposerSkill[]>();

export function ComposerAddMenu({ anchor, disabled, goalDisabled, sessionId, onAttach, onSkill, onGoal, onMore }: {
  anchor: RefObject<HTMLElement | null>;
  disabled: boolean;
  goalDisabled: boolean;
  sessionId?: string | null;
  onAttach(): void;
  onSkill(name: string): void;
  onGoal(command: string): Promise<boolean>;
  onMore(): void;
}) {
  const [open, setOpen] = useState(false);
  const [goal, setGoal] = useState(false);
  const cacheKey = sessionId || '';
  const [skills, setSkills] = useState<ComposerSkill[]>(() => skillCache.get(cacheKey) || []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const cached = skillCache.get(cacheKey);
    setSkills(cached || []);
    setLoading(!cached);
    setError('');
    void window.mixdogDesktop.readCapabilities([{ capability: 'skillsStatus', ...(sessionId ? { sessionId } : {}) }])
      .then(([result]) => {
        if (!result?.ok) throw new Error(result && !result.ok ? result.error : 'Skills unavailable.');
        const next = selectableComposerSkills(result.value);
        skillCache.set(cacheKey, next);
        if (!cancelled) setSkills(next);
      }).catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, sessionId, cacheKey]);
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)
        && !trigger.current?.contains(event.target)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        close();
      }
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [open]);
  useEffect(() => { if (disabled) { setOpen(false); setGoal(false); } }, [disabled]);
  return <React.Fragment>
    <button ref={trigger} type="button" className="composer-tool" disabled={disabled}
      aria-label={t('Add to message')} data-tooltip={t('Add to message')} data-tooltip-side="top"
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setGoal(false); setOpen(value => !value); }}>
      <MxIcon name="plus" size={16} />
    </button>
    {open && <ComposerPalette anchor={anchor} panel={panel} id={id}
      label={t('Add to message')} role="menu" className="composer-add-menu">
      <div onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])];
        if (!buttons.length) return;
        event.preventDefault();
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
        <button type="button" role="menuitem" onClick={() => { close(); onAttach(); }}>
          <CapabilityIcon name="attach-files" /><span>{t('Attach files')}</span>
        </button>
        <button type="button" role="menuitem" disabled={goalDisabled} onClick={() => { setOpen(false); setGoal(true); }}>
          <CapabilityIcon name="goal-management" /><span>{t('Set a goal')}</span>
        </button>
        <div className="composer-add-heading">{t('Skills')}</div>
        {loading && <p role="status">{t('Loading skills…')}</p>}
        {!loading && !skills.length && !error && <p>{t('No enabled skills.')}</p>}
        {skills.map(skill => <button type="button" role="menuitem" key={skill.name}
          onClick={() => { setOpen(false); onSkill(skill.name); }}>
          <CapabilityIcon name={skill.name} /><span><b>{t(skillTitle(skill.name))}</b>
            <small>{skill.description}</small></span>
        </button>)}
        <div className="composer-add-divider" role="separator" />
        <button type="button" role="menuitem" onClick={() => { close(); onMore(); }}>
          <CapabilityIcon name="setup" /><span>{t('Manage skills, plugins and MCP')}</span>
        </button>
      </div>
      {error && <p role="alert" className="composer-add-error">{error}</p>}
    </ComposerPalette>}
    {goal && <ComposerGoalDialog anchor={trigger} disabled={goalDisabled} onStart={onGoal}
      onClose={() => setGoal(false)} returnFocus={() => trigger.current?.focus()} />}
  </React.Fragment>;
}
