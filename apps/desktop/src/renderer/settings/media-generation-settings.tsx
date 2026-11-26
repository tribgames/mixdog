import { useCallback, useEffect, useRef, useState } from 'react';

import { CapabilityIcon } from '../CapabilityIcon';
import { t } from '../i18n';
import { providerDisplayName } from '../provider-display';
import { record } from '../record-utils';
import { StudioRouteMenu, type StudioModelEntry, type StudioOptionRow } from '../StudioRouteMenu';
import {
  callCapability,
  laneCatalogStatus,
  listMediaLanes,
  MEDIA_CATALOG_POLL_MS,
  MEDIA_KINDS,
  type MediaKind,
  type MediaLane,
  type StudioApi,
} from '../studio-support';
import { errorMessage } from '../editor-pane-session-errors';
import {
  ExtensionAction,
  ExtensionItemList,
  ExtensionItemRow,
  ExtensionNote,
  ExtensionSection,
} from './extension-detail';

/** The user's default generator for one kind. An empty `model` is the lane's
 *  own default; an empty `account` follows the provider's selected account. */
interface MediaPin {
  lane: string;
  model: string;
  account: string;
}
type MediaPins = Record<MediaKind, MediaPin | null>;
type AccountRow = { id: string; label: string };

export interface MediaGenerationData {
  /** Null until the first successful catalog read. */
  lanes: MediaLane[] | null;
  pins: MediaPins;
  pinsReady: boolean;
  /** Connected accounts per account provider (signed-in OAuth lanes only). */
  accounts: Record<string, AccountRow[]>;
  laneError: string;
  pinError: string;
  error: string;
  save(kind: MediaKind, pin: MediaPin | null): Promise<void>;
  retry(): void;
}

const NO_PINS: MediaPins = { image: null, video: null };

function pinOf(value: unknown): MediaPin | null {
  const row = record(value);
  return typeof row.lane === 'string' && row.lane
    ? {
        lane: row.lane,
        model: typeof row.model === 'string' ? row.model : '',
        account: typeof row.account === 'string' ? row.account : '',
      }
    : null;
}

function pinsOf(value: unknown): MediaPins {
  const rows = record(value);
  return { image: pinOf(rows.image), video: pinOf(rows.video) };
}

function accountRows(pool: unknown): AccountRow[] {
  const accounts = record(pool).accounts;
  return (Array.isArray(accounts) ? accounts : [])
    .map(record)
    .filter((row) => typeof row.id === 'string' && row.id)
    .map((row) => ({ id: String(row.id), label: String(row.label || row.id) }));
}

/** Names of the providers that can generate right now, e.g. "ChatGPT · Grok". */
export function mediaGeneratorNames(lanes: MediaLane[] | null): string {
  const names = (lanes ?? []).filter((lane) => lane.authenticated && lane.kinds.length > 0);
  return [...new Set(names.map((lane) => providerDisplayName(lane.authProvider)))].join(' · ');
}

/** Reads the catalog, the saved defaults and the accounts of the signed-in
 *  generators while `active`; `save` persists one kind and rolls back on failure. */
