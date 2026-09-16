import { loadComputerSource } from './native-assets';
import { RESPONSE_MARKER } from '../shared/common';
import { computerPowerShellActionArray } from '../../../../../../src/runtime/computer-bridge/actions.mjs';
import { NATIVE_CAPTURE_WORK_MS } from '../shared/capture-attempts';

export const PS_WINDOW_CAPTURE = loadComputerSource('window-capture.ps1').replace('@@MIXDOG_CAPTURE_WORK_MS@@', () =>
  String(NATIVE_CAPTURE_WORK_MS)
);

export const PS_RUNTIME = loadComputerSource('runtime.ps1')
  .replace('@@MIXDOG_RETAIN_REFS_ACTIONS@@', () => computerPowerShellActionArray('retainNativeRefs'))
  .replace('@@MIXDOG_NATIVE_READ_ACTIONS@@', () => computerPowerShellActionArray('nativeRead'))
  .replace('@@MIXDOG_RESPONSE_MARKER@@', () => RESPONSE_MARKER);
