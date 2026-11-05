//! Language-server capabilities as the editor sees them (port of
//! `normalizeLanguageServerCapabilities`, `capabilitiesWithDynamicRegistrations`
//! and `methodSupported` in `language-server-manager.ts`). A capability set is a
//! flat JSON object with the camelCase keys the editor reads.

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

/// (editor flag, server provider key). A provider is enabled by `true` or an object.
const FLAGS: &[(&str, &str)] = &[
    ("completion", "completionProvider"),
    ("signatureHelp", "signatureHelpProvider"),
    ("hover", "hoverProvider"),
    ("declaration", "declarationProvider"),
    ("definition", "definitionProvider"),
    ("typeDefinition", "typeDefinitionProvider"),
    ("implementation", "implementationProvider"),
    ("references", "referencesProvider"),
    ("documentHighlight", "documentHighlightProvider"),
    ("linkedEditingRange", "linkedEditingRangeProvider"),
    ("documentSymbol", "documentSymbolProvider"),
    ("codeLens", "codeLensProvider"),
    ("rename", "renameProvider"),
    ("codeAction", "codeActionProvider"),
    ("formatting", "documentFormattingProvider"),
    ("rangeFormatting", "documentRangeFormattingProvider"),
    ("onTypeFormatting", "documentOnTypeFormattingProvider"),
    ("documentLink", "documentLinkProvider"),
    ("documentColor", "colorProvider"),
    ("foldingRange", "foldingRangeProvider"),
    ("selectionRange", "selectionRangeProvider"),
    ("inlayHint", "inlayHintProvider"),
    ("callHierarchy", "callHierarchyProvider"),
    ("workspaceSymbol", "workspaceSymbolProvider"),
];

/// A dynamic registration method and the flag it enables.
const DYNAMIC_FLAGS: &[(&str, &str)] = &[
    ("textDocument/completion", "completion"),
    ("textDocument/signatureHelp", "signatureHelp"),
    ("textDocument/hover", "hover"),
    ("textDocument/declaration", "declaration"),
    ("textDocument/definition", "definition"),
    ("textDocument/typeDefinition", "typeDefinition"),
    ("textDocument/implementation", "implementation"),
    ("textDocument/references", "references"),
    ("textDocument/documentHighlight", "documentHighlight"),
    ("textDocument/linkedEditingRange", "linkedEditingRange"),
    ("textDocument/documentSymbol", "documentSymbol"),
    ("textDocument/codeLens", "codeLens"),
    ("textDocument/rename", "rename"),
    ("textDocument/codeAction", "codeAction"),
    ("textDocument/formatting", "formatting"),
    ("textDocument/rangeFormatting", "rangeFormatting"),
    ("textDocument/onTypeFormatting", "onTypeFormatting"),
    ("textDocument/documentLink", "documentLink"),
    ("textDocument/documentColor", "documentColor"),
    ("textDocument/foldingRange", "foldingRange"),
    ("textDocument/selectionRange", "selectionRange"),
    ("textDocument/inlayHint", "inlayHint"),
    ("textDocument/prepareCallHierarchy", "callHierarchy"),
    ("workspace/symbol", "workspaceSymbol"),
    ("workspace/executeCommand", "executeCommand"),
];

pub fn is_dynamic_method(method: &str) -> bool {
    method == "textDocument/semanticTokens" || DYNAMIC_FLAGS.iter().any(|(m, _)| *m == method)
}

fn enabled(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true))) || value.is_some_and(Value::is_object)
}

fn flag(value: Option<&Value>) -> bool {
    value == Some(&Value::Bool(true))
}

fn strings(value: Option<&Value>, max: usize) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|a| a.iter().filter(|v| v.is_string()).take(max).cloned().collect())
        .unwrap_or_default()
}

fn short_strings(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|v| v.as_str().is_some_and(|s| !s.is_empty() && s.chars().count() <= 8))
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

