// Global Skill documents and the disabled-skill list.
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** `skillsStatus({ cwd })`: the folder to list and scope skills for, in place
 *  of the session's own. Only an existing absolute directory; it reads the
 *  same skill roots a session opened there would, nothing wider. */
function statusCwd(options) {
  if (options == null) return '';
  const cwd = options?.cwd;
  if (typeof cwd !== 'string' || !cwd || cwd.includes('\0') || !isAbsolute(cwd)) {
    throw new TypeError('skillsStatus cwd must be an absolute path.');
  }
  const folder = resolve(cwd);
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
    throw new TypeError('skillsStatus cwd is not a directory.');
  }
  return folder;
}

export function createSkillsResourceApi({ deps, sync, decorate }) {
  const {
    skillsStatus,
    skillContent,
    addGlobalSkill,
    saveSkillDocument,
    removeGlobalSkill,
    invalidateSkills,
    getDisabledSkills,
    setDisabledSkills,
    flushSkillsSave,
  } = deps;
  return {
    skillsStatus(options) {
      const cwd = statusCwd(options);
      if (!cwd) return decorate.skills(skillsStatus());
      return decorate.skills(skillsStatus({ cwd }), cwd);
    },
    skillContent(name) {
      return skillContent(name);
    },
    async addSkill(input = {}) {
      const skill = addGlobalSkill(input);
      await sync.announce('skills');
      return { skill, status: skillsStatus() };
    },
    async saveSkill(input = {}) {
      const skill = saveSkillDocument(input);
      // A renamed skill keeps its disabled state under the new name.
      if (skill.originalName !== skill.name) {
        const disabled = getDisabledSkills?.().disabled;
        if (Array.isArray(disabled) && disabled.includes(skill.originalName)) {
          setDisabledSkills?.(disabled.map((name) => (name === skill.originalName ? skill.name : name)));
          await flushSkillsSave?.();
        }
      }
      await sync.announce('skills', { invalidate: false });
      return { skill, status: skillsStatus() };
    },
    async removeSkill(input = {}) {
      const removed = removeGlobalSkill(input);
      // A removed skill leaves no stale disabled entry behind.
      const disabled = getDisabledSkills?.().disabled;
      if (Array.isArray(disabled) && disabled.includes(removed.name)) {
        setDisabledSkills?.(disabled.filter((name) => name !== removed.name));
        await flushSkillsSave?.();
      }
      await sync.announce('skills');
      return { skill: removed, status: skillsStatus() };
    },
    async setDisabledSkills(names = []) {
      const result = setDisabledSkills?.(names);
      await flushSkillsSave?.();
      invalidateSkills?.();
      await sync.announce('skills', { invalidate: false });
      return result;
    },
    async reloadSkills() {
      await sync.announce('skills');
      return skillsStatus();
    },
  };
}
