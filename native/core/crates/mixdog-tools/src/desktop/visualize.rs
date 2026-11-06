//! `visualize`: previews and exports in the desktop's panel, over `host/visualize/command`.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use serde_json::Map;
use serde_json::Value;

use crate::orch::util::JsStr;

use super::host::HostCommands;
use super::host::command_error;
use super::pending::PendingWaits;
use crate::orch::util::cancelled;
use crate::orch::util::invalid;
use crate::orch::util::spec_from_def;
use crate::orch::util::text;

const ACTIONS: [&str; 8] = ["open", "close", "annotate", "capture", "export", "check", "inspect", "act"];
const ACT_STEP_KINDS: [&str; 6] = ["click", "type", "key", "scroll", "wait", "evaluate"];
const MAX_ACT_STEPS: usize = 25;
const INLINE_KINDS: [&str; 5] = ["mermaid", "svg", "chart", "html", "markdown"];
const MAX_INLINE_BYTES: usize = 512 * 1024;
const UNAVAILABLE: &str = "visualize is unavailable; the Mixdog desktop app must be running";

fn version_ok(input: &Map<String, Value>) -> bool {
    match input.get("version") {
        None | Some(Value::Null) => true,
        Some(v) => v.as_u64().is_some_and(|n| n >= 1),
    }
}

fn ends_with_ext(value: Option<&Value>, ext: &str) -> bool {
    value.and_then(Value::as_str).is_some_and(|s| s.js_trim().to_lowercase().ends_with(&format!(".{ext}")))
}

fn sized(value: Option<&Value>, min: u64, max: u64) -> bool {
    value.and_then(Value::as_u64).is_some_and(|n| (min..=max).contains(&n))
}

/// The action and input of a `visualize` call, validated with the existing wordings.
pub fn validate(args: &Value) -> Result<(String, Map<String, Value>), String> {
    let object = args.as_object().ok_or("visualize arguments must be an object")?;
    let action = object.get("action").and_then(Value::as_str).filter(|a| ACTIONS.contains(a));
    let Some(action) = action else {
        return Err("action must be open, close, annotate, capture, export, check, inspect, or act".to_owned());
    };
    let input = match object.get("input") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(o)) => o.clone(),
        Some(_) => return Err("input must be an object".to_owned()),
    };
    match action {
        "open" => validate_open(&input)?,
        "inspect" => {
            if let Some(v) = input.get("viewport").filter(|v| !v.is_null()) {
                let ok = v.is_object()
                    && sized(v.get("width"), 200, 3000)
                    && v.get("height").is_none_or(|h| h.is_null() || sized(Some(h), 200, 4000));
                if !ok {
                    return Err("inspect input.viewport must be { width: 200-3000, height?: 200-4000 } in whole pixels".to_owned());
                }
            }
            if let Some(s) = input.get("selector").filter(|s| !s.is_null()) {
                let ok = s.as_str().is_some_and(|s| !s.js_trim().is_empty() && s.js_len() <= 500);
                if !ok {
                    return Err("inspect input.selector must be a non-empty CSS selector of at most 500 characters".to_owned());
                }
            }
        }
        _ => {}
    }
    if ["annotate", "capture", "export", "check", "inspect", "act"].contains(&action)
        && !input.get("tab").and_then(Value::as_str).is_some_and(|t| !t.is_empty())
    {
        return Err(format!("{action} requires input.tab"));
    }
    match action {
        "capture" if !ends_with_ext(input.get("output"), "png") => {
            return Err("capture requires input.output ending in .png".to_owned());
        }
        "act" => {
            let steps = input.get("steps").and_then(Value::as_array).filter(|s| (1..=MAX_ACT_STEPS).contains(&s.len()));
            let Some(steps) = steps else {
                return Err(format!("act requires input.steps: 1-{MAX_ACT_STEPS} steps"));
            };
            let bad = steps
                .iter()
                .position(|s| !s.get("do").and_then(Value::as_str).is_some_and(|d| ACT_STEP_KINDS.contains(&d)));
            if let Some(bad) = bad {
                return Err(format!("act input.steps[{bad}].do must be click, type, key, scroll, wait, or evaluate"));
            }
            if input.get("output").is_some_and(|o| !o.is_null()) && !ends_with_ext(input.get("output"), "png") {
                return Err("act input.output must end in .png".to_owned());
            }
        }
        "export" => {
            let format = input.get("format").and_then(Value::as_str).filter(|f| *f == "png" || *f == "pdf");
            let Some(format) = format else {
                return Err("export requires input.format png or pdf".to_owned());
            };
            if !ends_with_ext(input.get("output"), format) {
                return Err(format!("export requires input.output ending in .{format}"));
            }
            if !version_ok(&input) {
                return Err("export input.version must be a positive integer (a kept version number)".to_owned());
            }
            if input.get("overwrite").is_some_and(|o| !o.is_null() && !o.is_boolean()) {
                return Err("export input.overwrite must be a boolean".to_owned());
            }
        }
        _ => {}
    }
    Ok((action.to_owned(), input))
}

