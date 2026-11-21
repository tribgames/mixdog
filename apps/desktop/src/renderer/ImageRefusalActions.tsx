import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import {
  base64OfDataUrl,
  blockerLabel,
  chosenAmong,
  continueWithoutRequest,
  type ImageRecoveryRequest,
  type ImageRecoveryState,
  type ImageRefusal,
  type ImageRefusalBlocker,
  recoveryStateOf,
  replaceRequest,
} from './image-refusal';

/** One conversation's stored image choices and restore check as every view of it shares them. */
interface RecoverySnapshot {
  state: ImageRecoveryState | null;
  busy: boolean;
  problem: string;
}

interface RecoveryEntry {
  snapshot: RecoverySnapshot;
  listeners: Set<() => void>;
}

// Every view of a conversation (the fixes beside a refused turn, the restore-check panel) reads one entry, so a fix made in one
// is what the other shows. An entry lives while a view of it is mounted; the next mount reads the core again.
const entries = new Map<string, RecoveryEntry>();

function entryOf(sessionId: string): RecoveryEntry {
  let entry = entries.get(sessionId);
  if (!entry) {
    entry = { snapshot: { state: null, busy: false, problem: '' }, listeners: new Set() };
    entries.set(sessionId, entry);
  }
  return entry;
}

function publish(entry: RecoveryEntry, patch: Partial<RecoverySnapshot>) {
  entry.snapshot = { ...entry.snapshot, ...patch };
  for (const listener of entry.listeners) listener();
}

function useImageRecovery(sessionId: string, poll = false) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = entryOf(sessionId);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) entries.delete(sessionId);
      };
    },
    [sessionId]
  );
  const { state, busy, problem } = useSyncExternalStore(subscribe, () => entryOf(sessionId).snapshot);
  const api = window.mixdogDesktop;
  // biome-ignore lint/correctness/useExhaustiveDependencies: api is the window bridge read each render, listed so the callback follows a replaced bridge
  const call = useCallback(
    async (request: ImageRecoveryRequest) => {
      const entry = entryOf(sessionId);
      publish(entry, { busy: true, problem: '' });
      try {
        const answer = await api.invokeCapability({ capability: 'imageRecovery', args: [request], sessionId });
        publish(entry, { state: recoveryStateOf(answer), busy: false });
        return true;
      } catch (reason) {
        publish(entry, { problem: errorMessageText(reason), busy: false });
        return false;
      }
    },
    [api, sessionId]
  );
  const setProblem = useCallback((text: string) => publish(entryOf(sessionId), { problem: text }), [sessionId]);
  useEffect(() => {
    if (sessionId) void call({ type: 'state' });
  }, [call, sessionId]);
  const checking = poll && state?.gate.state === 'checking';
  // The restore check has no event of its own yet (hand-off section 7), so it is asked again each second.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new state answer re-arms the one-second poll while the check runs
  useEffect(() => {
    if (!checking) return;
    const timer = window.setTimeout(() => void call({ type: 'state' }), 1000);
    return () => window.clearTimeout(timer);
  }, [call, checking, state]);
  return { state, busy, problem, setProblem, call };
}

type Recovery = ReturnType<typeof useImageRecovery>;

