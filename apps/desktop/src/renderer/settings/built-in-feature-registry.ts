export type BuiltInFeatureId =
  | 'git'
  | 'memory'
  | 'browser'
  | 'computer'
  | 'office'
  | 'tidy'
  | 'localProvider'
  | 'voice';

export interface BuiltInFeatureDefinition {
  id: BuiltInFeatureId;
  title: string;
  description: string;
  platform?: 'windows';
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
    platform: 'windows',
  },
  {
    id: 'office',
    title: 'Office',
    description: 'Create, review, and edit documents, spreadsheets, and presentations.',
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
    platform: 'windows',
  },
  {
    id: 'voice',
    title: 'Voice transcription',
    description: 'Turn what you say into text and enter it right away.',
  },
];
