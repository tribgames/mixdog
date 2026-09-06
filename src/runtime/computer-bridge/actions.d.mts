export const COMPUTER_ACTIONS: Readonly<Record<string, Readonly<{ policy: string; [capability: string]: string | boolean }>>>;
export const COMPUTER_POLICY_ACTIONS: readonly string[];
export function computerActionsWith(capability: string): string[];
export function computerActionPolicy(name: string): string;
export function computerActionHas(name: string, capability: string): boolean;
export function computerPowerShellActionArray(capability: string): string;
