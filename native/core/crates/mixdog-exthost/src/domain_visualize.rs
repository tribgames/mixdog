//! The `visualize/command` domain: the visualize panel's tab commands (activate, close, version,
//! restore, network, reopen, render, blocked, history, export, thumbnail), validated exactly as the
//! desktop's `requiredVisualizeTabCommand` did (`ipc-validation.ts`) and forwarded to the host as
//! `host/visualize/command{action, input}`. A paired phone (relay origin) is held to the extra
//! limits and the narrower answer of `remote-visualize.ts`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::DomainService;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_js::js_trim as trim_js;
use mixdog_js::slice_utf16;
use mixdog_js::utf16_len as len16;
use mixdog_protocol::Origin;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::host_forward::forward;

const ACTIONS: &str = "visualize command action must be activate, close, version, restore, network, reopen, render, blocked, history, export, or thumbnail.";
const INLINE_KINDS: [&str; 5] = ["mermaid", "svg", "chart", "html", "markdown"];
const MAX_INLINE_SOURCE: usize = 512 * 1024;
const MAX_SESSION_ID: usize = 256;
const THUMBNAIL_PREFIX: &str = "data:image/png;base64,";
const THUMBNAIL_MAX_BYTES: usize = 60 * 1024;

/// A rejected command; the text is the one the desktop's `TypeError` carried.
type Invalid = &'static str;
type Checked<T> = Result<T, String>;

/// `Number.isInteger` on a JSON value.
fn integer(value: &Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        return Some(n);
    }
    let f = value.as_f64()?;
    (f.is_finite() && f.fract() == 0.0 && f.abs() < 9.0e15).then_some(f as i64)
}

fn required_string(value: Option<&Value>, name: &str, maximum: usize) -> Checked<String> {
    let Some(Value::String(text)) = value else {
        return Err(format!("{name} must be a string."));
    };
    let text = trim_js(text);
    if text.is_empty() || len16(text) > maximum {
        return Err(format!("{name} is invalid."));
    }
    Ok(text.to_owned())
}

fn required_session_id(value: Option<&Value>) -> Checked<String> {
    let Some(Value::String(text)) = value else {
        return Err("session id must be a string.".to_owned());
    };
    let id = trim_js(text);
    let pattern = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if id.is_empty() || len16(id) > MAX_SESSION_ID || !pattern {
        return Err("session id is invalid.".to_owned());
    }
    Ok(id.to_owned())
}

fn pane_index(value: Option<&Value>) -> Checked<i64> {
    value
        .and_then(integer)
        .filter(|n| (0..=15).contains(n))
        .ok_or_else(|| "visualize pane index is invalid.".to_owned())
}

fn version_number(value: Option<&Value>) -> Checked<i64> {
    value
        .and_then(integer)
        .filter(|n| (1..=1_000_000_000).contains(n))
        .ok_or_else(|| "visualize version must be a positive integer.".to_owned())
}

