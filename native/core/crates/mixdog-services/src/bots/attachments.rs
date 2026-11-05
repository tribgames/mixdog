//! Stored automation attachments (schedule and webhook rows) as prompt content
//! (automation-attachments.mjs). Each is `{kind: image|text|pdf|office, name, mimeType, data}`;
//! image/pdf/office data is base64, text data is plain text. Text files inline into the
//! prompt body; images and PDFs become the content parts the desktop composer submits.

use serde_json::{Value, json};

const KINDS: [&str; 4] = ["image", "text", "pdf", "office"];
pub const MAX_ATTACHMENTS: usize = 8;
/// Base64 total across image/pdf/office items (the composer's combined file limit).
const MAX_BINARY_TOTAL: usize = 28_000_000;
const MAX_TEXT_TOTAL: usize = 200_000;

/// Validates and strips an attachments value to the persisted shape; None when nothing valid.
pub fn normalize_attachments(value: &Value) -> Result<Option<Value>, String> {
    let Some(list) = value.as_array() else { return Ok(None) };
    let (mut out, mut binary, mut text) = (Vec::new(), 0usize, 0usize);
    for entry in list.iter().take(MAX_ATTACHMENTS) {
        let kind = entry["kind"].as_str().unwrap_or_default();
        let kind = mixdog_js::js_trim(kind);
        let data = entry["data"].as_str().unwrap_or_default();
        if !KINDS.contains(&kind) || data.is_empty() {
            continue;
        }
        // JS string length counts UTF-16 units.
        let size = data.encode_utf16().count();
        if kind == "text" {
            text += size;
            if text > MAX_TEXT_TOTAL {
                return Err("text attachments are too large together (200 KB max)".into());
            }
        } else {
            binary += size;
            if binary > MAX_BINARY_TOTAL {
                return Err("image/PDF/Office attachments are too large together (28 MB max)".into());
            }
        }
        let default_mime = match kind {
            "pdf" => "application/pdf",
            "image" => "image/png",
            "office" => "application/octet-stream",
            _ => "text/plain",
        };
        let name: String = mixdog_js::slice_utf16(entry["name"].as_str().unwrap_or_default(), 200);
        let mime = entry["mimeType"].as_str().filter(|m| !m.is_empty()).unwrap_or(default_mime);
        out.push(json!({
            "kind": kind,
            "name": if name.is_empty() { format!("attachment-{}", out.len() + 1) } else { name },
            "mimeType": mime,
            "data": data,
        }));
    }
    Ok((!out.is_empty()).then(|| Value::Array(out)))
}

fn entries(attachments: &Value) -> &[Value] {
    attachments.as_array().map(Vec::as_slice).unwrap_or_default()
}

fn data_of(entry: &Value) -> &str {
    entry["data"].as_str().unwrap_or_default()
}

/// The content parts of the binary attachments (images and PDFs/Office files).
pub fn binary_parts(attachments: &Value) -> Vec<Value> {
    entries(attachments)
        .iter()
        .filter(|e| !data_of(e).is_empty())
        .filter_map(|e| match e["kind"].as_str() {
            Some("image") => Some(json!({
                "type": "image",
                "data": data_of(e),
                "mimeType": e["mimeType"].as_str().filter(|m| !m.is_empty()).unwrap_or("image/png"),
            })),
            Some(kind @ ("pdf" | "office")) => Some(json!({
                "type": "file",
                "data": data_of(e),
                "mimeType": e["mimeType"].as_str().filter(|m| !m.is_empty()).unwrap_or(
                    if kind == "pdf" { "application/pdf" } else { "application/octet-stream" }
                ),
                "filename": e["name"],
            })),
            _ => None,
        })
        .collect()
}

/// The prompt text with every text attachment appended.
pub fn prompt_text(prompt: &str, attachments: &Value) -> String {
    let files: Vec<String> = entries(attachments)
        .iter()
        .filter(|e| e["kind"] == "text" && !data_of(e).is_empty())
        .map(|e| format!("--- Attached file: {} ---\n{}", e["name"].as_str().unwrap_or_default(), data_of(e)))
        .collect();
    if files.is_empty() { prompt.to_string() } else { format!("{prompt}\n\n{}", files.join("\n\n")) }
}

/// The prompt content: a plain string without binary attachments, otherwise a parts array
/// (the text, then the image/file parts).
pub fn prompt_content(prompt: &str, attachments: &Value) -> Value {
    let text = prompt_text(prompt, attachments);
    let parts = binary_parts(attachments);
    if parts.is_empty() {
        return Value::String(text);
    }
    let mut content = vec![json!({"type": "text", "text": text})];
    content.extend(parts);
    Value::Array(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_drops_invalid_entries_and_names_the_rest() {
        let value = json!([
            {"kind": "text", "data": "hello"},
            {"kind": "video", "data": "x"},
            {"kind": "image", "data": ""},
            {"kind": "pdf", "name": "n.pdf", "data": "QUJD"},
            "junk"
        ]);
        let out = normalize_attachments(&value).unwrap().unwrap();
        assert_eq!(out[0], json!({"kind":"text","name":"attachment-1","mimeType":"text/plain","data":"hello"}));
        assert_eq!(out[1], json!({"kind":"pdf","name":"n.pdf","mimeType":"application/pdf","data":"QUJD"}));
        assert_eq!(out.as_array().unwrap().len(), 2);
        assert_eq!(normalize_attachments(&json!([])).unwrap(), None);
        assert_eq!(normalize_attachments(&json!("x")).unwrap(), None);
    }

    #[test]
    fn text_totals_are_capped() {
        let big = "a".repeat(MAX_TEXT_TOTAL + 1);
        let err = normalize_attachments(&json!([{"kind":"text","data":big}])).unwrap_err();
        assert_eq!(err, "text attachments are too large together (200 KB max)");
    }

    #[test]
    fn content_is_a_string_until_a_binary_part_rides_along() {
        let text_only = json!([{"kind":"text","name":"a.txt","mimeType":"text/plain","data":"body"}]);
        assert_eq!(prompt_content("hi", &text_only), json!("hi\n\n--- Attached file: a.txt ---\nbody"));
        assert_eq!(prompt_content("hi", &Value::Null), json!("hi"));
        let with_image = json!([{"kind":"image","name":"i.png","mimeType":"image/jpeg","data":"AAA"}]);
        assert_eq!(
            prompt_content("hi", &with_image),
            json!([{"type":"text","text":"hi"},{"type":"image","data":"AAA","mimeType":"image/jpeg"}])
        );
    }
}
