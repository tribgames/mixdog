import { useCallback, useEffect, useRef, useState } from 'react';

import { CapabilityIcon } from '../CapabilityIcon';
import { t } from '../i18n';
import { providerDisplayName } from '../provider-display';
import { record } from '../record-utils';
import { StudioRouteMenu, type StudioModelEntry, type StudioOptionRow } from '../StudioRouteMenu';
import { callCapability, MEDIA_KINDS, type MediaKind, type MediaLane, type StudioApi } from '../studio-support';
import { ExtensionItemList, ExtensionItemRow, ExtensionNote, ExtensionSection } from './extension-detail';

/** The user's default generator for one kind. An empty `model` is the lane's
 *  own default; an empty `account` follows the provider's selected account. */
export interface MediaPin {
  lane: string;
  model: string;
  account: string;
}
type MediaPins = Record<MediaKind, MediaPin | null>;
type AccountRow = { id: string; label: string };

export interface MediaGenerationData {
  /** Null until the first catalog read settles. */
  lanes: MediaLane[] | null;
  pins: MediaPins;
  /** Connected accounts per account provider (signed-in OAuth lanes only). */
  accounts: Record<string, AccountRow[]>;
  error: string;
  save(kind: MediaKind, pin: MediaPin | null): Promise<void>;
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
  const [accounts, setAccounts] = useState<Record<string, AccountRow[]>>({});
  const [error, setError] = useState('');
  // Picks can outrun their saves: only the latest save of a kind may set or
  // roll back its pin, and a rollback returns to the last value the host kept.
  const saveSeq = useRef<Record<MediaKind, number>>({ image: 0, video: 0 });
  const confirmedSeq = useRef<Record<MediaKind, number>>({ image: 0, video: 0 });
  const outstanding = useRef<Record<MediaKind, number>>({ image: 0, video: 0 });
  const confirmed = useRef<MediaPins>(NO_PINS);

  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    void (async () => {
      try {
        const [laneRows, pinRows] = await Promise.all([
          callCapability(api, 'listMediaLanes'),
          callCapability(api, 'getMediaPins'),
        ]);
        if (!live) return;
        const rows = (Array.isArray(laneRows) ? laneRows : []) as MediaLane[];
        setLanes(rows);
        confirmed.current = pinsOf(pinRows);
        setPins(confirmed.current);
        const providers = [
          ...new Set(rows.filter((lane) => lane.authType === 'oauth' && lane.authenticated).map((l) => l.authProvider)),
        ];
        const pools = await Promise.all(
          providers.map(async (provider) => {
            try {
              return [provider, accountRows(await callCapability(api, 'getProviderAccounts', [provider]))] as const;
            } catch {
              return [provider, []] as const;
            }
          })
        );
        if (live) setAccounts(Object.fromEntries(pools));
      } catch (reason) {
        if (!live) return;
        setLanes((current) => current ?? []);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => {
      live = false;
    };
  }, [api, active]);

  const save = useCallback(
    async (kind: MediaKind, pin: MediaPin | null) => {
      saveSeq.current[kind] += 1;
      const seq = saveSeq.current[kind];
      outstanding.current[kind] += 1;
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
        if (saveSeq.current[kind] === seq) setPins((current) => ({ ...current, [kind]: saved }));
      } catch (reason) {
        if (saveSeq.current[kind] === seq) {
          setPins((current) => ({ ...current, [kind]: confirmed.current[kind] }));
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      } finally {
        // An older save that lands after a failed newer one still reached the
        // host: once none is outstanding, show what the host kept.
        outstanding.current[kind] -= 1;
        if (outstanding.current[kind] === 0) setPins((current) => ({ ...current, [kind]: confirmed.current[kind] }));
      }
    },
    [api]
  );

  return { lanes, pins, accounts, error, save };
}

/** Every generator for the kind, ChatGPT first (the auto order); a provider
 *  that is not signed in is listed but cannot be chosen. */
function modelEntries(lanes: MediaLane[], kind: MediaKind): StudioModelEntry[] {
  const ordered = [...lanes].sort((a, b) => Number(b.id === 'openai-oauth') - Number(a.id === 'openai-oauth'));
  return ordered.flatMap<StudioModelEntry>((lane) => {
    const base = { lane: lane.id, laneLabel: providerDisplayName(lane.authProvider), authType: lane.authType };
    if (!lane.authenticated) {
      return lane.supportedKinds?.includes(kind)
        ? [{ ...base, model: '', label: lane.label, unavailable: t('Sign-in required') }]
        : [];
    }
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
  const accounts = (pinnedLane?.authType === 'oauth' && data.accounts[pinnedLane.authProvider]) || [];
  const account = accounts.find((row) => row.id === pin?.account);
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
            value: account?.id ?? '',
            valueLabel: account?.label ?? t('Current account'),
            onPick: (value) => void data.save(kind, { ...pin, account: value }),
          },
        ]
      : [];
  const title = kind === 'image' ? t('Image') : t('Video');
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
          disabled={data.lanes === null}
          triggerLabel={pin ? pinnedLabel || pinnedModel : t('Auto')}
          suffix={account?.label ?? ''}
          rows={accountRow}
          auto={{ label: t('Auto'), selected: !pin, onSelect: () => void data.save(kind, null) }}
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
  return (
    <ExtensionSection title={t('Default generator')}>
      <ExtensionItemList>
        {MEDIA_KINDS.map((kind) => (
          <GeneratorRow key={kind} kind={kind} data={data} />
        ))}
      </ExtensionItemList>
      {data.error ? <ExtensionNote tone="danger">{data.error}</ExtensionNote> : null}
    </ExtensionSection>
  );
}
