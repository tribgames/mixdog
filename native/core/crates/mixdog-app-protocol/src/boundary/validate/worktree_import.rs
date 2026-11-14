//! Input validation for the `worktree_import` methods: the Lead worktree and branch methods and the conversation
//! import methods. Each check is the desktop's argument check of the same capability (the shape of its one object
//! argument, with its messages and limits), applied to the protocol field that carries that argument. Paths, refs,
//! ids and sources are resolved and checked by the services.
//!
//! An argument that is the empty object has no field to check and passes: a service reports the fields it
//! needs, and the recorded client inputs carry `{}` for arguments they do not fill.

use mixdog_js::js_trim;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;

use crate::error::ErrorData;

const MAX_REF_LENGTH: usize = 255;
const MAX_PATH_LENGTH: usize = 4096;
const MAX_TEXT: usize = 4096;
const MAX_IDS: usize = 100_000;
const MAX_WORKTREES_LIMIT: f64 = 1000.0;
const UNUSED_DAYS_LIMIT: f64 = 3650.0;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

type Checked = Result<(), ErrorData>;

/// The object argument being checked, and the JSON pointer it sits at.
struct Obj<'a> {
    map: &'a Map<String, Value>,
    path: String,
}

fn invalid(path: String, expected: String) -> ErrorData {
    ErrorData::InvalidParams { path, expected }
}

impl<'a> Obj<'a> {
    fn at(&self, key: &str) -> String {
        format!("{}/{key}", self.path)
    }

    fn fail(&self, key: &str, expected: String) -> Checked {
        Err(invalid(self.at(key), expected))
    }

    fn has(&self, key: &str) -> bool {
        self.map.contains_key(key)
    }

    fn is(&self, key: &str, value: &str) -> bool {
        self.map.get(key).and_then(Value::as_str) == Some(value)
    }

    fn is_true(&self, key: &str) -> bool {
        self.map.get(key) == Some(&Value::Bool(true))
    }

    /// `Number.isSafeInteger(input[key])`, as the integer's value.
    fn safe_integer(&self, key: &str) -> Option<f64> {
        self.map
            .get(key)
            .and_then(Value::as_f64)
            .filter(|number| number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER)
    }

    /// An object that must be there: `{}` is a value here, not an absent argument.
    fn nested(&self, key: &str, name: &str) -> Result<Obj<'a>, ErrorData> {
        match self.map.get(key).and_then(Value::as_object) {
            Some(map) => Ok(Obj { map, path: self.at(key) }),
            None => Err(invalid(self.at(key), format!("{name} must be an object."))),
        }
    }
}

/// The object argument carried in `field` of `params`: `None` when there is nothing to check (absent, or null where
/// the argument is optional, or `{}`); a value that is not an object is refused.
fn object_arg<'a>(params: &'a Value, field: &str, name: &str, optional: bool) -> Result<Option<Obj<'a>>, ErrorData> {
    let Some(value) = params.get(field) else { return Ok(None) };
    if optional && value.is_null() {
        return Ok(None);
    }
    match value.as_object() {
        Some(map) if map.is_empty() => Ok(None),
        Some(map) => Ok(Some(Obj { map, path: format!("/{field}") })),
        None => Err(invalid(format!("/{field}"), format!("{name} must be an object."))),
    }
}

fn with_object(params: &Value, field: &str, name: &str, optional: bool, check: impl FnOnce(&Obj) -> Checked) -> Checked {
    match object_arg(params, field, name, optional)? {
        Some(obj) => check(&obj),
        None => Ok(()),
    }
}

fn allow_keys(obj: &Obj, keys: &[&str], name: &str) -> Checked {
    if obj.map.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err(invalid(obj.path.clone(), format!("{name} contains an unsupported field.")));
    }
    Ok(())
}

/// A string that is not blank and at most `max` UTF-16 units; `tail` finishes the message.
fn text(obj: &Obj, key: &str, label: &str, max: usize, tail: &str) -> Checked {
    match obj.map.get(key).and_then(Value::as_str) {
        Some(value) if !js_trim(value).is_empty() && utf16_len(value) <= max => Ok(()),
        _ => obj.fail(key, format!("{label} must be {tail}.")),
    }
}

fn plain_text(obj: &Obj, key: &str, label: &str) -> Checked {
    text(obj, key, label, MAX_TEXT, "a non-empty string")
}

fn ref_text(obj: &Obj, key: &str, label: &str) -> Checked {
    text(obj, key, label, MAX_REF_LENGTH, "a non-empty string")
}

