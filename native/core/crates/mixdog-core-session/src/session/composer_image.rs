use mixdog_core_api::domain::ext::ImageProfile;
use mixdog_core_api::domain::ext::ProfiledImageResizer;
use mixdog_core_api::domain::ext::ProfiledResizeError;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;
use serde_json::json;

/// The payload cap of `resizeImage` and `stageAttachmentOriginal` (base64 characters).
pub const MAX_PAYLOAD_CHARS: usize = 40_000_000;

/// `imageProfileForProvider`.
pub fn image_profile_for_provider(provider: &str) -> ImageProfile {
    let value = mixdog_js::js_trim(provider).to_lowercase();
    let openai = ["openai", "xai", "grok", "deepseek", "opencode-go", "mixdog-local"]
        .iter()
        .any(|name| value.strip_prefix(name).is_some_and(|rest| rest.is_empty() || rest.starts_with('-')));
    if openai { ImageProfile::OpenAi } else { ImageProfile::Anthropic }
}

/// `imageMetadataText(dims, sourcePath)` for dimensions that are all positive.
pub fn image_metadata_text(original: (u32, u32), display: (u32, u32), source: &str) -> Option<String> {
    let fallback = || (!source.is_empty()).then(|| format!("[Image source: {source}]"));
    if original.0 == 0 || original.1 == 0 || display.0 == 0 || display.1 == 0 {
        return fallback();
    }
    let mut parts = Vec::new();
    if !source.is_empty() {
        parts.push(format!("source: {source}"));
    }
    parts.push(format!("{}x{}", original.0, original.1));
    if original != display {
        let scale = f64::from(original.0) / f64::from(display.0);
        parts.push(format!(
            "displayed at {}x{}. Multiply coordinates by {} to map to the original image.",
            display.0,
            display.1,
            mixdog_js::math::to_fixed(scale, 2)
        ));
    } else {
        parts.push(format!("displayed at {}x{}", display.0, display.1));
    }
    Some(format!("[Image: {}]", parts.join(", ")))
}

/// The sextet of a base64 character in either alphabet; 64 and up is not one (Node's `unbase64`).
fn unbase64(c: u8) -> u8 {
    match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' | b'-' => 62,
        b'/' | b'_' => 63,
        _ => 255,
    }
}

/// `Buffer.from(text, 'base64')` for text that is not forgiving-base64 (Node's `nbytes`
/// `base64_decode_slow`, which also decodes what is). It reads the UTF-16 code units of the string
/// by their low byte, so `Ł` (U+0141) reads as `A`: a character outside the two alphabets is
/// skipped, decoding stops at the first `=` (or code unit whose low byte is `=`), and a dangling
/// single character carries no byte.
pub fn node_base64_decode(text: &str) -> Vec<u8> {
    let units: Vec<u8> = text.encode_utf16().map(|unit| unit as u8).collect();
    let mut out = Vec::with_capacity(units.len() / 4 * 3);
    let mut i = 0;
    while i < units.len() {
        let mut hi = 0u8;
        for step in 0..4 {
            let lo = loop {
                let c = units[i];
                i += 1;
                if unbase64(c) < 64 {
                    break unbase64(c);
                }
                if c == b'=' || i >= units.len() {
                    return out;
                }
            };
            match step {
                1 => out.push(((hi & 0x3F) << 2) | ((lo & 0x30) >> 4)),
                2 => out.push(((hi & 0x0F) << 4) | ((lo & 0x3C) >> 2)),
                3 => out.push(((hi & 0x03) << 6) | (lo & 0x3F)),
                _ => {}
            }
            if i >= units.len() {
                return out;
            }
            hi = lo;
        }
    }
    out
}

