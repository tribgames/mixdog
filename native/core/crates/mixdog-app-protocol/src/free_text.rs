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
/// (an array index or a map key); a last segment `**` is the value there and every value below it, for JSON with no fixed
/// fields that a model, a tool's source or a document wrote (tool-call arguments, a tool's schema, thinking blocks): its
/// keys are never free text.
pub static FREE_TEXT: &[(Kind, &str, &[&str])] = &[
    // The text of a turn, a steer or a queued message (the steer and the queue send turn/start's input), a `/goal`
    // command typed in the composer, the composer's text handed back with a queued entry.
    (
        Kind::Request,
        "thread/start",
        &["/initialInput/prompt", "/initialInput/prompt/*/text", "/initialInput/options/displayText", "/initialInput/options/pastedTexts/*/text", "/initialInput/options/goalCommand", "/initialInput/options/pastedImages/*/metadataText"],
    ),
    (
        Kind::Request,
        "turn/start",
        &["/input/prompt", "/input/prompt/*/text", "/input/options/displayText", "/input/options/pastedTexts/*/text", "/input/options/goalCommand", "/input/options/pastedImages/*/metadataText"],
    ),
    // A server's arguments and environment values as a person typed them (the names stay identifiers). Its header values are
    // not here: they go on every request to the server, where Node's fetch refuses a lone unit and the core's HTTP library
    // would send the U+FFFD bytes (recorded, native/core/fixtures/lone-surrogate-wire).
    (Kind::Request, "mcp/addMcpServer", &["/input/args/*", "/input/env/*"]),
    (Kind::Request, "mcp/saveMcpServer", &["/input/args/*", "/input/env/*"]),
    (Kind::Request, "thread/askSide", &["/question"]),
    (Kind::Request, "thread/queue/delete", &["/currentText"]),
    (Kind::Request, "thread/requestWorktree", &["/input/prompt"]),
    (Kind::Request, "thread/agentControl", &["/args/prompt", "/args/message", "/args/context"]),
    // A Goal's objective, typed or as a `/goal` command.
    (Kind::Request, "thread/goal/set", &["/goal", "/goal/command", "/goal/objective"]),
    (Kind::Request, "thread/goal/control", &["/args/command", "/args/objective"]),
    // Titles, names and renames shown as typed (the record's id is separate).
    (Kind::Request, "thread/name/set", &["/title"]),
    (Kind::Request, "project/update", &["/alias"]),
    (Kind::Request, "remoteAccess/setName", &["/name"]),
    (Kind::Request, "remoteAccess/setClientAlias", &["/alias"]),
    (Kind::Request, "room/create", &["/input/name"]),
    (Kind::Request, "room/update", &["/input/name"]),
    (Kind::Request, "media/createMediaBoard", &["/name"]),
    (Kind::Request, "media/renameMediaBoard", &["/name"]),
    (Kind::Request, "config/setProfile", &["/input/title", "/input/name"]),
    (Kind::Request, "account/updateProviderAccounts", &["/change/rename/label"]),
    (Kind::Request, "account/saveCustomProvider", &["/input/name"]),
    (Kind::Request, "account/testCustomProvider", &["/input/name"]),
    (Kind::Request, "account/discoverCustomProviderModels", &["/input/name"]),
    (Kind::Request, "account/updateCustomProviderModel", &["/patch/name"]),
    (Kind::Request, "projectFs/workspaceFile/write", &["/folders/*/name"]),
    // Text stored as written: notes, personas, definitions, instructions, prompts, descriptions.
    (Kind::Request, "thread/pushNotice", &["/text"]),
    (Kind::Request, "agent/saveLeadPersona", &["/text"]),
    (Kind::Request, "agent/saveLeadAgentBody", &["/text"]),
    (Kind::Request, "agent/setLeadCreated", &["/description"]),
    (Kind::Request, "agent/saveLeadIdentity", &["/payload/name"]),
    (Kind::Request, "agent/saveAgentDefinition", &["/payload/name", "/payload/description", "/payload/body", "/payload/persona"]),
    (Kind::Request, "instructions/saveInstructionFile", &["/input/body"]),
    // A skill's name is checked to `[a-z0-9-]` (mixdog-mcp skills.rs `validate_name`): one that held a lone unit is refused
    // by that check with Node's message, as Node's was.
    (Kind::Request, "skills/addSkill", &["/input/name", "/input/description", "/input/whenToUse", "/input/instructions", "/input/body"]),
    (Kind::Request, "skills/saveSkill", &["/input/name", "/input/description", "/input/whenToUse", "/input/instructions", "/input/body"]),
    (Kind::Request, "config/saveWorkflowPack", &["/payload/name", "/payload/description", "/payload/body"]),
    (Kind::Request, "config/createWorkflow", &["/payload/name", "/payload/description", "/payload/body"]),
    (Kind::Request, "channel/saveSchedule", &["/entry/instructions", "/entry/description"]),
    (Kind::Request, "channel/saveWebhook", &["/entry/instructions", "/entry/description"]),
    (Kind::Request, "channel/call", &["/args/entry/instructions", "/args/entry/description", "/args/def/instructions", "/args/def/description"]),
    (Kind::Request, "memory/memoryControl", &["/args/element", "/args/summary"]),
    (Kind::Request, "feedback/upload", &["/input/message"]),
    (Kind::Request, "media/startMediaJob", &["/input/prompt"]),
    (Kind::Request, "config/completeSetupRequest", &["/receipt/error"]),
    (Kind::Request, "git/globalConfig/write", &["/value"]),
    (Kind::Request, "github/request", &["/input/title", "/input/body", "/input/description"]),
    (Kind::Request, "github/pr/create", &["/value/title", "/value/body"]),
    // File content being written: the workspace refuses it with Node's message (mixdog-workspace fsops.rs `check_paired`);
    // a document's text as an editor holds it.
    // A save's expected content is file text too: the workspace marks one that held a lone unit, and it equals no file Node
    // would have saved over (a lossless file never holds one): refused at Node's comparison with Node's sentence
    // (mixdog-workspace fsops.rs `expected_text`; recorded, native/core/fixtures/inbound-lone-surrogate).
    (Kind::Request, "projectFs/writeText", &["/content", "/expectedContent"]),
    (Kind::Request, "projectFs/writeTextBatch", &["/files/*/content", "/files/*/expectedContent"]),
    (Kind::Request, "projectFs/backup/write", &["/content"]),
    (Kind::Request, "projectFs/replaceText", &["/replacement", "/options/query"]),
    (Kind::Request, "lsp/document", &["/document/content"]),
    // Search queries: a plain-text workspace one matches nothing, as Node's matched nothing (mixdog-workspace textsearch.rs,
    // search.rs); the others search for U+FFFD, the documented difference (decisions.md); git gets what Node's spawn gave it.
    (Kind::Request, "projectFs/searchText", &["/options/query"]),
    (Kind::Request, "search/update", &["/query"]),
    (Kind::Request, "git/log", &["/query"]),
    (Kind::Request, "thread/search", &["/query"]),
    (Kind::Request, "thread/list", &["/searchTerm"]),
    (Kind::Request, "memory/recall", &["/query", "/args/query"]),
    (Kind::Request, "project/codeGraph", &["/query"]),
    (Kind::Request, "tools/toolsStatus", &["/query", "/snapshotUserMessage"]),
    (Kind::Request, "localProvider/searchLocalProviderModels", &["/query"]),
    (Kind::Request, "import/listImportableConversations", &["/params/query"]),
    // Commit messages, given to git as Node's spawn gave them (U+FFFD).
    (Kind::Request, "git/commit", &["/message"]),
    (Kind::Request, "git/commitPaths", &["/input/message"]),
    (Kind::Request, "git/amend", &["/message"]),
    (Kind::Request, "git/stash", &["/message"]),
    // A person's answer to a tool approval or a question (the decision itself is `approved`/`response`, an enum).
    (Kind::Request, "thread/approval/answer", &["/result/reason", "/result/reply", "/result/answers/*/text", "/result/editedArgs/*"]),
    (Kind::Answer, "item/tool/requestUserInput", &["/answers/*/text", "/reply", "/reason", "/editedArgs/*"]),
    (Kind::Answer, "item/tool/requestApproval", &["/answers/*/text", "/reply", "/reason", "/editedArgs/*"]),
    (Kind::Answer, "item/browser/requestApproval", &["/answers/*/text", "/reply", "/reason", "/editedArgs/*"]),
    (Kind::Answer, "item/computer/requestApproval", &["/answers/*/text", "/reply", "/reason", "/editedArgs/*"]),
    (Kind::Answer, "item/permissions/requestApproval", &["/answers/*/text", "/reply", "/reason", "/editedArgs/*"]),
    // Text typed into a remote browser page or a terminal, written to the page or the pty as UTF-8 (Node's write gave the
    // unit as U+FFFD too); a log line.
    (Kind::Request, "browser/command", &["/input/text"]),
    (Kind::Notification, "terminal/input", &["/data"]),
    (Kind::Notification, "client/perfLog", &["/line"]),
    // What a page or a model shows: visualize tab labels, titles and inline content, a page's title and error.
    (Kind::Request, "visualize/command", &["/input/label", "/input/error", "/input/content/source", "/input/content/title"]),
    (
        Kind::Request,
        "host/state/set",
        &[
            "/value/*/history/*/label",
            "/value/*/tabs/*/annotations/*/label",
            "/value/*/tabs/*/label",
            "/value/*/tabs/*/panes/*/inline/title",
            "/value/*/tabs/*/panes/*/label",
            "/value/*/tabs/*/problems/*/message",
            "/value/*/tabs/*/remoteLabel",
            "/value/*/tabs/*/versions/*/label",
            "/value/state/history/*/label",
            "/value/state/tabs/*/annotations/*/label",
            "/value/state/tabs/*/label",
            "/value/state/tabs/*/panes/*/inline/title",
            "/value/state/tabs/*/panes/*/label",
            "/value/state/tabs/*/problems/*/message",
            "/value/state/tabs/*/remoteLabel",
            "/value/state/tabs/*/versions/*/label",
        ],
    ),
    (Kind::Notification, "host/browser/surface", &["/title", "/error"]),
    // What the desktop publishes as text: a web page's title (a page may set one holding a lone unit), an import's or the
    // updater's error message, a monitor's name.
    (Kind::Request, "host/state/set", &["/value/tabs/*/title", "/value/*/title", "/value/error"]),
    (Kind::Notification, "host/update/report", &["/state/message"]),
    (Kind::Answer, "host/update/command", &["/message"]),
    (Kind::Answer, "host/screen/displays", &["/*/label"]),
    // Language-server params the editor wrote (a rename's new name, a symbol query), sent to the server process.
    (Kind::Request, "lsp/request", &["/request/params/**"]),
    // A patch's text (file content), given to `git apply`.
    (Kind::Request, "git/applyPatch", &["/patch"]),
    // Values a person types into a form: a workflow's inputs, a provider's or a server's header values and extra body fields.
    (Kind::Request, "github/request", &["/input/inputs/*"]),
    (Kind::Request, "account/saveCustomProvider", &["/input/headers/*", "/input/requestBody/*"]),
    (Kind::Request, "account/testCustomProvider", &["/input/headers/*", "/input/requestBody/*"]),
    (Kind::Request, "account/discoverCustomProviderModels", &["/input/headers/*", "/input/requestBody/*"]),
    (Kind::Request, "mcp/probeMcpServerAuth", &["/cfg/headers/*"]),
    // A model call run on the desktop: the conversation's text, a model's output, a tool's description and schema, a
    // provider's error text; forwarded to and from the provider, never compared (model and tool names, ids and provider
    // state stay refused).
    (
        Kind::Request,
        "modelProxy/run",
        &[
            "/call/request/messages/*/content",
            "/call/request/messages/*/content/*/text",
            "/call/request/messages/*/content/*/title",
            "/call/request/messages/*/content/*/source/content/**",
            "/call/request/messages/*/assistantBlocks/**",
            "/call/request/messages/*/thinkingBlocks/**",
            "/call/request/messages/*/toolCalls/*/arguments/**",
            "/call/request/messages/*/providerReplay/*/items/**",
            "/call/request/messages/*/turnReminder",
            "/call/request/tools/*/description",
            "/call/request/tools/*/inputSchema/**",
            "/call/request/options/hostedTools/*/userLocation/city",
            "/call/request/options/hostedTools/*/userLocation/region",
        ],
    ),
    (
        Kind::Notification,
        "model/proxy/event",
        &["/event/text", "/event/delta", "/event/message", "/event/stop/value", "/event/value/**", "/event/call/arguments/**", "/event/calls/*/arguments/**", "/event/replay/items/**"],
    ),
    (
        Kind::Answer,
        "model/proxy/execute",
        &[
            "/result/failure/message",
            "/result/failure/notices/*/message",
            "/result/models/*/displayName",
            "/result/models/*/picker/description",
            "/result/models/*/picker/modelParameterOptions/*/label",
            "/result/models/*/picker/modelParameterOptions/*/options/*/label",
            "/result/models/*/picker/serviceTiers/*/description",
        ],
    ),
];

