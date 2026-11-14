//! `media.officeText` (`mediaOfficeText` of `src/ext-host/methods.mjs`): the text provider lowering gives an attached Office
//! document. The bytes arrive base64, as a message part carries them; no path is touched.

use mixdog_ooxml_text::media::office_text_for_file;
use serde_json::json;

use super::base64_param;
use crate::ctx::CallCtx;
use crate::error::CodedError;
use crate::registry::HandlerResult;
use crate::registry::Outcome;
use crate::registry::Registry;

pub(super) fn register(registry: &mut Registry) {
    registry.register_blocking("media.officeText", office_text);
}

fn office_text(ctx: CallCtx) -> HandlerResult {
    let data = base64_param(&ctx.params)?;
    let filename = ctx.params.get("filename").and_then(|name| name.as_str()).unwrap_or_default();
    if ctx.cancel.is_cancelled() {
        return Err(CodedError::cancelled());
    }
    Ok(Outcome::value(json!({"text": office_text_for_file(data, filename)})))
}
