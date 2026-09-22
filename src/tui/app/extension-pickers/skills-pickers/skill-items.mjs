// extension-pickers/skills-pickers/skill-items.mjs
// The row shapes of the two skill lists: the Skills list (enable/disable state
// as a marker plus the scope note) and the read-only project-skills list. Both
// render the same empty row when the project ships no skills.
import { withScope } from '../scope-note.mjs';

export const skillDescription = (skill) => `${skill.source || 'skill'} · ${skill.description || skill.filePath || ''}`;

const emptyItem = (label) => ({
  value: 'empty',
  label,
  description: 'no project skills available',
  _action: 'noop',
});

/** Toggle rows: the marker carries the enabled state the keypress flips. */
export const skillItems = (skills, disabledSet, theme) => {
  if (skills.length === 0) return [emptyItem('No skills')];
  return skills.map((skill) => {
    const enabled = !disabledSet.has(skill.name);
    return {
      value: skill.name,
      label: skill.name,
      marker: enabled ? '●' : '○',
      markerColor: enabled ? theme.success : theme.inactive,
      description: withScope(skillDescription(skill), skill),
      _action: 'skill',
      _skill: skill,
      _enabled: enabled,
    };
  });
};

/** Project-skills rows: Enter opens the detail panel, nothing toggles here. */
export const projectSkillItems = (skills) => {
  if (skills.length === 0) return [emptyItem('No project skills')];
  return skills.map((skill) => ({
    value: skill.name,
    label: skill.name,
    description: skillDescription(skill),
    _action: 'view',
    _skill: skill,
  }));
};
