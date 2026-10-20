// "대표 에이전트 먼저": a fresh profile has no agents until it creates Mixy.
// Whether Mixy exists is the host's answer to getLeadStatus (main/mixy-first.ts
// decides an undecided profile once: existing users count as created). While
// Mixy does not exist the Agents pane is empty, the new-agent dialog opens in
// 대표 에이전트 mode when asked (the empty state's button, "+", the guide's
// step); the starter guide's first step completes when Mixy is created.
import { useEffect, useState } from 'react';
import { MIXY_AGENT_ID } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { MIXY_AVATAR } from '../../../../src/runtime/shared/agent-avatar.mjs';
import type { DesktopApi, DesktopCapability, DesktopModelSelection } from '../shared/contract';
import { errorMessageText } from './ErrorNotice';
import { t } from './i18n';
import {
  MIXY_DEFAULT_NAME,
  onMixyDialogRequest,
  publishMixyStatus,
  settleMixyDialog,
  useMixyStatus,
} from './mixy-identity';
import { showDesktopToast } from './notifications';
import type { RecordValue } from './desktop-types';
import './mixy-first.css';

export { MIXY_AGENT_ID, MIXY_AVATAR, MIXY_DEFAULT_NAME };

type StatusApi = Partial<Pick<DesktopApi, 'invokeCapability'>> | undefined;

/** Whether Mixy exists; null until the host answered. */
export function useMixyCreated(api: StatusApi, enabled = true): boolean | null {
  return useMixyStatus(api, enabled).created;
}

/** The Agents pane's side: while Mixy does not exist, the 대표 에이전트 dialog
 *  opens only on request — the empty state's button, "+" or the guide's step. */
export function useMixyFirstPane(active: boolean) {
  const mixyCreated = useMixyCreated(window.mixdogDesktop, active);
  const [creatingMixy, setCreatingMixy] = useState(false);
  useEffect(() => onMixyDialogRequest(() => setCreatingMixy(true)), []);
  return {
    /** Mixy is known not to exist. */
    empty: mixyCreated === false,
    mixyCreated,
    creatingMixy,
    openMixyDialog: () => setCreatingMixy(true),
    closeMixyDialog: () => {
      setCreatingMixy(false);
      settleMixyDialog();
    },
  };
}

type Run = (capability: DesktopCapability, args?: unknown[]) => Promise<unknown>;

/** Saves Mixy's definition from the 대표 에이전트 dialog: its name and face
 *  and PERSONA.md / AGENT.md under agents/lead/, the model as the Main route
 *  (as the profile does), then the created flag. False when a step failed
 *  (shown by `run`). */
export async function createMixy(
  api: Partial<Pick<DesktopApi, 'setModelRoute'>> | undefined,
  run: Run,
  payload: RecordValue
): Promise<boolean> {
  const identity = await run('saveLeadIdentity', [
    { name: String(payload.name || ''), ...(payload.avatar ? { avatar: payload.avatar } : {}) },
  ]);
  if (identity === undefined) return false;
  publishMixyStatus(identity);
  if (typeof payload.persona === 'string' && (await run('saveLeadPersona', [payload.persona])) === undefined)
    return false;
  if (typeof payload.body === 'string' && (await run('saveLeadAgentBody', [payload.body])) === undefined) return false;
  if (payload.route) {
    try {
      await api?.setModelRoute?.(payload.route as DesktopModelSelection);
    } catch (reason) {
      showDesktopToast(errorMessageText(reason), 'error');
      return false;
    }
  }
  const created = await run('setLeadCreated', [true, String(payload.description || '')]);
  if (created === undefined) return false;
  publishMixyStatus(created);
  return true;
}

/** The empty Agents pane before Mixy exists: one action reopens the dialog. */
export function MixyEmptyState({ onCreate }: { onCreate(): void }) {
  return (
    <div className="utility-dock-empty mixy-empty">
      <p>{t('No bots.')}</p>
      <button type="button" className="mixy-empty-create" onClick={onCreate}>
        {t('Create representative bot')}
      </button>
    </div>
  );
}
