export type BuiltInFeatureId =
  | 'git'
  | 'memory'
  | 'browser'
  | 'computer'
  | 'office'
  | 'media'
  | 'tidy'
  | 'localProvider'
  | 'autoEffort'
  | 'visualize'
  | 'voice';

export interface BuiltInFeatureDefinition {
  id: BuiltInFeatureId;
  title: string;
  description: string;
}

export const BUILT_IN_FEATURES: ReadonlyArray<BuiltInFeatureDefinition> = [
  {
    id: 'git',
    title: 'Git & GitHub',
    description: 'Manage changes, repositories, issues, pull requests, Actions, releases, and notifications.',
  },
  {
    id: 'memory',
    title: 'Memory',
    description: 'Remember important details from conversations and use them when needed.',
  },
  {
    id: 'browser',
    title: 'Browser Use',
    description: 'Sessions share one Browser Use profile, including sign-ins, cookies, and site data.',
  },
  {
    id: 'computer',
    title: 'Computer Use',
    description: 'See your screen and use the mouse and keyboard to complete computer tasks.',
  },
  {
    id: 'office',
    title: 'Office',
    description: 'Create, review, and edit documents, spreadsheets, and presentations.',
  },
  {
    id: 'media',
    title: 'Media generation',
    description: 'Create images and videos in chat.',
  },
  {
    id: 'tidy',
    title: 'Code Tidy',
    description: 'Format, lint, and clean up code across languages with auto-detected engines.',
  },
  {
    id: 'localProvider',
    title: 'Local Provider',
    description: 'Download AI models and run them directly in Mixdog.',
  },
  {
    id: 'autoEffort',
    title: 'Auto reasoning',
    description:
      'Adjust the reasoning effort of each turn and each step after tool results to how hard the work is, on models that can change it without breaking the prompt cache.',
  },
  {
    id: 'visualize',
    title: 'Visualize',
    description: 'Show mockups, documents, and other results beside the chat.',
  },
  {
    id: 'voice',
    title: 'Voice transcription',
    description: 'Turn what you say into text and enter it right away.',
  },
];
