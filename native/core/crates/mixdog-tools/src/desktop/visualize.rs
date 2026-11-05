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
}

impl VisualizeTool {
    pub fn new(host: Arc<dyn HostCommands>) -> Self {
        Self { spec: spec_from_def(include_str!("defs/visualize.json"), false, &[]), host }
    }
}

#[async_trait]
impl Tool for VisualizeTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let (action, input) = validate(&args).map_err(|m| invalid("input", m))?;
        let answer = tokio::select! {
            biased;
            _ = ctx.cancel.cancelled() => return Err(cancelled()),
            r = self.host.visualize(&ctx.thread_id, &action, Value::Object(input)) => r,
        };
        match answer {
            Ok(value) => text(format_success(&value)),
            Err(error) => Err(command_error(UNAVAILABLE, error)),
        }
    }
}

#[cfg(test)]
mod tests {
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

    #[test]
    fn success_lists_tabs_and_path() {
        let v = json!({"text":"opened","tabs":[{"id":"t1","kind":"file","label":"a.md","target":"/x/a.md"}],"path":"/x/out.png"});
        assert_eq!(format_success(&v), "opened\nt1 file a.md → /x/a.md\npath: /x/out.png");
    }
}