fn validate_open(input: &Map<String, Value>) -> Result<(), String> {
    if input.get("verify").is_some_and(|v| !v.is_null() && !v.is_boolean()) {
        return Err("open input.verify must be a boolean".to_owned());
    }
    const VERSION: &str = "open input.version must be a positive integer (a kept version number)";
    if let Some(content) = input.get("content").filter(|c| !c.is_null()) {
        if input.get("targets").is_some_and(|t| !t.is_null()) {
            return Err("open takes either input.targets or input.content, not both".to_owned());
        }
        let Some(content) = content.as_object() else {
            return Err("open input.content must be { kind, source, title? }".to_owned());
        };
        if !content.get("kind").and_then(Value::as_str).is_some_and(|k| INLINE_KINDS.contains(&k)) {
            return Err(format!("open input.content.kind must be one of {}", INLINE_KINDS.join(", ")));
        }
        let source = content.get("source").and_then(Value::as_str).filter(|s| !s.js_trim().is_empty());
        let Some(source) = source else {
            return Err("open input.content.source must be a non-empty string".to_owned());
        };
        if source.len() > MAX_INLINE_BYTES {
            return Err(format!("open input.content.source must be at most {} KiB", MAX_INLINE_BYTES / 1024));
        }
        if content.get("title").is_some_and(|t| !t.is_null() && !t.is_string()) {
            return Err("open input.content.title must be a string".to_owned());
        }
        if !version_ok(input) {
            return Err(VERSION.to_owned());
        }
        return Ok(());
    }
    let targets = input
        .get("targets")
        .and_then(Value::as_array)
        .filter(|t| (1..=3).contains(&t.len()) && t.iter().all(|x| x.as_str().is_some_and(|s| !s.js_trim().is_empty())));
    let Some(targets) = targets else {
        return Err("open requires input.targets: 1-3 non-empty strings".to_owned());
    };
    let is_url = |t: &Value| {
        let s = t.as_str().unwrap_or_default().js_trim().to_lowercase();
        s.starts_with("http://") || s.starts_with("https://")
    };
    if targets.iter().any(is_url) && targets.len() > 1 {
        return Err("a web URL must be the only target; do not mix it with files or other URLs".to_owned());
    }
    if !version_ok(input) {
        return Err(VERSION.to_owned());
    }
    Ok(())
}

/// The reply: the host's text, then one line per tab, then the saved path.
pub fn format_success(value: &Value) -> String {
    let mut lines = vec![value.get("text").and_then(Value::as_str).unwrap_or_default().to_owned()];
    if let Some(tabs) = value.get("tabs").and_then(Value::as_array) {
        for tab in tabs {
            let part = |k: &str| tab.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
            lines.push(format!("{} {} {} → {}", part("id"), part("kind"), part("label"), part("target")));
        }
    }
    if let Some(path) = value.get("path").and_then(Value::as_str).filter(|p| !p.is_empty()) {
        lines.push(format!("path: {path}"));
    }
    lines.retain(|l| !l.is_empty());
    lines.join("\n")
}

