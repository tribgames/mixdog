import { loadComputerSource } from './native-assets';
import { RESPONSE_MARKER } from '../shared/common';
import { computerPowerShellActionArray } from '../../../../../../src/runtime/computer-bridge/actions.mjs';

export const PS_RUNTIME = loadComputerSource('runtime.ps1')
  .replace('@@MIXDOG_RETAIN_REFS_ACTIONS@@', () => computerPowerShellActionArray('retainNativeRefs'))
  .replace('@@MIXDOG_NATIVE_READ_ACTIONS@@', () => computerPowerShellActionArray('nativeRead'))
  .replace('@@MIXDOG_RESPONSE_MARKER@@', () => RESPONSE_MARKER);
