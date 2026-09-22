// extension-pickers/skills-pickers/skill-detail.mjs
// The per-skill detail panel: enable, disable, or write a request that runs the
// skill. It returns to the Skills list through `reopenSkills`, which the owning
// factory supplies so the toggle list stays the single opener of that surface.
export function createSkillDetailPickers({
  store,
  clean,
  surface,
  setSettingsPrompt,
  getDisabledSkills,
  setDisabledSkills,
  reopenSkills,
}) {
  /** Flips one skill in the disabled set, notifies, and returns to Skills. */
  const setSkillDisabled = (skill, disabled) => {
    setDisabledSkills((current) => {
      const next = new Set(current);
      if (disabled) next.add(skill.name);
      else next.delete(skill.name);
      return next;
    });
    store.pushNotice(
      `skill ${disabled ? 'disabled' : 'enabled'}: ${skill.name} (prompt updates next session /clear)`,
      'info'
    );
    reopenSkills();
  };

  const openSkillDetailPicker = (skill) => {
    // Synchronous detail panel for an Enter on a skill row: an ordinary claimed
    // paint — nothing async precedes it, and the claim proves it anyway.
    const own = surface.claim();
    const disabled = getDisabledSkills().has(skill.name);
    // Same two halves the model's listing shows: capability, then trigger.
    const summary = [clean(skill.description), clean(skill.whenToUse)].filter(Boolean).join(' — ');
    own.paint({
      title: `Skill · ${skill.name}`,
      description: summary || 'Enable, disable, or run this skill.',
      items: [
        {
          value: 'use',
          label: 'Use skill',
          description: disabled ? 'enable this skill first' : 'write a request with this skill',
          _action: disabled ? 'noop' : 'use',
        },
        {
          value: disabled ? 'enable' : 'disable',
          label: disabled ? 'Enable skill' : 'Disable skill',
          description: disabled ? 'show and allow this skill in the TUI' : 'hide use action until re-enabled',
          _action: disabled ? 'enable' : 'disable',
        },
      ],
      onSelect: (_value, item) => {
        own.close();
        if (item._action === 'enable') {
          setSkillDisabled(skill, false);
          return;
        }
        if (item._action === 'disable') {
          setSkillDisabled(skill, true);
          return;
        }
        if (item._action === 'use') {
          setSettingsPrompt({
            kind: 'skill-use',
            label: `Skill · ${skill.name}`,
            hint: 'Write the request to run with this skill.',
            skillName: skill.name,
          });
        }
      },
      onCancel: () => {
        own.close();
        reopenSkills();
      },
    });
  };

  return { openSkillDetailPicker };
}
