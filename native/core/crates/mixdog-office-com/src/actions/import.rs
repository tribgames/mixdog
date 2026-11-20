//! `replace_presentation_from_source`: the session's deck replaced by slides of another deck (the `import_slides` operation
//! of a background PowerPoint session that starts from an empty deck). The source is opened and saved onto the session's path,
//! trimmed and ordered to the selection, saved, and the session is reopened on it; any failure takes the deck back from the
//! checkpoint.

use mixdog_fsio::WriteProof;

use super::Actions;
use super::document::item_with;
use super::location;
use super::null_call;
use super::reopen::reopen_background_powerpoint_session;
use super::text;
use crate::com::Error;
use crate::com::Value as Com;
use crate::host::Emitter;
use crate::identity::Ownership;
use crate::office::get_full_path;
use crate::office::long_of;
use crate::office::save_document;
use crate::office::save_format_for_path;
use crate::ps::ObjectKind;
use crate::ps::Value;
use crate::ps::convert;
use crate::ps::payload;
use crate::ps::pipeline_items;
use crate::state::Mode;
use crate::state::SessionState;
use crate::state::session_response;

/// `[int]$value` of a COM value.
fn int_of(value: &Com) -> Result<i32, Error> {
    long_of(value)
        .and_then(|number| i32::try_from(number).ok())
        .ok_or_else(|| Error::host(format!("Cannot convert the value of type \"{}\" to type \"System.Int32\".", value.dotnet_type_name())))
}

/// The slides the request selects, in the order they are placed: `slides` when it holds any, else every slide of the source.
fn selection(request: &Value, source_slide_count: i32) -> Result<Vec<i32>, String> {
    let slides = payload::property(request, "slides");
    if convert::to_bool(&slides) {
        return pipeline_items(&slides).iter().map(convert::to_int).collect();
    }
    Ok((1..=source_slide_count).collect())
}

/// The source deck cut down to the selection: unselected slides deleted from the end, the kept ones placed by slide id in
/// the order selected, a slide selected again duplicated into its places.
fn arrange_slides(document: &crate::com::Obj, selected: &[i32], source_slide_count: i32) -> Result<(), Error> {
    let slides = || document.get("Slides");
    let mut source_ids: Vec<(i32, i32)> = Vec::new();
    for &slide_number in selected {
        if !source_ids.iter().any(|(known, _)| *known == slide_number) {
            let slide = item_with(&slides()?, Com::I4(slide_number))?;
            source_ids.push((slide_number, int_of(&slide.member("SlideID")?)?));
        }
    }
    for slide_index in (1..=source_slide_count).rev() {
        if !source_ids.iter().any(|(known, _)| *known == slide_index) {
            item_with(&slides()?, Com::I4(slide_index))?.call_member("Delete", &[])?;
        }
    }
    let mut placed: Vec<i32> = Vec::new();
    for (position, &source_slide) in selected.iter().enumerate() {
        let target_index = i32::try_from(position + 1).unwrap_or(i32::MAX);
        let source_id = source_ids.iter().find(|(known, _)| *known == source_slide).map_or(0, |(_, id)| *id);
        let slide = slides()?.call_member("FindBySlideID", &[Com::I4(source_id)])?;
        if placed.contains(&source_slide) {
            let duplicates = slide.call_member("Duplicate", &[])?;
            item_with(&duplicates, Com::I4(1))?.call_member("MoveTo", &[Com::I4(target_index)])?;
        } else {
            slide.call_member("MoveTo", &[Com::I4(target_index)])?;
            placed.push(source_slide);
        }
    }
    Ok(())
}

