//! Curated selection triggers for catalog connectors. The deferred-tool manifest lists each
//! connected server once as `- mcp__<server id>: <trigger>`, so a line says WHEN to call the
//! server, in plain ASCII English of at most `CONNECTOR_TRIGGER_MAX_CHARS` characters.

pub const CONNECTOR_TRIGGER_MAX_CHARS: usize = 100;

pub const CONNECTOR_TRIGGERS: [(&str, &str); 17] = [
    // Not a catalog connector (the signed-in GitHub CLI is used), but a user-added `github`
    // MCP server still gets this line.
    ("github", "GitHub issues, pull requests, Actions runs and repo code search; not local Git history."),
    ("notion", "Finding, reading or updating Notion pages, databases and team notes."),
    ("linear", "Looking up, creating or triaging Linear issues, projects and cycles."),
    ("sentry", "Investigating production errors, stack traces and releases in Sentry."),
    // The line never names an account: that arrives with the server's instructions.
    ("gmail", "Gmail email: sending, reading, searching or organizing mail."),
    ("google-calendar", "Google Calendar: checking, creating or editing events."),
    ("google-drive", "Google Drive: finding, reading or creating files Mixdog made or was given; not local files."),
    ("jira", "Looking up, creating or transitioning Jira tickets, sprints and JQL searches."),
    ("confluence", "Searching, reading or editing Confluence wiki pages; not Jira tickets."),
    ("dropbox", "Finding, reading, uploading or sharing Dropbox files; not local files."),
    ("trello", "Viewing, creating or moving Trello boards, lists and cards."),
    ("airtable", "Querying or updating Airtable bases, tables and records."),
    ("stripe", "Checking or acting on Stripe payments, invoices, subscriptions and refunds."),
    ("vercel", "Checking Vercel deployments, domains, logs and build errors."),
    ("supabase", "Working with Supabase Postgres tables, SQL, auth, storage or edge functions."),
    ("postgres", "Running SQL or inspecting schemas on a connected PostgreSQL database; not local files."),
    ("hugging-face", "Finding Hugging Face Hub models, datasets, Spaces or papers; not local GGUF setup."),
];

/// Server ids differ only in separators and case (google_calendar, huggingface).
fn trigger_key(id: &str) -> String {
    id.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect()
}

fn lookup(id: &str) -> Option<&'static str> {
    let key = trigger_key(id);
    CONNECTOR_TRIGGERS.iter().find(|(known, _)| trigger_key(known) == key).map(|(_, line)| *line)
}

/// The curated trigger of the catalog connector `server_id`, or "".
pub fn connector_trigger(server_id: &str) -> &'static str {
    if let Some(line) = lookup(server_id) {
        return line;
    }
    // Another account of a connector is named `<id>-2`, `<id>-3`…
    let base = match server_id.rsplit_once(['-', '_']) {
        Some((head, tail)) if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) => head,
        _ => server_id,
    };
    lookup(base).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_line_is_short_ascii() {
        for (id, line) in CONNECTOR_TRIGGERS {
            assert!(line.is_ascii() && line.chars().count() <= CONNECTOR_TRIGGER_MAX_CHARS, "{id}");
        }
    }

    #[test]
    fn ids_match_across_separators_case_and_account_suffix() {
        let calendar = "Google Calendar: checking, creating or editing events.";
        assert_eq!(connector_trigger("google_calendar"), calendar);
        assert_eq!(connector_trigger("Google-Calendar-2"), calendar);
        assert_eq!(connector_trigger("huggingface"), CONNECTOR_TRIGGERS[16].1);
        assert_eq!(connector_trigger("unknown"), "");
        assert_eq!(connector_trigger(""), "");
    }
}
