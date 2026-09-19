// Global Skill documents and the disabled-skill list.
export function createSkillsResourceApi({ deps, sync, decorate }) {
  const {
    skillsStatus,
    skillContent,
    addGlobalSkill,
    saveSkillDocument,
    invalidateSkills,
    getDisabledSkills,
    setDisabledSkills,
    flushSkillsSave,
  } = deps;
  return {
    skillsStatus() {
      return decorate.skills(skillsStatus());
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
