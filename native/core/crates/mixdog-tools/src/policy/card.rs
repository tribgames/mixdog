//! What an outbound approval card shows: the target, the account it acts as,
//! the editable text and the per-kind details (mail headers, the payment, the
//! delete). Read from the call's arguments; which calls are outbound at all is
//! decided by `Tool::outbound_kind`, never here.

use std::collections::BTreeMap;

use async_trait::async_trait;
use mixdog_core_api::domain::approval::ActionKind;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::action::kind_name;
use mixdog_js::js_trim;
use super::grants::slice_utf16;

const PAYLOAD_FIELDS: [&str; 6] = ["body", "text", "message", "content", "comment", "subject"];
const TARGET_FIELDS: [&str; 9] = [
    "to",
    "recipient",
    "recipients",
    "channel",
    "channel_id",
    "chat_id",
    "thread",
    "url",
    "page",
];
const PAYLOAD_LIMIT: usize = 40_000;
const MCP_PREFIX: &str = "mcp__";

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct OutboundCard {
    pub category: ActionKind,
    pub tool: String,
    pub target: String,
    pub account: String,
    pub payload: String,
    pub editable: Vec<String>,
    pub details: BTreeMap<String, String>,
}

impl OutboundCard {
    pub fn to_json(&self) -> Value {
        json!({
            "category": kind_name(self.category),
            "target": self.target,
            "account": self.account,
            "payload": self.payload,
            "editable": self.editable,
            "details": self.details,
        })
    }

    /// The card of `tool` called with `args` as an outbound `category`. An MCP
    /// tool (`mcp__<server>__<tool>`) is shown by its server; a built-in one
    /// is shown as a repository target.
    pub fn build(tool: &str, args: &Value, category: ActionKind) -> Self {
        let empty = Map::new();
        let input = args.as_object().unwrap_or(&empty);
        match tool.strip_prefix(MCP_PREFIX) {
            Some(rest) => Self::mcp(tool, rest.split("__").next().unwrap_or(""), input, category),
            None => Self::builtin(tool, input, category),
        }
    }

    fn builtin(tool: &str, input: &Map<String, Value>, category: ActionKind) -> Self {
        let action = input.get("action").and_then(Value::as_str);
        let repo = truthy_text(input.get("repo")).unwrap_or_else(|| "(current project)".into());
        let number = match input.get("number") {
            None | Some(Value::Null) => "?".to_owned(),
            Some(value) => js_string(value),
        };
        let (payload, editable) = payload_of(input, &["body"]);
        Self {
            category,
            tool: match action {
                Some(action) => format!("{tool}:{action}"),
                None => tool.to_owned(),
            },
            target: format!("{repo}#{number}"),
            account: truthy_text(input.get("hostname")).unwrap_or_else(|| "github.com".into()),
            payload,
            editable,
            details: BTreeMap::new(),
        }
    }

    fn mcp(tool: &str, server: &str, input: &Map<String, Value>, category: ActionKind) -> Self {
        let details = details_of(category, input);
        let spends = matches!(category, ActionKind::Payment | ActionKind::Delete);
        let target = match category {
            ActionKind::Payment => details.get("merchant").cloned().filter(|v| !v.is_empty()),
            ActionKind::Trash => first_of(input, &["ids"]),
            ActionKind::Delete => first_of(
                input,
                &["path", "name", "folder", "paths", "ids", "file_ids"],
            ),
            _ => None,
        }
        .unwrap_or_else(|| mcp_target(input, server));
        let account = match category {
            ActionKind::Email => first_of(input, &["from", "account"]),
            _ => None,
        }
        .unwrap_or_else(|| server.to_owned());
        let (payload, editable) = if spends || category == ActionKind::Trash {
            (String::new(), Vec::new())
        } else {
            payload_of(input, &PAYLOAD_FIELDS)
        };
        Self {
            category,
            tool: tool.to_owned(),
            target,
            account,
            payload,
            editable,
            details,
        }
    }
}

/// A connector that can say more about the call (whose account it is, what a
/// message id stands for) adds it to the card. Never changes what is approved.
#[async_trait]
pub trait CardEnricher: Send + Sync {
    async fn enrich(&self, tool: &str, args: &Value, card: &mut OutboundCard);
}

/// `args` with the card's edited fields in place of the model's; only the
/// card's `editable` fields can change.
pub fn apply_edited_args(
    args: &Value,
    edited: &BTreeMap<String, String>,
    editable: &[String],
) -> Value {
    let edits: Vec<(&String, String)> = editable
        .iter()
        .filter_map(|name| {
            edited
                .get(name)
                .map(|value| (name, slice_utf16(value, PAYLOAD_LIMIT)))
        })
        .collect();
    if edits.is_empty() {
        return args.clone();
    }
    let mut out = args.as_object().cloned().unwrap_or_default();
    for (name, value) in edits {
        out.insert(name.clone(), Value::String(value));
    }
    Value::Object(out)
}

