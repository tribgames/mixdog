// extension-pickers/skills-pickers.mjs
// The Skills list (enable/disable toggles), the project-skills list, and the
// per-skill detail panel. `disabledSkills` is read fresh via
// getDisabledSkills() so toggles observe the latest state at call time.
import { readStatus, withScope } from './scope-note.mjs';

const skillDescription = (skill) => `${skill.source || 'skill'} · ${skill.description || skill.filePath || ''}`;

export function createSkillsPickers({
  store,
  theme,
  clean,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  getDisabledSkills,
  setDisabledSkills,
}) {
  const openProjectSkillsPicker = async () => {
    const own = surface.claim();
    const status = await readStatus(store, 'skillsStatus', 'skills', 'skills status');
    if (!status) return;
    const skills = status.skills;
    const items = [];
    if (skills.length === 0) {
      items.push({
        value: 'empty',
        label: 'No project skills',
        description: 'no project skills available',
        _action: 'noop',
      });
    }
    for (const skill of skills) {
      items.push({
        value: skill.name,
        label: skill.name,
        description: skillDescription(skill),
        _action: 'view',
        _skill: skill,
      });
    }
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    own.paint({
      title: 'Project skills',
      description: 'Skills bundled with this project.',
      items,
      onSelect: (_value, item) => {
        own.close();
        if (item._action !== 'view') return;
        openSkillDetailPicker(item._skill);
      },
      onCancel: () => {
        own.close();
        void openSkillsPicker();
      },
    });
  };

  const skillItems = (skills, disabledSet) => {
    const items = [];
    if (skills.length === 0) {
      items.push({
        value: 'empty',
        label: 'No skills',
        description: 'no project skills available',
        _action: 'noop',
      });
    }
    for (const skill of skills) {
      const enabled = !disabledSet.has(skill.name);
      items.push({
        value: skill.name,
        label: skill.name,
        marker: enabled ? '●' : '○',
        markerColor: enabled ? theme.success : theme.inactive,
        description: withScope(skillDescription(skill), skill),
        _action: 'skill',
        _skill: skill,
        _enabled: enabled,
      });
    }
    return items;
  };

  const openSkillsPicker = async (options = {}) => {
    const own = surface.claim();
    // Reuse the skills list already fetched by the opening call when a toggle
    // reopens the picker: avoids a store.skillsStatus() round-trip per keypress.
    let skills;
    if (Array.isArray(options.skills)) {
      skills = options.skills;
    } else {
      const status = await readStatus(store, 'skillsStatus', 'skills', 'skills status');
      if (!status) return;
      skills = status.skills;
    }
    const disabledSet = options.disabledOverride instanceof Set ? options.disabledOverride : getDisabledSkills();
    const items = skillItems(skills, disabledSet);
    if (!own.owns()) return;
    setProviderPrompt(null);
    setSettingsPrompt(null);
    const toggleSkill = (item) => {
      if (item._action !== 'skill' || !item._skill?.name) return;
      const name = item._skill.name;
      const next = new Set(disabledSet);
      if (item._enabled) next.add(name);
      else next.delete(name);
      setDisabledSkills(next);
      store.pushNotice(
        `skill ${item._enabled ? 'disabled' : 'enabled'}: ${name} (prompt updates next session /clear)`,
        'info'
      );
      openSkillsPicker({ highlightValue: name, disabledOverride: next, skills });
    };
    own.paint({
      _kind: 'skills',
      title: 'Skills',
      description: 'Enable or disable project skills.',
      initialIndex: Math.max(
        0,
        items.findIndex((entry) => entry.value === options.highlightValue)
      ),
      items,
      onSelect: (_value, item) => toggleSkill(item),
      onLeft: (item) => toggleSkill(item),
      onRight: (item) => toggleSkill(item),
      onCancel: () => {
        own.close();
      },
    });
  };

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
    openSkillsPicker();
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
        void openSkillsPicker();
      },
    });
  };

  return { openProjectSkillsPicker, openSkillsPicker, openSkillDetailPicker };
}
