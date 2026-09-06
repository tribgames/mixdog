export { COMPUTER_POLICY_ACTIONS } from '../../../../src/runtime/computer-bridge/actions.mjs';

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
  error?: 'computer_policy_invalid';
}

export interface ComputerAuthorizationWindow {
  id: string;
  pid: number;
  app: string;
  title: string;
}
