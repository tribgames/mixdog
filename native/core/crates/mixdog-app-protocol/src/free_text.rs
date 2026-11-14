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
    // A user's message to a room: the turn input `turn/start` takes.
    (
        Kind::Request,
        "room/send",
        &["/input/prompt", "/input/prompt/*/text", "/input/options/displayText", "/input/options/pastedTexts/*/text", "/input/options/goalCommand", "/input/options/pastedImages/*/metadataText"],
    ),
    // A server's arguments and environment values as a person typed them (the names stay identifiers). Its header values are
    // not here: a value that becomes a header is refused naming the field, nothing saved (decisions.md "Lone UTF-16 surrogates
    // in client strings"; Node saves it and its fetch refuses it, recorded in native/core/fixtures/lone-surrogate-wire).
    (Kind::Request, "mcp/addMcpServer", &["/input/args/*", "/input/env/*"]),
    (Kind::Request, "mcp/saveMcpServer", &["/input/args/*", "/input/env/*"]),
    (Kind::Request, "thread/askSide", &["/question"]),
    (Kind::Request, "connections/ssh/rename", &["/name"]),
    (Kind::Request, "connections/ssh/openEphemeral", &["/name"]),
    (Kind::Request, "connections/ssh/askpassReply", &["/secret"]),
    (Kind::Request, "remoteHosts/rename", &["/name"]),
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
    // A link copied from a conversation (a model's markdown link) and the session's folder: resolved to a host path as the
    // desktop's transcript-file-links.ts resolved it, which never refused a lone unit.
    (Kind::Request, "desktop/link/resolve", &["/href", "/cwd"]),
    (Kind::Request, "desktop/link/resolvePath", &["/path", "/cwd"]),
    // A link to a file under a project, an attachment written from a data URL, the launch record file, a user file written as
    // the user typed it: file names, paths and attachment text may carry any UTF-16 unit.
    (Kind::Request, "desktop/localLink/open", &["/projectPath", "/href", "/confirmedPath"]),
    (Kind::Request, "desktop/attachment/write", &["/dataUrl", "/name"]),
    (Kind::Request, "desktop/launchVersion/record", &["/path"]),
    (Kind::Request, "desktop/launchVersion/acknowledge", &["/path"]),
    (Kind::Request, "desktop/userFile/write", &["/path", "/text"]),
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
    (Kind::Request, "projectFs/localPage/virtual", &["/files/*/text"]),
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
    (Kind::Answer, "host/computer/displays", &["/*/label"]),
    // The text of a Computer Use screen capture reply: the model reads it as the tool's result.
    (Kind::Answer, "host/computer/capture", &["/text"]),
    // A window's title as the desktop reports it, a bridge reply's text and error: the model reads them as the tool's result.
    (Kind::Answer, "host/computer/appWindows", &["/windows/*/title"]),
    (Kind::Answer, "host/computer/command", &["/text", "/error"]),
    // The text an app-input answer carries back (what the field reads after typing): the model reads it as the tool's result.
    (Kind::Answer, "host/computer/appInput", &["/text"]),
    // The Computer Use command the live harness sends (dev/computer/run, a test hook): its text and keys are what the model typed.
    (Kind::Request, "dev/computer/run", &["/command/**"]),
    // The Computer Use command the desktop's bridge forwards (computer/bridge/run): its text and keys are what the model typed.
    (Kind::Request, "computer/bridge/run", &["/command/**"]),
    // The browser command the desktop's bridge forwards (browser/bridge/run): its text, selectors and scripts are what the model typed.
    (Kind::Request, "browser/bridge/run", &["/command/**"]),
    // What a human-only hold is for: the model reads it in Computer Use's refusal.
    (Kind::Request, "host/humanOnly/begin", &["/label"]),
    // Language-server params, per field (tests/it/free_text_fields.json `payloads` lsp/request): document text, messages,
    // labels, titles and other prose, forwarded as Node forwards them (a code action's diagnostic message included). A rename's
    // new name, a symbol query, a command, a URI, a token, a diagnostic's code, a vocabulary word and a server's own `data`
    // name or run something on the server: refused (recorded, native/core/fixtures/lone-surrogate-wire).
    (
        Kind::Request,
        "lsp/request",
        &[
            "/request/params/detail",
            "/request/params/documentation",
            "/request/params/documentation/value",
            "/request/params/labelDetails/detail",
            "/request/params/labelDetails/description",
            "/request/params/insertText",
            "/request/params/textEditText",
            "/request/params/textEdit/newText",
            "/request/params/additionalTextEdits/*/newText",
            "/request/params/textEdits/*/newText",
            "/request/params/title",
            "/request/params/command/title",
            "/request/params/label/*/command/title",
            "/request/params/disabled/reason",
            "/request/params/tooltip",
            "/request/params/tooltip/value",
            "/request/params/label/*/tooltip",
            "/request/params/label/*/tooltip/value",
            "/request/params/edit/changes/*/*/newText",
            "/request/params/edit/documentChanges/*/edits/*/newText",
            "/request/params/edit/changeAnnotations/*/label",
            "/request/params/edit/changeAnnotations/*/description",
            "/request/params/item/detail",
            "/request/params/context/activeSignatureHelp/signatures/*/label",
            "/request/params/context/activeSignatureHelp/signatures/*/documentation",
            "/request/params/context/activeSignatureHelp/signatures/*/documentation/value",
            "/request/params/context/activeSignatureHelp/signatures/*/parameters/*/documentation",
            "/request/params/context/activeSignatureHelp/signatures/*/parameters/*/documentation/value",
            "/request/params/context/triggerCharacter",
            "/request/params/ch",
            "/request/params/label",
            "/request/params/label/*/value",
            "/request/params/sortText",
            "/request/params/filterText",
            "/request/params/commitCharacters/*",
            "/request/params/context/activeSignatureHelp/signatures/*/parameters/*/label",
            "/request/params/context/diagnostics/*/source",
            "/request/params/context/diagnostics/*/message",
            "/request/params/context/diagnostics/*/relatedInformation/*/message",
            "/request/params/diagnostics/*/source",
            "/request/params/diagnostics/*/message",
            "/request/params/diagnostics/*/relatedInformation/*/message",
        ],
    ),
    // A patch's text (file content), given to `git apply`.
    (Kind::Request, "git/applyPatch", &["/patch"]),
    // Values a person types into a form: a workflow's inputs (a JSON body), a provider's extra body fields (their size is
    // measured as Node measures it, mixdog-ai providers/custom/config.rs `normalize_request_body`) and header
    // values, which the provider check refuses outside Latin-1 with Node's message (`normalize_headers`); a probed server's
    // header values, which the probe never sends (any header is configured authentication). Recorded,
    // native/core/fixtures/lone-surrogate-wire.
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
        &["/event/text", "/event/delta", "/event/message", "/event/pointer", "/event/reason", "/event/stop/value", "/event/value/**", "/event/call/arguments/**", "/event/calls/*/arguments/**", "/event/replay/items/**"],
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
    (
        Kind::Answer,
        "host/browser/pages/resolve",
        &["/page/facts/title", "/page/facts/fault", "/page/facts/pendingDialog/message", "/page/facts/pendingDialog/defaultPrompt", "/page/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/pages/list",
        &["/pages/*/facts/title", "/pages/*/facts/fault", "/pages/*/facts/pendingDialog/message", "/pages/*/facts/pendingDialog/defaultPrompt", "/pages/*/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/pages/surface",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/page/navigate",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/page/stop",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/page/eval",
        &["/exception/text", "/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message", "/value/**"],
    ),
    (
        Kind::Answer,
        "host/browser/page/read",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message", "/payload/**"],
    ),
    (
        Kind::Answer,
        "host/browser/page/renderCheckpoint",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/page/domQuiet",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/page/dialog/answer",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/page/sync",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/snapshot",
        &["/payload/title", "/payload/elements/*/name", "/payload/elements/*/value", "/payload/headings/*", "/payload/text", "/payload/query", "/payload/warnings/*", "/warnings/*", "/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/ref/call",
        &["/exception/text", "/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message", "/value/**"],
    ),
    (
        Kind::Answer,
        "host/browser/ref/mint",
        &["/matches/*/role", "/matches/*/name", "/invalid", "/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/input/batch",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/screenshot",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/cdp/send",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message", "/result/**"],
    ),
    (
        Kind::Answer,
        "host/browser/cookies",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message", "/cookies/*/**"],
    ),
    (
        Kind::Answer,
        "host/browser/storage",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message", "/entries/**"],
    ),
    (
        Kind::Answer,
        "host/browser/initScripts",
        &["/scripts/*/source"],
    ),
    (
        Kind::Answer,
        "host/browser/intercept",
        &["/rules/*/body"],
    ),
    (
        Kind::Answer,
        "host/browser/performance",
        &["/metrics/**", "/summary/**"],
    ),
    (
        Kind::Answer,
        "host/browser/emulation",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/upload",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/upload/receiver",
        &["/key", "/url", "/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/signIn",
        &["/note", "/line", "/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/revision",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Answer,
        "host/browser/credentials/fill",
        &["/reason", "/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Notification,
        "host/browser/events",
        &["/events/*/params/**"],
    ),
    (
        Kind::Notification,
        "host/browser/page/facts",
        &["/facts/title", "/facts/fault", "/facts/pendingDialog/message", "/facts/pendingDialog/defaultPrompt", "/facts/dismissedDialog/message"],
    ),
    (
        Kind::Request,
        "test/browserEngine/run",
        &["/args/**"],
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
        LoneAt::Value(pointer) | LoneAt::Unit { pointer, .. } => patterns.filter(|pattern| !pattern.ends_with("/{}")).any(|pattern| matches(pattern, pointer)),
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
        // A server's header value becomes a header: refused, and so is its name. A language server's params per field.
        assert_eq!(refused(Kind::Request, "mcp/addMcpServer", &[text("/input/headers/X-Token")]), Some("/input/headers/X-Token"));
        assert_eq!(refused(Kind::Request, "mcp/addMcpServer", &[LoneAt::Key("/input/headers/X-Token".into())]), Some("/input/headers/X-Token"));
        assert_eq!(refused(Kind::Request, "lsp/request", &[text("/request/params/newName")]), Some("/request/params/newName"));
        assert_eq!(refused(Kind::Request, "lsp/request", &[text("/request/params/textEdit/newText")]), None);
        // A code action's diagnostic: its message is text, its code an identifier.
        assert_eq!(refused(Kind::Request, "lsp/request", &[text("/request/params/context/diagnostics/0/message")]), None);
        assert_eq!(
            refused(Kind::Request, "lsp/request", &[text("/request/params/context/diagnostics/0/code")]),
            Some("/request/params/context/diagnostics/0/code")
        );
    }
}
