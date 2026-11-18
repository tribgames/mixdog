//! The links of a mail the core's own Gmail connector read are kept for the session that read it, so Browser Use may open exactly
//! those; another server's `read_email`, and the connector's other tools, leave none.

use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_mcp::McpServerConfig;
use mixdog_mcp::connector_model::GMAIL_APP_PASSWORD_URL;
use mixdog_mcp::mail_reads::is_builtin_mail_read;
use mixdog_mcp::mail_reads::record;
use mixdog_tools::desktop::mail_links::link_for;
use mixdog_tools::desktop::mail_links::now_ms;
use serde_json::json;

const LINK: &str = "https://example.com/confirm?token=abc123";

fn server(entry: serde_json::Value) -> McpServerConfig {
    McpServerConfig::from_entry("mail", &entry, &std::env::vars().collect()).unwrap()
}

/// A `read_email` result: the header line (its authenticated sender and the links the mail holds), a blank line, the body.
fn mail() -> ToolOutput {
    let head = json!({
        "fromAddresses": [{"address": "noreply@example.com"}],
        "authentication": {"dmarc": {"result": "pass", "from": "example.com"}},
        "links": [LINK],
    });
    let mut output = ToolOutput::default();
    output.parts.push(ToolPart::Text(format!("{head}\n\nPlease confirm: {LINK}")));
    output
}

#[test]
fn only_read_email_of_the_cores_own_gmail_connector_is_a_mail_read() {
    let own = server(json!({"url": GMAIL_APP_PASSWORD_URL}));
    assert!(is_builtin_mail_read(&own, "read_email"));
    assert!(!is_builtin_mail_read(&own, "search_emails"), "its other tools are not mail reads");
    assert!(!is_builtin_mail_read(&server(json!({"url": "https://other.example/mcp"})), "read_email"), "another server's read_email is only text");
    assert!(!is_builtin_mail_read(&server(json!({"command": "run"})), "read_email"), "a command server is not the connector");
    // The core answers Google's reserved address in-process as well, so a read through it is a mail as the mailbox holds it.
    assert!(is_builtin_mail_read(&server(json!({"url": "https://gmail.mixdog.invalid/mcp"})), "read_email"));
    // Only over https: a plain-http address of a host that is not loopback is no server at all (config.rs `normalize_url`).
    assert_eq!(
        McpServerConfig::from_entry("mail", &json!({"url": "http://gmail.mixdog.invalid/mcp"}), &std::env::vars().collect()).err(),
        Some(mixdog_mcp::config::ConfigError::InsecureUrl)
    );
}

#[test]
fn a_mail_the_connector_read_leaves_its_authenticated_links_for_that_session_only() {
    let own = server(json!({"url": GMAIL_APP_PASSWORD_URL}));
    let now = now_ms();
    record(&own, "read_email", "mail-read-session-a", &mail(), now);
    let link = link_for("mail-read-session-a", LINK, now).expect("the link of the mail it read");
    assert_eq!((link.url.as_str(), link.from_domain.as_str(), link.read_at), (LINK, "example.com", now));
    assert_eq!(link_for("mail-read-session-b", LINK, now), None, "another session read nothing");
    assert_eq!(link_for("mail-read-session-a", "https://example.com/other", now), None, "only the link the mail holds");
}

#[test]
fn a_read_by_another_server_or_another_tool_leaves_no_link() {
    let now = now_ms();
    record(&server(json!({"url": "https://other.example/mcp"})), "read_email", "mail-read-session-c", &mail(), now);
    record(&server(json!({"url": GMAIL_APP_PASSWORD_URL})), "search_emails", "mail-read-session-d", &mail(), now);
    assert_eq!(link_for("mail-read-session-c", LINK, now), None);
    assert_eq!(link_for("mail-read-session-d", LINK, now), None);
}