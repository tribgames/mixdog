//! The secrets a session has filled (`session-secrets.ts`) and the one way to redact them
//! (`secret-markers.ts`): every filled value is remembered for its session, in memory only and
//! until the session ends, so every later reply of that session is redacted; and whether a
//! secret field may still hold focus (captures are withheld meanwhile).

use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::hash_map::Entry;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;

/// What replaces a filled secret wherever it later appears in tool output.
pub const REDACTED_MARKER: &str = "[redacted]";
/// What replaces a Computer Use saved-login password wherever it later appears.
pub const SAVED_LOGIN_MARKER: &str = "[saved login]";
/// Every marker any redactor writes.
const SECRET_MARKERS: [&str; 2] = [REDACTED_MARKER, SAVED_LOGIN_MARKER];

/// [start, end) of every marker in `text`, in order.
fn marker_spans(text: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    for marker in SECRET_MARKERS {
        let mut from = 0;
        while let Some(at) = text[from..].find(marker).map(|i| i + from) {
            spans.push((at, at + marker.len()));
            from = at + marker.len();
        }
    }
    spans.sort_by_key(|span| span.0);
    spans
}

fn find_from(text: &str, secret: &str, from: usize) -> Option<usize> {
    text[from..].find(secret).map(|i| i + from)
}

/// `text` with each occurrence of `secret` (non-empty) replaced by `marker`, except one lying
/// entirely inside markers. An occurrence that partly overlaps a marker replaces that marker
/// whole, so no marker is left broken.
fn redact_secret(text: &str, secret: &str, marker: &str) -> String {
    let spans = marker_spans(text);
    let mut next = String::new();
    let mut copied = 0;
    let mut at = find_from(text, secret, 0);
    while let Some(start) = at {
        let end = start + secret.len();
        let touched: Vec<&(usize, usize)> = spans.iter().filter(|(from, to)| *from < end && start < *to).collect();
        let mut reach = start;
        for (from, to) in touched.iter().map(|span| **span) {
            if from > reach {
                break;
            }
            reach = reach.max(to);
        }
        if reach >= end {
            let step = text[start..].chars().next().map_or(1, char::len_utf8);
            at = find_from(text, secret, start + step);
            continue;
        }
        let from = start.min(touched.first().map_or(start, |span| span.0));
        let to = end.max(touched.last().map_or(end, |span| span.1));
        next.push_str(if from > copied { &text[copied..from] } else { "" });
        next.push_str(marker);
        copied = to;
        at = find_from(text, secret, to);
    }
    next.push_str(&text[copied..]);
    next
}

/// `text` with every one of `secrets` (non-empty, given longest first, so a secret containing a
/// shorter one is replaced whole) replaced by `marker`, passes repeated until no secret occurs
/// outside the markers: a replacement can join a secret that holds marker text (`a[redacted]`)
/// to the text before it, so one pass is not enough. The result is stable.
pub fn redact_secrets(text: &str, secrets: &[String], marker: &str) -> String {
    let mut out = text.to_owned();
    loop {
        let before = out.clone();
        for secret in secrets {
            out = redact_secret(&out, secret, marker);
        }
        if out == before {
            return out;
        }
    }
}

#[derive(Default)]
struct Sessions {
    secrets: HashMap<String, Vec<String>>,
    focused: HashSet<String>,
}

/// The filled secrets and secret-field focus of every session. Never printed: it has no `Debug`.
#[derive(Default)]
pub struct SessionSecrets {
    sessions: Mutex<Sessions>,
}

impl SessionSecrets {
    pub fn new() -> Self {
        Self::default()
    }

    fn held(&self) -> MutexGuard<'_, Sessions> {
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `remember`: `value` is redacted from every later reply of `session` until `forget`: every
    /// non-empty value, of any length. A username is no secret and is never registered. An empty
    /// value hides nothing (replacing it would mark every character boundary), so it is not kept.
    pub fn remember(&self, session: &str, value: &str) {
        if session.is_empty() || value.is_empty() {
            return;
        }
        let mut sessions = self.held();
        let secrets = sessions.secrets.entry(session.to_owned()).or_default();
        if !secrets.iter().any(|secret| secret == value) {
            secrets.push(value.to_owned());
        }
    }

    /// `secretsOf`, in the order they were filled.
    pub fn secrets_of(&self, session: &str) -> Vec<String> {
        self.held().secrets.get(session).cloned().unwrap_or_default()
    }

    /// `redact`: `text` with every secret of `session` replaced by [`REDACTED_MARKER`], longest
    /// first (UTF-16 length, ties in fill order); markers already in `text` are left as they are.
    pub fn redact(&self, session: &str, text: &str) -> String {
        let mut secrets = self.secrets_of(session);
        secrets.sort_by_key(|secret| std::cmp::Reverse(mixdog_js::utf16_len(secret)));
        redact_secrets(text, &secrets, REDACTED_MARKER)
    }

    /// `forget`: the session ended; its secrets and focus leave memory.
    pub fn forget(&self, session: &str) {
        let mut sessions = self.held();
        if let Entry::Occupied(entry) = sessions.secrets.entry(session.to_owned()) {
            entry.remove();
        }
        sessions.focused.take(session);
    }

    /// `armFocus`: a secret field of `session` may hold focus; captures are withheld.
    pub fn arm_focus(&self, session: &str) {
        self.held().focused.insert(session.to_owned());
    }

    pub fn clear_focus(&self, session: &str) {
        self.held().focused.take(session);
    }

    pub fn focus_armed(&self, session: &str) -> bool {
        self.held().focused.contains(session)
    }
}