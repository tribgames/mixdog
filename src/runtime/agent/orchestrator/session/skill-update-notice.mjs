// A thread can live for days while its loaded skills change underneath it (an
// app update ships a new SKILL.md, the user edits or switches one off). Compact
// restores every skill from its current source; between Compacts, each turn
// tells the model once that a skill it holds instructions for changed, as a
// new runtime message after the history, never by rewriting what was sent.
import { createHash } from 'node:crypto';
import { loadConfig } from '../config.mjs';
import { collectSkillsCached, currentSkillDelivery } from '../context/collect.mjs';
import { latestSkillBodies, skillMessageText } from '../context/skill-state.mjs';

export const SKILL_UPDATE_SOURCE = 'skill-update-notice';

const UNAVAILABLE = 'unavailable';
// The loaded body is what the Skill tool delivers again (after an
// unavailable notice): its instructions are back in force.
const CURRENT = 'current';

function skillUpdateNotice(name, version) {
  let text = `[mixdog-runtime] Skill "${name}" was updated since it was loaded. Reload it with the Skill tool before relying on it.`;
  if (version === UNAVAILABLE) {
    text = `[mixdog-runtime] Skill "${name}" is no longer available in this session (switched off, removed, or outside this project's scope). Do not rely on its instructions.`;
  } else if (version === CURRENT) {
    text = `[mixdog-runtime] Skill "${name}" is available again, unchanged; its loaded instructions apply again.`;
  }
  return { role: 'user', content: text, meta: { source: SKILL_UPDATE_SOURCE, synthetic: true, skill: name, version } };
}

/**
 * For every skill whose latest body is in `messages`, compare it with what the
 * Skill tool would deliver at `cwd` now. Its state — the loaded body still
 * current, a changed version, or unavailable — is announced whenever it
 * differs from the last state told after that body (none told: current).
 * So each transition notifies once: changed, switched off, and back again
 * unchanged. A reload replaces the body and starts over. Returns the
 * appended notices.
 */
export function appendSkillUpdateNotices(messages, cwd) {
  const bodies = latestSkillBodies(messages);
  if (!bodies.length) return [];
  const config = loadConfig({ secrets: false });
  const skills = collectSkillsCached(cwd);
  const notices = [];
  for (const { name, message } of bodies) {
    const delivery = currentSkillDelivery(name, cwd, config, skills);
    let version = UNAVAILABLE;
    if (delivery) {
      version =
        skillMessageText(message.content).trimStart() === delivery.body
          ? CURRENT
          : createHash('sha256').update(delivery.body).digest('hex').slice(0, 16);
    }
    const told =
      messages
        .slice(messages.lastIndexOf(message) + 1)
        .findLast((m) => m?.meta?.source === SKILL_UPDATE_SOURCE && m.meta.skill === name)?.meta.version || CURRENT;
    if (told !== version) notices.push(skillUpdateNotice(name, version));
  }
  messages.push(...notices);
  return notices;
}
