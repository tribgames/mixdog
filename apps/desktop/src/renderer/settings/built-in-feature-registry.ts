export type BuiltInFeatureId =
  | 'git'
  | 'memory'
  | 'browser'
  | 'computer'
  | 'office'
  | 'localProvider'
  | 'voice';

export interface BuiltInFeatureDefinition {
  id: BuiltInFeatureId;
  title: string;
  description: string;
  group: 'agent' | 'input';
  platform?: 'windows';
  managedInstall?: boolean;
}

export const BUILT_IN_FEATURES: ReadonlyArray<BuiltInFeatureDefinition> = [
  {
    id: 'git',
    title: 'Git & GitHub',
    description: 'Manage changes, repositories, issues, pull requests, Actions, releases, and notifications.',
    group: 'agent',
    managedInstall: true,
  },
  {
    id: 'memory',
    title: 'Memory',
    description: 'Remember important details from conversations and use them when needed.',
    group: 'agent',
  },
  {
    id: 'browser',
    title: 'Browser Use',
    description: 'Sessions share one Browser Use profile, including sign-ins, cookies, and site data.',
    group: 'agent',
  },
  {
    id: 'computer',
    title: 'Computer Use',
    description: 'See your screen and use the mouse and keyboard to complete computer tasks.',
    group: 'agent',
    platform: 'windows',
  },
  {
    id: 'office',
    title: 'Office',
    description: 'Create, review, and edit documents, spreadsheets, and presentations.',
    group: 'agent',
  },
  {
    id: 'localProvider',
    title: 'Local Provider',
    description: 'Run recommended models on this PC without installing another model app.',
    group: 'agent',
    platform: 'windows',
    managedInstall: true,
  },
  {
    id: 'voice',
    title: 'Voice transcription',
    description: 'Turn what you say into text and enter it right away.',
    group: 'input',
    managedInstall: true,
  },
];
