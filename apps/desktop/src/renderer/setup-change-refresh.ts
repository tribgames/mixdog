import { useEffect, useRef } from 'react';
import type { SetupLaneSource } from './app-shell-ui-open-request';
import type { DesktopApi } from '../shared/contract';
import type { Snapshot } from './desktop-types';
import { invalidateSidebarReferenceForMutation } from './sidebar-reference-cache';

/** Window event every settings reader re-reads on after a setup-tool change. */
export const SETUP_CHANGED_EVENT = 'mixdog:setup-changed';

const SETUP_CHANGE_TTL_MS = 15_000;

// Setup actions whose shared sidebar caches have a settings-click twin: the
// change invalidates exactly what that click invalidates.
const SETUP_ACTION_MUTATIONS: Readonly<Record<string, string>> = {
  set_agent_route: 'setAgentRoute',
  set_web_search_route: 'setWebSearchRoute',
  forget_provider_auth: 'forgetProviderAuth',
  set_provider_account: 'updateProviderAccounts',
  install_builtin: 'installBuiltinFeature',
  set_builtin_enabled: 'setBuiltinToolEnabled',
  install_local_model: 'installLocalProviderModel',
  register_hf_model: 'installLocalProviderModel',
  delete_local_model: 'installLocalProviderModel',
  set_developer_option: 'setDeveloperOption',
  set_workflow: 'saveWorkflowPack',
  // Definitions cover workflows and agents; this twin retires both lists.
  create_definition: 'deleteWorkflow',
  save_definition: 'deleteWorkflow',
  delete_definition: 'deleteWorkflow',
  save_automation: 'saveSchedule',
  delete_automation: 'deleteSchedule',
  set_automation_enabled: 'setScheduleEnabled',
  set_webhook_config: 'saveWebhook',
  save_project: 'addProject',
  remove_project: 'removeProject',
};

export function announceSetupChange(action: string): void {
  const mutation = SETUP_ACTION_MUTATIONS[action];
  if (mutation) invalidateSidebarReferenceForMutation(mutation);
  window.dispatchEvent(new CustomEvent(SETUP_CHANGED_EVENT, { detail: { action } }));
}

/** A desktop setting or Git identity was written on the host or by another
 *  client: open settings pages re-read through the same setup-change event. */
export function useSettingsChangeSync(api: Pick<Partial<DesktopApi>, 'subscribeSettingsChanged'> | undefined): void {
  useEffect(() => api?.subscribeSettingsChanged?.(() => announceSetupChange('settings_changed')), [api]);
}

export function subscribeSetupChanges(listener: () => void): () => void {
  const onChange = () => listener();
  window.addEventListener(SETUP_CHANGED_EVENT, onChange);
  return () => window.removeEventListener(SETUP_CHANGED_EVENT, onChange);
}

/** The engine publishes { action, seq } on the session snapshot after every
 *  setup-tool mutation. Each new seq per session announces once, whether it
 *  arrives on the App snapshot or a split-pane lane; a replayed snapshot older
 *  than the TTL is history. */
export function useSetupChangeAnnouncer(
  setupChanged: Snapshot['setupChanged'],
  sessionId: Snapshot['sessionId'],
  subscribeSessionLanes?: SetupLaneSource
): void {
  const seen = useRef(new Map<string, number>());
  const route = useRef<(changeSessionId: string, change: Snapshot['setupChanged']) => void>(() => {});
  route.current = (changeSessionId, change) => {
    const seq = Number(change?.seq) || 0;
    if (!change?.action || seq <= (seen.current.get(changeSessionId) || 0)) return;
    seen.current.set(changeSessionId, seq);
    if (Number(change.at) > 0 && Date.now() - Number(change.at) > SETUP_CHANGE_TTL_MS) return;
    announceSetupChange(change.action);
  };
  useEffect(() => route.current(sessionId || '', setupChanged), [sessionId, setupChanged]);
  useEffect(
    () =>
      subscribeSessionLanes?.(({ sessionId: laneSessionId, snapshot }) =>
        route.current(laneSessionId, (snapshot as Pick<Snapshot, 'setupChanged'> | null)?.setupChanged)
      ),
    [subscribeSessionLanes]
  );
}
