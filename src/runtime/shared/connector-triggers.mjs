// Curated selection triggers for catalog connectors (MCP servers). A catalog
// entry carries its line as `trigger`; the deferred-tool manifest lists each
// connected server once as `- mcp__<server id>: <trigger>`, so one line must
// say WHEN to call the server (the user requests it covers, plus a close
// negative where useful), not list its capabilities; plain ASCII English, at
// most CONNECTOR_TRIGGER_MAX_CHARS characters.
export const CONNECTOR_TRIGGER_MAX_CHARS = 100;

export const CONNECTOR_TRIGGERS = Object.freeze({
  // Not a catalog connector (Mixdog uses the signed-in GitHub CLI), but a
  // user-added `github` MCP server still gets this line.
  github: 'GitHub issues, pull requests, Actions runs and repo code search; not local Git history.',
  notion: 'Finding, reading or updating Notion pages, databases and team notes.',
  linear: 'Looking up, creating or triaging Linear issues, projects and cycles.',
  sentry: 'Investigating production errors, stack traces and releases in Sentry.',
  // The line never names an account: that arrives with the server's
  // instructions when its tools are loaded.
  gmail: 'Gmail email: sending, reading, searching or organizing mail.',
  'google-calendar': 'Google Calendar: checking, creating or editing events.',
  'google-drive': 'Google Drive: finding, reading or creating files Mixdog made or was given; not local files.',
  jira: 'Looking up, creating or transitioning Jira tickets, sprints and JQL searches.',
  confluence: 'Searching, reading or editing Confluence wiki pages; not Jira tickets.',
  dropbox: 'Finding, reading, uploading or sharing Dropbox files; not local files.',
  trello: 'Viewing, creating or moving Trello boards, lists and cards.',
  airtable: 'Querying or updating Airtable bases, tables and records.',
  stripe: 'Checking or acting on Stripe payments, invoices, subscriptions and refunds.',
  vercel: 'Checking Vercel deployments, domains, logs and build errors.',
  supabase: 'Working with Supabase Postgres tables, SQL, auth, storage or edge functions.',
  postgres: 'Running SQL or inspecting schemas on a connected PostgreSQL database; not local files.',
  'hugging-face': 'Finding Hugging Face Hub models, datasets, Spaces or papers; not local GGUF setup.',
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