fn payload_of(input: &Map<String, Value>, fields: &[&str]) -> (String, Vec<String>) {
    let editable: Vec<String> = fields
        .iter()
        .filter(|name| input.get(**name).is_some_and(Value::is_string))
        .map(|name| (*name).to_owned())
        .collect();
    let payload = editable
        .first()
        .and_then(|name| input.get(name))
        .and_then(Value::as_str)
        .map(|text| slice_utf16(text, PAYLOAD_LIMIT))
        .unwrap_or_default();
    (payload, editable)
}

/// JavaScript `String(value)` for the scalar and array shapes arguments carry.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => String::new(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

fn truthy_text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// The first field holding a non-blank string, a finite number or a non-empty
/// list (joined by `, `).
fn first_of(input: &Map<String, Value>, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| match input.get(*name)? {
        Value::String(text) if !js_trim(text).is_empty() => Some(js_trim(text).to_owned()),
        Value::Number(number) => Some(number.to_string()),
        Value::Array(items) if !items.is_empty() => {
            Some(items.iter().map(js_string).collect::<Vec<_>>().join(", "))
        }
        _ => None,
    })
}

fn details_of(category: ActionKind, input: &Map<String, Value>) -> BTreeMap<String, String> {
    let lines: Vec<(&str, Option<String>)> = match category {
        ActionKind::Email => vec![
            ("to", first_of(input, &["to", "recipient", "recipients"])),
            ("cc", first_of(input, &["cc"])),
            ("subject", first_of(input, &["subject"])),
        ],
        ActionKind::Payment => vec![
            (
                "merchant",
                first_of(
                    input,
                    &["merchant", "payee", "vendor", "seller", "recipient", "to", "description"],
                ),
            ),
            ("amount", first_of(input, &["amount", "price", "total", "value"])),
            (
                "currency",
                first_of(input, &["currency"]).map(|text| text.to_uppercase()),
            ),
            (
                "recurrence",
                first_of(input, &["recurrence", "interval", "frequency", "billing_cycle"]),
            ),
        ],
        ActionKind::Trash => vec![(
            "count",
            Some(list_len(input.get("ids")).unwrap_or(1).to_string()),
        )],
        ActionKind::Delete => {
            let listed = ["ids", "paths", "files", "file_ids", "items"]
                .iter()
                .find_map(|name| list_len(input.get(*name)));
            vec![
                (
                    "count",
                    first_of(input, &["count"]).or(Some(listed.unwrap_or(1).to_string())),
                ),
                ("size", first_of(input, &["size", "total_size", "bytes"])),
            ]
        }
        _ => Vec::new(),
    };
    lines
        .into_iter()
        .filter_map(|(name, value)| Some((name.to_owned(), value.filter(|v| !v.is_empty())?)))
        .collect()
}

fn list_len(value: Option<&Value>) -> Option<usize> {
    value.and_then(Value::as_array).map(Vec::len)
}

