/** In-process Computer Use narrowing (embedding host / reliability harness);
 *  never persisted and no longer exposed to the renderer. */
export interface ComputerAuthorization {
  version: 1;
  actions: string[];
  windows: Array<{ id: string; pid: number }>;
  launchTargets: string[];
  allowElevatedInput: boolean;
  expiresAt: string;
}

export interface ComputerAuthorizationStatus {
  policy: ComputerAuthorization | null;
  externallyRestricted: boolean;
  updating: boolean;
}

export interface ComputerAuthorizationWindow {
  id: string;
  pid: number;
  app: string;
  title: string;
}
