import { loadComputerSource } from './native-assets';
import { MIXDOG_HOST_CSHARP } from './native-source';

export const PS_SESSION = loadComputerSource('session.ps1')
  .replace('@@MIXDOG_HOST_CSHARP@@', () => MIXDOG_HOST_CSHARP);
