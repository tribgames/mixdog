import { loadComputerSource } from './native-assets';

export const MIXDOG_HOST_CSHARP = [
  loadComputerSource('MixWin32.cs').trimEnd(),
  loadComputerSource('InputObservation.cs').trimEnd(),
  loadComputerSource('TaggedKeys.cs').trimEnd(),
].join('\n');
