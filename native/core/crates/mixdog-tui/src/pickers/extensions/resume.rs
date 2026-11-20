//! The `/resume` saved-chat picker (`resume-picker.mjs`) and the two session formatters it takes from `app-format.mjs`.

use mixdog_js::time::local_fields;
use mixdog_js::{js_words, to_number, to_number_of};
use serde_json::{Value, json};

use super::Extensions;
use super::panel::{Action, ExtItem, ExtPanel, ExtensionsHost, Handler, claim, close_now, or_text};
use crate::slash::host::Tone;
use crate::slash::notices::{truthy, value_text};

/// `formatSessionUpdatedAt(value)`: `MM-DD HH:MM` in local time, with the year when it is not the current one (`now_ms` is the
/// clock), `--:--` for a value that is no time.
pub fn format_session_updated_at(value: Option<&Value>, now_ms: f64) -> String {
    let n = to_number_of(value);
    if !n.is_finite() || n <= 0.0 {
        return "--:--".to_owned();
    }
    let (Some(date), Some(now)) = (local_fields(n), local_fields(now_ms)) else { return "--:--".to_owned() };
    let time = format!("{:02}:{:02}", date.hour, date.minute);
    let day = format!("{:02}-{:02}", date.month, date.day);
    if date.year == now.year { format!("{day} {time}") } else { format!("{}-{day} {time}", date.year) }
}

/// `formatSessionMessageCount(count)`: `3 msgs`, `1 msg`.
pub fn format_session_message_count(count: Option<&Value>) -> String {
    let n = match count {
        Some(value) if truthy(value) => to_number(value),
        _ => 0.0,
    };
    let shown = if n.is_finite() { (n + 0.5).floor().max(0.0) } else { 0.0 };
    format!("{shown} msg{}", if n == 1.0 { "" } else { "s" })
}

/// Whitespace runs collapsed into one space, trimmed.
fn collapse(text: &str) -> String {
    js_words(text).collect::<Vec<_>>().join(" ")
}

fn text_of(session: &Value, key: &str) -> String {
    match session.get(key) {
        Some(value) if truthy(value) => value_text(value),
        _ => String::new(),
    }
}

impl Extensions {
    /// `openResumePicker()`: the saved chats of this and every other process (a storage rescan, so a chat the desktop app or
    /// another terminal wrote after this process's first listing shows too).
    pub fn open_resume(&mut self, host: &mut dyn ExtensionsHost) {
        // Surface claim: the storage rescan below is slow, so Esc can easily land before this panel ever paints.
        let mut own = claim(host);
        let sessions = match host.store_call("listSessions", json!([{"refreshFromStorage": true}])) {
            Ok(Value::Array(sessions)) if !sessions.is_empty() => sessions,
            Ok(_) => {
                host.push_notice("no saved chats", Tone::Warn);
                return;
            }
            Err(error) => {
                host.push_notice(&format!("could not list saved chats: {error}"), Tone::Error);
                return;
            }
        };
        let now = host.now_ms() as f64;
        let items = sessions
            .iter()
            .map(|session| {
                let preview = text_of(session, "preview").replace('\n', " ");
                let preview = mixdog_js::js_trim(&preview).to_owned();
                let title = collapse(&text_of(session, "title"));
                let description = if !title.is_empty() {
                    title
                } else if !preview.is_empty() {
                    preview
                } else {
                    "(no message)".to_owned()
                };
                let label =
                    format!("{}  {}", format_session_updated_at(session.get("updatedAt"), now), format_session_message_count(session.get("messageCount")));
                ExtItem::new(&or_text(session, "id", ""), &label, &description, Action::Noop)
            })
            .collect();
        let panel = ExtPanel { label_width: Some(21), ..ExtPanel::new("Resume", "Restore a saved chat session.", items, Handler::Resume(sessions)) };
        host.paint(&mut own, Some(panel));
    }
}

/// Enter on a saved chat: closes the picker and resumes it.
pub fn select(host: &mut dyn ExtensionsHost, sessions: &[Value], value: &str) {
    close_now(host);
    let selected = sessions.iter().find(|session| or_text(session, "id", "") == value);
    let named = selected.map_or_else(String::new, |session| match text_of(session, "title") {
        title if !title.is_empty() => title,
        _ => text_of(session, "preview"),
    });
    let named = if named.is_empty() { value.to_owned() } else { named };
    let resumed_name = collapse(&named);
    match host.store_call("resume", json!([value])) {
        Ok(ok) => {
            if truthy(&ok) {
                let name = if resumed_name.is_empty() { value } else { resumed_name.as_str() };
                host.push_notice(&format!("Resumed {name}"), Tone::Info);
            } else {
                host.push_notice("Couldn\u{2019}t resume chat.", Tone::Warn);
            }
        }
        Err(error) => host.push_notice(&format!("Couldn\u{2019}t resume chat: {error}"), Tone::Error),
    }
}
