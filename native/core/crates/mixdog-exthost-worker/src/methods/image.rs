//! `image.probe`, `image.jpeg` and `image.validate` (`src/ext-host/image.mjs`). The image arrives base64, as a message part
//! carries it; nothing on disk is touched. An answer is `{ok}` or `{error: 'invalid' | 'environment'}`: the decoder rejected
//! the bytes, or the machine failed (only the first judges the image). `image.resize` answers the read tool's and the
//! composer's resize, `image.still` the media store's WebP rendition.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_imaging::ImagingError;
use mixdog_imaging::Profile;
use mixdog_imaging::ResizeOptions;
use serde_json::Value;
use serde_json::json;

use super::base64_param;
use super::invalid_params;
use super::js_string;
use super::node_base64;
use crate::ctx::CallCtx;
use crate::error::CodedError;
use crate::registry::HandlerResult;
use crate::registry::Outcome;
use crate::registry::Registry;

pub(super) fn register(registry: &mut Registry) {
    registry.register_blocking("image.probe", probe);
    registry.register_blocking("image.jpeg", jpeg);
    registry.register_blocking("image.validate", validate);
    registry.register_blocking("image.resize", resize);
    registry.register_blocking("image.still", still);
}

/// JavaScript's `String(value ?? '')`.
fn text_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

fn failure(error: &ImagingError) -> HandlerResult {
    let reason = if error.is_environment() { "environment" } else { "invalid" };
    Ok(Outcome::value(json!({"error": reason})))
}

fn not_cancelled(ctx: &CallCtx) -> Result<(), CodedError> {
    if ctx.cancel.is_cancelled() { Err(CodedError::cancelled()) } else { Ok(()) }
}

/// `decodedImageMeta`: the dimensions after one full pixel decode.
fn probe(ctx: CallCtx) -> HandlerResult {
    let bytes = node_base64(base64_param(&ctx.params)?);
    not_cancelled(&ctx)?;
    match mixdog_imaging::probe(&bytes) {
        Ok((width, height)) => Ok(Outcome::value(json!({"ok": {"width": width, "height": height}}))),
        Err(error) => failure(&error),
    }
}

/// `Number.isInteger` of a parameter. A whole number beyond `i64` saturates; the encoder's range check then answers it
/// `invalid`, as sharp rejects it in Node.
fn integer(params: &Value, name: &str) -> Result<i64, CodedError> {
    let whole = params.get(name).and_then(Value::as_number).and_then(|number| {
        number.as_i64().or_else(|| number.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64))
    });
    whole.ok_or_else(|| invalid_params(format!("{name} must be an integer")))
}

/// One tool-result re-encode: `compactToolResultImage`'s call at a quality.
fn jpeg(ctx: CallCtx) -> HandlerResult {
    let params = &ctx.params;
    let width = integer(params, "width")?;
    let height = integer(params, "height")?;
    let quality = integer(params, "quality")?;
    let Some(allow_enlargement) = params.get("allowEnlargement").and_then(Value::as_bool) else {
        return Err(invalid_params("allowEnlargement must be a boolean"));
    };
    let bytes = node_base64(base64_param(params)?);
    not_cancelled(&ctx)?;
    // The encoder takes a box of positive sides and a quality of 1 to 100; the decoder's judgement is "invalid" for the rest.
    let (Ok(width), Ok(height), Ok(quality)) = (u32::try_from(width), u32::try_from(height), u8::try_from(quality)) else {
        return Ok(Outcome::value(json!({"error": "invalid"})));
    };
    if !(1..=100).contains(&quality) {
        return Ok(Outcome::value(json!({"error": "invalid"})));
    }
    match mixdog_imaging::encode_tool_image_jpeg(&bytes, width, height, allow_enlargement, quality) {
        Ok(encoded) => Ok(Outcome::value(
            json!({"ok": {"data": STANDARD.encode(&encoded.data), "width": encoded.width, "height": encoded.height}}),
        )),
        Err(error) => failure(&error),
    }
}

/// `resizeImageBuffer` as the provider image preparation calls it: whether the decoder takes the image. An empty buffer gives
/// no resizer answer, which is an environment failure.
fn validate(ctx: CallCtx) -> HandlerResult {
    let bytes = node_base64(base64_param(&ctx.params)?);
    let format = text_or_empty(ctx.params.get("format"));
    not_cancelled(&ctx)?;
    match mixdog_imaging::validate(&bytes, &format) {
        Ok(()) => Ok(Outcome::value(json!({"ok": true}))),
        Err(error) => failure(&error),
    }
}

/// The read tool's resize (`read-image.mjs`): `resizeImageBuffer(buffer, ext)` end to end with its defaults. `ok` is the
/// image with its sizes, or null for an empty buffer. The composer names its provider's image `profile`; the read tool
/// names none (the Anthropic one). A decoder rejection is `invalid` with the decoder's sentence, whatever its cause,
/// because the read tool reports every `INVALID_IMAGE_DATA` the same way.
fn resize(ctx: CallCtx) -> HandlerResult {
    let bytes = node_base64(base64_param(&ctx.params)?);
    let ext = text_or_empty(ctx.params.get("ext"));
    let profile = match ctx.params.get("profile") {
        Some(Value::String(name)) => Profile::from_name(name),
        _ => Profile::default(),
    };
    not_cancelled(&ctx)?;
    match mixdog_imaging::resize_image_buffer(&bytes, &ext, ResizeOptions { profile, ..ResizeOptions::default() }) {
        Ok(None) => Ok(Outcome::value(json!({"ok": null}))),
        Ok(Some(resized)) => {
            let dimensions = resized.dimensions;
            Ok(Outcome::value(json!({"ok": {
                "data": STANDARD.encode(&resized.data),
                "mimeType": resized.mime,
                "dimensions": {
                    "originalWidth": dimensions.original_width,
                    "originalHeight": dimensions.original_height,
                    "displayWidth": dimensions.display_width,
                    "displayHeight": dimensions.display_height,
                },
            }})))
        }
        Err(error) => Ok(Outcome::value(json!({"error": "invalid", "message": error.message()}))),
    }
}

/// The media store's still rendition (`renditions.mjs` `encodeStill`): the WebP of a variant's size and quality,
/// EXIF-rotated. `ok` is `{extension, data}`, or null for a source that does not decode. The variant is judged before the
/// data, as Node judges it.
fn still(ctx: CallCtx) -> HandlerResult {
    let variant = ctx.params.get("variant");
    let Some(spec) = variant.and_then(Value::as_str).and_then(mixdog_imaging::still::rendition_spec) else {
        return Err(invalid_params(format!("unknown rendition variant: {}", js_string(variant))));
    };
    let bytes = node_base64(base64_param(&ctx.params)?);
    not_cancelled(&ctx)?;
    let answer = mixdog_imaging::still::encode_still(&bytes, spec)
        .map(|still| json!({"extension": still.extension, "data": STANDARD.encode(&still.data)}));
    Ok(Outcome::value(json!({"ok": answer})))
}
