import { loadComputerSource } from './native-assets';
import { DEFAULT_CAPTURE_AFTER_DELAY_MS } from '../shared/common';

export const PS_SEQUENCE = loadComputerSource('sequence.ps1')
  .replace('@@MIXDOG_SEQUENCE_SETTLE_MS@@', () => String(DEFAULT_CAPTURE_AFTER_DELAY_MS));
