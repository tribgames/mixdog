import { loadComputerSource } from './native-assets';
import { MIXDOG_BOUNDED_UIA_CSHARP, MIXDOG_HOST_CSHARP } from './native-source';

export const PS_SESSION = loadComputerSource('session.ps1')
  .replace('@@MIXDOG_HOST_CSHARP@@', () => MIXDOG_HOST_CSHARP)
  .replace('@@MIXDOG_BOUNDED_UIA_CSHARP@@', () => MIXDOG_BOUNDED_UIA_CSHARP);
