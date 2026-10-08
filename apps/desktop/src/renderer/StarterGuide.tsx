// Getting-started guide: a pill pinned to the foot of the left side panel —
// shared by every rail destination — that unfolds a short checklist of the
// setup steps a new user needs after onboarding (onboarding configures the
// account; this guide teaches the app). It leaves for good once dismissed or
// once every step is done. Each step opens its screen and runs a spotlight
// tour over the real controls; a one-time welcome card offers the whole
// tour in order.
import { Check, GraduationCap, KeyRound, Smartphone, X, type LucideIcon } from 'lucide-react';
import { type CSSProperties, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { t } from './i18n';
import { record, rows } from './record-utils';
import { SettingsConfirmDialog } from './settings/capability-controls';
import { getCachedConnectionInfo } from './settings/connection-info';
import { useSidebarReferences } from './sidebar-reference-cache';
import { StarterTour, StarterWelcome, type TourStop } from './StarterTour';
import type { WorkbenchSideViewDescriptor, WorkbenchSideViewId } from './workbench-side-view-layout';
import './starter-guide.css';

const STORAGE_KEY = 'mixdog.desktop.starter-guide.v1';
const REFERENCE_KEYS = ['providerSetup', 'projects'] as const;

type StepId = 'provider' | 'project' | 'workflow' | 'extensions' | 'remote';
interface GuideState {
  closed: boolean;
  /** The welcome card was answered (tour started or postponed). */
  welcomed: boolean;
  /** Steps whose tour was completed; the steps with no state of their own
   *  (workflow, extensions, project without a folder, remote without a
   *  paired device) are done by it. */
  visited: StepId[];
}

function readGuideState(): GuideState {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') as Partial<GuideState>;
    return {
      closed: parsed.closed === true,
      welcomed: parsed.welcomed === true,
      visited: Array.isArray(parsed.visited) ? parsed.visited : [],
    };
  } catch {
    return { closed: false, welcomed: false, visited: [] };
  }
}

function writeGuideState(state: GuideState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* the guide simply reappears next launch */
  }
}

/** State updater that also persists a real change. */
function persisted(change: (current: GuideState) => GuideState) {
  return (current: GuideState) => {
    const next = change(current);
    if (next !== current) writeGuideState(next);
    return next;
  };
}

function markVisited(step: StepId): (current: GuideState) => GuideState {
  return (current: GuideState) =>
    current.visited.includes(step) ? current : { ...current, visited: [...current.visited, step] };
}

/** The completion notice sits just above the pill; with the side panel
 *  closed (no visible pill) it takes the window's bottom-left corner. */
function toastPosition(pill: HTMLElement | null): CSSProperties {
  const box = pill?.getBoundingClientRect();
  if (!box || box.width === 0) return { left: 60, bottom: 16 };
  return { left: box.left, width: box.width, bottom: window.innerHeight - box.top + 6 };
}

function providerConnected(setup: unknown): boolean {
  const value = record(setup);
  return [...rows(value.api), ...rows(value.oauth)].some(
    (provider) => provider.usable === true || provider.authenticated === true
  );
}

