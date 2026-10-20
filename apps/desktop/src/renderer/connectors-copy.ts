// "할 수 있는 일" for each catalog connector: plain bullets, one per thing an
// agent can do once the service is connected.
import { t } from './i18n';

const COPY: Record<string, () => string[]> = {
  airtable: () => [t('Reads bases, tables and records.'), t('Adds and updates records.')],
  confluence: () => [t('Searches and reads team pages.'), t('Creates and edits pages.')],
  dropbox: () => [t('Finds and reads files in Dropbox.'), t('Uploads and shares files.')],
  github: () => [t('Works with pull requests, issues and Actions.'), t('Uses your GitHub account for commits.')],
  gmail: () => [t('Searches, reads and organizes your mail.'), t('Sending and Trash ask first.')],
  'google-calendar': () => [t('Lists and searches events.'), t('Creates, changes and deletes events.')],
  'google-drive': () => [t('Finds and reads files Mixdog created or was given.'), t('Creates files and Docs.')],
  'hugging-face': () => [t('Searches models, datasets and Spaces.'), t('Reads model cards and papers.')],
  jira: () => [t('Searches and reads issues.'), t('Creates issues and moves them along.')],
  linear: () => [t('Finds issues, projects and cycles.'), t('Creates, triages and updates issues.')],
  notion: () => [
    t('Reads pages and databases.'),
    t('Creates pages and edits their content.'),
    t('Finds and summarises meeting notes and docs.'),
  ],
  postgres: () => [t('Reads schemas and tables.'), t('Runs SQL queries on your database.')],
  sentry: () => [t('Reads issues, events and stack traces.'), t('Helps triage production errors.')],
  stripe: () => [t('Looks up customers, payments and invoices.'), t('Issues refunds and manages subscriptions.')],
  supabase: () => [t('Reads tables and runs SQL.'), t('Manages auth, storage and edge functions.')],
  trello: () => [t('Reads boards, lists and cards.'), t('Creates and moves cards.')],
  vercel: () => [t('Checks projects and deployments.'), t('Reads build and runtime logs.')],
};

export function connectorCanDo(id: string): string[] {
  return COPY[id]?.() ?? [];
}
