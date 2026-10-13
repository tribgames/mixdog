/**
 * Local worktree slug generator: a short, Windows-safe folder name and branch
 * suffix derived from the task's first message, made unique on demand.
 */
import { randomBytes } from 'node:crypto';
import { worktreeNameError } from './contract.mjs';

export const SLUG_MAX_LENGTH = 40;
const FALLBACK_SLUG = 'task';
// DOS device names stay reserved on Windows, even with an extension.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

function trimSlug(value, max) {
  return value.slice(0, max).replace(/-+$/, '');
}

/**
 * @param {unknown} hint Free text, typically the first user message.
 * @returns {string} Lowercase [a-z0-9-], at most SLUG_MAX_LENGTH characters.
 */
export function slugFromHint(hint) {
  const words = String(hint ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > SLUG_MAX_LENGTH) {
      if (!slug) slug = trimSlug(word, SLUG_MAX_LENGTH);
      break;
    }
    slug = next;
  }
  if (!slug) slug = FALLBACK_SLUG;
  if (WINDOWS_RESERVED.test(slug)) slug = `${slug}-${FALLBACK_SLUG}`;
  return slug;
}

/**
 * First of base, base-2, base-3, … that `isTaken` rejects, then a random
 * suffix. Every candidate passes worktreeNameError.
 * @param {string} base
 * @param {(slug: string) => boolean} isTaken
 */
export function uniqueSlug(base, isTaken) {
  const root = worktreeNameError(base) ? FALLBACK_SLUG : base;
  for (let attempt = 1; attempt <= 50; attempt++) {
    const suffix = attempt === 1 ? '' : `-${attempt}`;
    const candidate = `${trimSlug(root, SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!worktreeNameError(candidate) && !isTaken(candidate)) return candidate;
  }
  for (;;) {
    const suffix = `-${randomBytes(4).toString('hex')}`;
    const candidate = `${trimSlug(root, SLUG_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }
}
