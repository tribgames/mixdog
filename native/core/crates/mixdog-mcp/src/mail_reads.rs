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

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/mail-link-navigation/golden.json");

    /// `fixtures/mail-link-navigation`, the dispatch case: of the calls Node's `dispatchToolCall` made, only the built-in Gmail
    /// connector's `read_email` leaves links for the session that read it; another server's `read_email` (even one marked as the
    /// Gmail connector) and the connector's other tools leave none. Servers are the recorded configs, results the recorded texts.
    #[test]
    fn only_the_built_in_gmail_connectors_read_email_records_links_for_its_session() {
        let golden: Value = serde_json::from_str(&GOLDEN).expect("golden.json");
        let case = golden["cases"].as_array().unwrap().iter().find(|case| case["case"].as_str().unwrap().starts_with("only the built-in Gmail connector")).expect("the recorded case");
        let clock = golden["clock"]["dateNow"].as_i64().unwrap();
        let base = mail_links::now_ms();
        let at = |node: &Value| base + node.as_i64().unwrap() - clock;
        let env = std::env::vars().collect();
        let servers: Vec<(String, McpServerConfig)> = case["observed"]["servers"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, entry)| (name.clone(), McpServerConfig::from_entry(name, entry, &env).expect("a recorded server config")))
            .collect();
        let mut probes = 0;
        for op in case["observed"]["ops"].as_array().unwrap() {
            let session = op["session"].as_str().unwrap();
            match op["op"].as_str().unwrap() {
                "dispatch" => {
                    let qualified = op["name"].as_str().unwrap();
                    let [_, server, tool] = qualified.splitn(3, "__").collect::<Vec<_>>()[..] else { panic!("{qualified}") };
                    let (_, config) = servers.iter().find(|(name, _)| name == server).expect("a registered server");
                    let output = ToolOutput { parts: vec![ToolPart::Text(op["result"].as_str().unwrap().to_owned())], ..ToolOutput::default() };
                    record(config, tool, session, &output, at(&op["at"]));
                }
                "probe" => {
                    probes += 1;
                    let got = mail_links::link_for(session, op["url"].as_str().unwrap(), at(&op["at"]));
                    let want = (!op["link"].is_null()).then(|| (op["link"]["url"].as_str().unwrap(), op["link"]["from_domain"].as_str().unwrap(), at(&op["link"]["read_at"])));
                    assert_eq!(got.as_ref().map(|link| (link.url.as_str(), link.from_domain.as_str(), link.read_at)), want, "{}: {}", session, op["why"]);
                }
                other => panic!("unexpected recorded operation {other}"),
            }
        }
        assert_eq!(probes, 6);
    }
}
