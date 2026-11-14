//! The tool names of other agent CLIs that have no builtin of their own (Node `EXTERNAL_TOOL_REDIRECTS`), shared by the
//! unknown-tool text of the agent loop and by the adapters (`write`, `bash`, `run`) that refuse a call whose arguments are
//! not the shape they take.

/// Tools of other agent CLIs that have no builtin: the redirect names the
/// right one. Keys are lowercase.
const REDIRECTS: [(&str, &str); 27] = [
    ("write", "use `apply_patch` with an `*** Add File:` V4A section to create a file"),
    ("edit", "use `apply_patch` with a `*** Update File:` V4A section"),
    ("multiedit", "use a single `apply_patch` call with multiple `*** Update File:` sections"),
    ("strreplace", "use `apply_patch` with a `*** Update File:` V4A section"),
    ("str_replace", "use `apply_patch` with a `*** Update File:` V4A section"),
    ("str_replace_editor", "use `apply_patch` with a `*** Update File:` V4A section"),
    ("search_replace", "use `apply_patch` with a `*** Update File:` V4A section"),
    ("applypatch", "call the `apply_patch` tool (snake_case) with a V4A patch"),
    ("createfile", "use `apply_patch` with an `*** Add File:` V4A section"),
    ("create_file", "use `apply_patch` with an `*** Add File:` V4A section"),
    ("deletefile", "use `apply_patch` with a `*** Delete File:` V4A section"),
    ("delete_file", "use `apply_patch` with a `*** Delete File:` V4A section"),
    ("bash", "use the `shell` tool"),
    ("run", "use the `shell` tool"),
    ("runcommand", "use the `shell` tool"),
    ("terminal", "use the `shell` tool"),
    ("view", "use the `read` tool"),
    ("cat", "use the `read` tool"),
    ("read_file", "use the `read` tool"),
    ("ls", "use the `list` tool"),
    ("list_dir", "use the `list` tool"),
    ("searchfiles", "use the `grep` tool"),
    ("file_search", "use the `find` or `glob` tool"),
    ("grep_search", "use the `grep` tool"),
    ("codebase_search", "use the `grep` or `code_graph` tool"),
    ("semanticsearch", "use the `grep` or `code_graph` tool"),
    ("semantic_search", "use the `grep` or `code_graph` tool"),
];

/// The redirect of a foreign tool name (matched in any case): which builtin does what that tool would have done.
pub fn redirect(name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    REDIRECTS.iter().find(|(key, _)| *key == lower).map(|(_, redirect)| *redirect)
}

/// What a call by a foreign name gets when its arguments are no shape an adapter takes (Node falls back to
/// `formatUnknownBuiltinToolMessage`): the name as the model wrote it, with the redirect of that name when there is one.
pub fn refusal(called: &str) -> String {
    match redirect(called) {
        Some(redirect) => format!("Error: unknown builtin tool \"{called}\" — {redirect}."),
        None => format!("Error: unknown builtin tool \"{called}\""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_names_the_tool_as_the_model_called_it() {
        assert_eq!(refusal("create_file"), "Error: unknown builtin tool \"create_file\" — use `apply_patch` with an `*** Add File:` V4A section.");
        assert_eq!(refusal("Write"), "Error: unknown builtin tool \"Write\" — use `apply_patch` with an `*** Add File:` V4A section to create a file.");
        assert_eq!(refusal("Bash"), "Error: unknown builtin tool \"Bash\" — use the `shell` tool.");
        // Node's map has no entry for this name: the bare text.
        assert_eq!(refusal("run_terminal_cmd"), "Error: unknown builtin tool \"run_terminal_cmd\"");
        assert_eq!(redirect("STR_REPLACE"), Some("use `apply_patch` with a `*** Update File:` V4A section"));
    }
}
