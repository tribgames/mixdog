//! `ooxml.text` (`ooxmlText` of `src/ext-host/methods.mjs`): the text of a .docx, .pptx, .xlsx or .xlsm.
//!
//! Without `maxPartBytes` and `maxContainerBytes` (the read tool) the answer is the text, or the `Error: ...` line the tool
//! shows. With either (provider lowering) an unreadable file or package answers `null`.

use mixdog_fsio::Unlaned;
use mixdog_ooxml_text::DEFAULT_MAX_OUTPUT_BYTES;
use mixdog_ooxml_text::ExtractOptions;
use mixdog_ooxml_text::Limits;
use mixdog_ooxml_text::extract_ooxml_text;
use mixdog_ooxml_text::try_extract_ooxml_text_from_buffer;
use serde_json::Value;
use serde_json::json;

use super::js_string;
use crate::ctx::CallCtx;
use crate::error::CodedError;
use crate::registry::HandlerResult;
use crate::registry::Outcome;
use crate::registry::Registry;

pub(super) fn register(registry: &mut Registry) {
    // Runs on the registry's own thread for blocking work, so the reads below do not hold the frame loop.
    registry.register_blocking("ooxml.text", text);
}

fn text(ctx: CallCtx) -> HandlerResult {
    let params = &ctx.params;
    let file = ctx.approved_path(&js_string(params.get("path")), "")?;
    if ctx.cancel.is_cancelled() {
        return Err(CodedError::cancelled());
    }
    let max_output_bytes = params
        .get("maxOutputBytes")
        .and_then(Value::as_u64)
        .map_or(DEFAULT_MAX_OUTPUT_BYTES, |bytes| usize::try_from(bytes).unwrap_or(usize::MAX));
    if params.get("maxPartBytes").is_none() && params.get("maxContainerBytes").is_none() {
        let options = ExtractOptions { max_output_bytes };
        return Ok(Outcome::value(json!({"text": extract_ooxml_text(&Unlaned, &file, &options)})));
    }
    let Ok(bytes) = mixdog_fsio::read(&Unlaned, &file) else {
        return Ok(Outcome::value(json!({"text": null})));
    };
    let filename = match params.get("filename") {
        None | Some(Value::Null) => file.to_string_lossy().into_owned(),
        other => js_string(other),
    };
    let limit = |name: &str| params.get(name).and_then(Value::as_u64).unwrap_or(0);
    let limits = Limits {
        max_output_bytes,
        max_part_bytes: limit("maxPartBytes"),
        max_container_bytes: limit("maxContainerBytes"),
    };
    Ok(Outcome::value(json!({"text": try_extract_ooxml_text_from_buffer(&bytes, &filename, &limits)})))
}
