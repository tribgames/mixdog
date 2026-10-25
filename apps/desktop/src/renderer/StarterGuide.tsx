// Getting-started guide: a pill pinned to the foot of the left side panel —
// shared by every rail destination — that unfolds a short checklist of the
// setup steps a new user needs after onboarding (onboarding configures the
// account; this guide teaches the app). It leaves for good once dismissed or
// once every step is done. Each step opens its screen and runs a spotlight
// tour over the real controls; a one-time welcome card offers the whole
// tour in order.
import { Check, GraduationCap, KeyRound, Smartphone, Star, X, type LucideIcon } from 'lucide-react';
import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { t } from './i18n';
import { useMobileBack } from './mobile-back';
import { requestMixyDialog, useMixyDialogSettled, useMixyStatus } from './mixy-identity';
import { providerConnected } from './setup-facts';
import { record } from './record-utils';
import { SettingsConfirmDialog } from './settings/capability-controls';
import { getCachedConnectionInfo } from './settings/connection-info';
import { useSidebarReferences } from './sidebar-reference-cache';
import { setStarterGuideBlocking } from './starter-guide-gate';
import { StarterTour, StarterWelcome, type TourStop } from './StarterTour';
import type { WorkbenchSideViewDescriptor, WorkbenchSideViewId } from './workbench-side-view-layout';
import './starter-guide.css';

const STORAGE_KEY = 'mixdog.desktop.starter-guide.v1';
const REFERENCE_KEYS = ['providerSetup', 'projects'] as const;

type StepId = 'provider' | 'project' | 'workflow' | 'extensions' | 'remote' | 'mixy';
interface GuideState {
  closed: boolean;
  /** The welcome card was answered (tour started or postponed). */
  welcomed: boolean;
  /** Steps whose tour was completed; the steps with no state of their own
   *  (workflow, extensions, project without a folder, remote without a
   *  paired device) are done by it. */
  visited: StepId[];
}

// Steps a finished tour completes (persisted, mirrored by the IPC gate); the
// mixy step follows the host's created flag only.
const STEP_IDS: readonly StepId[] = ['provider', 'project', 'workflow', 'extensions', 'remote'];

function normalizeGuideState(value: unknown): GuideState {
  const parsed = record(value);
  const visited = Array.isArray(parsed.visited) ? parsed.visited : [];
  return {
    closed: parsed.closed === true,
    welcomed: parsed.welcomed === true,
    visited: STEP_IDS.filter((step) => visited.includes(step)),
  };
}

function readGuideState(): GuideState {
  try {
    return normalizeGuideState(JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}'));
  } catch {
    return normalizeGuideState(null);
  }
}

function hasLocalGuideState(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** The config copy, or null when the config has none. */
function storedGuideState(value: unknown): GuideState | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? normalizeGuideState(value) : null;
}

/** closed/welcomed: either; visited: union. Nothing ever moves backward. */
function mergeGuideState(a: GuideState, b: GuideState): GuideState {
  return {
    closed: a.closed || b.closed,
    welcomed: a.welcomed || b.welcomed,
    visited: STEP_IDS.filter((step) => a.visited.includes(step) || b.visited.includes(step)),
  };
}

const FRESH_GUIDE: GuideState = { closed: false, welcomed: false, visited: [] };
/** A first onboarding completion stores a fresh guide state in the config
 *  (src/session-runtime/starter-guide-state.mjs). Onboarding done with no copy
 *  in the config nor in localStorage is therefore a profile onboarded before
 *  the guide was persisted whose localStorage was since lost (Chromium
 *  recreates a missing Local Storage database empty) — not a new user. */
const RETIRED_GUIDE: GuideState = { closed: true, welcomed: true, visited: [] };

function sameGuideState(a: GuideState, b: GuideState): boolean {
  return (
    a.closed === b.closed &&
    a.welcomed === b.welcomed &&
    a.visited.length === b.visited.length &&
    a.visited.every((step) => b.visited.includes(step))
  );
}

type GuideApi = Window['mixdogDesktop'] | undefined;

/** The config file is the durable copy (the renderer's localStorage can be
 *  lost); localStorage stays as the fast local one. */
function writeLocalGuideState(state: GuideState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* the config copy still keeps it */
  }
}

function writeGuideState(api: GuideApi, state: GuideState): void {
  writeLocalGuideState(state);
  saveGuideStateToDisk(api, state);
}