export function useMediaGeneration(api: StudioApi | undefined, active: boolean): MediaGenerationData {
  const [lanes, setLanes] = useState<MediaLane[] | null>(null);
  const [pins, setPins] = useState<MediaPins>(NO_PINS);
  const [pinsReady, setPinsReady] = useState(false);
  const [accounts, setAccounts] = useState<Record<string, AccountRow[]>>({});
  const [laneError, setLaneError] = useState('');
  const [pinError, setPinError] = useState('');
  const [error, setError] = useState('');
  const [laneRevision, setLaneRevision] = useState(0);
  const [pinRevision, setPinRevision] = useState(0);
  // Only the latest edit is optimistic. Older saves can still confirm a pin
  // but cannot display it while that newer edit is pending.
  const saveSeq = useRef<Record<MediaKind, number>>({ image: 0, video: 0 });
  const confirmedSeq = useRef<Record<MediaKind, number>>({ image: 0, video: 0 });
  const optimistic = useRef<Record<MediaKind, boolean>>({ image: false, video: false });
  const confirmed = useRef<MediaPins>(NO_PINS);

  // biome-ignore lint/correctness/useExhaustiveDependencies: laneRevision is the retry's trigger to read the lanes again
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    let timer: number | undefined;
    const readLanes = async (withAccounts: boolean) => {
      let rows: MediaLane[];
      try {
        rows = await listMediaLanes(api);
      } catch (reason) {
        if (live) setLaneError(errorMessage(reason));
        return;
      }
      if (!live) return;
      setLanes(rows);
      setLaneError('');
      // Catalog polls join the runtime's in-flight listing; they don't reread accounts or pins.
      if (rows.some((lane) => lane.catalogPending)) {
        timer = window.setTimeout(() => void readLanes(false), MEDIA_CATALOG_POLL_MS);
      }
      if (!withAccounts) return;
      const providers = [
        ...new Set(
          rows.filter((lane) => lane.authType === 'oauth' && lane.authenticated).map((lane) => lane.authProvider)
        ),
      ];
      await Promise.all(
        providers.map(async (provider) => {
          try {
            const rows = accountRows(await callCapability(api, 'getProviderAccounts', [provider]));
            if (live) setAccounts((current) => ({ ...current, [provider]: rows }));
          } catch {
            // A failed read does not invalidate the last known accounts.
          }
        })
      );
    };
    void readLanes(true);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [api, active, laneRevision]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pinRevision is the retry's trigger to read the pins again
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    const confirmedAtStart = { ...confirmedSeq.current };
    void (async () => {
      try {
        const saved = pinsOf(await callCapability(api, 'getMediaPins'));
        if (!live) return;
        for (const kind of MEDIA_KINDS) {
          // Keep the host's rollback value during an optimistic edit, unless
          // a successful save has already supplied a newer confirmation.
          if (confirmedAtStart[kind] !== confirmedSeq.current[kind]) continue;
          const pin = saved[kind];
          confirmed.current = { ...confirmed.current, [kind]: pin };
          if (!optimistic.current[kind]) setPins((current) => ({ ...current, [kind]: pin }));
        }
        setPinsReady(true);
        setPinError('');
      } catch (reason) {
        if (live) setPinError(errorMessage(reason));
      }
    })();
    return () => {
      live = false;
    };
  }, [api, active, pinRevision]);

  const retry = useCallback(() => {
    if (laneError || lanes?.some((lane) => lane.authenticated && lane.catalogError)) {
      setLaneRevision((current) => current + 1);
    }
    if (pinError) setPinRevision((current) => current + 1);
  }, [laneError, lanes, pinError]);

  const save = useCallback(
    async (kind: MediaKind, pin: MediaPin | null) => {
      saveSeq.current[kind] += 1;
      const seq = saveSeq.current[kind];
      optimistic.current[kind] = true;
      setPins((current) => ({ ...current, [kind]: pin }));
      setError('');
      try {
        const saved = pinOf(
          await callCapability(api, 'setMediaPin', [
            { kind, lane: pin?.lane ?? '', model: pin?.model ?? '', account: pin?.account ?? '' },
          ])
        );
        if (seq > confirmedSeq.current[kind]) {
          confirmedSeq.current[kind] = seq;
          confirmed.current = { ...confirmed.current, [kind]: saved };
        }
      } catch (reason) {
        if (saveSeq.current[kind] === seq) setError(errorMessage(reason));
      } finally {
        if (saveSeq.current[kind] === seq) optimistic.current[kind] = false;
        if (!optimistic.current[kind]) {
          const pin = confirmed.current[kind];
          setPins((current) => ({ ...current, [kind]: pin }));
        }
      }
    },
    [api]
  );

  return { lanes, pins, pinsReady, accounts, laneError, pinError, error, save, retry };
}

/** Every generator for the kind, ChatGPT first (the auto order); a provider
 *  that is not signed in is listed but cannot be chosen. */
function modelEntries(lanes: MediaLane[], kind: MediaKind): StudioModelEntry[] {
  const ordered = [...lanes].sort((a, b) => Number(b.id === 'openai-oauth') - Number(a.id === 'openai-oauth'));
  return ordered.flatMap<StudioModelEntry>((lane) => {
    const base = { lane: lane.id, laneLabel: providerDisplayName(lane.authProvider), authType: lane.authType };
    if (!lane.authenticated) {
      return lane.supportedKinds?.includes(kind)
        ? [{ ...base, model: '', label: lane.label, unavailable: lane.unavailableReason || t('Sign-in required') }]
        : [];
    }
    // Still loading or failed: listed with that state, never silently dropped.
    const status = laneCatalogStatus(lane, kind);
    if (status) return [{ ...base, model: '', label: lane.label, unavailable: status }];
    return (lane[kind]?.models ?? []).map((model) => ({
      ...base,
      model: model.id,
      label: model.label,
      description: model.description,
    }));
  });
}