pub fn normalize(initialization: &Value) -> Value {
    let caps = initialization.get("capabilities").filter(|v| v.is_object()).unwrap_or(initialization);
    let get = |key: &str| caps.get(key);
    let mut out = Map::new();
    for (name, key) in FLAGS {
        out.insert((*name).into(), Value::Bool(enabled(get(key))));
    }
    let opt = |key: &str, field: &str| get(key).and_then(|v| v.get(field));
    out.insert("completionResolve".into(), json!(flag(opt("completionProvider", "resolveProvider"))));
    out.insert("completionTriggerCharacters".into(), Value::Array(short_strings(opt("completionProvider", "triggerCharacters"))));
    out.insert("signatureHelpTriggerCharacters".into(), Value::Array(strings(opt("signatureHelpProvider", "triggerCharacters"), 64)));
    out.insert("signatureHelpRetriggerCharacters".into(), Value::Array(strings(opt("signatureHelpProvider", "retriggerCharacters"), 64)));
    out.insert("codeLensResolve".into(), json!(flag(opt("codeLensProvider", "resolveProvider"))));
    out.insert("prepareRename".into(), json!(flag(opt("renameProvider", "prepareProvider"))));
    out.insert("codeActionResolve".into(), json!(flag(opt("codeActionProvider", "resolveProvider"))));
    out.insert(
        "codeActionKinds".into(),
        Value::Array(opt("codeActionProvider", "codeActionKinds").and_then(Value::as_array).map(|a| a.iter().filter(|v| v.is_string()).cloned().collect()).unwrap_or_default()),
    );
    let mut on_type: Vec<Value> = Vec::new();
    if let Some(first) = opt("documentOnTypeFormattingProvider", "firstTriggerCharacter").filter(|v| v.is_string()) {
        on_type.push(first.clone());
    }
    on_type.extend(strings(opt("documentOnTypeFormattingProvider", "moreTriggerCharacter"), 64));
    out.insert("onTypeFormattingTriggerCharacters".into(), Value::Array(on_type));
    out.insert("documentLinkResolve".into(), json!(flag(opt("documentLinkProvider", "resolveProvider"))));
    let tokens = get("semanticTokensProvider");
    let full = tokens.and_then(|t| t.get("full"));
    out.insert("semanticTokens".into(), json!(enabled(tokens) && (flag(full) || full.is_some_and(Value::is_object))));
    out.insert("semanticTokensRange".into(), json!(enabled(tokens) && enabled(tokens.and_then(|t| t.get("range")))));
    out.insert("semanticTokensDelta".into(), json!(flag(full.and_then(|f| f.get("delta")))));
    let legend = tokens.and_then(|t| t.get("legend"));
    out.insert(
        "semanticTokensLegend".into(),
        json!({
            "tokenTypes": strings(legend.and_then(|l| l.get("tokenTypes")), 256),
            "tokenModifiers": strings(legend.and_then(|l| l.get("tokenModifiers")), 256),
        }),
    );
    out.insert("inlayHintResolve".into(), json!(flag(opt("inlayHintProvider", "resolveProvider"))));
    let commands = opt("executeCommandProvider", "commands").and_then(Value::as_array);
    out.insert("executeCommand".into(), json!(commands.is_some_and(|c| !c.is_empty())));
    Value::Object(out)
}

fn matches_selector(options: &Value, language_id: &str, uri: Option<&str>) -> bool {
    let selector = match options.get("documentSelector") {
        None | Some(Value::Null) => return true,
        Some(Value::Array(a)) if !a.is_empty() => a,
        Some(_) => return false,
    };
    let path = uri.and_then(|u| crate::lspwire::uri_to_path(u)).map(|p| p.to_string_lossy().replace('\\', "/"));
    selector.iter().any(|raw| {
        if let Some(text) = raw.as_str() {
            return text == language_id;
        }
        let Some(filter) = raw.as_object() else { return false };
        if filter.get("language").and_then(Value::as_str).is_some_and(|l| l != language_id) {
            return false;
        }
        if filter.get("scheme").and_then(Value::as_str).is_some_and(|s| s != "file") {
            return false;
        }
        if let Some(pattern) = filter.get("pattern").and_then(Value::as_str) {
            let Some(path) = &path else { return false };
            let source = crate::glob::glob_expression(&pattern.replace('\\', "/"));
            return regex::Regex::new(&format!("^{source}$")).is_ok_and(|r| r.is_match(path));
        }
        true
    })
}

fn union(base: &mut Map<String, Value>, key: &str, add: Vec<Value>) {
    let mut list: Vec<Value> = base.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    for item in add {
        if !list.contains(&item) {
            list.push(item);
        }
    }
    base.insert(key.into(), Value::Array(list));
}

fn or_flag(base: &mut Map<String, Value>, key: &str, value: bool) {
    if value {
        base.insert(key.into(), Value::Bool(true));
    }
}

