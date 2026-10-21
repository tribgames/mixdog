// The bot's drawn art, shared by the pet window (which draws it) and main
// (which stands it on the composer and keeps the island clear of it).
import { agentAvatar, mascotCells } from '../../../../src/runtime/shared/agent-avatar.mjs';
import type { DesktopPetFace, DesktopPetMember } from './desktop-pet';

/** The look a face draws: a custom picture needs the app's capability
 *  bridge, so the pet window shows the agent's own mascot look instead. */
export function petMemberAvatar(member: DesktopPetMember) {
  const stored = member.avatar as { kind?: unknown } | null;
  return agentAvatar(member.id, stored?.kind === 'custom' ? null : stored);
}

/** The one bot's drawn cells on the mascot's 16x12 grid (one sixteenth of
 *  the sprite box each, the svg filling the box's width); [] for a room's
 *  stack or a face that is not a mascot. */
export function petMascotCells(face: DesktopPetFace | undefined): { x: number; y: number }[] {
  const member = face && !face.room ? face.members[0] : undefined;
  if (!member) return [];
  const avatar = petMemberAvatar(member);
  return avatar.kind === 'mascot' ? mascotCells(avatar) : [];
}
