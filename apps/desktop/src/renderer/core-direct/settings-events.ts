import type { ConnectionStoreChange } from '../../main/protocol/connection';
import type { DesktopApi } from '../../shared/contract';
import type { DirectKey } from '../../shared/desktop-api-split';
import { configuredOrchestrationMode } from '../../shared/orchestration-mode';
import { remotePagedMember } from '../../shared/core-lanes/remote-reads';
import { readActivityRailPins } from '../../shared/core-lanes/section-reads';
import type { DirectContext } from './context.ts';
import { record } from '../record-utils.ts';

type SettingsApi = Pick<DesktopApi, DirectKey<'settings'>>;

/** The settings events that are what the held sections show changing, each compared with what its listener last heard. */
export function createSettingsEvents(ctx: DirectContext) {
  const { connection } = ctx;
  /** The held value of `(section, key)`, or undefined while the core holds none. */
  const held = (section: string, key: string | null): unknown =>
    connection.snapshot().entries.find((entry) => entry.section === section && entry.key === key)?.value;
  /** True while sections a snapshot swapped in are still being announced: they are where things stand, not changes. */
  const announcingSnapshot = (): boolean =>
    Boolean((connection.client()?.store as { readonly owed?: unknown } | undefined)?.owed);
  /** Calls `onChange` for every change of the held `(section, key)`, and for a whole snapshot (which only resets where
   *  things stand); a snapshot's own announcements of the section are skipped. */
  const followSection = (
    section: string,
    key: string | null,
    onChange: (change: ConnectionStoreChange) => void
  ): (() => void) =>
    connection.onStoreChange((change) => {
      if (change.type === 'appSnapshot') return onChange(change);
      if (change.type !== 'section' || change.section !== section || (change.key ?? null) !== key) return;
      if (!announcingSnapshot()) onChange(change);
    });

  const activityRailPins: SettingsApi['subscribeActivityRailPins'] = (listener) => {
    let told = readActivityRailPins(connection.snapshot())?.revision ?? 0;
    return followSection('config', 'desktop', (change) => {
      const state = readActivityRailPins(connection.snapshot());
      if (change.type === 'appSnapshot') told = state?.revision ?? 0;
      else if (state && state.revision !== told) {
        told = state.revision;
        listener(state);
      }
    });
  };
  const turnReview: NonNullable<SettingsApi['subscribeTurnReviewChanged']> = (listener) =>
    connection.onStoreChange((change) => {
      // A tell, not state: one the window was not there for (a snapshot) is not delivered.
      if (change.type === 'section' && change.section === 'reviewDiff' && !announcingSnapshot()) listener();
    });
  const configuredMode = () => configuredOrchestrationMode(held('config', 'agent'));
  const orchestrationMode: NonNullable<SettingsApi['subscribeOrchestrationModeChanged']> = (listener) => {
    let told = configuredMode();
    return followSection('config', 'agent', (change) => {
      const mode = configuredMode();
      if (change.type === 'appSnapshot') told = mode;
      else if (mode !== told) {
        told = mode;
        listener({ mode });
      }
    });
  };
  /** Runs `read` with the `remote` member `name` on every change of the section, one at a time and in order (a section
   *  over the inline limit is paged, remotePagedMember). The first run only records where things stand. */
  const followRemote = (name: string, read: (value: unknown, first: boolean) => void): (() => void) => {
    let first = true;
    let queue: Promise<void> = Promise.resolve();
    const check = (): void => {
      queue = queue
        .then(async () => {
          read(await remotePagedMember(connection.snapshot(), name, ctx.call), first);
          first = false;
        })
        // Not held yet (sectionUnavailable) or a failed page: the next change reads again.
        .catch(() => undefined);
    };
    check();
    return followSection('remote', null, check);
  };
  const remoteSettings: SettingsApi['subscribeRemoteAccessSettings'] = (listener) => {
    let told: string | null = null;
    return followRemote('settings', (value, first) => {
      const settings = JSON.stringify(value ?? null);
      const changed = settings !== told;
      told = settings;
      if (changed && !first) listener(value as never);
    });
  };
  const remoteClaims: SettingsApi['subscribeRemoteClientClaim'] = (listener) => {
    let known = new Set<string>();
    return followRemote('claims', (value, first) => {
      const claims = Array.isArray(value) ? value.map(record) : [];
      const fresh = claims.filter((claim) => typeof claim.claimId === 'string' && !known.has(claim.claimId));
      known = new Set(claims.map((claim) => String(claim.claimId)));
      if (!first) for (const claim of fresh) listener(claim as never);
    });
  };

  return { activityRailPins, turnReview, orchestrationMode, remoteSettings, remoteClaims };
}
