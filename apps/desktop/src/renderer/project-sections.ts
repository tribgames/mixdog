// The Projects rail destination hosts two sections behind one toolbar (the
// Extensions panel's Plugin | Skill grammar): the project list and the
// workflow/agent configuration that used to own its own rail icon.
export const PROJECT_SECTIONS = ['projects', 'workflows'] as const;

export type ProjectsSection = typeof PROJECT_SECTIONS[number];

/** Settings/slash sections that live on the Projects panel's Workflow tab:
 *  /workflow edits packs and agents, /websearch the Web Search route. */
export function projectsSectionForSettings(
  section: string | null | undefined,
): ProjectsSection | null {
  if (section === 'workflow' || section === 'websearch') return 'workflows';
  return null;
}