pub struct VisualizeTool {
    spec: ToolSpec,
    host: Arc<dyn HostCommands>,
    waits: PendingWaits,
}

impl VisualizeTool {
    /// `waits` is the registry the `ui/newTab/created` notification settles.
    pub fn new(host: Arc<dyn HostCommands>, waits: PendingWaits) -> Self {
        Self { spec: spec_from_def(include_str!("defs/visualize.json"), false, &[]), host, waits }
    }
}

/// An `open` of one web URL: the pane creates a tab for it and reports the tab's page.
fn opens_web_url(input: &Map<String, Value>) -> bool {
    static SCHEME: std::sync::OnceLock<mixdog_js::JsRegex> = std::sync::OnceLock::new();
    let scheme = SCHEME.get_or_init(|| mixdog_js::JsRegex::new_static("^[a-z][a-z0-9+.-]*://", "i"));
    match input.get("targets").and_then(Value::as_array).map(Vec::as_slice) {
        Some([Value::String(target)]) => scheme.is_match(target),
        _ => false,
    }
}

/// The reply to an open of a web URL, from the page id the pane reported (if it did).
fn opened_text(url: &str, page: Option<&str>) -> String {
    match page {
        Some(page) => format!("Opened {url} in the session's browser panel as page {page}; pass tab:\"{page}\" to the browser tool."),
        None => format!("Opened {url} in the session's browser panel; its page id (p…) is not known yet, so find it with the browser tool's list_tabs."),
    }
}

#[async_trait]
impl Tool for VisualizeTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let (action, mut input) = validate(&args).map_err(|m| invalid("input", m))?;
        // The wait starts before the open is published, and the request id names the tab the
        // pane creates, so no other tab (an older page, the user's "+") answers for it.
        let mut watch = None;
        if action == "open" && opens_web_url(&input) {
            let request_id = uuid::Uuid::new_v4().to_string();
            watch = Some(self.waits.watch_new_tab(ctx.thread_id.as_str(), &request_id));
            input.insert("openRequestId".to_owned(), Value::String(request_id));
        }
        let cwd = ctx.cwd.as_path().to_string_lossy().into_owned();
        let answer = tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => return Err(cancelled()),
            r = self.host.visualize(&ctx.thread_id, &cwd, &action, Value::Object(input)) => r,
        };
        let mut value = match answer {
            Ok(value) => value,
            Err(error) => return Err(command_error(UNAVAILABLE, error)),
        };
        if let Some(mut watch) = watch {
            let page = watch.wait_or_cancel(&ctx.cancel).await;
            if ctx.cancel.is_cancelled() {
                return Err(cancelled());
            }
            let url = value
                .pointer("/tabs/0")
                .filter(|tab| tab.get("kind").and_then(Value::as_str) == Some("url"))
                .and_then(|tab| tab.get("target").and_then(Value::as_str))
                .map(|url| opened_text(url, page.as_deref()));
            if let (Some(opened), Some(object)) = (url, value.as_object_mut()) {
                object.insert("text".to_owned(), Value::String(opened));
            }
        }
        text(format_success(&value))
    }
}

#[cfg(test)]
mod tests {
    use mixdog_protocol::ThreadId;
    use serde_json::json;

    use super::*;

    #[test]
    fn open_and_export_wordings() {
        assert_eq!(
            validate(&json!({"action":"open","input":{}})).unwrap_err(),
            "open requires input.targets: 1-3 non-empty strings"
        );
        assert_eq!(
            validate(&json!({"action":"open","input":{"targets":["https://a.com","b.md"]}})).unwrap_err(),
            "a web URL must be the only target; do not mix it with files or other URLs"
        );
        assert_eq!(
            validate(&json!({"action":"export","input":{"tab":"t1","format":"pdf","output":"a.png"}})).unwrap_err(),
            "export requires input.output ending in .pdf"
        );
        assert_eq!(validate(&json!({"action":"close"})).map(|r| r.0), Ok("close".to_owned()));
    }

