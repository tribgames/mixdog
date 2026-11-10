// extension-pickers/skills-pickers.mjs
// The Skills list (enable/disable toggles). `disabledSkills` is read fresh via
// getDisabledSkills() so toggles observe the latest state at call time.
//
// The row shapes live in skills-pickers/skill-items.mjs and the two panels that
// return here — the project-skills list (skills-pickers/project-skills.mjs) and
// the per-skill detail (skills-pickers/skill-detail.mjs) — re-enter this list
// through the `reopenSkills` callback below, so this file stays the only opener
// of the Skills surface.
import { readStatus } from './scope-note.mjs';
import { createProjectSkillsPicker } from './skills-pickers/project-skills.mjs';
import { createSkillDetailPickers } from './skills-pickers/skill-detail.mjs';
import { skillItems } from './skills-pickers/skill-items.mjs';

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
    const items = skillItems(skills, disabledSet, theme);
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

  const reopenSkills = () => {
    void openSkillsPicker();
  };
  const { openSkillDetailPicker } = createSkillDetailPickers({
    store,
    clean,
    surface,
    setSettingsPrompt,
    getDisabledSkills,
    setDisabledSkills,
    reopenSkills,
  });
  const openProjectSkillsPicker = createProjectSkillsPicker({
    store,
    surface,
    setProviderPrompt,
    setSettingsPrompt,
    openSkillDetailPicker,
    reopenSkills,
  });

  return { openProjectSkillsPicker, openSkillsPicker, openSkillDetailPicker };
}
