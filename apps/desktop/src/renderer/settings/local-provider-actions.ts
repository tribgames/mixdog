import { useState } from 'react';
import type { PanelContext } from './capability-data';

export function useLocalProviderActions(run: PanelContext['run'], pending: PanelContext['pending']) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const invoke = async (
    capability: 'cancelLocalProviderInstallation' | 'startLocalProviderInstallation' | 'setLocalProviderIdleTtl'
      | 'getLocalProviderModelDetails' | 'startLocalProviderModelMaintenance' | 'deleteLocalProviderModel',
    args: unknown[],
  ) => {
    if (working || pending) return;
    setWorking(true);
    setError('');
    try {
      const result = await run(capability, args, 'local-provider-operation', true, false, 'throw');
      if (result === undefined) throw new Error('Local Provider operation did not complete.');
      return result;
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setWorking(false);
    }
  };
  return {
    busy: working || Boolean(pending),
    error,
    cancel: (jobId: string) => void invoke('cancelLocalProviderInstallation', [jobId]),
    resume: (phase: string, modelId?: string) => void (phase === 'verify' || phase === 'repair'
      ? invoke('startLocalProviderModelMaintenance', [modelId, phase])
      : invoke('startLocalProviderInstallation', phase === 'model' ? [phase, modelId] : [phase])),
    setIdleTtl: (seconds: number) => void invoke('setLocalProviderIdleTtl', [seconds]),
    details: (modelId: string) => invoke('getLocalProviderModelDetails', [modelId]),
    maintain: (modelId: string, operation: 'verify' | 'repair') => void invoke('startLocalProviderModelMaintenance', [modelId, operation]),
    deleteModel: (confirmationToken: string) => void invoke('deleteLocalProviderModel', [confirmationToken]),
  };
}
