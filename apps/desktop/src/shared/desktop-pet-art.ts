// The bot's drawn art, shared by the pet window (which draws it) and main
// (which stands it on the composer and keeps the island clear of it).
import { agentAvatar, mascotCells } from '../../../../src/runtime/shared/agent-avatar.mjs';
import type { DesktopPetFace, DesktopPetMember } from './desktop-pet';

/** The look a face has: its mascot pick or its custom picture (the pet
 *  window reads the picture through main: DesktopPetBridge.avatarImage). */
export function petMemberAvatar(member: DesktopPetMember) {
  return agentAvatar(member.id, member.avatar);
}

/** What the pet window draws while a picture is not read (or cannot be):
 *  the agent's own mascot look. */
export function petFallbackAvatar(member: DesktopPetMember) {
  const avatar = petMemberAvatar(member);
  return avatar.kind === 'custom' ? agentAvatar(member.id, null) : avatar;
}

/** The custom picture's still idle frame from getAgentAvatarImage's answer
 *  (its first frame for a moving one), as a data URL; '' when it holds none
 *  for `avatar`'s idle file. */
export function petPictureSource(avatar: { states: { idle: string } }, answer: unknown): string {
  const states = (answer as { states?: Record<string, { file?: unknown; url?: unknown; poster?: unknown }> } | null)
    ?.states;
  const image = Object.values(states ?? {}).find((entry) => entry?.file === avatar.states.idle);
  if (typeof image?.url !== 'string' || !image.url.startsWith('data:image/')) return '';
  return typeof image.poster === 'string' && image.poster.startsWith('data:image/png;') ? image.poster : image.url;
}

/** The one bot's drawn cells on the mascot's 16x12 grid (one sixteenth of
 *  the sprite box each, the svg filling the box's width); [] for a room's
 *  stack or a picture. `fallback`: the mascot drawn in a picture's place. */
export function petMascotCells(face: DesktopPetFace | undefined, fallback = false): { x: number; y: number }[] {
  const member = face && !face.room ? face.members[0] : undefined;
  if (!member) return [];
  const avatar = fallback ? petFallbackAvatar(member) : petMemberAvatar(member);
  return avatar.kind === 'mascot' ? mascotCells(avatar) : [];
}