export function StarterGuide({
  descriptors,
  onboardingActive,
  onOpenView,
  onOpenSettings,
  onCloseSettings,
}: {
  descriptors: ReadonlyMap<WorkbenchSideViewId, WorkbenchSideViewDescriptor>;
  /** Onboarding is open or still deciding: the welcome card waits for it. */
  onboardingActive: boolean;
  onOpenView(id: WorkbenchSideViewId): void;
  onOpenSettings(section: 'providers' | 'connection'): void;
  onCloseSettings(): void;
}) {
  const api = window.mixdogDesktop;
  const [state, setState] = useState(readGuideState);
  const [expanded, setExpanded] = useState(false);
  // Closing retires the guide for good, so X asks once before it does.
  const [confirmClose, setConfirmClose] = useState(false);
  const [tour, setTour] = useState<{ step: StepId; chain: boolean } | null>(null);
  const [justDone, setJustDone] = useState<StepId | null>(null);
  const previousDone = useRef<string | null>(null);
  const pillRef = useRef<HTMLElement>(null);
  const listId = useId();
  const { values, loading } = useSidebarReferences(api, REFERENCE_KEYS, !state.closed);
  const update = (change: (current: GuideState) => GuideState) => setState(persisted(change));
  const visit = (step: StepId) => update(markVisited(step));

  const remotePaired = Boolean(api && (getCachedConnectionInfo(api)?.clients?.length ?? 0) > 0);
  const viewIcon = (id: WorkbenchSideViewId, fallback: LucideIcon) => descriptors.get(id)?.icon ?? fallback;
  // Guided order: a model to talk to, a folder to work in, who does the work,
  // then reaching it from anywhere and growing its toolset.
  // Rail destinations sit under Settings, so a sidebar step closes it first.
  const openView = (id: WorkbenchSideViewId) => {
    onCloseSettings();
    onOpenView(id);
  };
  // Each step states what completes it. Provider follows real state only (it
  // completes the moment one is connected, tour or not); the rest are
  // completed by finishing their tour, project also by adding a folder and
  // remote also by pairing a device.
  // The last stop of a tour whose control opens something is a live
  // "click it" stop, so the tour ends inside the real action.
  const steps: Array<{
    id: StepId;
    label: string;
    hint: string;
    doneWhen: string;
    icon: LucideIcon;
    done: boolean;
    open(): void;
    tour: TourStop[];
  }> = [
    {
      id: 'provider',
      label: t('Connect a provider'),
      hint: t('Sign in with an account or an API key.'),
      doneWhen: t('Done when a provider is connected.'),
      icon: KeyRound,
      done: providerConnected(values.providerSetup),
      open: () => onOpenSettings('providers'),
      // Which provider is the user's call: the tour explains how to choose and
      // lights every option; any sign-in or key action hands over.
      tour: [
        {
          target: ['.settings-provider-cards', '.mixdog-settings__body'],
          title: t('Have a subscription? Sign in'),
          body: t('Subscribed to ChatGPT, Claude or Grok? Press + and sign in.'),
          action: true,
        },
        {
          target: ['.settings-provider-cards ~ .settings-group:last-of-type', '.mixdog-settings__body'],
          title: t('No subscription? Use an API key'),
          body: t('Get a key, paste it here and save.'),
          action: true,
        },
      ],
    },
    {
      id: 'project',
      label: t('Add a project'),
      hint: t('Add a folder for Mixdog to work in.'),
      doneWhen: t('Done when a project is added or you finish this tour.'),
      icon: viewIcon('projects', GraduationCap),
      // A folder is optional (tasks run without one): finishing the tour
      // counts just like adding it.
      done: values.projects.length > 0 || state.visited.includes('project'),
      open: () => openView('projects'),
      tour: [
        {
          target: '.projects-common-instructions .projects-row',
          title: t('Memories'),
          body: t(
            'Install Memory under Extensions → Built-in and turn on the Maintainer, and Mixdog remembers what matters.'
          ),
        },
        {
          target: '.session-panel-action.projects-add',
          title: t('Add a project folder'),
          body: t('Press + and pick a folder on this computer.'),
          // The picker below needs a folder to offer, so the tour steps aside
          // for the add form and carries on once it closes — added or not.
          action: true,
          resume: '.projects-add-dialog',
        },
        // Adding a folder is only half of it: each task then runs in the
        // project picked here, and that choice is what loads its instructions.
        {
          target: '.composer-project-context',
          title: t('Choose the task project'),
          body: t('Pick the project for each task. Open a project to add memories it should keep.'),
          action: true,
        },
      ],
    },
    {
      id: 'workflow',
      label: t('Set up workflows and agents'),
      hint: t('Turn on agents and pick their models.'),
      doneWhen: t('Done when you finish this tour.'),
      icon: viewIcon('workflows', GraduationCap),
      done: state.visited.includes('workflow'),
      open: () => openView('workflows'),
      tour: [
        {
          target: '.workflows-packs .schedules-row',
          title: t('Workflows'),
          body: t('A workflow sets how a request gets done. Open one to edit it.'),
        },
        {
          target: '.workflows-packs ~ section.workflows-models:last-of-type .schedules-row',
          title: t('Agents'),
          body: t('Agents start off. Open one, turn it on and pick a model.'),
        },
        {
          target: '.orchestration-mode-select',
          title: t('Delegation mode'),
          body: t('Choose how much work goes to agents.'),
        },
        {
          target: '[data-agent-id="maintainer"]',
          title: t('Turn on the Maintainer'),
          body: t(
            'The Maintainer handles upkeep like memory and session titles. Open it, turn it on and pick a model.'
          ),
          tip: t('Recommended: the cheapest model at the lowest effort is enough.'),
          action: true,
        },
      ],
    },
    {
      id: 'remote',
      label: t('Set up remote access'),
      hint: t('Follow and steer tasks from your phone.'),
      doneWhen: t('Done when a device is paired or you finish this tour.'),
      icon: Smartphone,
      done: remotePaired || state.visited.includes('remote'),
      open: () => onOpenSettings('connection'),
      tour: [
        {
          target: ['.settings-connection-card', '.mixdog-settings__body'],
          title: t('Scan to install the web app'),
          body: t('Scan with your phone, then approve it here.'),
        },
      ],
    },
    {
      id: 'extensions',
      label: t('Explore extensions'),
      hint: t('Give agents more tools.'),
      doneWhen: t('Done when you finish this tour.'),
      icon: viewIcon('extensions', GraduationCap),
      done: state.visited.includes('extensions'),
      open: () => openView('extensions'),
      tour: [
        {
          target: '.extensions-pane[data-surface-active="true"] .sidebar-section-toolbar',
          title: t('Extension type'),
          body: t('Plugins add tools; skills teach agents how to work.'),
        },
        {
          target: '.session-panel-action.extensions-add',
          title: t('Add an extension'),
          body: t('Press + to add one.'),
        },
        // The built-in list ships with the app: pointing at it (and letting
        // the user open one) is the fastest way to useful tools.
        {
          target: '.extensions-pane[data-surface-active="true"] .settings-group',
          title: t('Built-in plugins'),
          body: t('Ready-made tools like Git, Memory, Browser and Office. Install the ones you need.'),
          action: true,
        },
      ],
    },
  ];
  const startTour = (id: StepId, chain: boolean) => {
    const step = steps.find((entry) => entry.id === id);
    if (!step) return;
    setExpanded(false);
    step.open();
    setTour({ step: id, chain });
  };
  // Finishing a tour completes its step. A chained tour (from the welcome
  // card) then walks on to the next open step — unless a live control was
  // clicked, which leaves the user inside what it opened.
  const endTour = (finished: boolean, handedOff: boolean) => {
    const current = tour;
    setTour(null);
    if (!current || !finished) return;
    visit(current.step);
    if (!current.chain || handedOff) return;
    const after = steps.slice(steps.findIndex((entry) => entry.id === current.step) + 1);
    const next = after.find((entry) => !entry.done);
    if (next) startTour(next.id, true);
  };
  const activeTour = tour ? steps.find((entry) => entry.id === tour.step) : undefined;
  const doneCount = steps.filter((step) => step.done).length;
  // Only the next step explains itself; the rest stay one line each so the
  // open checklist never swallows the panel above it.
  const nextId = steps.find((step) => !step.done)?.id;
  const finished = doneCount === steps.length;
  const doneKey = steps
    .filter((step) => step.done)
    .map((step) => step.id)
    .join(',');

  // Completing a step says so right away, whichever way it happened (a tour
  // finished, a provider connected, a project added).
  useEffect(() => {
    if (loading) return undefined;
    const before = previousDone.current;
    previousDone.current = doneKey;
    if (before === null) return undefined;
    const earlier = new Set(before.split(','));
    const added = doneKey.split(',').filter((id) => id && !earlier.has(id));
    if (!added.length) return undefined;
    setJustDone(added[added.length - 1] as StepId);
    const timer = window.setTimeout(() => setJustDone(null), 3200);
    return () => window.clearTimeout(timer);
  }, [doneKey, loading]);
  const justDoneLabel = justDone ? steps.find((step) => step.id === justDone)?.label : undefined;

  useEffect(() => {
    // Finishing retires the guide for good: a provider disconnected later
    // must not resurrect a checklist the user already completed.
    if (finished && !loading) {
      setState(persisted((current) => (current.closed ? current : { ...current, closed: true })));
    }
  }, [finished, loading]);

  // An open checklist folds away when anything outside the guide is pressed
  // (user: 시작 가이드 버튼 다른 영역 누르면 닫히는 형태로).
  useEffect(() => {
    if (!expanded) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && pillRef.current?.contains(event.target)) return;
      setExpanded(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [expanded]);

  // No pill until the real state is known, so it never paints 0 and jumps.
  // A running tour outlives the pill: its last step may be what finishes it.
  const hidden = state.closed || finished || loading;
  const welcoming = !hidden && !state.welcomed && !onboardingActive && !tour;
  const answerWelcome = () => update((current) => ({ ...current, welcomed: true }));
  const pill = hidden ? null : (
    <section
      ref={pillRef}
      className="starter-guide"
      data-expanded={expanded ? 'true' : undefined}
      aria-label={t('Getting started')}
    >
      {expanded && (
        <ul className="starter-guide-list" id={listId}>
          {steps.map((step) => {
            const Icon = step.icon;
            return (
              <li key={step.id}>
                <button
                  type="button"
                  className="starter-guide-step"
                  data-done={step.done ? 'true' : undefined}
                  data-next={step.id === nextId ? 'true' : undefined}
                  onClick={() => startTour(step.id, false)}
                >
                  <span className="starter-guide-step-mark" aria-hidden="true">
                    {step.done ? <Check size={14} /> : <Icon size={14} />}
                  </span>
                  <span className="starter-guide-step-text">
                    <b>{step.label}</b>
                    {step.id === nextId && <small>{step.hint}</small>}
                    {step.id === nextId && <small className="starter-guide-step-done-when">{step.doneWhen}</small>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="starter-guide-pill">
        <button
          type="button"
          className="starter-guide-toggle"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          onClick={() => setExpanded((value) => !value)}
        >
          <GraduationCap size={14} aria-hidden="true" />
          <span className="starter-guide-title">{t('Getting started')}</span>
          <span className="starter-guide-count">
            {doneCount}/{steps.length}
          </span>
          <span className="starter-guide-meter" aria-hidden="true">
            <span style={{ width: `${(doneCount / steps.length) * 100}%` }} />
          </span>
        </button>
        <button
          type="button"
          className="starter-guide-close"
          aria-label={t('Dismiss')}
          onClick={() => setConfirmClose(true)}
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
  return (
    <>
      {activeTour && <StarterTour key={activeTour.id} stops={activeTour.tour} onClose={endTour} />}
      {welcoming && (
        <StarterWelcome
          steps={steps.map((step) => step.label)}
          onLater={answerWelcome}
          onStart={() => {
            answerWelcome();
            const first = steps.find((step) => !step.done);
            if (first) startTour(first.id, true);
          }}
        />
      )}
      {/* Portaled above every layer: a step completed inside Settings would
          otherwise announce itself under the dialog, unseen. */}
      {justDoneLabel &&
        createPortal(
          <output
            className="starter-guide-toast"
            data-modal-above=""
            aria-live="polite"
            style={toastPosition(pillRef.current)}
          >
            <Check size={14} aria-hidden="true" />
            <span>{justDoneLabel}</span>
            <b>{t('Done')}</b>
          </output>,
          document.body
        )}
      {pill}
      {confirmClose &&
        createPortal(
          <SettingsConfirmDialog
            options={{
              title: t('Close the getting started guide?'),
              description: t('It will not appear again.'),
              confirmLabel: t('Close'),
              onConfirm: () => update((current) => ({ ...current, closed: true })),
            }}
            onClose={() => setConfirmClose(false)}
          />,
          document.body
        )}
    </>
  );
}
