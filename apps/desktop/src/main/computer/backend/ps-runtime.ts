import { loadComputerSource } from './native-assets';
import { RESPONSE_MARKER } from '../shared/common';
import { computerPowerShellActionArray } from '../../../../../../src/runtime/computer-bridge/actions.mjs';
import { NATIVE_CAPTURE_WORK_MS } from '../shared/capture-attempts';

export const PS_WINDOW_CAPTURE = loadComputerSource('window-capture.ps1').replace('@@MIXDOG_CAPTURE_WORK_MS@@', () =>
  String(NATIVE_CAPTURE_WORK_MS)
);

/** The resident program's functions, then the command dispatcher and stdin loop
 *  (`runtime.ps1`) last. Each part ends on a statement boundary, so the parts
 *  join with no separator. */
export const PS_RUNTIME = [
  loadComputerSource('runtime-recovery.ps1'),
  loadComputerSource('runtime-typing.ps1'),
  loadComputerSource('runtime-ocr-clipboard.ps1'),
  loadComputerSource('runtime-window.ps1'),
  loadComputerSource('runtime.ps1'),
]
  .join('')
  .replace('@@MIXDOG_RETAIN_REFS_ACTIONS@@', () => computerPowerShellActionArray('retainNativeRefs'))
  .replace('@@MIXDOG_NATIVE_READ_ACTIONS@@', () => computerPowerShellActionArray('nativeRead'))
  .replace('@@MIXDOG_RESPONSE_MARKER@@', () => RESPONSE_MARKER);