fn project_path_text(obj: &Obj, key: &str, label: &str) -> Checked {
    text(obj, key, label, MAX_PATH_LENGTH, "a non-empty path")
}

fn optional_text(obj: &Obj, key: &str, label: &str) -> Checked {
    if obj.has(key) { plain_text(obj, key, label) } else { Ok(()) }
}

/// A commit object id (4-64 hex digits): never a ref name or an option.
fn commit_id(obj: &Obj, key: &str, label: &str) -> Checked {
    match obj.map.get(key).and_then(Value::as_str) {
        Some(id) if (4..=64).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_hexdigit()) => Ok(()),
        _ => obj.fail(key, format!("{label} must be a commit id.")),
    }
}

fn optional_revision(obj: &Obj, name: &str) -> Checked {
    if obj.has("expectedRevision") && !obj.safe_integer("expectedRevision").is_some_and(|revision| revision >= 0.0) {
        return obj.fail("expectedRevision", format!("{name}.expectedRevision must be a non-negative integer."));
    }
    Ok(())
}

fn optional_boolean(obj: &Obj, key: &str, name: &str) -> Checked {
    if obj.map.get(key).is_some_and(|value| !value.is_boolean()) {
        return obj.fail(key, format!("{name}.{key} must be a boolean."));
    }
    Ok(())
}

/// `String(input[key])`, which is how the branch action is compared.
fn js_string(obj: &Obj, key: &str) -> String {
    obj.map.get(key).map_or_else(|| "undefined".to_owned(), value_to_string)
}

/// `None`: this group does not own `method`.
pub fn check(method: &str, params: Option<&Value>) -> Option<Result<(), ErrorData>> {
    static NONE: Value = Value::Null;
    let params = params.unwrap_or(&NONE);
    Some(match method {
        "project/inspectProjectBranch" => inspect_project_branch(params),
        "project/manageProjectBranch" => manage_project_branch(params),
        "thread/selectBranch" => select_branch(params),
        "project/getProjectBranchMenu" => get_project_branch_menu(params),
        "project/selectProjectBranch" => select_project_branch(params),
        "project/mergeProjectBranch" => merge_project_branch(params),
        "thread/requestWorktree" => request_worktree(params),
        "thread/mergeWorkspace" => merge_workspace(params),
        "project/removeWorktree" => remove_worktree(params),
        "config/setWorktreeSettings" => set_worktree_settings(params),
        "project/deleteWorktree" => delete_worktree(params),
        "project/pruneWorktrees" => repo_common_dir(params, "pruneWorktrees input"),
        "project/previewWorktreeCleanup" => repo_common_dir(params, "previewWorktreeCleanup input"),
        "import/listImportableConversations" => list_importable_conversations(params),
        "import/getConversationImportJobs" => get_conversation_import_jobs(params),
        "import/registerConversationImportFile" => register_conversation_import_file(params),
        "import/startConversationImport" => start_conversation_import(params),
        "import/cancelConversationImport" => cancel_conversation_import(params),
        _ => return None,
    })
}

fn inspect_project_branch(params: &Value) -> Checked {
    let name = "inspectProjectBranch input";
    with_object(params, "input", name, false, |input| {
        allow_keys(input, &["projectPath", "branch"], name)?;
        project_path_text(input, "projectPath", "projectPath")?;
        ref_text(input, "branch", "branch")
    })
}

fn manage_project_branch(params: &Value) -> Checked {
    let name = "manageProjectBranch input";
    with_object(params, "input", name, false, |input| {
        allow_keys(
            input,
            &["projectPath", "branch", "action", "commit", "target", "targetCommit", "confirmed", "force"],
            name,
        )?;
        project_path_text(input, "projectPath", "projectPath")?;
        ref_text(input, "branch", "branch")?;
        commit_id(input, "commit", "commit")?;
        optional_boolean(input, "force", name)?;
        if input.has("force") && !input.is("action", "delete-branch") {
            return input.fail("force", format!("{name}.force applies to delete-branch only."));
        }
        let action_known = ["merge", "remove-worktree", "delete-branch"].contains(&js_string(input, "action").as_str());
        if !action_known || !input.is_true("confirmed") {
            let key = if action_known { "confirmed" } else { "action" };
            return input.fail(key, "A supported branch action and explicit confirmation are required.".to_owned());
        }
        if !input.is("action", "remove-worktree") {
            ref_text(input, "target", "target")?;
            commit_id(input, "targetCommit", "targetCommit")?;
        }
        Ok(())
    })
}

