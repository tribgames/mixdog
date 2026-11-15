//! The design a session carries, bound once per call: `resolveOfficeDesignContext`, `ensureOfficeSessionDesign`,
//! `mergeOfficeDesignRequest` and the persistence half of `registerOfficeSession` of `core/office-core.mjs`.
//!
//! A native document (the author's own design: no profile, no composer) never touches the design library; any other
//! request is resolved against it, and the binding that pins the pack and template version is written beside the
//! library through `mixdog_office_design::library::persist_office_design_binding`.

use std::path::Path;

use mixdog_office_base::values::{plain_object, truthy};
use mixdog_office_design::design_system::resolve_office_design;
use mixdog_office_design::library::{Context, ResolveRequest, persist_office_design_binding, resolve_office_design_library};
use mixdog_office_design::native_design::{native_office_design, uses_native_office_design};
use mixdog_statefile::WriteLane;
use serde_json::{Map, Value, json};

use super::{DesignState, Session};

/// What `resolveOfficeDesignContext` answers: `{ designRequest, designLibrary, design }`, which a session takes over as
/// its own fields (`Object.assign(session, context)`).
#[derive(Clone, Debug)]
pub struct DesignContext {
    pub design_request: Value,
    /// `None` for a native document, which has no library.
    pub design_library: Option<Value>,
    pub design: Value,
}

impl DesignContext {
    /// The context as Node's object.
    pub fn to_value(&self) -> Value {
        json!({
            "designRequest": self.design_request,
            "designLibrary": self.design_library.clone().unwrap_or(Value::Null),
            "design": self.design,
        })
    }
}

/// `resolveOfficeDesignContext({ args, dataDir, target, source, format, created })`: the design request of the call (the
/// `design` argument; for an existing document with none, a request to keep the document's own design, reviewed for a
/// deck), and the design it resolves to. Native documents stay native: no library is bound for them. Any other design
/// binds the library once, here.
pub fn resolve_office_design_context<L: WriteLane>(
    cx: &Context<'_, L>,
    data_dir: &Path,
    args: &Value,
    target: &str,
    source: &str,
    format: &str,
    created: bool,
) -> Result<DesignContext, String> {
    let design_request = match args.get("design").filter(|design| truthy(design)) {
        Some(design) => design.clone(),
        None if created => Value::Object(Map::new()),
        None => json!({ "source": "existing-document", "review": format == "pptx" }),
    };
    let operations: &[Value] = args.get("operations").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    if uses_native_office_design(format, &design_request, operations) {
        let design = native_office_design(format, &design_request)?;
        return Ok(DesignContext { design_request, design_library: None, design });
    }
    let library = resolve_office_design_library(
        cx,
        &ResolveRequest { data_dir, document_path: target, source_path: source, format, created, request: &design_request, config: None },
    )?;
    let design = resolve_office_design(format, &design_request, Some(&library))?;
    Ok(DesignContext { design_request, design_library: Some(library), design })
}

/// The options of [`ensure_office_session_design`].
#[derive(Clone, Copy, Debug, Default)]
pub struct EnsureOptions {
    /// Whether the document is new; the session's own `created` when `None`.
    pub created: Option<bool>,
    /// A `design.upgradeLibrary: true` request rebinds the library.
    pub allow_library_upgrade: bool,
    /// A native design stays native when a later call carries only review or content.
    pub preserve_native_design: bool,
}

/// `ensureOfficeSessionDesign(session, args, dataDir, options)`: binds the session design exactly once per call.
/// Open and create merge a preset; later calls may upgrade the library and keep a native document native instead of
/// applying a profile it never asked for.
pub fn ensure_office_session_design<L: WriteLane>(
    cx: &Context<'_, L>,
    data_dir: &Path,
    session: &mut Session,
    args: &Value,
    options: EnsureOptions,
) -> Result<(), String> {
    let created = options.created.unwrap_or(session.created);
    if session.design.is_none() {
        let context = resolve_office_design_context(cx, data_dir, args, &session.target, &session.source, &session.format, created)?;
        session.apply_design_context(context);
        session.design_state = DesignState::default();
        return Ok(());
    }
    let Some(request) = args.get("design").filter(|design| truthy(design)) else { return Ok(()) };
    if options.allow_library_upgrade && request.get("upgradeLibrary") == Some(&Value::Bool(true)) {
        let upgraded = resolve_office_design_context(cx, data_dir, args, &session.target, &session.source, &session.format, false)?;
        session.design_library = upgraded.design_library;
        // A native request has no library to take a binding from: `session.designLibrary.binding` is a TypeError in Node.
        let Some(library) = &session.design_library else { return Err("Cannot read properties of null (reading 'binding')".to_owned()) };
        let binding = library.get("binding").cloned().unwrap_or(Value::Null);
        persist_office_design_binding(cx.lane, cx.env, data_dir, &session.target, &binding)?;
    }
    let merged = merge_office_design_request(session.design_request.as_ref(), Some(request));
    session.design_request = Some(merged.clone());
    // A native document stays native: the `design` a later call carries is the page review (reviewed, reviewToken,
    // critique) or content, not a request for a preset. Resolving it as one would hand a Word or Excel file the default
    // profile's palette and art direction it never asked for, and put the preset review's gates in front of finalize.
    let stays_native = options.preserve_native_design
        && session.design.as_ref().and_then(|design| design.get("authoring")) == Some(&Value::String("native".to_owned()))
        && uses_native_office_design(&session.format, &merged, &[]);
    session.design = Some(if stays_native {
        native_office_design(&session.format, &merged)?
    } else {
        resolve_office_design(&session.format, &merged, session.design_library.as_ref())?
    });
    Ok(())
}

