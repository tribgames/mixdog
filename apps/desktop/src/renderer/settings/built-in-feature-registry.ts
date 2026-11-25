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
    description: 'Manage Git changes, repos, issues, PRs, and Actions.',
  },
  {
    id: 'memory',
    title: 'Memory',
    description: 'Remember key details across chats and recall them.',
  },
  {
    id: 'browser',
    title: 'Browser Use',
    description: 'Shared browser profile for logins, cookies, and data.',
  },
  {
    id: 'computer',
    title: 'Computer Use',
    description: 'View your screen and control mouse and keyboard.',
  },
  {
    id: 'office',
    title: 'Office',
    description: 'Create and edit documents, sheets, and slides.',
  },
  {
    id: 'media',
    title: 'Media generation',
    description: 'Create images and videos in chat.',
  },
  {
    id: 'tidy',
    title: 'Code Tidy',
    description: 'Format, lint, and clean up code automatically.',
  },
  {
    id: 'localProvider',
    title: 'Local Provider',
    description: 'Download AI models and run them directly in Mixdog.',
  },
  {
    id: 'autoEffort',
    title: 'Auto reasoning',
    description: 'Tunes reasoning effort to task difficulty per turn.',
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
