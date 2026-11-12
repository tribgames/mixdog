//! The mails the core's own Gmail connector read for a session (Node's `isBuiltinMailRead` and the record `dispatch.mjs` makes of
//! its result): the links of such a mail are what Browser Use may open although they carry a token
//! (`mixdog_tools::desktop::mail_links`). Another server's `read_email`, even one marked as the Gmail connector, is only text.

use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_tools::desktop::mail_links;
use url::Url;

use crate::config::McpServerConfig;
use crate::config::TransportConfig;
use crate::connector_model::GMAIL_APP_PASSWORD_URL;

const READ_EMAIL: &str = "read_email";

/// Whether `url` addresses the Gmail app-password server (`gmailAppPasswordService`).
fn is_gmail_app_password(url: &Url) -> bool {
    let own = Url::parse(GMAIL_APP_PASSWORD_URL).ok();
    url.scheme() == "https" && own.is_some_and(|own| url.host_str() == own.host_str() && url.port() == own.port())
}

/// Whether `tool` of the server `config` is the `read_email` of a server the core answers in-process, whose result is a mail as the
/// mailbox holds it.
pub fn is_builtin_mail_read(config: &McpServerConfig, tool: &str) -> bool {
    let (TransportConfig::Http { url, .. } | TransportConfig::Sse { url, .. }) = &config.transport else { return false };
    tool == READ_EMAIL && (is_gmail_app_password(url) || crate::google_mcp::service(url).is_some())
}

/// Records the links of a built-in mail read's `output` for `session`; anything else is left alone.
pub fn record(config: &McpServerConfig, tool: &str, session: &str, output: &ToolOutput, now: i64) {
    if !is_builtin_mail_read(config, tool) {
        return;
    }
    let text: String = output.parts.iter().filter_map(|part| if let ToolPart::Text(text) = part { Some(text.as_str()) } else { None }).collect();
    mail_links::record(session, &text, now);
}