fn select_branch(params: &Value) -> Checked {
    let name = "selectBranch input";
    with_object(params, "input", name, false, |input| {
        allow_keys(input, &["branch", "create", "expectedRevision", "confirmLarge"], name)?;
        ref_text(input, "branch", "selectBranch input.branch")?;
        optional_boolean(input, "create", name)?;
        optional_boolean(input, "confirmLarge", name)?;
        optional_revision(input, name)
    })
}

fn get_project_branch_menu(params: &Value) -> Checked {
    let name = "getProjectBranchMenu input";
    with_object(params, "input", name, false, |input| {
        allow_keys(input, &["projectPath"], name)?;
        project_path_text(input, "projectPath", "getProjectBranchMenu input.projectPath")
    })
}

fn select_project_branch(params: &Value) -> Checked {
    let name = "selectProjectBranch input";
    with_object(params, "input", name, false, |input| {
        allow_keys(input, &["projectPath", "branch", "create", "remote", "startPoint", "detach"], name)?;
        project_path_text(input, "projectPath", "selectProjectBranch input.projectPath")?;
        if input.has("detach") {
            commit_id(input, "detach", "selectProjectBranch input.detach")?;
            if ["branch", "create", "remote", "startPoint"].iter().any(|key| input.has(key)) {
                return input.fail(
                    "detach",
                    "selectProjectBranch input.detach excludes branch, create, remote and startPoint.".to_owned(),
                );
            }
            return Ok(());
        }
        ref_text(input, "branch", "selectProjectBranch input.branch")?;
        optional_boolean(input, "create", name)?;
        optional_boolean(input, "remote", name)?;
        if input.is_true("create") && input.is_true("remote") {
            return input.fail(
                "remote",
                "selectProjectBranch input cannot both create and check out a remote branch.".to_owned(),
            );
        }
        if input.has("startPoint") {
            commit_id(input, "startPoint", "selectProjectBranch input.startPoint")?;
            if !input.is_true("create") {
                return input.fail("startPoint", "selectProjectBranch input.startPoint needs create: true.".to_owned());
            }
        }
        Ok(())
    })
}

fn merge_project_branch(params: &Value) -> Checked {
    let name = "mergeProjectBranch input";
    with_object(params, "input", name, false, |input| {
        allow_keys(input, &["projectPath", "branch", "target"], name)?;
        project_path_text(input, "projectPath", "mergeProjectBranch input.projectPath")?;
        ref_text(input, "branch", "mergeProjectBranch input.branch")?;
        ref_text(input, "target", "mergeProjectBranch input.target")
    })
}

fn request_worktree(params: &Value) -> Checked {
    let name = "requestWorktree input";
    with_object(params, "input", name, false, |input| {
        // `prompt` and `txId` are the New Task worktree choice the core reads (worktree_service.rs request_input): the prompt it
        // names the worktree after and the transaction id. The desktop's IPC check never saw them; the protocol's clients send them.
        allow_keys(input, &["name", "expectedRevision", "confirmLarge", "provision", "carryChanges", "prompt", "txId"], name)?;
        if input.map.get("name").is_some_and(|value| !value.is_null()) {
            ref_text(input, "name", "requestWorktree input.name")?;
        }
        optional_boolean(input, "confirmLarge", name)?;
        optional_boolean(input, "provision", name)?;
        if input.has("carryChanges") && !input.is("carryChanges", "leave") && !input.is("carryChanges", "carry") {
            return input.fail("carryChanges", format!("{name}.carryChanges must be leave or carry."));
        }
        optional_revision(input, name)
    })
}

fn merge_workspace(params: &Value) -> Checked {
    let name = "mergeWorkspace input";
    with_object(params, "input", name, false, |input| {
        allow_keys(input, &["confirmed", "target", "expectedRevision", "cleanup"], name)?;
        if !input.is_true("confirmed") {
            return input.fail("confirmed", "mergeWorkspace requires confirmed: true.".to_owned());
        }
        ref_text(input, "target", "mergeWorkspace input.target")?;
        optional_revision(input, name)?;
        optional_boolean(input, "cleanup", name)
    })
}

fn remove_worktree(params: &Value) -> Checked {
    let name = "removeWorktree input";
    with_object(params, "input", name, true, |input| {
        allow_keys(input, &["force", "expectedRevision"], name)?;
        optional_boolean(input, "force", name)?;
        optional_revision(input, name)
    })
}

