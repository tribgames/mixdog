import { loadComputerSource } from './native-assets';

export const MIXDOG_INPUT_TRANSPORT_CSHARP = loadComputerSource('InputTransport.cs').trimEnd();

export const MIXDOG_HOST_CSHARP = [
  loadComputerSource('MixWin32.cs').trimEnd(),
  MIXDOG_INPUT_TRANSPORT_CSHARP,
  loadComputerSource('InputObservation.cs').trimEnd(),
  loadComputerSource('TaggedKeys.cs').trimEnd(),
  loadComputerSource('CursorTheme.cs').trimEnd(),
].join('\n');