/// `base` plus the registrations that apply to `language_id` / `uri`.
pub fn with_registrations(base: &Value, registrations: &[(String, Value)], language_id: &str, uri: Option<&str>) -> Value {
    let mut caps = base.as_object().cloned().unwrap_or_default();
    for (method, options) in registrations {
        if !matches_selector(options, language_id, uri) {
            continue;
        }
        if let Some((_, flag_name)) = DYNAMIC_FLAGS.iter().find(|(m, _)| m == method) {
            caps.insert((*flag_name).into(), Value::Bool(true));
        }
        let resolve = flag(options.get("resolveProvider"));
        match method.as_str() {
            "textDocument/completion" => {
                or_flag(&mut caps, "completionResolve", resolve);
                union(&mut caps, "completionTriggerCharacters", strings(options.get("triggerCharacters"), 64));
            }
            "textDocument/signatureHelp" => {
                union(&mut caps, "signatureHelpTriggerCharacters", strings(options.get("triggerCharacters"), 64));
                union(&mut caps, "signatureHelpRetriggerCharacters", strings(options.get("retriggerCharacters"), 64));
            }
            "textDocument/codeLens" => or_flag(&mut caps, "codeLensResolve", resolve),
            "textDocument/rename" => or_flag(&mut caps, "prepareRename", flag(options.get("prepareProvider"))),
            "textDocument/codeAction" => {
                or_flag(&mut caps, "codeActionResolve", resolve);
                union(&mut caps, "codeActionKinds", strings(options.get("codeActionKinds"), 256));
            }
            "textDocument/onTypeFormatting" => {
                let mut add = Vec::new();
                if let Some(first) = options.get("firstTriggerCharacter").filter(|v| v.is_string()) {
                    add.push(first.clone());
                }
                add.extend(strings(options.get("moreTriggerCharacter"), 64));
                union(&mut caps, "onTypeFormattingTriggerCharacters", add);
            }
            "textDocument/documentLink" => or_flag(&mut caps, "documentLinkResolve", resolve),
            "textDocument/semanticTokens" => {
                let full = options.get("full");
                or_flag(&mut caps, "semanticTokens", flag(full) || full.is_some_and(Value::is_object));
                or_flag(&mut caps, "semanticTokensRange", enabled(options.get("range")));
                or_flag(&mut caps, "semanticTokensDelta", flag(full.and_then(|f| f.get("delta"))));
                let legend = options.get("legend");
                caps.insert(
                    "semanticTokensLegend".into(),
                    json!({
                        "tokenTypes": strings(legend.and_then(|l| l.get("tokenTypes")), 256),
                        "tokenModifiers": strings(legend.and_then(|l| l.get("tokenModifiers")), 256),
                    }),
                );
            }
            "textDocument/inlayHint" => or_flag(&mut caps, "inlayHintResolve", resolve),
            _ => {}
        }
    }
    Value::Object(caps)
}

pub fn method_supported(method: &str, caps: &Value) -> bool {
    let on = |key: &str| caps.get(key) == Some(&Value::Bool(true));
    match method {
        "textDocument/completion" => on("completion"),
        "completionItem/resolve" => on("completionResolve"),
        "textDocument/signatureHelp" => on("signatureHelp"),
        "textDocument/hover" => on("hover"),
        "textDocument/declaration" => on("declaration"),
        "textDocument/definition" => on("definition"),
        "textDocument/typeDefinition" => on("typeDefinition"),
        "textDocument/implementation" => on("implementation"),
        "textDocument/references" => on("references"),
        "textDocument/documentHighlight" => on("documentHighlight"),
        "textDocument/linkedEditingRange" => on("linkedEditingRange"),
        "textDocument/documentSymbol" => on("documentSymbol"),
        "textDocument/codeLens" => on("codeLens"),
        "codeLens/resolve" => on("codeLensResolve"),
        "textDocument/prepareRename" => on("prepareRename"),
        "textDocument/rename" => on("rename"),
        "textDocument/codeAction" => on("codeAction"),
        "codeAction/resolve" => on("codeActionResolve"),
        "textDocument/formatting" => on("formatting"),
        "textDocument/rangeFormatting" => on("rangeFormatting"),
        "textDocument/onTypeFormatting" => on("onTypeFormatting"),
        "textDocument/documentLink" => on("documentLink"),
        "documentLink/resolve" => on("documentLinkResolve"),
        "textDocument/documentColor" | "textDocument/colorPresentation" => on("documentColor"),
        "textDocument/foldingRange" => on("foldingRange"),
        "textDocument/selectionRange" => on("selectionRange"),
        "textDocument/semanticTokens/full" => on("semanticTokens"),
        "textDocument/semanticTokens/full/delta" => on("semanticTokens") && on("semanticTokensDelta"),
        "textDocument/semanticTokens/range" => on("semanticTokensRange"),
        "textDocument/inlayHint" => on("inlayHint"),
        "inlayHint/resolve" => on("inlayHintResolve"),
        "textDocument/prepareCallHierarchy" | "callHierarchy/incomingCalls" | "callHierarchy/outgoingCalls" => on("callHierarchy"),
        "workspace/symbol" => on("workspaceSymbol"),
        "workspace/executeCommand" => on("executeCommand"),
        _ => false,
    }
}