fn set_worktree_settings(params: &Value) -> Checked {
    let name = "worktree settings";
    with_object(params, "patch", name, false, |patch| {
        allow_keys(
            patch,
            &[
                "newTaskDefault",
                "branchPrefix",
                "sizeWarnBytes",
                "autoCleanup",
                "maxWorktrees",
                "unusedDays",
                "cleanupArchived",
                "deleteBranch",
            ],
            name,
        )?;
        if patch.has("newTaskDefault") && !patch.is("newTaskDefault", "branch") && !patch.is("newTaskDefault", "worktree") {
            return patch.fail("newTaskDefault", format!("{name} newTaskDefault must be branch or worktree."));
        }
        // "" (no prefix) is a valid choice; the runtime checks the ref shape.
        if patch.has("branchPrefix")
            && !patch.map["branchPrefix"].as_str().is_some_and(|prefix| utf16_len(prefix) <= MAX_REF_LENGTH)
        {
            return patch.fail("branchPrefix", format!("{name} branchPrefix must be a string."));
        }
        if patch.has("sizeWarnBytes") && !patch.safe_integer("sizeWarnBytes").is_some_and(|bytes| bytes >= 0.0) {
            return patch.fail("sizeWarnBytes", format!("{name} sizeWarnBytes must be a non-negative integer."));
        }
        optional_boolean(patch, "autoCleanup", name)?;
        optional_boolean(patch, "cleanupArchived", name)?;
        optional_boolean(patch, "deleteBranch", name)?;
        for (key, limit) in [("maxWorktrees", MAX_WORKTREES_LIMIT), ("unusedDays", UNUSED_DAYS_LIMIT)] {
            if patch.has(key) && !patch.safe_integer(key).is_some_and(|value| (0.0..=limit).contains(&value)) {
                return patch.fail(key, format!("{name} {key} must be an integer from 0 to {limit}."));
            }
        }
        Ok(())
    })
}

fn delete_worktree(params: &Value) -> Checked {
    let name = "deleteWorktree input";
    with_object(params, "input", name, false, |input| {
        allow_keys(input, &["entryId", "force"], name)?;
        ref_text(input, "entryId", "deleteWorktree input.entryId")?;
        optional_boolean(input, "force", name)
    })
}

/// `pruneWorktrees` and `previewWorktreeCleanup`: an optional repository common directory.
fn repo_common_dir(params: &Value, name: &str) -> Checked {
    with_object(params, "input", name, true, |input| {
        allow_keys(input, &["repoCommonDir"], name)?;
        if input.has("repoCommonDir") {
            project_path_text(input, "repoCommonDir", &format!("{name}.repoCommonDir"))?;
        }
        Ok(())
    })
}

fn source(obj: &Obj, label: &str) -> Checked {
    if ["codex", "claude", "cowork"].iter().any(|source| obj.is("source", source)) {
        return Ok(());
    }
    obj.fail("source", format!("{label} must be codex, claude, or cowork."))
}

fn optional_timestamp(obj: &Obj, key: &str, name: &str) -> Checked {
    let valid = obj.map.get(key).and_then(Value::as_f64).is_some_and(|value| value.is_finite() && value >= 0.0);
    if obj.has(key) && !valid {
        return obj.fail(key, format!("{name}.{key} must be an epoch millisecond number."));
    }
    Ok(())
}

fn id_list(obj: &Obj, key: &str, name: &str) -> Checked {
    let Some(ids) = obj.map.get(key).and_then(Value::as_array).filter(|ids| ids.len() <= MAX_IDS) else {
        return obj.fail(key, format!("{name} must be a list of ids."));
    };
    for (index, id) in ids.iter().enumerate() {
        if !id.as_str().is_some_and(|id| !js_trim(id).is_empty() && utf16_len(id) <= MAX_TEXT) {
            return Err(invalid(format!("{}/{index}", obj.at(key)), format!("{name} entry must be a non-empty string.")));
        }
    }
    Ok(())
}

fn list_importable_conversations(params: &Value) -> Checked {
    let name = "listImportableConversations input";
    with_object(params, "params", name, false, |input| {
        allow_keys(input, &["source", "query", "project", "modifiedAfter", "modifiedBefore", "cursor", "limit"], name)?;
        source(input, &format!("{name}.source"))?;
        if input.has("query") && !input.map["query"].as_str().is_some_and(|query| utf16_len(query) <= MAX_TEXT) {
            return input.fail("query", format!("{name}.query must be a string."));
        }
        optional_text(input, "project", &format!("{name}.project"))?;
        optional_text(input, "cursor", &format!("{name}.cursor"))?;
        optional_timestamp(input, "modifiedAfter", name)?;
        optional_timestamp(input, "modifiedBefore", name)?;
        if input.has("limit") && !input.safe_integer("limit").is_some_and(|limit| (1.0..=100.0).contains(&limit)) {
            return input.fail("limit", format!("{name}.limit must be between 1 and 100."));
        }
        Ok(())
    })
}

