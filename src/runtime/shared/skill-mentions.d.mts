export interface SkillMention {
  name: string;
  start: number;
  end: number;
}
export function isReservedMentionName(name: unknown): boolean;
export function isInMarkdownCode(text: unknown, offset: number): boolean;
export function skillMentionCandidates(text: unknown): SkillMention[];
export function skillMentions(text: unknown, isSkill: (name: string) => boolean): SkillMention[];
export function mentionedSkillNames(text: unknown, isSkill: (name: string) => boolean): string[];
