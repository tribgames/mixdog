//! What a phone says about its own screen (`setForeground`, `setScreenSessions` in
//! remote-relay-client-calls.ts): whether the app is visible and which conversations it paints.
//! A phone showing a conversation is not pushed that conversation's notifications. The reports
//! are answered by nothing and never reach the core.

use std::collections::HashSet;

use mixdog_js::{slice_utf16, value_to_string};
use serde_json::Value;

const BROWSER_ID_MAX: usize = 64;

/// One report, as the phone's call carries it.
#[derive(Debug, PartialEq, Eq)]
pub enum Report {
    /// `setForeground(visible, browserId?)`: only a literal `false` hides the app.
    Visible { visible: bool, browser_id: Option<String> },
    /// `setScreenSessions(ids)`: the conversations painted now (malformed ids are dropped).
    Screens(HashSet<String>),
}

/// `isSessionId`: `/^[A-Za-z0-9_-]+$/`.
fn is_session_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `filterSessionIds`: each entry is `String(item || '')`, kept when it is an id.
fn session_ids(value: Option<&Value>) -> HashSet<String> {
    let Some(Value::Array(items)) = value else { return HashSet::new() };
    items
        .iter()
        .filter(|item| match item {
            Value::Null | Value::Bool(false) => false,
            Value::String(text) => !text.is_empty(),
            Value::Number(number) => number.as_f64() != Some(0.0),
            _ => true,
        })
        .map(value_to_string)
        .filter(|id| is_session_id(id))
        .collect()
}

/// The report a clear text frame carries, if it is one of the two calls.
pub fn parse_report(text: &str) -> Option<Report> {
    let call: Value = serde_json::from_str(text).ok()?;
    let params = call.get("params")?.as_array()?;
    match call.get("method")?.as_str()? {
        "setForeground" => Some(Report::Visible {
            visible: params.first() != Some(&Value::Bool(false)),
            browser_id: params.get(1).and_then(Value::as_str).map(|id| slice_utf16(id, BROWSER_ID_MAX)),
        }),
        "setScreenSessions" => Some(Report::Screens(session_ids(params.first()))),
        _ => None,
    }
}

/// One leg's account of itself: showing nothing until it reports.
#[derive(Default)]
pub struct Foreground {
    background: bool,
    browser_id: String,
    screens: HashSet<String>,
}

impl Foreground {
    pub fn apply(&mut self, report: Report) {
        match report {
            Report::Visible { visible, browser_id } => {
                self.background = !visible;
                if let Some(id) = browser_id {
                    self.browser_id = id;
                }
            }
            Report::Screens(ids) => self.screens = ids,
        }
    }

    /// Visible, and painting `thread_id`. Hiding the app removes the claim at once.
    pub fn shows(&self, thread_id: &str) -> bool {
        !self.background && self.screens.contains(thread_id)
    }

    /// The browser id the phone reported (what a direct Web Push subscription names).
    pub fn browser_id(&self) -> &str {
        &self.browser_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(list: &[&str]) -> HashSet<String> {
        list.iter().map(|id| (*id).to_owned()).collect()
    }

    #[test]
    fn only_a_literal_false_hides_the_app_and_the_browser_id_is_clipped() {
        let long = "b".repeat(80);
        let text = format!(r#"{{"id":1,"method":"setForeground","params":[false,"{long}"]}}"#);
        assert_eq!(parse_report(&text), Some(Report::Visible { visible: false, browser_id: Some("b".repeat(64)) }));
        assert_eq!(
            parse_report(r#"{"method":"setForeground","params":[0,7]}"#),
            Some(Report::Visible { visible: true, browser_id: None })
        );
    }

    #[test]
    fn screen_ids_follow_filter_session_ids() {
        // String(item || ''): falsy entries are empty, a one-element array stringifies to its
        // element, anything that is not [A-Za-z0-9_-]+ is dropped, duplicates collapse.
        let report = parse_report(r#"{"method":"setScreenSessions","params":[["a-1","a-1","b c",0,null,"",7,["z"],{"k":1},"é"]]}"#);
        assert_eq!(report, Some(Report::Screens(ids(&["a-1", "7", "z"]))));
        assert_eq!(parse_report(r#"{"method":"setScreenSessions","params":["a"]}"#), Some(Report::Screens(HashSet::new())));
    }

    #[test]
    fn other_frames_are_not_reports() {
        assert_eq!(parse_report(r#"{"method":"setForeground"}"#), None);
        assert_eq!(parse_report(r#"{"method":"setForeground","params":"x"}"#), None);
        assert_eq!(parse_report(r#"{"method":"setVisibleSessions","params":[[]]}"#), None);
        assert_eq!(parse_report("not json"), None);
    }

    #[test]
    fn a_phone_shows_a_thread_only_while_visible_and_painting_it() {
        let mut leg = Foreground::default();
        assert!(!leg.shows("t1"));
        leg.apply(Report::Screens(ids(&["t1"])));
        assert!(leg.shows("t1") && !leg.shows("t2"));
        leg.apply(Report::Visible { visible: false, browser_id: Some("br".into()) });
        assert!(!leg.shows("t1"));
        assert_eq!(leg.browser_id(), "br");
        leg.apply(Report::Visible { visible: true, browser_id: None });
        assert!(leg.shows("t1"));
        assert_eq!(leg.browser_id(), "br");
    }
}
