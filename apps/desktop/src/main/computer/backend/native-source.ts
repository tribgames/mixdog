import { loadComputerSource } from './native-assets';

export const MIXDOG_INPUT_TRANSPORT_CSHARP = loadComputerSource('InputTransport.cs').trimEnd();

export const MIXDOG_HOST_CSHARP = [
  // The usings and the MSAA types come first; MixWin32 is one partial class
  // spread over the parts that follow.
  loadComputerSource('MixMsaa.cs').trimEnd(),
  loadComputerSource('MixWin32.cs').trimEnd(),
  loadComputerSource('MixWin32Process.cs').trimEnd(),
  loadComputerSource('MixWin32Window.cs').trimEnd(),
  loadComputerSource('MixWin32Message.cs').trimEnd(),
  loadComputerSource('MixWin32Keyboard.cs').trimEnd(),
  loadComputerSource('MixWin32InactiveLedger.cs').trimEnd(),
  loadComputerSource('MixWin32Foreground.cs').trimEnd(),
  loadComputerSource('MixWin32SendInput.cs').trimEnd(),
  loadComputerSource('WindowGraphicsCapture.cs').trimEnd(),
  MIXDOG_INPUT_TRANSPORT_CSHARP,
  loadComputerSource('InputObservation.cs').trimEnd(),
  loadComputerSource('TaggedKeys.cs').trimEnd(),
  loadComputerSource('CursorTheme.cs').trimEnd(),
].join('\n');
