//! The fields where an unpaired surrogate escape may be read as U+FFFD.
//!
//! No shipped client sends a lone UTF-16 surrogate in an identifier, a path, a selector, a key or an
//! enum: one arrives only in text a person typed or pasted (cut inside an emoji). So a frame holding
//! one is refused whole before any service runs (a request fails with `invalidParams`, a
//! notification is dropped, an answer fails its request) unless every place that held one is a
//! free-text field listed here: text shown or stored as text and compared with nothing, where the
//! core reads the unit as U+FFFD (decisions.md "frame-lone-surrogate"). A field missing here costs a
//! refused message for broken text; a field wrongly listed costs a wrong match, so a field is listed
//! only when no service compares it, or the service named beside it reads the report and acts as
//! Node did (refuses, or matches nothing).
//!
//! Every string field of every method is either listed here or named as refused in
//! `tests/it/free_text_fields.json`; the contract test fails on a field that is in neither.

use mixdog_js::LoneAt;

/// What a frame is to the server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A client request, by its method; pointers into `params`.
    Request,
    /// A client notification, by its method; pointers into `params`.
    Notification,
    /// A client's answer to a server request, by that request's method; pointers into `result`.
    Answer,
}

/// The free-text fields: (kind, method, pointer patterns into the payload). A pattern segment `*` is any one segment
/// (an array index or a map key).
pub static FREE_TEXT: &[(Kind, &str, &[&str])] = &[
    // The text of a turn, a steer or a queued message (the steer and the queue send turn/start's input).
    (Kind::Request, "thread/start", &["/initialInput/prompt", "/initialInput/prompt/*/text", "/initialInput/options/displayText", "/initialInput/options/pastedTexts/*/text"]),
    (Kind::Request, "turn/start", &["/input/prompt", "/input/prompt/*/text", "/input/options/displayText", "/input/options/pastedTexts/*/text"]),
    (Kind::Request, "thread/askSide", &["/question"]),
    // Titles and renames, shown as typed.
    (Kind::Request, "thread/name/set", &["/title"]),
    (Kind::Request, "project/update", &["/alias"]),
    (Kind::Request, "remoteAccess/setName", &["/name"]),
    (Kind::Request, "remoteAccess/setClientAlias", &["/alias"]),
    // Text stored as written.
    (Kind::Request, "thread/pushNotice", &["/text"]),
    (Kind::Request, "agent/saveLeadPersona", &["/text"]),
    (Kind::Request, "agent/saveLeadAgentBody", &["/text"]),
    (Kind::Request, "agent/setLeadCreated", &["/description"]),
    (Kind::Request, "memory/memoryControl", &["/args/element", "/args/summary"]),
    (Kind::Request, "feedback/upload", &["/input/message"]),
    // File content being written: the workspace refuses it with Node's message (mixdog-workspace fsops.rs `check_paired`).
    (Kind::Request, "projectFs/writeText", &["/content"]),
    (Kind::Request, "projectFs/writeTextBatch", &["/files/*/content"]),
    (Kind::Request, "projectFs/backup/write", &["/content"]),
    (Kind::Request, "projectFs/replaceText", &["/replacement", "/options/query"]),
    // Search queries: a plain-text one matches nothing, as Node's matched nothing (mixdog-workspace textsearch.rs,
    // search.rs); a regex one is the documented difference (decisions.md); git gets what Node's spawn gave it.
    (Kind::Request, "projectFs/searchText", &["/options/query"]),
    (Kind::Request, "search/update", &["/query"]),
    (Kind::Request, "git/log", &["/query"]),
    // Commit messages, given to git as Node's spawn gave them (U+FFFD).
    (Kind::Request, "git/commit", &["/message"]),
    (Kind::Request, "git/commitPaths", &["/input/message"]),
    (Kind::Request, "git/amend", &["/message"]),
    (Kind::Request, "git/stash", &["/message"]),
    // Terminal input, written to the pty as UTF-8 (Node's write gives the unit as U+FFFD too); a log line.
    (Kind::Notification, "terminal/input", &["/data"]),
    (Kind::Notification, "client/perfLog", &["/line"]),
    // A person's answer to a question.
    (Kind::Answer, "item/tool/requestUserInput", &["/answers/*/text", "/reply"]),
];

/// Whether `pattern` (segments, `*` any one) names `pointer`.
pub fn matches(pattern: &str, pointer: &str) -> bool {
    let mut pattern = pattern.split('/');
    let mut pointer = pointer.split('/');
    loop {
        match (pattern.next(), pointer.next()) {
            (None, None) => return true,
            (Some(want), Some(got)) if want == "*" || want == got => {}
            _ => return false,
        }
    }
}

/// Whether the value at `pointer` of a `kind` frame of `method` is a free-text field.
pub fn is_free_text(kind: Kind, method: &str, pointer: &str) -> bool {
    FREE_TEXT
        .iter()
        .filter(|(k, m, _)| *k == kind && *m == method)
        .any(|(_, _, patterns)| patterns.iter().any(|pattern| matches(pattern, pointer)))
}

/// The first place that held a lone surrogate outside the free-text fields (a key is never free text): the frame is
/// refused whole.
pub fn refused<'a>(kind: Kind, method: &str, lone: &'a [LoneAt]) -> Option<&'a str> {
    lone.iter()
        .find(|at| match at {
            LoneAt::Value(pointer) => !is_free_text(kind, method, pointer),
            LoneAt::Key(_) => true,
        })
        .map(LoneAt::pointer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_is_refused_unless_every_lone_place_is_free_text() {
        let text = |pointer: &str| LoneAt::Value(pointer.into());
        assert_eq!(refused(Kind::Request, "turn/start", &[text("/input/prompt/2/text")]), None);
        assert_eq!(refused(Kind::Request, "turn/start", &[text("/input/prompt/2/text"), text("/threadId")]), Some("/threadId"));
        assert_eq!(refused(Kind::Request, "turn/start", &[LoneAt::Key("/input/prompt/2/text".into())]), Some("/input/prompt/2/text"));
        assert_eq!(refused(Kind::Request, "turn/start", &[text("/input/prompt/2/text/x")]), Some("/input/prompt/2/text/x"));
        assert_eq!(refused(Kind::Request, "turn/start", &[text("#/id")]), Some("#/id"));
        assert_eq!(refused(Kind::Notification, "turn/start", &[text("/input/prompt")]), Some("/input/prompt"));
        assert_eq!(refused(Kind::Notification, "modelProxy/cancel", &[text("/runId")]), Some("/runId"));
        // A selector is no free text: a search whose include, exclude or relPaths held a lone unit is refused, not run.
        assert_eq!(refused(Kind::Request, "projectFs/searchText", &[text("/options/query")]), None);
        assert_eq!(refused(Kind::Request, "projectFs/searchText", &[text("/options/include")]), Some("/options/include"));
        assert_eq!(refused(Kind::Request, "projectFs/replaceText", &[text("/options/exclude")]), Some("/options/exclude"));
        assert_eq!(refused(Kind::Request, "projectFs/replaceText", &[text("/relPaths/0")]), Some("/relPaths/0"));
    }
}
