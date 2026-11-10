// extension-pickers/skills-pickers/project-skills.mjs
// The read-only project-skills list: Enter opens a skill's detail panel, Esc
// returns to the Skills list.
import { readStatus } from '../scope-note.mjs';
import { projectSkillItems } from './skill-items.mjs';

export function createProjectSkillsPicker({
  store,
  surface,
  setProviderPrompt,
  setSettingsPrompt,
  openSkillDetailPicker,
  reopenSkills,
}) {
  return async () => {
    const own = surface.claim();
    const status = await readStatus(store, 'skillsStatus', 'skills', 'skills status');
    if (!status) return;
    const items = projectSkillItems(status.skills);
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
        reopenSkills();
      },
    });
  };
}