/// `{ ...value }` for the one value a spread can take: an object's entries, an array's or a string's indexed ones;
/// anything else adds nothing.
fn spread(into: &mut Map<String, Value>, value: Option<&Value>) {
    match value {
        Some(Value::Object(map)) => {
            for (key, item) in map {
                into.insert(key.clone(), item.clone());
            }
        }
        Some(Value::Array(items)) => {
            for (index, item) in items.iter().enumerate() {
                into.insert(index.to_string(), item.clone());
            }
        }
        Some(Value::String(text)) => {
            for (index, character) in text.chars().enumerate() {
                into.insert(index.to_string(), Value::String(character.to_string()));
            }
        }
        _ => {}
    }
}

/// `mergeOfficeDesignRequest(current, next)`: the later request over the earlier, its `palette` and `typography` merged
/// key by key.
pub fn merge_office_design_request(current: Option<&Value>, next: Option<&Value>) -> Value {
    let left = current.filter(|value| plain_object(value));
    let right = next.filter(|value| plain_object(value));
    let mut merged = Map::new();
    spread(&mut merged, left);
    spread(&mut merged, right);
    for key in ["palette", "typography"] {
        let (before, after) = (left.and_then(|value| value.get(key)), right.and_then(|value| value.get(key)));
        if before.is_some_and(truthy) || after.is_some_and(truthy) {
            let mut section = Map::new();
            if before.is_some_and(truthy) {
                spread(&mut section, before);
            }
            if after.is_some_and(truthy) {
                spread(&mut section, after);
            }
            merged.insert(key.to_owned(), Value::Object(section));
        }
    }
    Value::Object(merged)
}

/// The persistence half of `registerOfficeSession`: the binding of the session's library is written; a failure is not
/// fatal, it is said on the library and on the design that names it.
pub fn persist_session_binding<L: WriteLane>(cx: &Context<'_, L>, session: &mut Session) {
    let binding = session.design_library.as_ref().and_then(|library| library.get("binding")).cloned().unwrap_or(Value::Null);
    let Err(message) = persist_office_design_binding(cx.lane, cx.env, &session.data_dir, &session.target, &binding) else { return };
    let warning = Value::String(format!("Office design binding could not be persisted: {message}"));
    if let Some(Value::Object(library)) = &mut session.design_library {
        library.insert("warning".to_owned(), warning.clone());
    }
    if let Some(Value::Object(library)) = session.design.as_mut().and_then(|design| design.get_mut("library")) {
        library.insert("warning".to_owned(), warning);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_later_request_wins_and_palette_and_typography_merge_by_key() {
        let merged = merge_office_design_request(
            Some(&json!({ "profile": "clean", "palette": { "a": 1, "b": 2 }, "typography": { "h": "x" } })),
            Some(&json!({ "profile": "bold", "palette": { "b": 3 }, "review": false })),
        );
        assert_eq!(
            mixdog_js::json_stringify(&merged),
            r#"{"profile":"bold","palette":{"a":1,"b":3},"typography":{"h":"x"},"review":false}"#
        );
    }

    #[test]
    fn a_request_that_is_not_an_object_is_nothing() {
        assert_eq!(merge_office_design_request(None, Some(&json!("clean"))), json!({}));
        assert_eq!(merge_office_design_request(Some(&json!([1])), None), json!({}));
        assert_eq!(merge_office_design_request(None, Some(&json!({ "palette": null }))), json!({ "palette": null }));
    }
}