/// Whether `pattern` (segments, `*` and `{}` any one, a last `**` the rest) names `pointer`.
pub fn matches(pattern: &str, pointer: &str) -> bool {
    let mut pattern = pattern.split('/');
    let mut pointer = pointer.split('/');
    loop {
        match (pattern.next(), pointer.next()) {
            (None, None) => return true,
            (Some("**"), _) => return pattern.next().is_none(),
            (Some(want), Some(got)) if want == "*" || want == "{}" || want == got => {}
            _ => return false,
        }
    }
}

/// Whether the place `at` of a `kind` frame of `method` is free text: a value named by a pattern (not a `{}` one), a key
/// named by a `{}` pattern (the keys of a map) or lying under a `**` one (JSON a model or a tool wrote, keys and all). A
/// key that merged with another of its object ([`LoneAt::MergedKey`]) is never free text: one value would overwrite the other.
pub fn is_free_text(kind: Kind, method: &str, at: &LoneAt) -> bool {
    let patterns = FREE_TEXT.iter().filter(|(k, m, _)| *k == kind && *m == method).flat_map(|(_, _, patterns)| patterns.iter());
    match at {
        LoneAt::Value(pointer) => patterns.filter(|pattern| !pattern.ends_with("/{}")).any(|pattern| matches(pattern, pointer)),
        LoneAt::Key(pointer) => patterns.filter(|pattern| pattern.ends_with("/{}") || pattern.ends_with("/**")).any(|pattern| matches(pattern, pointer)),
        LoneAt::MergedKey(_) => false,
    }
}