/// What the replacement does until it fails or is done.
fn replace<P: WriteProof>(actions: &Actions<'_, P>, out: &mut Emitter, state: &mut SessionState, source_path: &str, request: &Value) -> Result<Value, String> {
    let current = state.document.clone().ok_or_else(|| text(null_call()))?;
    current.call("Close", &[]).map_err(text)?;
    state.document = None;
    let application = state.app.clone().ok_or_else(|| text(null_call()))?;
    let document = application
        .get("Presentations")
        .and_then(|decks| decks.call_member("Open", &[Com::from(source_path), Com::Bool(false), Com::Bool(false), Com::Bool(false)]))
        .map_err(text)?
        .into_obj()
        .ok_or_else(|| "Microsoft Office did not answer a document.".to_owned())?;
    state.document = Some(document.clone());
    let save_format = save_format_for_path("pptx", &state.path).unwrap_or(24);
    document.call("SaveAs", &[Com::from(state.path.as_str()), Com::I4(save_format)]).map_err(text)?;
    let slide_count = document.get("Slides").and_then(|slides| slides.member("Count")).map_err(text)?;
    let source_slide_count = int_of(&slide_count).map_err(text)?;
    let selected = selection(request, source_slide_count)?;
    if selected.iter().any(|&slide| slide < 1 || slide > source_slide_count) {
        return Err(format!("import_slides selection is outside source deck range 1-{source_slide_count}"));
    }
    let identity = selected.len() == usize::try_from(source_slide_count).unwrap_or(0)
        && selected.iter().enumerate().all(|(index, &slide)| i64::try_from(index + 1).is_ok_and(|expected| i64::from(slide) == expected));
    if !identity {
        arrange_slides(&document, &selected, source_slide_count).map_err(text)?;
    }
    save_document(Some(&document), "pptx").map_err(text)?;
    // The reopen quits the application and waits for its process, which does not end while something holds a reference to
    // it: the handles this replacement took (the closed deck, the application, the new deck) are released first, as the
    // PowerShell host's release of the state's objects released the one wrapper they shared.
    drop(document);
    drop(application);
    drop(current);
    reopen_background_powerpoint_session(actions, out, state, "")?;
    let document = state.document.clone().ok_or_else(|| text(null_call()))?;
    let value = actions.snapshot(&document, "pptx", &super::empty_payload()).map_err(text)?;
    let result = Value::object(
        ObjectKind::Ordered,
        vec![
            ("op", Value::string("import_slides")),
            ("changed", Value::Bool(true)),
            ("count", Value::Int(i32::try_from(selected.len()).unwrap_or(i32::MAX))),
            ("source", Value::string(source_path)),
            ("replacedEmptyDeck", Value::Bool(true)),
        ],
    );
    let fields = Value::object(ObjectKind::Ordered, vec![("saved", Value::Bool(true)), ("results", Value::Array(vec![result])), ("value", value)]);
    session_response(state, &actions.env, &fields)
}

/// The `replace_presentation_from_source` action of an owned background PowerPoint session.
pub fn replace_presentation_from_source<P: WriteProof>(
    actions: &Actions<'_, P>,
    out: &mut Emitter,
    state: &mut SessionState,
    request: &Value,
) -> Result<Value, String> {
    if state.format != "pptx" || state.mode != Mode::Background || state.ownership != Ownership::Owned {
        return Err("PowerPoint source replacement is available only for owned background sessions".to_owned());
    }
    let source_path = get_full_path(&convert::to_ps_string(&payload::property(request, "source")))?;
    let checkpoint = get_full_path(&convert::to_ps_string(&payload::property(request, "checkpoint")))?;
    let message = match replace(actions, out, state, &source_path, request) {
        Ok(answer) => return Ok(answer),
        Err(message) => message,
    };
    let failed_at = location(file!(), line!());
    if let Some(document) = state.document.take() {
        let _ = document.call("Close", &[]);
    }
    let restore_path = if actions.exists(&checkpoint) { checkpoint.as_str() } else { "" };
    let restore_warning = match reopen_background_powerpoint_session(actions, out, state, restore_path) {
        Ok(_) => String::new(),
        Err(error) => format!(" Restore reopen failed: {error}"),
    };
    Err(format!("replace_presentation_from_source failed at {failed_at}: {message}{restore_warning}"))
}