function RecoveryActions({
  blockers,
  numberOf,
  newContextOffered,
  recovery,
}: {
  blockers: readonly ImageRefusalBlocker[];
  /** The image's place (0-based) in the whole list the person sees, so a label names the same image there. */
  numberOf(blocker: ImageRefusalBlocker): number;
  newContextOffered: boolean;
  recovery: Recovery;
}) {
  const [confirming, setConfirming] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const replacing = useRef<ImageRefusalBlocker | null>(null);
  const { state, busy, problem, setProblem, call } = recovery;

  async function apply(request: ImageRecoveryRequest) {
    if (await call(request)) setConfirming(false);
  }

  function pickedFile(file: File | undefined) {
    const blocker = replacing.current;
    if (!file || !blocker) return;
    const reader = new FileReader();
    reader.onerror = () => setProblem(t('That file could not be read. Choose another picture.'));
    reader.onload = () => {
      const data = base64OfDataUrl(String(reader.result));
      if (!data) return setProblem(t('That file could not be read. Choose another picture.'));
      void apply(replaceRequest(blocker, data, file.name));
    };
    reader.readAsDataURL(file);
  }

  // Until the stored choices are read nothing is offered: an offer made from a guess could undo or repeat a choice.
  if (!state) return problem ? <span role="alert">{problem}</span> : null;
  if (chosenAmong(state, blockers).length > 0 || state.newContextAt) {
    return (
      <span className="image-refusal-actions" role="status">
        {t('Done. Send your message again.')}
      </span>
    );
  }
  const startAgain = (newContextOffered || state.choicesUnreadable) && (
    <button type="button" disabled={busy} onClick={() => void apply({ type: 'newBranchWithoutContext' })}>
      {t('Start again from your last message')}
    </button>
  );
  // Saved choices that cannot be read can only be replaced by a new start; any other choice would be refused.
  if (state.choicesUnreadable) {
    return (
      <span className="image-refusal-actions">
        {startAgain}
        {problem && <span role="alert">{problem}</span>}
      </span>
    );
  }
  const leavable = blockers.filter((blocker) => blocker.actions.includes('continueWithout'));
  const replaceable = blockers.filter((blocker) => blocker.actions.includes('replace'));
  const label = (blocker: ImageRefusalBlocker) => blockerLabel(blocker, numberOf(blocker));
  const names = leavable.map(label).join(', ');
  return (
    <span className="image-refusal-actions">
      {confirming ? (
        <>
          <span>{t('Leave out {{names}}? The conversation keeps them, and you can put them back.', { names })}</span>{' '}
          <button type="button" disabled={busy} onClick={() => void apply(continueWithoutRequest(leavable))}>
            {t('Leave them out')}
          </button>
          <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
            {t('Cancel')}
          </button>
        </>
      ) : (
        <>
          {leavable.length > 0 && (
            <button type="button" disabled={busy} onClick={() => setConfirming(true)}>
              {t('Continue without these images')}
            </button>
          )}
          {replaceable.map((blocker) => (
            <button
              key={`${blocker.messageId}/${blocker.part}`}
              type="button"
              disabled={busy}
              onClick={() => {
                replacing.current = blocker;
                picker.current?.click();
              }}
            >
              {t('Replace {{name}}…', { name: label(blocker) })}
            </button>
          ))}
          {startAgain}
        </>
      )}
      <input
        ref={picker}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          pickedFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
      {problem && <span role="alert">{problem}</span>}
    </span>
  );
}

function StoredChoices({ state, recovery }: { state: ImageRecoveryState; recovery: Recovery }) {
  const { busy, problem, call } = recovery;
  if (state.edits.length === 0 && !state.newContextAt) return null;
  const images = state.edits.map(({ messageId, part }) => ({ messageId, part }));
  return (
    <span className="image-stored-choices" role="status">
      {images.length > 0 && (
        <button type="button" disabled={busy} onClick={() => void call({ type: 'undo', images })}>
          {t('Put the images back')}
        </button>
      )}
      {state.newContextAt && (
        <button type="button" disabled={busy} onClick={() => void call({ type: 'undoNewBranch' })}>
          {t('Bring back the earlier conversation')}
        </button>
      )}
      {problem && <span role="alert">{problem}</span>}
    </span>
  );
}

/** The fixes beside a failure that refused a send for its images. */
export function ImageRefusalActions({ refusal, sessionId }: { refusal: ImageRefusal; sessionId: string }) {
  const recovery = useImageRecovery(sessionId);
  return (
    <RecoveryActions
      blockers={refusal.blockers}
      numberOf={(blocker) => refusal.blockers.indexOf(blocker)}
      newContextOffered={refusal.newContextOffered}
      recovery={recovery}
    />
  );
}

/** The image panel of an opened conversation: restore-check progress, the images it could not take with their fixes, and the undo of stored choices. */
export function ImageCheckStatus({ sessionId }: { sessionId: string }) {
  const recovery = useImageRecovery(sessionId, true);
  const { state } = recovery;
  if (!state) return null;
  const gate = state.gate;
  const stored = <StoredChoices state={state} recovery={recovery} />;
  if (gate.state === 'ready') return stored;
  if (gate.state === 'checking') {
    return (
      <div className="image-check-status" role="status">
        {gate.total > 0
          ? t('Checking the images in this conversation: {{done}} of {{total}}.', {
              done: gate.done,
              total: gate.total,
            })
          : t('Checking the images in this conversation…')}
        {stored}
      </div>
    );
  }
  const blockers: ImageRefusalBlocker[] = gate.images.flatMap((image) =>
    image.part === null
      ? []
      : [{ messageId: image.messageId, part: image.part, name: '', message: image.message, actions: image.actions }]
  );
  const numberOf = (blocker: ImageRefusalBlocker) =>
    gate.images.findIndex((image) => image.messageId === blocker.messageId && image.part === blocker.part);
  return (
    <div className="image-check-status" role="status">
      <span>{t('Some earlier images could not be checked, so this conversation cannot send yet.')}</span>
      <ol>
        {gate.images.map((image) => (
          <li key={`${image.messageId}/${image.part}`}>{image.message}</li>
        ))}
      </ol>
      <RecoveryActions
        blockers={blockers}
        numberOf={numberOf}
        newContextOffered={gate.images.every((image) => image.actions.includes('newBranchWithoutContext'))}
        recovery={recovery}
      />
      {stored}
    </div>
  );
}