/// A URL scheme prefix such as `https://`.
fn has_url_scheme(target: &str) -> bool {
    let Some(end) = target.find("://") else { return false };
    let scheme = &target[..end];
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// The renderer's command, validated: `{ sessionId, tabId, action, ... }` with only the fields the
/// action carries.
pub fn required_tab_command(value: &Value) -> Checked<Map<String, Value>> {
    let empty = Map::new();
    let command = value.as_object().unwrap_or(&empty);
    let action = match command.get("action").and_then(Value::as_str) {
        Some(
            a @ ("activate" | "close" | "version" | "restore" | "network" | "reopen" | "render" | "blocked"
            | "history" | "export" | "thumbnail"),
        ) => a,
        _ => return Err(ACTIONS.to_owned()),
    };
    let mut out = Map::new();
    let session = required_session_id(command.get("sessionId"))?;
    if action == "history" {
        out.insert("sessionId".into(), json!(session));
        out.insert("tabId".into(), json!(""));
        out.insert("action".into(), json!(action));
        out.insert("entry".into(), json!(required_string(command.get("entry"), "visualize history entry", 64)?));
        return Ok(out);
    }
    out.insert("sessionId".into(), json!(session));
    out.insert("tabId".into(), json!(required_string(command.get("tabId"), "visualize tab id", 64)?));
    out.insert("action".into(), json!(action));
    match action {
        "export" => {
            let format = command.get("format").and_then(Value::as_str);
            if !matches!(format, Some("png" | "pdf" | "project")) {
                return Err("visualize export format must be png, pdf, or project.".to_owned());
            }
            out.insert("format".into(), json!(format));
            if command.contains_key("pane") {
                out.insert("pane".into(), json!(pane_index(command.get("pane"))?));
            }
        }
        "reopen" => reopen(&mut out, command)?,
        "network" => {
            let Some(Value::Bool(allow)) = command.get("allow") else {
                return Err("visualize network allow must be a boolean.".to_owned());
            };
            out.insert("allow".into(), json!(allow));
        }
        "version" => {
            if command.get("compare").is_some_and(|c| !c.is_boolean()) {
                return Err("visualize compare must be a boolean.".to_owned());
            }
            let version = match command.get("version") {
                Some(Value::Null) => Value::Null,
                other => json!(version_number(other)?),
            };
            out.insert("version".into(), version);
            if command.get("compare") == Some(&Value::Bool(true)) {
                out.insert("compare".into(), json!(true));
            }
        }
        "render" => {
            out.insert("pane".into(), json!(pane_index(command.get("pane"))?));
            let error = command.get("error");
            if error.is_some_and(|e| !e.is_string()) {
                return Err("visualize render error must be text.".to_owned());
            }
            out.insert("renderId".into(), json!(required_string(command.get("renderId"), "visualize render id", 128)?));
            if let Some(text) = error.and_then(Value::as_str).filter(|t| !t.is_empty()) {
                out.insert("error".into(), json!(slice_utf16(text, 4000)));
            }
        }
        "blocked" => {
            out.insert("pane".into(), json!(pane_index(command.get("pane"))?));
            let resource = command.get("resource").and_then(Value::as_str);
            if !resource.is_some_and(|r| (1..=24).contains(&r.len()) && r.chars().all(|c| c.is_ascii_alphabetic())) {
                return Err("visualize blocked resource is invalid.".to_owned());
            }
            out.insert("url".into(), json!(required_string(command.get("url"), "visualize blocked url", 2048)?));
            out.insert("resource".into(), json!(resource));
        }
        "restore" => {
            let assets = command.get("assets");
            let bad = |a: &Value| {
                a.as_array().is_none_or(|list| {
                    list.len() > 64 || list.iter().any(|r| r.as_str().is_none_or(|s| s.is_empty() || len16(s) > 1024))
                })
            };
            if assets.is_some_and(bad) {
                return Err("visualize restore assets must be a list of file paths.".to_owned());
            }
            out.insert("version".into(), json!(version_number(command.get("version"))?));
            if let Some(list) = assets.and_then(Value::as_array).filter(|l| !l.is_empty()) {
                out.insert("assets".into(), Value::Array(list.clone()));
            }
        }
        "thumbnail" => {
            let version = command.get("version").and_then(integer).filter(|n| (0..=1_000_000).contains(n));
            out.insert(
                "version".into(),
                json!(version.ok_or_else(|| "visualize thumbnail version is invalid.".to_owned())?),
            );
        }
        _ => {}
    }
    Ok(out)
}

/// A closed tab's file targets (1-3 paths, never URLs), or the inline content it showed.
fn reopen(out: &mut Map<String, Value>, command: &Map<String, Value>) -> Checked<()> {
    let label_text = command.get("label").and_then(Value::as_str).filter(|l| !l.is_empty());
    let label_bad = command.get("label").is_some_and(|l| l.as_str().is_none_or(|s| len16(s) > 120));
    if let Some(content) = command.get("content") {
        let empty = Map::new();
        let item = content.as_object().unwrap_or(&empty);
        let kind = item.get("kind").and_then(Value::as_str).filter(|k| INLINE_KINDS.contains(k));
        let source = item.get("source").and_then(Value::as_str).filter(|s| len16(s) <= MAX_INLINE_SOURCE);
        let title_bad = item.get("title").is_some_and(|t| t.as_str().is_none_or(|s| len16(s) > 120));
        let (Some(kind), Some(source), false, false) = (kind, source, title_bad, label_bad) else {
            return Err("visualize reopen content is invalid.".to_owned());
        };
        out.insert("targets".into(), json!([]));
        let mut inline = Map::new();
        inline.insert("kind".into(), json!(kind));
        inline.insert("source".into(), json!(source));
        if let Some(title) = item.get("title").and_then(Value::as_str).filter(|t| !t.is_empty()) {
            inline.insert("title".into(), json!(title));
        }
        out.insert("content".into(), Value::Object(inline));
    } else {
        let targets = command.get("targets").and_then(Value::as_array);
        let valid = targets.is_some_and(|list| {
            (1..=3).contains(&list.len())
                && list.iter().all(|t| {
                    t.as_str().is_some_and(|s| !trim_js(s).is_empty() && len16(s) <= 4096 && !has_url_scheme(s))
                })
        });
        if !valid {
            return Err("visualize reopen targets must be 1-3 file paths.".to_owned());
        }
        if label_bad {
            return Err("visualize reopen label is invalid.".to_owned());
        }
        out.insert("targets".into(), Value::Array(targets.cloned().unwrap_or_default()));
    }
    if let Some(label) = label_text {
        out.insert("label".into(), json!(label));
    }
    Ok(())
}

/// `visualizeThumbnail`: the data URL when it is a PNG within the size cap, else empty.
fn thumbnail(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let data = text.strip_prefix(THUMBNAIL_PREFIX)?;
    let body = data.trim_end_matches('=');
    let padding = data.len() - body.len();
    let valid = !body.is_empty()
        && padding <= 2
        && body.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/');
    (valid && data.len() * 3 / 4 <= THUMBNAIL_MAX_BYTES).then(|| text.to_owned())
}

pub struct VisualizeService {
    channel: Arc<dyn HostChannel>,
}

impl VisualizeService {
    /// Commands go to the desktop that claimed the host role and declared `visualize`.
    pub fn new(channel: Arc<dyn HostChannel>) -> Self {
        Self { channel }
    }
}

fn invalid(message: Invalid) -> CoreError {
    CoreError::InvalidParams { path: "params".into(), expected: message.into() }
}

#[async_trait]
impl DomainService for VisualizeService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        if req.method.as_str() != "visualize/command" {
            return Err(CoreError::InvalidParams { path: "method".into(), expected: "visualize/command".into() });
        }
        let action = req
            .params
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| CoreError::InvalidParams { path: "action".into(), expected: "a string".into() })?;
        let mut fields = req.params.get("input").and_then(Value::as_object).cloned().unwrap_or_default();
        fields.insert("action".into(), json!(action));
        let valid = required_tab_command(&Value::Object(fields))
            .map_err(|message| CoreError::InvalidParams { path: "params".into(), expected: message.into() })?;
        let relay = req.ctx.origin == Origin::Relay;
        // Outside network for a page is the desktop user's decision alone.
        if relay && action == "network" {
            return Err(invalid("Outside network can only be allowed on the desktop."));
        }
        // PNG / PDF exports use the desktop's save dialog; saving into the project stays on the host.
        if relay && action == "export" && valid.get("format") != Some(&json!("project")) {
            return Err(invalid("This export is only available in the desktop window."));
        }
        let mut input = valid.clone();
        input.remove("action");
        let sent = json!({ "action": action, "input": input });
        let result = forward(&*self.channel, HostCapability::Visualize, "visualize", "host/visualize/command", sent).await?;
        if !relay {
            return Ok(Reply::Value(result));
        }
        // A phone gets only the outcome it may use: a thumbnail, or an export's project path.
        let answer = match action {
            "thumbnail" => thumbnail(result.get("thumbnail")).map_or(Value::Null, |t| json!({ "thumbnail": t })),
            "export" => match result.get("path").and_then(Value::as_str) {
                Some(path) if result.get("openable") == Some(&Value::Bool(true)) => {
                    json!({ "path": path, "openable": true })
                }
                Some(path) => json!({ "path": path }),
                None => Value::Null,
            },
            _ => Value::Null,
        };
        Ok(Reply::Value(answer))
    }

    fn methods(&self) -> &'static [&'static str] {
        &["visualize/command"]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::call::CallContext;
    use mixdog_core_api::mock::MockHostChannel;
    use tokio_util::sync::CancellationToken;

    use super::*;

    fn check(command: Value) -> Result<Value, String> {
        required_tab_command(&command).map(Value::Object)
    }

    fn base(extra: Value) -> Value {
        let mut command = json!({ "sessionId": "session-1", "tabId": "v2" });
        command.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        command
    }

    #[test]
    fn each_action_keeps_only_its_own_fields() {
        assert_eq!(
            check(base(json!({ "action": "close", "stray": 1 }))).unwrap(),
            json!({ "sessionId": "session-1", "tabId": "v2", "action": "close" })
        );
        assert_eq!(
            check(json!({ "sessionId": "s", "action": "history", "entry": " e ", "tabId": "ignored" })).unwrap(),
            json!({ "sessionId": "s", "tabId": "", "action": "history", "entry": "e" })
        );
        assert_eq!(
            check(base(json!({ "action": "version", "version": null, "compare": true }))).unwrap()["compare"],
            json!(true)
        );
        assert_eq!(check(base(json!({ "action": "version", "version": 3 }))).unwrap()["version"], json!(3));
        assert_eq!(
            check(base(json!({ "action": "render", "pane": 2, "renderId": "r", "error": "x".repeat(5000) })))
                .unwrap()["error"]
                .as_str()
                .unwrap()
                .len(),
            4000
        );
        assert_eq!(
            check(base(json!({ "action": "reopen", "targets": ["a/b.md"], "label": "L" }))).unwrap()["targets"],
            json!(["a/b.md"])
        );
        assert_eq!(
            check(base(json!({ "action": "restore", "version": 2, "assets": [] }))).unwrap().get("assets"),
            None
        );
    }

    #[test]
    fn refusals_carry_the_desktops_own_wording() {
        let say = |c: Value| check(c).unwrap_err();
        assert_eq!(say(json!({ "action": "open" })), ACTIONS);
        assert_eq!(say(json!({ "action": "close", "sessionId": 1 })), "session id must be a string.");
        assert_eq!(say(json!({ "action": "close", "sessionId": "a b" })), "session id is invalid.");
        assert_eq!(say(json!({ "action": "close", "sessionId": "s" })), "visualize tab id must be a string.");
        assert_eq!(say(base(json!({ "action": "close", "tabId": "  " }))), "visualize tab id is invalid.");
        assert_eq!(say(base(json!({ "action": "network" }))), "visualize network allow must be a boolean.");
        assert_eq!(say(base(json!({ "action": "export", "format": "gif" }))), "visualize export format must be png, pdf, or project.");
        assert_eq!(say(base(json!({ "action": "export", "format": "png", "pane": 16 }))), "visualize pane index is invalid.");
        assert_eq!(say(base(json!({ "action": "version", "version": 0 }))), "visualize version must be a positive integer.");
        assert_eq!(say(base(json!({ "action": "version", "version": 1, "compare": "y" }))), "visualize compare must be a boolean.");
        assert_eq!(say(base(json!({ "action": "thumbnail", "version": -1 }))), "visualize thumbnail version is invalid.");
        assert_eq!(say(base(json!({ "action": "blocked", "pane": 0, "url": "u", "resource": "a-b" }))), "visualize blocked resource is invalid.");
        assert_eq!(say(base(json!({ "action": "render", "pane": 0, "renderId": "r", "error": 5 }))), "visualize render error must be text.");
        assert_eq!(say(base(json!({ "action": "reopen", "targets": ["https://x.test/a"] }))), "visualize reopen targets must be 1-3 file paths.");
        assert_eq!(say(base(json!({ "action": "reopen", "targets": ["a"], "label": 5 }))), "visualize reopen label is invalid.");
        assert_eq!(say(base(json!({ "action": "reopen", "content": { "kind": "pdf", "source": "x" } }))), "visualize reopen content is invalid.");
        assert_eq!(say(base(json!({ "action": "restore", "version": 1, "assets": [1] }))), "visualize restore assets must be a list of file paths.");
    }

    #[test]
    fn trimming_follows_javascript_not_rust() {
        let say = |c: Value| check(c).unwrap_err();
        // U+0085 is Rust whitespace but not JavaScript's, so it is not trimmed away.
        assert_eq!(say(json!({ "action": "close", "sessionId": "\u{85}s\u{85}" })), "session id is invalid.");
        assert_eq!(
            check(json!({ "action": "close", "sessionId": "\u{feff}s\u{a0}", "tabId": "\u{85}t" })).unwrap()["tabId"],
            "\u{85}t"
        );
        assert_eq!(check(json!({ "action": "close", "sessionId": "\u{feff}s\u{a0}", "tabId": "t" })).unwrap()["sessionId"], "s");
    }

    fn request(origin: Origin, params: Value) -> CoreRequest {
        let mut ctx = CallContext::connection(ConnectionId(1), origin, CancellationToken::new());
        ctx.origin = origin;
        CoreRequest { method: Method("visualize/command"), params, op: None, ctx }
    }

    fn rig(reply: Value) -> (VisualizeService, Arc<MockHostChannel>) {
        let channel = Arc::new(MockHostChannel::default());
        channel.claim(HostCapability::Visualize);
        channel.reply(Method("host/visualize/command"), reply);
        (VisualizeService::new(channel.clone()), channel)
    }

    async fn value(service: &VisualizeService, origin: Origin, params: Value) -> Result<Value, CoreError> {
        match service.call(request(origin, params)).await? {
            Reply::Value(v) => Ok(v),
            Reply::Subscribe(_) => panic!("a value reply"),
        }
    }

    #[tokio::test]
    async fn the_desktop_gets_the_validated_command_and_its_raw_answer() {
        let (service, channel) = rig(json!({ "anything": true }));
        let params = json!({ "action": "close", "input": { "sessionId": "s", "tabId": "t", "stray": 1 } });
        assert_eq!(value(&service, Origin::Local, params).await.unwrap(), json!({ "anything": true }));
        assert_eq!(channel.sent()[0].2, json!({ "action": "close", "input": { "sessionId": "s", "tabId": "t" } }));
        let bad = json!({ "action": "close", "input": { "sessionId": "s" } });
        assert!(matches!(value(&service, Origin::Local, bad).await, Err(CoreError::InvalidParams { .. })));
        assert_eq!(channel.sent().len(), 1, "an invalid command never reaches the host");
    }

    #[tokio::test]
    async fn a_phone_cannot_allow_network_or_export_outside_the_project_and_sees_a_narrow_answer() {
        let (service, channel) = rig(json!({}));
        let input = json!({ "sessionId": "s", "tabId": "t" });
        let network = json!({ "action": "network", "input": { "sessionId": "s", "tabId": "t", "allow": true } });
        let CoreError::InvalidParams { expected, .. } = value(&service, Origin::Relay, network.clone()).await.unwrap_err() else {
            panic!("invalid params")
        };
        assert_eq!(&*expected, "Outside network can only be allowed on the desktop.");
        assert!(value(&service, Origin::Local, network).await.is_ok(), "the desktop may");

        let mut png = input.clone();
        png.as_object_mut().unwrap().insert("format".into(), json!("png"));
        let refused = value(&service, Origin::Relay, json!({ "action": "export", "input": png })).await;
        assert!(matches!(refused, Err(CoreError::InvalidParams { .. })));
        assert_eq!(channel.sent().len(), 1, "refused before the host");

        channel.reply(Method("host/visualize/command"), json!({ "path": "out/x.vis", "openable": true, "extra": 1 }));
        let mut project = input.clone();
        project.as_object_mut().unwrap().insert("format".into(), json!("project"));
        assert_eq!(
            value(&service, Origin::Relay, json!({ "action": "export", "input": project })).await.unwrap(),
            json!({ "path": "out/x.vis", "openable": true })
        );

        let png_data = format!("{THUMBNAIL_PREFIX}iVBORw0KGgo=");
        channel.reply(Method("host/visualize/command"), json!({ "thumbnail": png_data, "extra": 1 }));
        let mut thumb = input.clone();
        thumb.as_object_mut().unwrap().insert("version".into(), json!(1));
        assert_eq!(
            value(&service, Origin::Relay, json!({ "action": "thumbnail", "input": thumb.clone() })).await.unwrap(),
            json!({ "thumbnail": png_data })
        );
        channel.reply(Method("host/visualize/command"), json!({ "thumbnail": "data:image/jpeg;base64,AAAA" }));
        assert_eq!(value(&service, Origin::Relay, json!({ "action": "thumbnail", "input": thumb })).await.unwrap(), Value::Null);
        channel.reply(Method("host/visualize/command"), json!({ "x": 1 }));
        assert_eq!(value(&service, Origin::Relay, json!({ "action": "close", "input": input })).await.unwrap(), Value::Null);
    }

    #[test]
    fn thumbnails_need_the_png_data_url_shape_and_the_size_cap() {
        assert!(thumbnail(Some(&json!(format!("{THUMBNAIL_PREFIX}AAAA==")))).is_some());
        assert!(thumbnail(Some(&json!(format!("{THUMBNAIL_PREFIX}AA=A")))).is_none());
        assert!(thumbnail(Some(&json!(format!("{THUMBNAIL_PREFIX}")))).is_none());
        assert!(thumbnail(Some(&json!(format!("{THUMBNAIL_PREFIX}{}", "A".repeat(90_000))))).is_none());
        assert!(thumbnail(Some(&json!(5))).is_none());
    }
}
