export interface MascotLook {
  species: string;
  accessory: string;
  expression: string;
}
export interface MascotAvatar extends MascotLook {
  kind: 'mascot';
  color: string;
}
export type AgentAvatarState = 'idle' | 'typing' | 'message';
export interface CustomAvatar {
  kind: 'custom';
  /** File names; `idle` is required and every missing state falls back to it. */
  states: { idle: string } & Partial<Record<AgentAvatarState, string>>;
}
export type AgentAvatarValue = MascotAvatar | CustomAvatar;
export interface MascotCell {
  x: number;
  y: number;
  fill: string;
}
export interface MascotParts {
  tail: MascotCell[];
  legs: MascotCell[];
  body: MascotCell[];
  ear: MascotCell[];
  marks: MascotCell[];
  eyes: MascotCell[];
  blink: MascotCell[];
  accessory: MascotCell[];
}
export interface AvatarImageInfo {
  format: 'png' | 'gif' | 'webp';
  width: number;
  height: number;
  animated: boolean;
}
export const AGENT_AVATAR_COLORS: readonly string[];
export const MASCOT_SPECIES: readonly string[];
export const MASCOT_ACCESSORIES: readonly string[];
export const MASCOT_EXPRESSIONS: readonly string[];
export const MASCOT_INKS: Readonly<Record<string, string>>;
export const MIXY_AVATAR: Readonly<MascotAvatar>;
export const AGENT_AVATAR_STATES: readonly AgentAvatarState[];
export const AGENT_AVATAR_LATER_STATES: readonly string[];
export const AGENT_AVATAR_IMAGE_FILE: RegExp;
export const AGENT_AVATAR_STATE_FILE: RegExp;
export const AGENT_AVATAR_DIR: string;
export const AGENT_AVATAR_IMAGE_MAX_BYTES: number;
export const AGENT_AVATAR_IMAGE_MAX_SIDE: number;
export function shadeHex(hex: string, k: number): string;
export function mascotFromVariant(variant: string): MascotLook | null;
export function mascotLook(avatar: MascotLook): string;
export function mascotParts(avatar: MascotLook & { color: string }): MascotParts | null;
export function mascotCells(avatar: MascotLook & { color: string }): MascotCell[];
export function cellPaths(cells: readonly MascotCell[]): Array<{ fill: string; d: string }>;
export function agentAvatarStatePath(file: string): string;
export function avatarPosterFile(file: string): string;
export function customAvatarStateFile(avatar: CustomAvatar, state: AgentAvatarState): string;
export function avatarImageInfo(bytes: Uint8Array): AvatarImageInfo | null;
export function agentAvatarImageProblem(bytes: Uint8Array): string;
export function normalizeAgentAvatar(value: unknown): AgentAvatarValue | null;
export function defaultAgentAvatar(id: string): MascotAvatar;
export function agentAvatar(id: string, stored: unknown): AgentAvatarValue;