/// The first place that held a lone surrogate outside the free-text fields: the frame is refused whole.
pub fn refused<'a>(kind: Kind, method: &str, lone: &'a [LoneAt]) -> Option<&'a str> {
    lone.iter().find(|at| !is_free_text(kind, method, at)).map(LoneAt::pointer)
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
        // `**`: every value and every key below, unless two keys merged; nothing beside it.
        let args = "/call/request/messages/0/toolCalls/1/arguments";
        assert_eq!(refused(Kind::Request, "modelProxy/run", &[text(args), text(&format!("{args}/path/0"))]), None);
        assert_eq!(refused(Kind::Request, "modelProxy/run", &[LoneAt::Key(format!("{args}/a")), LoneAt::Key(format!("{args}/b/c"))]), None);
        assert_eq!(refused(Kind::Request, "modelProxy/run", &[LoneAt::MergedKey(format!("{args}/a"))]), Some(format!("{args}/a").as_str()));
        assert_eq!(refused(Kind::Request, "modelProxy/run", &[text("/call/request/messages/0/toolCalls/1/name")]), Some("/call/request/messages/0/toolCalls/1/name"));
        // A map: its values are free text by `*`, its keys stay refused unless a `{}` pattern names them.
        assert_eq!(refused(Kind::Request, "mcp/addMcpServer", &[text("/input/env/HOME")]), None);
        assert_eq!(refused(Kind::Request, "mcp/addMcpServer", &[LoneAt::Key("/input/env/HOME".into())]), Some("/input/env/HOME"));
        // A server's header value goes on the wire: refused.
        assert_eq!(refused(Kind::Request, "mcp/addMcpServer", &[text("/input/headers/X-Token")]), Some("/input/headers/X-Token"));
    }
}