    /// A host that opens the URL tab and, like the pane, reports the page it made (or not).
    struct Pane {
        waits: PendingWaits,
        report: Option<&'static str>,
        seen: std::sync::Mutex<Vec<Value>>,
    }

    #[async_trait]
    impl HostCommands for Pane {
        async fn browser(&self, _: &ThreadId, _: &str, _: JsonValue) -> Result<JsonValue, super::super::host::HostCommandError> {
            unreachable!()
        }

        async fn visualize(&self, thread: &ThreadId, _: &str, _: &str, input: JsonValue) -> Result<JsonValue, super::super::host::HostCommandError> {
            if let Some(page) = self.report {
                self.waits.new_tab_created(thread.as_str(), input["openRequestId"].as_str().unwrap(), page);
            }
            self.seen.lock().unwrap().push(input);
            // The shape of Node's reply (`VisualizeResult`): the tab record of the open.
            Ok(json!({"text": "host text", "tabs": golden()["known"]["tabs"].clone()}))
        }
    }

    async fn open_url(report: Option<&'static str>, wait_ms: u64) -> (String, Value) {
        let waits = crate::desktop::pending::tests::waits(wait_ms, 1000);
        let pane = Arc::new(Pane { waits: waits.clone(), report, seen: Default::default() });
        let tool = VisualizeTool::new(pane.clone(), waits);
        let target = golden()["url"].clone();
        let out = tool.call(&crate::orch::tests::ctx(), json!({"action":"open","input":{"targets":[target]}})).await.unwrap();
        let mixdog_core_api::domain::tool::ToolPart::Text(reply) = &out.parts[0] else { panic!("text expected") };
        let sent = pane.seen.lock().unwrap()[0].clone();
        (reply.clone(), sent)
    }

    /// Node's `createVisualizeService().execute({action:"open"})` for one web URL, recorded for
    /// a page id the pane reported (`known`) and for none (`unknown`).
    fn golden() -> Value {
        serde_json::from_str(include_str!("golden/web_open.json")).unwrap()
    }

    /// Node's whole reply: the recorded text, then the tab line `format_success` prints.
    fn node_reply(outcome: &Value) -> String {
        let tab = &outcome["tabs"][0];
        format!(
            "{}\n{} {} {} → {}",
            outcome["text"].as_str().unwrap(),
            tab["id"].as_str().unwrap(),
            tab["kind"].as_str().unwrap(),
            tab["label"].as_str().unwrap(),
            tab["target"].as_str().unwrap()
        )
    }

    #[tokio::test]
    async fn a_web_url_open_answers_with_the_page_the_pane_made() {
        let (reply, sent) = open_url(Some("p7"), 1000).await;
        assert_eq!(reply, node_reply(&golden()["known"]));
        assert!(uuid::Uuid::parse_str(sent["openRequestId"].as_str().unwrap()).is_ok());
    }

    #[tokio::test]
    async fn a_web_url_open_with_an_empty_page_id_points_to_list_tabs() {
        let (reply, _) = open_url(Some(""), 1000).await;
        assert_eq!(reply, node_reply(&golden()["empty"]));
    }

    #[tokio::test]
    async fn a_web_url_open_with_no_report_points_to_list_tabs() {
        let (reply, _) = open_url(None, 40).await;
        assert_eq!(reply, node_reply(&golden()["unknown"]));
    }

    #[test]
    fn only_one_url_target_is_a_web_open() {
        let open = |v: Value| opens_web_url(v.as_object().unwrap());
        assert!(open(json!({"targets":["HTTP://a.com"]})));
        assert!(!open(json!({"targets":["a.md"]})));
        assert!(!open(json!({"targets":[" https://a.com"]})));
        assert!(!open(json!({"content":{"kind":"svg","source":"x"}})));
    }

    #[test]
    fn success_lists_tabs_and_path() {
        let v = json!({"text":"opened","tabs":[{"id":"t1","kind":"file","label":"a.md","target":"/x/a.md"}],"path":"/x/out.png"});
        assert_eq!(format_success(&v), "opened\nt1 file a.md → /x/a.md\npath: /x/out.png");
    }
}