fn mcp_target(input: &Map<String, Value>, server: &str) -> String {
    let part = |name: &str| truthy_text(input.get(name));
    let repo: Vec<String> = ["owner", "repo"].iter().filter_map(|name| part(name)).collect();
    let repo = repo.join("/");
    if !repo.is_empty() {
        let number = ["issue_number", "pull_number", "number"]
            .iter()
            .find_map(|name| input.get(*name).filter(|v| !v.is_null()));
        return match number {
            Some(number) => format!("{repo}#{}", js_string(number)),
            None => repo,
        };
    }
    TARGET_FIELDS
        .iter()
        .find_map(|name| match input.get(*name)? {
            Value::String(text) if !js_trim(text).is_empty() => Some(js_trim(text).to_owned()),
            Value::Array(items) if !items.is_empty() => {
                Some(items.iter().map(js_string).collect::<Vec<_>>().join(", "))
            }
            _ => None,
        })
        .unwrap_or_else(|| server.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression: blank means JavaScript's `trim()`: U+FEFF is white space, U+0085 is not.
    #[test]
    fn blank_text_is_judged_by_javascript_trim() {
        let input = json!({"a": "\u{feff} \u{a0}", "b": "\u{85}x\u{feff}"});
        let input = input.as_object().expect("object");
        assert_eq!(first_of(input, &["a"]), None);
        assert_eq!(first_of(input, &["b"]), Some("\u{85}x".to_owned()));
    }

    /// Regression: the payload limit counts UTF-16 units like `String.prototype.slice`.
    #[test]
    fn the_payload_limit_counts_utf16_units() {
        // 20_001 emoji are 40_002 units: 20_000 whole emoji fit in 40_000, and the 20_001st is cut.
        let body = "😀".repeat(20_001);
        let (payload, _) = payload_of(json!({"body": body}).as_object().expect("object"), &["body"]);
        assert_eq!(payload, "😀".repeat(20_000));
        let edited = BTreeMap::from([("body".to_owned(), "😀".repeat(201))]);
        let out = apply_edited_args(&json!({"body": "x"}), &edited, &["body".to_owned()]);
        assert_eq!(out["body"], "😀".repeat(201));
    }

    #[test]
    fn a_github_comment_card_names_repo_number_account_and_the_body() {
        let card = OutboundCard::build(
            "github",
            &json!({"action": "pr.comment", "repo": "o/r", "number": 7, "body": "LGTM"}),
            ActionKind::Comment,
        );
        assert_eq!(card.tool, "github:pr.comment");
        assert_eq!(card.target, "o/r#7");
        assert_eq!(card.account, "github.com");
        assert_eq!(card.payload, "LGTM");
        assert_eq!(card.editable, ["body"]);
        assert!(card.details.is_empty());
        let bare = OutboundCard::build("github", &json!({"action": "issue.comment"}), ActionKind::Comment);
        assert_eq!(bare.target, "(current project)#?");
    }

    #[test]
    fn a_mail_card_carries_headers_and_the_editable_fields() {
        let card = OutboundCard::build(
            "mcp__gmail__send_email",
            &json!({"to": "a@b.c", "cc": ["d@e.f"], "subject": "s", "body": "b"}),
            ActionKind::Email,
        );
        assert_eq!(card.target, "a@b.c");
        assert_eq!(card.account, "gmail");
        assert_eq!(card.editable, ["body", "subject"]);
        assert_eq!(card.payload, "b");
        assert_eq!(
            card.details,
            BTreeMap::from([
                ("to".into(), "a@b.c".into()),
                ("cc".into(), "d@e.f".into()),
                ("subject".into(), "s".into()),
            ])
        );
    }

    #[test]
    fn a_payment_card_shows_the_merchant_and_cannot_be_edited() {
        let card = OutboundCard::build(
            "mcp__stripe__create_payment",
            &json!({"amount": 12900, "currency": "krw", "merchant": "Notion Labs", "interval": "monthly"}),
            ActionKind::Payment,
        );
        assert_eq!(card.target, "Notion Labs");
        assert_eq!(
            card.details,
            BTreeMap::from([
                ("merchant".into(), "Notion Labs".into()),
                ("amount".into(), "12900".into()),
                ("currency".into(), "KRW".into()),
                ("recurrence".into(), "monthly".into()),
            ])
        );
        assert!(card.editable.is_empty() && card.payload.is_empty());
    }

    #[test]
    fn a_delete_card_counts_the_listed_items() {
        let card = OutboundCard::build(
            "mcp__drive__delete_permanently",
            &json!({"file_ids": ["a", "b", "c"]}),
            ActionKind::Delete,
        );
        assert_eq!(card.details, BTreeMap::from([("count".into(), "3".into())]));
        assert_eq!(card.target, "a, b, c");
        let single = OutboundCard::build("mcp__drive__delete_file", &json!({"permanent": true}), ActionKind::Delete);
        assert_eq!(single.details["count"], "1");
        assert_eq!(single.target, "drive");
    }

    #[test]
    fn a_trash_card_lists_ids_and_counts() {
        let card = OutboundCard::build("mcp__gmail__trash_emails", &json!({"ids": ["m1", "m2"]}), ActionKind::Trash);
        assert_eq!(card.target, "m1, m2");
        assert_eq!(card.details["count"], "2");
    }

    #[test]
    fn repository_arguments_make_an_mcp_target() {
        let card = OutboundCard::build(
            "mcp__github__add_issue_comment",
            &json!({"owner": "o", "repo": "r", "issue_number": 4, "body": "x"}),
            ActionKind::Comment,
        );
        assert_eq!(card.target, "o/r#4");
        let chat = OutboundCard::build("mcp__slack__send_message", &json!({"channel": "#dev", "text": "hi"}), ActionKind::Message);
        assert_eq!(chat.target, "#dev");
        assert_eq!(chat.editable, ["text"]);
    }

    #[test]
    fn edits_replace_only_editable_string_fields() {
        let args = json!({"action": "issue.comment", "repo": "o/r", "number": 3, "body": "draft"});
        let edited = BTreeMap::from([
            ("body".to_owned(), "final text".to_owned()),
            ("repo".to_owned(), "evil/x".to_owned()),
        ]);
        let got = apply_edited_args(&args, &edited, &["body".to_owned()]);
        assert_eq!(
            got,
            json!({"action": "issue.comment", "repo": "o/r", "number": 3, "body": "final text"})
        );
        assert_eq!(apply_edited_args(&args, &edited, &[]), args);
    }
}
