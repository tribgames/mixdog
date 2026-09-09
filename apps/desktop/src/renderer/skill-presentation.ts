import { t } from './i18n';

// UI copy is independent of the model-facing SKILL.md description. Only
// shipped skills use this catalog; external authors retain their own wording.
const DESCRIPTIONS: Record<string, () => string> = {
  'browser-use': () => t('Browse websites and complete tasks using signed-in sessions.'),
  'computer-use': () => t('Operate desktop apps with the mouse and keyboard.'),
  docx: () => t('Create, edit, and review Word documents.'),
  pdf: () => t('Read, create, and edit PDF documents.'),
  xlsx: () => t('Create and analyze spreadsheets and CSV data.'),
  pptx: () => t('Create, edit, and review slide presentations.'),
  image: () => t('Generate and edit still images.'),
  video: () => t('Generate, extend, and animate videos.'),
  'goal-management': () => t('Set and manage ongoing task goals.'),
  'history-recall': () => t('Find information from previous conversations.'),
  'memory-management': () => t('Manage saved user preferences and constraints.'),
  'local-provider': () => t('Download and run AI models on this device.'),
  setup: () => t('Configure models, tools, and application settings.'),
  'skill-creator': () => t('Create, review, and improve reusable skills.'),
};

export function skillDisplayDescription(skill: {
  name?: unknown; description?: unknown; source?: unknown; owner?: unknown;
}): string {
  const owner = skill.owner as { kind?: unknown } | null;
  const native = skill.source === 'builtin' || owner?.kind === 'builtin';
  const name = String(skill.name || '');
  return native && Object.hasOwn(DESCRIPTIONS, name)
    ? DESCRIPTIONS[name]()
    : String(skill.description || '');
}