function GeneratorRow({ kind, data }: { kind: MediaKind; data: MediaGenerationData }) {
  const lanes = data.lanes ?? [];
  const pin = data.pins[kind];
  const entries = modelEntries(lanes, kind);
  const pinnedLane = pin ? lanes.find((lane) => lane.id === pin.lane) : undefined;
  const pinnedModel = pin ? pin.model || pinnedLane?.[kind]?.defaultModel || '' : '';
  const pinnedLabel = entries.find((entry) => entry.lane === pin?.lane && entry.model === pinnedModel)?.label;
  const accounts =
    (pinnedLane?.authenticated && pinnedLane.authType === 'oauth' && data.accounts[pinnedLane.authProvider]) || [];
  const account = accounts.find((row) => row.id === pin?.account);
  const accountLabel = account?.label ?? pin?.account ?? '';
  const accountRow: StudioOptionRow[] =
    pin && accounts.length >= 2
      ? [
          {
            id: 'account',
            label: t('Account'),
            options: [
              { value: '', label: t('Current account') },
              ...accounts.map((row) => ({ value: row.id, label: row.label })),
            ],
            value: pin.account,
            valueLabel: accountLabel || t('Current account'),
            onPick: (value) => void data.save(kind, { ...pin, account: value }),
          },
        ]
      : [];
  const title = kind === 'image' ? t('Image') : t('Video');
  const canPick = data.lanes !== null && data.pinsReady;
  let triggerLabel = t('Auto');
  if (pin) triggerLabel = pinnedLabel || pinnedModel || pinnedLane?.label || pin.lane;
  else if (!data.pinsReady) triggerLabel = data.pinError ? t('Unavailable') : t('Loading…');
  return (
    <ExtensionItemRow
      icon={<CapabilityIcon name={kind} size={16} />}
      title={title}
      description={t('Used when the chat does not name a generator.')}
      dataAttributes={{ 'data-media-kind': kind }}
      control={
        <StudioRouteMenu
          variant="field"
          ariaLabel={`${title} · ${t('Default generator')}`}
          entries={entries}
          lane={pin?.lane ?? ''}
          model={pinnedModel}
          disabled={!canPick}
          triggerLabel={triggerLabel}
          suffix={accountLabel}
          rows={accountRow}
          auto={canPick ? { label: t('Auto'), selected: !pin, onSelect: () => void data.save(kind, null) } : undefined}
          onSelect={(entry) =>
            void data.save(kind, {
              lane: entry.lane,
              model: entry.model,
              account: entry.lane === pin?.lane ? pin.account : '',
            })
          }
        />
      }
    />
  );
}

export function MediaGenerationSettings({ data }: { data: MediaGenerationData }) {
  const catalogErrors = (data.lanes ?? [])
    .filter((lane) => lane.authenticated && lane.catalogError)
    .map((lane) => lane.catalogError as string);
  const canRetry = data.laneError || data.pinError || catalogErrors.length > 0;
  return (
    <ExtensionSection
      title={t('Default generator')}
      dataAttributes={{ 'data-media-generation': '' }}
      action={canRetry ? <ExtensionAction onClick={data.retry}>{t('Retry')}</ExtensionAction> : null}
    >
      <ExtensionItemList>
        {MEDIA_KINDS.map((kind) => (
          <GeneratorRow key={kind} kind={kind} data={data} />
        ))}
      </ExtensionItemList>
      {catalogErrors.map((message) => (
        <ExtensionNote key={message} tone="danger">
          {message}
        </ExtensionNote>
      ))}
      {data.laneError ? <ExtensionNote tone="danger">{data.laneError}</ExtensionNote> : null}
      {data.pinError ? <ExtensionNote tone="danger">{data.pinError}</ExtensionNote> : null}
      {data.error ? <ExtensionNote tone="danger">{data.error}</ExtensionNote> : null}
    </ExtensionSection>
  );
}