/// `buffer.toString('base64')`.
pub fn base64_of(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// `String(value || fallback)` of a payload field.
fn text_or(input: &Value, key: &str, fallback: &str) -> String {
    match input.get(key) {
        None | Some(Value::Null) | Some(Value::Bool(false)) => fallback.to_owned(),
        Some(Value::String(s)) if s.is_empty() => fallback.to_owned(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => fallback.to_owned(),
        Some(other) => mixdog_js::value_to_string(other),
    }
}

/// The resized attachment `imageAttachmentFromBuffer` builds.
pub struct Resized {
    pub content: String,
    pub media_type: String,
    pub metadata_text: Option<String>,
}

/// `imageAttachmentFromBuffer(buffer, mimeType, { filename, provider })`; the error is Node's
/// thrown message.
pub async fn image_attachment(
    resizer: &dyn ProfiledImageResizer,
    thread: &ThreadId,
    buffer: &[u8],
    mime: &str,
    filename: &str,
    provider: &str,
) -> Result<Resized, String> {
    if buffer.is_empty() {
        return Err("image is empty".into());
    }
    let mime_text = if mime.is_empty() { "image/png" } else { mime };
    let ext = mime_text.split('/').nth(1).filter(|e| !e.is_empty()).unwrap_or("png");
    match resizer.resize_profiled(thread, buffer, ext, image_profile_for_provider(provider)).await {
        Ok(Some(r)) => Ok(Resized {
            metadata_text: image_metadata_text((r.original_w, r.original_h), (r.display_w, r.display_h), filename),
            content: r.data_base64,
            media_type: r.mime,
        }),
        // The resizer is the codec of this build and is always present (the composer is constructed with it);
        // it answers nothing only for an empty buffer, which was refused above. The picked bytes are never
        // passed on as they are: only what the resizer wrote (PNG, JPEG, GIF or WebP) may become an attachment.
        Ok(None) => Err("the image resizer returned no image".into()),
        Err(ProfiledResizeError::Invalid(message)) => Err(message),
        Err(ProfiledResizeError::Host(error)) => Err(format!("{error:?}")),
    }
}

/// What `resizeImage` answers; `stage` runs only when the resized copy differs from the file as
/// picked, and a staging failure just leaves the reference out.
pub async fn resize_image<F, Fut>(resizer: &dyn ProfiledImageResizer, thread: &ThreadId, input: &Value, provider: &str, stage: F) -> Result<Value, String>
where
    F: FnOnce(Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let base64 = text_or(input, "data", "");
    if base64.is_empty() {
        return Err("resizeImage: image payload is required".into());
    }
    if mixdog_js::utf16_len(&base64) > MAX_PAYLOAD_CHARS {
        return Err("resizeImage: image too large".into());
    }
    let mime = text_or(input, "mimeType", "image/png");
    let filename = text_or(input, "filename", "Pasted image");
    let bytes = node_base64_decode(&base64);
    let attachment = image_attachment(resizer, thread, &bytes, &mime, &filename, provider).await?;
    let original_ref = if attachment.content == base64 { None } else { stage(bytes).await.ok() };
    let mut out = json!({
        "data": attachment.content,
        "mimeType": attachment.media_type,
        "metadataText": attachment.metadata_text.unwrap_or_default(),
    });
    if let (Some(reference), Some(map)) = (original_ref, out.as_object_mut()) {
        map.insert("originalRef".into(), json!(reference));
    }
    Ok(out)
}

/// `stageAttachmentOriginal({ data })`: `{ originalRef }`; `stage` stores the decoded bytes.
pub async fn stage_original_payload<F, Fut>(input: &Value, stage: F) -> Result<Value, String>
where
    F: FnOnce(Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let data = text_or(input, "data", "");
    if data.is_empty() {
        return Err("stageAttachmentOriginal: payload is required".into());
    }
    if mixdog_js::utf16_len(&data) > MAX_PAYLOAD_CHARS {
        return Err("stageAttachmentOriginal: file too large".into());
    }
    Ok(json!({ "originalRef": stage(node_base64_decode(&data)).await? }))
}
