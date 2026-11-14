//! Read-only window state: the texts a predicate waits on and whether the
//! window exposes any interactive element.

use super::source_or;
use crate::a11y::PredicateObservation;
use crate::host::{Host, Res};
use crate::obj;
use crate::platform::WindowInfo;
use crate::protocol::{Obj, Req};
use serde_json::{json, Value};

/// Get-WindowPredicates' reply for a window that exists. `read` is the
/// element read, absent when the caller asked for none; a read that returned
/// nothing proves no text absent, so it never counts as complete.
fn predicate_reply(info: WindowInfo, read: Option<(Vec<PredicateObservation>, bool)>) -> Obj {
    let mut reply = obj! {
        "text" => format!("window predicate state: {}", info.title),
        "window_id" => info.id(),
        "title" => info.title,
        "exists" => true,
    };
    let Some((observations, complete)) = read else {
        reply.insert("returned".into(), json!(0));
        reply.insert("elements".into(), json!([]));
        return reply;
    };
    let elements: Vec<Value> = observations
        .into_iter()
        .map(|seen| {
            json!({
                "role": seen.role,
                "name": seen.name,
                "value": seen.value,
                "enabled": seen.enabled,
            })
        })
        .collect();
    reply.insert("returned".into(), json!(elements.len()));
    reply.insert("text_complete".into(), json!(complete && !elements.is_empty()));
    reply.insert("elements".into(), json!(elements));
    reply
}

/// Probe-WindowAccessibility's reply: the tree that showed an interactive
/// element, where "" stands for the desktop's own.
fn probe_reply(source: Option<&'static str>, desktop: &'static str) -> Obj {
    match source {
        Some(source) => obj! {
            "interactive" => true,
            "source" => source_or(source, desktop),
        },
        None => obj! { "interactive" => false },
    }
}

impl Host {
    /// Read-only predicate state. It leaves refs and generation untouched so
    /// waiting for a condition never invalidates what the caller holds.
    pub(in crate::host) fn window_predicates(&self, req: &Req) -> Res<Obj> {
        let info = match self.resolve_window(req) {
            Ok(info) => info,
            Err(error)
                if error.starts_with("window_id is stale or invalid:")
                    || error.starts_with("foreground window not found")
                    || error.starts_with("window not found:") =>
            {
                return Ok(obj! {
                    "text" => "window predicate state: absent",
                    "window_id" => req.str("window_id"),
                    "title" => "",
                    "exists" => false,
                    "returned" => 0,
                    "elements" => Vec::<Value>::new(),
                })
            }
            Err(error) => return Err(error),
        };
        if req.bool_false("include_elements") {
            return Ok(predicate_reply(info, None));
        }
        // Refused before the maximum is read, as Get-WindowPredicates does.
        self.assert_accessible_integrity(info.handle)?;
        let max = req.int("max_elements").unwrap_or(400);
        if !(1..=1000).contains(&max) {
            return Err("max_elements must be 1..1000".into());
        }
        let read = self.accessibility()?.predicate_read(&info, max as usize)?;
        Ok(predicate_reply(info, Some(read)))
    }

    pub(in crate::host) fn accessibility_probe(&self, req: &Req) -> Res<Obj> {
        let info = self.resolve_window(req)?;
        let source = self.accessibility()?.probe(&info)?;
        Ok(probe_reply(source, self.desktop.element_source()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::a11y::PredicateRead;

    fn window() -> WindowInfo {
        WindowInfo {
            handle: 0x2a,
            title: "Notes".into(),
            ..WindowInfo::default()
        }
    }

    fn reply(max: usize, texts: &[(&str, &str)], complete: bool) -> Obj {
        let mut read = PredicateRead::new(max);
        for (name, value) in texts {
            if read.full() {
                break;
            }
            read.add("Text", name, value, true);
        }
        predicate_reply(window(), Some((read.observations, read.complete && complete)))
    }

    #[test]
    fn a_whole_read_is_complete_and_lists_each_observation() {
        let reply = reply(5, &[("Saved", ""), ("", "draft")], true);
        let keys: Vec<&str> = reply.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            ["text", "window_id", "title", "exists", "returned", "text_complete", "elements"]
        );
        assert_eq!(reply["text"], "window predicate state: Notes");
        assert_eq!(reply["window_id"], window().id());
        assert_eq!(reply["title"], "Notes");
        assert_eq!(reply["exists"], true);
        assert_eq!(reply["returned"], 2);
        assert_eq!(reply["text_complete"], true);
        assert_eq!(
            reply["elements"][1],
            json!({ "role": "Text", "name": "", "value": "draft", "enabled": true })
        );
    }

    #[test]
    fn a_read_that_returned_nothing_is_never_complete() {
        let reply = reply(5, &[], true);
        assert_eq!(reply["returned"], 0);
        assert_eq!(reply["text_complete"], false);
    }

    #[test]
    fn an_overlong_name_a_reached_maximum_or_an_incomplete_source_is_incomplete() {
        let long = "x".repeat(201);
        assert_eq!(reply(5, &[(&long, "")], true)["text_complete"], false);
        let cut = reply(1, &[("a", ""), ("b", "")], true);
        assert_eq!(cut["returned"], 1);
        assert_eq!(cut["text_complete"], false);
        // What the MSAA walk reports when it was cut or failed.
        assert_eq!(reply(5, &[("a", "")], false)["text_complete"], false);
    }

    #[test]
    fn a_reply_without_an_element_read_carries_no_completeness() {
        let reply = predicate_reply(window(), None);
        let keys: Vec<&str> = reply.keys().map(String::as_str).collect();
        assert_eq!(keys, ["text", "window_id", "title", "exists", "returned", "elements"]);
        assert_eq!(reply["returned"], 0);
        assert_eq!(reply["elements"], json!([]));
    }

    #[test]
    fn the_probe_reports_the_tree_that_answered() {
        assert_eq!(
            Value::Object(probe_reply(Some("uia"), "uia")),
            json!({ "interactive": true, "source": "uia" })
        );
        assert_eq!(probe_reply(Some("msaa"), "uia")["source"], "msaa");
        assert_eq!(probe_reply(Some(""), "atspi")["source"], "atspi");
        assert_eq!(Value::Object(probe_reply(None, "uia")), json!({ "interactive": false }));
    }
}