function saveGuideStateToDisk(api: GuideApi, state: GuideState): void {
  try {
    void Promise.resolve(api?.invokeCapability?.({ capability: 'saveStarterGuideState', args: [state] })).catch(
      () => undefined
    );
  } catch {
    /* the local copy still holds it */
  }
}

/** State updater that also persists a real change. */
function persisted(api: GuideApi, change: (current: GuideState) => GuideState) {
  return (current: GuideState) => {
    const next = change(current);
    if (next !== current) writeGuideState(api, next);
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
  // On a phone the fixed toast's containing block is the body, pinned to the
  // visual viewport (soft keyboard): measure from that box, not the window.
  const frame = document.documentElement.hasAttribute('data-mixdog-mobile-tabs')
    ? document.body.getBoundingClientRect()
    : { left: 0, top: 0, height: window.innerHeight };
  return { left: box.left - frame.left, width: box.width, bottom: frame.height - (box.top - frame.top) + 6 };
}

/** The coach-mark stops of each step's tour. */
function starterTours(): Record<Exclude<StepId, 'mixy'>, TourStop[]> {
  return {
    // Which provider is the user's call: the tour explains how to choose and
    // lights every option; any sign-in or key action hands over.
    provider: [
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
    project: [
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
    workflow: [
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
        body: t('The Maintainer handles upkeep like memory and session titles. Open it, turn it on and pick a model.'),
        tip: t('Recommended: the cheapest model at the lowest effort is enough.'),
        action: true,
      },
    ],
    remote: [
      // Pairing starts from Connect a device (QR, browser or code), so the
      // tour ends on that live control and hands over to its dialog.
      {
        target: ['.conn-connect-device', '.mixdog-settings__body'],
        title: t('Connect a device'),
        body: t('Choose the kind of device to connect.'),
        action: true,
      },
    ],
    extensions: [
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
  };
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
  // Until the config copy has been read, the guide stays hidden: a lost
  // localStorage must not flash a guide the user already closed.
  const [diskRead, setDiskRead] = useState(false);
  const [hadLocalState] = useState(hasLocalGuideState);
  const [expanded, setExpanded] = useState(false);
  // Closing retires the guide for good, so X asks once before it does.
  const [confirmClose, setConfirmClose] = useState(false);
  const [tour, setTour] = useState<{ step: StepId; chain: boolean } | null>(null);
  const [justDone, setJustDone] = useState<StepId | null>(null);
  const previousDone = useRef<string | null>(null);
  const pillRef = useRef<HTMLElement>(null);
  const listId = useId();
  const { values, loading: referencesLoading } = useSidebarReferences(api, REFERENCE_KEYS, !state.closed);
  // Mixy's status follows the host; it counts as loading until known so an
  // existing user's done step never announces itself.
  const mixyCreated = useMixyStatus(api, !state.closed).created;
  // The welcome comes after the 대표 에이전트 dialog: once Mixy exists or the
  // dialog was dismissed, never on top of (or under) it.
  const mixySettled = useMixyDialogSettled() || mixyCreated === true;
  const loading = referencesLoading || mixyCreated === null;
  const update = (change: (current: GuideState) => GuideState) => setState(persisted(api, change));
  const visit = (step: StepId) => update(markVisited(step));

  // Merge the config copy with localStorage and write the merge back once
  // when the config copy lacks any of it.
  useEffect(() => {
    let live = true;
    Promise.resolve(api?.invokeCapability?.({ capability: 'getOnboardingStatus' }))
      .then((result) => {
        if (!live) return;
        const status = record(result?.value);
        const stored = storedGuideState(status.starterGuide);
        const disk = stored ?? (!hadLocalState && status.completed === true ? RETIRED_GUIDE : FRESH_GUIDE);
        setState((current) => {
          const merged = mergeGuideState(current, disk);
          if (!sameGuideState(merged, stored ?? FRESH_GUIDE)) saveGuideStateToDisk(api, merged);
          if (sameGuideState(merged, current)) return current;
          writeLocalGuideState(merged);
          return merged;
        });
        setDiskRead(true);
      })
      .catch(() => {
        // Unread config: a local copy still decides; with none, a returning
        // user cannot be told from a new one, so the guide waits for a launch
        // that can read it.
        if (live && hadLocalState) setDiskRead(true);
      });
    return () => {
      live = false;
    };
  }, [api, hadLocalState]);

  const remotePaired = Boolean(api && (getCachedConnectionInfo(api)?.clients?.length ?? 0) > 0);
  // A paired device completes the step for good. The cached connection info
  // empties while the relay reconnects or access is switched off, and a
  // live-only check re-announced "Set up remote access · Done" every time it
  // came back.
  // biome-ignore lint/correctness/useExhaustiveDependencies: visit only persists the flag.
  useEffect(() => {
    if (diskRead && remotePaired && !state.visited.includes('remote')) visit('remote');
  }, [diskRead, remotePaired, state.visited]);
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
  const tours = starterTours();
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
      tour: tours.provider,
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
      tour: tours.project,
    },
    {
      id: 'workflow',
      label: t('Set up workflows and agents'),
      hint: t('Turn on agents and pick their models.'),
      doneWhen: t('Done when you finish this tour.'),
      icon: viewIcon('workflows', GraduationCap),
      done: state.visited.includes('workflow'),
      open: () => openView('workflows'),
      tour: tours.workflow,
    },
    {
      id: 'remote',
      label: t('Set up remote access'),
      hint: t('Follow and steer tasks from your phone.'),
      doneWhen: t('Done when a device is paired or you finish this tour.'),
      icon: Smartphone,
      done: remotePaired || state.visited.includes('remote'),
      open: () => onOpenSettings('connection'),
      tour: tours.remote,
    },
    {
      id: 'extensions',
      label: t('Explore extensions'),
      hint: t('Give agents more tools.'),
      doneWhen: t('Done when you finish this tour.'),
      icon: viewIcon('extensions', GraduationCap),
      done: state.visited.includes('extensions'),
      open: () => openView('extensions'),
      tour: tours.extensions,
    },
    {
      id: 'mixy',
      label: t('Create representative bot'),
      hint: t('The representative bot helps with anything, sets up Mixdog and makes other bots.'),
      doneWhen: t('Done when the representative bot is created.'),
      icon: viewIcon('agents', Star),
      // Real state only: the host's created flag (mixy-identity.ts).
      done: mixyCreated === true,
      // The Agents page with the 대표 에이전트 dialog open: no tour over it.
      open: () => {
        openView('agents');
        requestMixyDialog();
      },
      tour: [],
    },
  ];
  const startTour = (id: StepId, chain: boolean) => {
    const step = steps.find((entry) => entry.id === id);
    if (!step) return;
    setExpanded(false);
    step.open();
    if (step.tour.length) setTour({ step: id, chain });
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
    if (loading || !diskRead) return undefined;
    const before = previousDone.current;
    previousDone.current = doneKey;
    if (before === null) return undefined;
    const earlier = new Set(before.split(','));
    const added = doneKey.split(',').filter((id) => id && !earlier.has(id));
    if (!added.length) return undefined;
    setJustDone(added[added.length - 1] as StepId);
    const timer = window.setTimeout(() => setJustDone(null), 3200);
    return () => window.clearTimeout(timer);
  }, [doneKey, loading, diskRead]);
  const justDoneLabel = justDone ? steps.find((step) => step.id === justDone)?.label : undefined;

  useEffect(() => {
    // Finishing retires the guide for good: a provider disconnected later
    // must not resurrect a checklist the user already completed.
    if (finished && !loading && diskRead) {
      setState(persisted(api, (current) => (current.closed ? current : { ...current, closed: true })));
    }
  }, [api, finished, loading, diskRead]);

  useMobileBack(expanded, () => setExpanded(false));
  // An open checklist folds away when anything outside the guide is pressed.
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
  const hidden = state.closed || finished || loading || !diskRead;
  const welcoming = !hidden && !state.welcomed && !onboardingActive && !tour && mixySettled;
  // The welcome and the tour cover the window: the What's new notice waits for
  // them. Layout phase, so the gate is set before any passive effect looks.
  const coversWindow = (!state.closed && !state.welcomed) || tour !== null;
  useLayoutEffect(() => {
    setStarterGuideBlocking(coversWindow);
    return () => setStarterGuideBlocking(false);
  }, [coversWindow]);
  const answerWelcome = () => update((current) => ({ ...current, welcomed: true }));
  const pill = !hidden && (
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
