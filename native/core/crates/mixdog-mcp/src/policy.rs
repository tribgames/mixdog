//! The MCP side of the approval pipeline (`mixdog-tools` policy): the per-agent connector
//! permissions (`auto` / `needs_approval` / `disabled`) and the Gmail `describe_emails` preview an
//! outbound mail card shows.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::approval::ActionKind;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_js::js_trim;
use mixdog_js::value_to_string;
use mixdog_protocol::ThreadId;
use mixdog_tools::policy::CardEnricher;
use mixdog_tools::policy::ConnectorPermissions;
use mixdog_tools::policy::OutboundCard;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::hub::McpHub;
use crate::permissions::ConnectorPolicy;
use crate::permissions::Permission;

/// Messages a mail card lists by sender and subject; the rest read "more".
const PREVIEW_MESSAGES: usize = 3;
const GMAIL: &str = "gmail";

#[async_trait]
impl ConnectorPermissions for ConnectorPolicy {
    fn needs_approval(&self, connector_agent_id: &str, tool: &str) -> bool {
        self.permission(connector_agent_id, tool) == Permission::NeedsApproval
    }

    fn disabled(&self, connector_agent_id: &str, tool: &str) -> bool {
        self.permission(connector_agent_id, tool) == Permission::Disabled
    }

    fn project_disabled(&self, thread: &ThreadId, tool: &str) -> bool {
        ConnectorPolicy::project_disabled(self, &self.paths_of(thread), tool)
    }

    async fn allow_always(&self, bot_id: &str, tool: &str) -> bool {
        self.write_permission(bot_id, tool, Permission::Auto).await
    }
}

/// Adds the connected account and the sender, subject and date of the messages a mail or
/// trash call names, read from the Gmail connector's `describe_emails` (a read-only tool the
/// server answers without listing it). Never changes what is approved; any failure leaves the
/// card with what the call itself carries.
pub struct GmailCardEnricher {
    hub: Arc<McpHub>,
}

impl GmailCardEnricher {
    pub fn new(hub: Arc<McpHub>) -> Self {
        Self { hub }
    }

    async fn describe(&self, tool: &str, args: &Value, trash: bool) -> Option<(String, Vec<String>, usize)> {
        let (server, _) = self.hub.resolve(tool)?;
        if server.config().connector.as_deref() != Some(GMAIL) {
            return None;
        }
        let ids: Vec<String> = match args.get("ids").and_then(Value::as_array) {
            Some(list) if trash => list.iter().map(js_string).collect(),
            _ => Vec::new(),
        };
        let shown: Vec<&String> = ids.iter().take(PREVIEW_MESSAGES).collect();
        let mut request = json!({"ids": shown});
        // The account the call acts as (one server holds every Gmail account).
        if let Some(account) = args.get("account").and_then(Value::as_str).map(js_trim).filter(|a| !a.is_empty()) {
            request["account"] = Value::String(account.to_owned());
        }
        let output = server
            .call_tool_unlisted("card:describe_emails", "describe_emails", request, &CancellationToken::new(), None)
            .await
            .ok()?;
        let text: String = output
            .parts
            .iter()
            .filter_map(|p| if let ToolPart::Text(t) = p { Some(t.as_str()) } else { None })
            .collect::<Vec<_>>()
            .join("\n");
        let parsed: Value = serde_json::from_str(&text).ok()?;
        let account = parsed.get("account").map(js_string).unwrap_or_default();
        let messages = parsed
            .get("emails")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|mail| {
                let field = |key: &str| mail.get(key).filter(|v| !v.is_null()).map(js_string).unwrap_or_default();
                let date = mixdog_js::slice_utf16(&field("date"), 10);
                [field("from"), field("subject"), date]
                    .into_iter()
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join(" · ")
            })
            .collect();
        Some((account, messages, ids.len().saturating_sub(shown.len())))
    }
}

/// `String(value ?? '')`.
fn js_string(value: &Value) -> String {
    if value.is_null() { String::new() } else { value_to_string(value) }
}

#[async_trait]
impl CardEnricher for GmailCardEnricher {
    async fn enrich(&self, tool: &str, args: &Value, card: &mut OutboundCard) {
        if !matches!(card.category, ActionKind::Email | ActionKind::Trash) {
            return;
        }
        let Some((account, messages, more)) = self.describe(tool, args, card.category == ActionKind::Trash).await else {
            return;
        };
        if !account.is_empty() {
            card.account = account;
        }
        if !messages.is_empty() {
            card.details.insert("messages".to_owned(), messages.join("\n"));
        }
        if more > 0 {
            card.details.insert("more".to_owned(), more.to_string());
        }
    }
}
