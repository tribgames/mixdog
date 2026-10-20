// Curated selection triggers for catalog connectors (MCP servers). A catalog
// entry carries its line as `trigger`; the deferred-tool manifest lists each
// connected server once as `- mcp__<server id>: <trigger>`, so one line must
// say what the connector is for (plus a close negative where useful), in
// English, at most CONNECTOR_TRIGGER_MAX_CHARS characters.
export const CONNECTOR_TRIGGER_MAX_CHARS = 100;

export const CONNECTOR_TRIGGERS = Object.freeze({
  // Not a catalog connector (Mixdog uses the signed-in GitHub CLI), but a
  // user-added `github` MCP server still gets this line.
  github: 'GitHub repos, issues, pull requests, Actions and code search; not local Git history or diffs.',
  notion: 'Notion pages, databases and workspace search; create or update team docs and notes.',
  linear: 'Linear issues, projects, cycles and comments; create, triage or update tickets.',
  sentry: 'Sentry issues, events, stack traces and releases; triage production errors.',
  gmail: 'Gmail: send email; with an app password also search, read, archive, label, star, trash.',
  'google-calendar': 'Google Calendar events on the primary calendar; list, search, create, update or delete.',
  'google-drive': 'Google Drive files Mixdog created or was given; search, read or create; not local files.',
  jira: 'Jira issues, projects, sprints and comments; JQL search, create or transition tickets.',
  confluence: 'Confluence spaces and pages; search, read or edit the team wiki; not Jira tickets.',
  dropbox: 'Dropbox files and folders; search, read, upload or share cloud files; not local files.',
  trello: 'Trello boards, lists and cards; create, move or update cards.',
  airtable: 'Airtable bases, tables and records; query, create or update rows.',
  stripe: 'Stripe customers, payments, invoices, subscriptions and refunds; billing data and actions.',
  vercel: 'Vercel projects, deployments, domains and logs; deploy status and build errors.',
  supabase: 'Supabase projects: Postgres tables and SQL, auth, storage and edge functions.',
  postgres: 'PostgreSQL schemas, tables and SQL queries on a connected database; not local files.',
  'hugging-face': 'Hugging Face Hub models, datasets, Spaces and papers; not local GGUF model setup.',
});

// Server ids differ only in separators and case (google_calendar, huggingface).
const triggerKey = (id) =>
  String(id || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const TRIGGERS_BY_KEY = new Map(Object.entries(CONNECTOR_TRIGGERS).map(([id, line]) => [triggerKey(id), line]));

/** The curated trigger of the catalog connector `serverId`, or ''. */
export function connectorTrigger(serverId) {
  // Another account of a connector is named `<id>-2`, `<id>-3`…
  return (
    TRIGGERS_BY_KEY.get(triggerKey(serverId)) ||
    TRIGGERS_BY_KEY.get(triggerKey(String(serverId || '').replace(/[-_]\d+$/, ''))) ||
    ''
  );
}