fn get_conversation_import_jobs(params: &Value) -> Checked {
    let name = "getConversationImportJobs input";
    with_object(params, "params", name, true, |input| {
        allow_keys(input, &["jobId"], name)?;
        optional_text(input, "jobId", &format!("{name}.jobId"))
    })
}

fn register_conversation_import_file(params: &Value) -> Checked {
    let name = "registerConversationImportFile input";
    with_object(params, "params", name, false, |input| {
        allow_keys(input, &["source", "path"], name)?;
        source(input, &format!("{name}.source"))?;
        plain_text(input, "path", &format!("{name}.path"))
    })
}

fn start_conversation_import(params: &Value) -> Checked {
    let name = "startConversationImport input";
    with_object(params, "params", name, false, |input| {
        allow_keys(input, &["requestId", "selection"], name)?;
        plain_text(input, "requestId", &format!("{name}.requestId"))?;
        let selection = input.nested("selection", &format!("{name}.selection"))?;
        let selection_name = "startConversationImport selection";
        if selection.has("ids") {
            allow_keys(&selection, &["ids"], selection_name)?;
            id_list(&selection, "ids", &format!("{selection_name}.ids"))
        } else {
            allow_keys(&selection, &["viewId", "excludeIds"], selection_name)?;
            plain_text(&selection, "viewId", &format!("{selection_name}.viewId"))?;
            id_list(&selection, "excludeIds", &format!("{selection_name}.excludeIds"))
        }
    })
}

fn cancel_conversation_import(params: &Value) -> Checked {
    let name = "cancelConversationImport input";
    with_object(params, "params", name, false, |input| {
        allow_keys(input, &["jobId"], name)?;
        plain_text(input, "jobId", &format!("{name}.jobId"))
    })
}

#[cfg(test)]
mod validate_worktree_import {
    use serde_json::Value;

    use super::check;
    use crate::error::ErrorData;

    const FIXTURE: &str = include_str!("fixtures/worktree_import.json");
    const CLIENTS_ACCEPTED: &str = include_str!("fixtures/clients-accepted.json");

    /// Every row of `fixtures/worktree_import.json`: `expected` is null (accepted) or the refusal's `path` and message.
    #[test]
    fn fixture_rows_match() {
        let rows: Vec<Value> = serde_json::from_str(FIXTURE).expect("fixture is a JSON list");
        assert!(!rows.is_empty());
        for row in rows {
            let method = row["method"].as_str().expect("method");
            let got = check(method, Some(&row["params"])).unwrap_or_else(|| panic!("{method} is not owned"));
            let case = row["case"].as_str().unwrap_or("");
            match row["expected"].as_object() {
                None => assert_eq!(got, Ok(()), "{method}: {case}"),
                Some(expected) => {
                    let want = ErrorData::InvalidParams {
                        path: expected["path"].as_str().expect("path").to_owned(),
                        expected: expected["expected"].as_str().expect("expected").to_owned(),
                    };
                    assert_eq!(got, Err(want), "{method}: {case}");
                }
            }
        }
    }

    /// Every client input the clients send for a method of this group is accepted.
    #[test]
    fn clients_accepted_rows_pass() {
        let rows: Vec<Value> = serde_json::from_str(CLIENTS_ACCEPTED).expect("corpus is a JSON list");
        let mut seen = 0;
        for row in rows {
            let method = row["method"].as_str().expect("method");
            if let Some(got) = check(method, Some(&row["params"])) {
                assert_eq!(got, Ok(()), "{} row `{}`", method, row["case"].as_str().unwrap_or(""));
                seen += 1;
            }
        }
        assert!(seen > 0);
    }

    /// The id-list count limit, built here: a fixture row of 100,000 ids would be most of the file.
    #[test]
    fn selection_id_count_limit() {
        let params = |count: usize| serde_json::json!({"params": {"requestId": "r", "selection": {"ids": vec!["x"; count]}}});
        let method = "import/startConversationImport";
        assert_eq!(check(method, Some(&params(100_000))), Some(Ok(())));
        assert_eq!(
            check(method, Some(&params(100_001))),
            Some(Err(ErrorData::InvalidParams {
                path: "/params/selection/ids".to_owned(),
                expected: "startConversationImport selection.ids must be a list of ids.".to_owned(),
            }))
        );
    }

    #[test]
    fn other_methods_are_not_owned() {
        assert!(check("thread/start", None).is_none());
        assert!(check("project/listWorktrees", None).is_none());
    }
}
