//! `design/library/design-library-pack.mjs`: the reading of a design pack (profiles, layouts, templates), the check of
//! its Ed25519 signature over the canonical JSON of the pack, the download of a pack's templates into a cache folder
//! and the loading of a cached pack with its integrity check.
//!
//! The network is reached through [`Fetch`]; [`HttpsFetch`] is the real one. Timeouts and size limits are Node's: 10 s to
//! the response headers of the manifest, 30 s of each template, 2 MB of manifest, 64 MB of template.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use mixdog_fsio::OpenOptions;
use mixdog_js::{
    js_object_keys, js_to_lowercase, js_trim, json_number, json_stringify, string_to_number, to_number, to_number_of, utf16_len, value_to_string,
};
use mixdog_office_base::values::{clamp_of, clone, plain_object, sha256, truthy};
use mixdog_rt::InLane;
use mixdog_statefile::WriteLane;
use ring::signature::{ED25519, Ed25519KeyPair, KeyPair, UnparsedPublicKey};
use serde_json::{Map, Value, json};
use url::Url;

use super::core::{
    ALLOWED_LAYOUT_DEFAULTS, LAYOUT_SLOT_TYPES, LibraryConfig, LibraryPaths, MAX_TEMPLATE_BYTES, MAX_TEMPLATE_COUNT, SCHEMA_VERSION, canonical_office_design_pack,
    is_format, parse_version, read_json, safe_id, safe_id_text, sha256_file, template_format, write_json_atomic,
};
use crate::{prop, text};

fn is_integer(number: f64) -> bool {
    number.is_finite() && number.fract() == 0.0
}

/// `Object.keys(value)` of any value: an object's keys, an array's or a string's indices, nothing for the rest.
fn object_keys_of(value: &Value) -> Vec<String> {
    match value {
        Value::Object(map) => js_object_keys(map).into_iter().cloned().collect(),
        Value::Array(items) => (0..items.len()).map(|index| index.to_string()).collect(),
        Value::String(string) => (0..utf16_len(string)).map(|index| index.to_string()).collect(),
        _ => Vec::new(),
    }
}

/// `String(value || '').trim().toLowerCase()`.
fn lower_trimmed(value: Option<&Value>) -> String {
    js_to_lowercase(js_trim(&text(value)))
}

fn normalize_profiles(value: Option<&Value>) -> Result<Value, String> {
    let Some(Value::Object(map)) = value else { return Ok(Value::Object(Map::new())) };
    let keys = js_object_keys(map);
    if keys.len() > 32 {
        return Err("Office design pack has too many profiles".to_owned());
    }
    let mut out = Map::new();
    for key in keys {
        let profile = &map[key];
        let id = safe_id_text(key, "profile id")?;
        if !plain_object(profile) {
            return Err(format!("Office design profile {id} must be an object"));
        }
        if utf16_len(&json_stringify(profile)) > 64 * 1024 {
            return Err(format!("Office design profile {id} is too large"));
        }
        if prop(profile, "extends").is_some_and(truthy) {
            safe_id(prop(profile, "extends"), "profile extends")?;
        }
        if let Some(formats) = prop(profile, "formats").filter(|formats| truthy(formats)) {
            for format in object_keys_of(formats) {
                if !is_format(&format) {
                    return Err(format!("Office design profile {id} has unsupported format {format}"));
                }
            }
        }
        out.insert(id, clone(profile));
    }
    Ok(Value::Object(out))
}

fn normalize_layout_slots(value: Option<&Value>) -> Result<Value, String> {
    let items = match value {
        None | Some(Value::Null) => return Ok(Value::Array(Vec::new())),
        Some(Value::Array(items)) if items.len() <= 128 => items,
        Some(_) => return Err("Office design layout slots must be an array of at most 128 entries".to_owned()),
    };
    let mut slots = Vec::new();
    for slot in items {
        if !plain_object(slot) {
            return Err("Office design layout slots must be objects".to_owned());
        }
        let role = safe_id(prop(slot, "role"), "layout slot role")?;
        let kind = match prop(slot, "type") {
            Some(given) if truthy(given) => js_to_lowercase(js_trim(&value_to_string(given))),
            _ => "text".to_owned(),
        };
        if !LAYOUT_SLOT_TYPES.contains(&kind.as_str()) {
            return Err(format!("Office design layout slot {role} has unsupported type {kind}"));
        }
        let shape = to_number_of(prop(slot, "shape"));
        if !is_integer(shape) || shape < 1.0 {
            return Err(format!("Office design layout slot {role} requires a positive shape index"));
        }
        let mut out = Map::new();
        out.insert("role".to_owned(), Value::String(role));
        out.insert("type".to_owned(), Value::String(kind));
        out.insert("shape".to_owned(), json_number(shape));
        if prop(slot, "placeholderType").is_some_and(truthy) {
            out.insert("placeholderType".to_owned(), Value::String(text(prop(slot, "placeholderType"))));
        }
        let placeholder_index = to_number_of(prop(slot, "placeholderIndex"));
        if is_integer(placeholder_index) {
            out.insert("placeholderIndex".to_owned(), json_number(placeholder_index));
        }
        if let Some(geometry) = prop(slot, "geometry").filter(|geometry| plain_object(geometry)) {
            out.insert("geometry".to_owned(), clone(geometry));
        }
        out.insert("required".to_owned(), Value::Bool(prop(slot, "required") == Some(&Value::Bool(true))));
        slots.push(Value::Object(out));
    }
    Ok(Value::Array(slots))
}

fn normalize_layout_capacity(value: Option<&Value>) -> Value {
    let Some(value @ Value::Object(_)) = value else { return Value::Object(Map::new()) };
    let bounded = |name: &str, maximum: f64| {
        let number = to_number_of(prop(value, name));
        json_number(if number.is_finite() && number >= 0.0 { number.min(maximum) } else { 0.0 })
    };
    let mut out = Map::new();
    out.insert("sampleTextChars".to_owned(), bounded("sampleTextChars", 1_000_000.0));
    out.insert("shapeCount".to_owned(), bounded("shapeCount", 10_000.0));
    out.insert("textSlots".to_owned(), bounded("textSlots", 1_000.0));
    out.insert("metricGroups".to_owned(), bounded("metricGroups", 100.0));
    out.insert("columnGroups".to_owned(), bounded("columnGroups", 100.0));
    out.insert("stepGroups".to_owned(), bounded("stepGroups", 100.0));
    out.insert("textArea".to_owned(), bounded("textArea", 1_000_000_000.0));
    Value::Object(out)
}

/// `normalizeDesignTags(value, limit)`: lower-cased, trimmed, empties dropped, duplicates dropped, cut to `limit`.
fn normalize_design_tags(value: Option<&Value>, limit: usize) -> Value {
    let mut tags: Vec<String> = Vec::new();
    if let Some(Value::Array(items)) = value {
        for entry in items {
            let tag = lower_trimmed(Some(entry));
            if !tag.is_empty() && !tags.contains(&tag) {
                tags.push(tag);
            }
        }
    }
    Value::Array(tags.into_iter().take(limit).map(Value::String).collect())
}

/// The layout defaults a pack may carry, refusing any key nothing reads.
fn known_layout_defaults(value: Option<&Value>, label: &str) -> Result<Value, String> {
    let defaults = match value {
        Some(given @ Value::Object(_)) => clone(given),
        _ => Value::Object(Map::new()),
    };
    let unknown: Vec<String> = object_keys_of(&defaults).into_iter().filter(|key| !ALLOWED_LAYOUT_DEFAULTS.contains(&key.as_str())).collect();
    if !unknown.is_empty() {
        return Err(format!("{label} has unsupported default(s): {}", unknown.join(", ")));
    }
    Ok(defaults)
}

/// `Number(value || 0)`.
fn number_or_zero(value: Option<&Value>) -> f64 {
    match value {
        Some(given) if truthy(given) => to_number(given),
        _ => 0.0,
    }
}

/// A truthy number (`sourceSlide && ...`).
fn truthy_number(number: f64) -> bool {
    number != 0.0 && !number.is_nan()
}

/// `normalizeLayouts(value, { templatePath })`.
pub fn normalize_layouts(value: Option<&Value>, template_path: &str) -> Result<Value, String> {
    let items = match value {
        None | Some(Value::Null) => return Ok(Value::Array(Vec::new())),
        Some(Value::Array(items)) if items.len() <= 1_000 => items,
        Some(_) => return Err("Office design layouts must be an array of at most 1000 entries".to_owned()),
    };
    let mut layouts = Vec::new();
    for layout in items {
        if !plain_object(layout) {
            return Err("Office design layout entries must be objects".to_owned());
        }
        let id = safe_id(prop(layout, "id"), "layout id")?;
        let format = match prop(layout, "format") {
            Some(given) if truthy(given) => js_to_lowercase(&value_to_string(given)),
            _ => "pptx".to_owned(),
        };
        if !is_format(&format) {
            return Err(format!("Office design layout {id} has unsupported format {format}"));
        }
        let kind = lower_trimmed(prop(layout, "kind"));
        if kind.is_empty() {
            return Err(format!("Office design layout {id} requires kind"));
        }
        let defaults = known_layout_defaults(prop(layout, "defaults"), &format!("Office design layout {id}"))?;
        let source_slide = number_or_zero(prop(layout, "sourceSlide"));
        if truthy_number(source_slide) && (!is_integer(source_slide) || source_slide < 1.0) {
            return Err(format!("Office design layout {id} has invalid sourceSlide"));
        }
        let source_layout = number_or_zero(prop(layout, "sourceLayout"));
        if truthy_number(source_layout) && (!is_integer(source_layout) || source_layout < 1.0) {
            return Err(format!("Office design layout {id} has invalid sourceLayout"));
        }
        let profile = match prop(layout, "profile") {
            Some(given) if truthy(given) => safe_id(Some(given), "layout profile")?,
            _ => String::new(),
        };
        let template_id = match prop(layout, "templateId") {
            Some(given) if truthy(given) => safe_id(Some(given), "layout templateId")?,
            _ => String::new(),
        };
        let carried_path = if template_path.is_empty() { text(prop(layout, "templatePath")) } else { template_path.to_owned() };
        let mut out = Map::new();
        out.insert("id".to_owned(), Value::String(id));
        out.insert("format".to_owned(), Value::String(format));
        out.insert("kind".to_owned(), Value::String(kind));
        out.insert("profile".to_owned(), Value::String(profile));
        out.insert("density".to_owned(), Value::String(js_to_lowercase(&text(prop(layout, "density")))));
        out.insert("variant".to_owned(), Value::String(lower_trimmed(prop(layout, "variant"))));
        out.insert("purposes".to_owned(), normalize_design_tags(prop(layout, "purposes"), 16));
        out.insert("expressionModes".to_owned(), normalize_design_tags(prop(layout, "expressionModes"), 16));
        out.insert("templateId".to_owned(), Value::String(template_id));
        out.insert("templatePath".to_owned(), Value::String(carried_path));
        out.insert("sourceSlide".to_owned(), json_number(source_slide));
        out.insert("sourceLayout".to_owned(), json_number(source_layout));
        out.insert("slots".to_owned(), normalize_layout_slots(prop(layout, "slots"))?);
        out.insert("capacity".to_owned(), normalize_layout_capacity(prop(layout, "capacity")));
        out.insert("capabilities".to_owned(), normalize_design_tags(prop(layout, "capabilities"), 32));
        out.insert("priority".to_owned(), json_number(clamp_of(prop(layout, "priority"), -100.0, 100.0)));
        out.insert("strict".to_owned(), Value::Bool(prop(layout, "strict") == Some(&Value::Bool(true))));
        out.insert("defaults".to_owned(), defaults);
        layouts.push(Value::Object(out));
    }
    Ok(Value::Array(layouts))
}

/// `normalizeLocalSamples(value)`: the samples of a template's sidecar file.
pub fn normalize_local_samples(value: Option<&Value>) -> Result<Value, String> {
    let items = match value {
        None | Some(Value::Null) => return Ok(Value::Array(Vec::new())),
        Some(Value::Array(items)) if items.len() <= 1_000 => items,
        Some(_) => return Err("Office local template samples must be an array of at most 1000 entries".to_owned()),
    };
    let mut samples = Vec::new();
    for sample in items {
        if !plain_object(sample) {
            return Err("Office local template samples must be objects".to_owned());
        }
        let slide = to_number_of(prop(sample, "slide"));
        if !is_integer(slide) || slide < 1.0 {
            return Err("Office local template sample requires a positive slide number".to_owned());
        }
        let slide_text = mixdog_js::number_to_string(slide);
        let mut roles = Map::new();
        if let Some(Value::Object(map)) = prop(sample, "roles") {
            for shape in js_object_keys(map) {
                let shape_index = string_to_number(shape);
                if !is_integer(shape_index) || shape_index < 1.0 {
                    return Err(format!("Office local template sample {slide_text} has an invalid shape index"));
                }
                let role = safe_id(Some(&map[shape]), &format!("sample {slide_text} slot role"))?;
                roles.insert(mixdog_js::number_to_string(shape_index), Value::String(role));
            }
        }
        let defaults = known_layout_defaults(prop(sample, "defaults"), &format!("Office local template sample {slide_text}"))?;
        let id = match prop(sample, "id") {
            Some(given) if truthy(given) => safe_id(Some(given), &format!("sample {slide_text} layout id"))?,
            _ => String::new(),
        };
        let mut out = Map::new();
        out.insert("slide".to_owned(), json_number(slide));
        out.insert("id".to_owned(), Value::String(id));
        out.insert("kind".to_owned(), Value::String(lower_trimmed(prop(sample, "kind"))));
        out.insert("density".to_owned(), Value::String(lower_trimmed(prop(sample, "density"))));
        out.insert("variant".to_owned(), Value::String(lower_trimmed(prop(sample, "variant"))));
        out.insert("purposes".to_owned(), normalize_design_tags(prop(sample, "purposes"), 16));
        out.insert("expressionModes".to_owned(), normalize_design_tags(prop(sample, "expressionModes"), 16));
        out.insert("priority".to_owned(), json_number(clamp_of(prop(sample, "priority"), -100.0, 100.0)));
        out.insert("strict".to_owned(), Value::Bool(prop(sample, "strict") == Some(&Value::Bool(true))));
        out.insert("roles".to_owned(), Value::Object(roles));
        out.insert("capacity".to_owned(), normalize_layout_capacity(prop(sample, "capacity")));
        out.insert("defaults".to_owned(), defaults);
        samples.push(Value::Object(out));
    }
    Ok(Value::Array(samples))
}

/// `extname(url.pathname).toLowerCase()` of a posix path.
fn extension_of(pathname: &str) -> String {
    let base = pathname.rsplit('/').next().unwrap_or_default();
    match base.rfind('.') {
        Some(index) if index > 0 && base != ".." => js_to_lowercase(&base[index..]),
        _ => String::new(),
    }
}

/// `new URL(text)`.
fn parse_url(given: &str) -> Result<Url, String> {
    Url::parse(given).map_err(|_| "Invalid URL".to_owned())
}

fn normalize_remote_templates(value: Option<&Value>) -> Result<Value, String> {
    let items = match value {
        None | Some(Value::Null) => return Ok(Value::Array(Vec::new())),
        Some(Value::Array(items)) if items.len() <= MAX_TEMPLATE_COUNT => items,
        Some(_) => return Err(format!("Office design pack templates must be an array of at most {MAX_TEMPLATE_COUNT} entries")),
    };
    let mut ids: Vec<String> = Vec::new();
    let mut templates = Vec::new();
    for template in items {
        if !plain_object(template) {
            return Err("Office design template entries must be objects".to_owned());
        }
        let id = safe_id(prop(template, "id"), "template id")?;
        if ids.contains(&id) {
            return Err(format!("Office design pack contains duplicate template id {id}"));
        }
        ids.push(id.clone());
        let format = js_to_lowercase(&text(prop(template, "format")));
        if !["docx", "xlsx", "pptx"].contains(&format.as_str()) {
            return Err(format!("Office design template {id} has unsupported format {format}"));
        }
        let url = parse_url(&text(prop(template, "url")))?;
        if url.scheme() != "https" {
            return Err(format!("Office design template {id} requires an HTTPS URL"));
        }
        let digest = js_to_lowercase(&text(prop(template, "sha256")));
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
            return Err(format!("Office design template {id} requires sha256"));
        }
        let bytes = to_number_of(prop(template, "bytes"));
        if !is_integer(bytes) || bytes < 1.0 || bytes > MAX_TEMPLATE_BYTES as f64 {
            return Err(format!("Office design template {id} has an invalid byte size"));
        }
        let extension = extension_of(url.path());
        if template_format(&extension) != Some(format.as_str()) {
            return Err(format!("Office design template {id} URL extension does not match {format}"));
        }
        let label = match prop(template, "label") {
            Some(given) if truthy(given) => value_to_string(given),
            _ => id.clone(),
        };
        let mut out = Map::new();
        out.insert("id".to_owned(), Value::String(id));
        out.insert("label".to_owned(), Value::String(label));
        out.insert("format".to_owned(), Value::String(format));
        out.insert("url".to_owned(), Value::String(url.as_str().to_owned()));
        out.insert("sha256".to_owned(), Value::String(digest));
        out.insert("bytes".to_owned(), json_number(bytes));
        out.insert("extension".to_owned(), Value::String(extension));
        let layouts = match prop(template, "layouts") {
            Some(given) if truthy(given) => Some(given),
            _ => None,
        };
        out.insert("layouts".to_owned(), normalize_layouts(layouts, "")?);
        templates.push(Value::Object(out));
    }
    Ok(Value::Array(templates))
}

fn normalize_pack(value: &Value) -> Result<Value, String> {
    if !plain_object(value) {
        return Err("Office design pack payload must be an object".to_owned());
    }
    let id = safe_id(prop(value, "id"), "pack id")?;
    let version = js_trim(&text(prop(value, "version"))).to_owned();
    if parse_version(&version).is_none() {
        return Err(format!("Office design pack {id} has invalid semantic version {version}"));
    }
    let channel = match prop(value, "channel") {
        Some(given) if truthy(given) => js_to_lowercase(js_trim(&value_to_string(given))),
        _ => "stable".to_owned(),
    };
    let mut default_profiles = match prop(value, "defaultProfiles") {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let formats: Vec<String> = js_object_keys(&default_profiles).into_iter().cloned().collect();
    for format in formats {
        if !is_format(&format) {
            return Err(format!("Office design pack {id} has unsupported default format {format}"));
        }
        let profile = safe_id(default_profiles.get(&format), "default profile")?;
        default_profiles.insert(format, Value::String(profile));
    }
    let layouts = prop(value, "layouts").filter(|given| truthy(given));
    let templates = prop(value, "templates").filter(|given| truthy(given));
    let mut out = Map::new();
    out.insert("schemaVersion".to_owned(), Value::from(SCHEMA_VERSION));
    out.insert("id".to_owned(), Value::String(id));
    out.insert("version".to_owned(), Value::String(version));
    out.insert("channel".to_owned(), Value::String(channel));
    out.insert("publishedAt".to_owned(), Value::String(text(prop(value, "publishedAt"))));
    out.insert("profiles".to_owned(), normalize_profiles(prop(value, "profiles"))?);
    out.insert("defaultProfiles".to_owned(), Value::Object(default_profiles));
    out.insert("layouts".to_owned(), normalize_layouts(layouts, "")?);
    out.insert("templates".to_owned(), normalize_remote_templates(templates)?);
    Ok(Value::Object(out))
}

/// What a verified envelope yields.
#[derive(Clone, Debug)]
pub struct Verified {
    pub key_id: String,
    pub pack: Value,
    pub envelope: Value,
}

/// `Buffer.from(text, 'base64')`: both alphabets, white space and other stray characters skipped, `=` ends it.
fn base64_lenient(input: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let (mut accumulator, mut bits) = (0u32, 0u32);
    for c in input.chars() {
        let value = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            _ => continue,
        };
        accumulator = (accumulator << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((accumulator >> bits) as u8);
            accumulator &= (1 << bits) - 1;
        }
    }
    out
}

const SPKI_ED25519_PREFIX: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];
const PKCS8_ED25519_PREFIX: [u8; 16] = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
const UNSUPPORTED_KEY: &str = "error:1E08010C:DECODER routines::unsupported";

/// `createPublicKey(pem)`: the raw Ed25519 public key; `Ok(None)` for a key of another algorithm. A private key's
/// public half is taken, as Node does.
fn ed25519_public_key(pem: &str) -> Result<Option<[u8; 32]>, String> {
    let begin = pem.find("-----BEGIN ").ok_or_else(|| UNSUPPORTED_KEY.to_owned())?;
    let after = &pem[begin + "-----BEGIN ".len()..];
    let label_end = after.find("-----").ok_or_else(|| UNSUPPORTED_KEY.to_owned())?;
    let label = &after[..label_end];
    let body = &after[label_end + 5..];
    let end = body.find("-----END ").ok_or_else(|| UNSUPPORTED_KEY.to_owned())?;
    let der = base64_lenient(&body[..end]);
    match label {
        "PUBLIC KEY" if der.len() == 44 && der[..12] == SPKI_ED25519_PREFIX => {
            let mut key = [0u8; 32];
            key.copy_from_slice(&der[12..]);
            Ok(Some(key))
        }
        "PRIVATE KEY" if der.len() == 48 && der[..16] == PKCS8_ED25519_PREFIX => {
            let pair = Ed25519KeyPair::from_seed_unchecked(&der[16..]).map_err(|_| UNSUPPORTED_KEY.to_owned())?;
            let mut key = [0u8; 32];
            key.copy_from_slice(pair.public_key().as_ref());
            Ok(Some(key))
        }
        "PUBLIC KEY" | "PRIVATE KEY" | "RSA PUBLIC KEY" | "RSA PRIVATE KEY" | "EC PRIVATE KEY" if der.first() == Some(&0x30) => Ok(None),
        _ => Err(UNSUPPORTED_KEY.to_owned()),
    }
}

/// `verifyOfficeDesignPackEnvelope(envelope, trustedKeys)`.
pub fn verify_office_design_pack_envelope(envelope: &Value, trusted_keys: &Map<String, Value>) -> Result<Verified, String> {
    if !plain_object(envelope) || to_number_of(prop(envelope, "schemaVersion")) != SCHEMA_VERSION as f64 {
        return Err(format!("Office design pack envelope requires schemaVersion {SCHEMA_VERSION}"));
    }
    let key_id = safe_id(prop(envelope, "keyId"), "signing key id")?;
    let Some(public_key_value) = trusted_keys.get(&key_id).filter(|key| truthy(key)) else {
        return Err(format!("Office design pack signing key is not trusted: {key_id}"));
    };
    let signature = base64_lenient(&text(prop(envelope, "signature")));
    if signature.len() != 64 {
        return Err("Office design pack signature is invalid".to_owned());
    }
    let Some(public_key) = ed25519_public_key(&value_to_string(public_key_value))? else {
        return Err(format!("Office design pack signing key {key_id} must be Ed25519"));
    };
    let Some(pack) = prop(envelope, "pack") else {
        // `Buffer.from(JSON.stringify(undefined))`.
        return Err("The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received undefined".to_owned());
    };
    let message = canonical_office_design_pack(pack);
    if UnparsedPublicKey::new(&ED25519, public_key).verify(message.as_bytes(), &signature).is_err() {
        return Err("Office design pack signature verification failed".to_owned());
    }
    Ok(Verified { key_id, pack: normalize_pack(pack)?, envelope: clone(envelope) })
}

/// One answer of the network: the status, the declared length (0 when absent), the entity tag and the body, read
/// at most one byte past the limit the request asked for.
#[derive(Clone, Debug, Default)]
pub struct FetchResponse {
    pub status: u16,
    pub content_length: f64,
    pub etag: Option<String>,
    pub body: Vec<u8>,
}

/// One GET: the URL, the entity tag to send as `If-None-Match`, the time to the response headers and the most body
/// bytes worth reading.
pub struct FetchRequest<'a> {
    pub url: &'a str,
    pub if_none_match: Option<&'a str>,
    pub timeout: Duration,
    pub max_bytes: u64,
}

/// The network the library reaches packs through. A failure is the text of the error `fetch` threw.
pub trait Fetch {
    fn get(&self, request: &FetchRequest<'_>) -> Result<FetchResponse, String>;
}

/// The real network: HTTPS over reqwest, redirects followed, the timeout applying until the response headers have
/// arrived (the body is then read without one, as `fetchWithTimeout` clears its timer on the response).
pub struct HttpsFetch;

impl Fetch for HttpsFetch {
    fn get(&self, request: &FetchRequest<'_>) -> Result<FetchResponse, String> {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_| "fetch failed".to_owned())?;
        runtime.block_on(async {
            let client = reqwest::Client::builder().build().map_err(|_| "fetch failed".to_owned())?;
            let mut builder = client.get(request.url);
            if let Some(tag) = request.if_none_match {
                builder = builder.header(reqwest::header::IF_NONE_MATCH, tag);
            }
            let mut response = match mixdog_rt::time::timeout(request.timeout, builder.send()).await {
                Err(_) => return Err("This operation was aborted".to_owned()),
                Ok(Err(_)) => return Err("fetch failed".to_owned()),
                Ok(Ok(response)) => response,
            };
            let header = |name: reqwest::header::HeaderName| response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_owned);
            let content_length = header(reqwest::header::CONTENT_LENGTH).map_or(0.0, |length| string_to_number(&length));
            let etag = header(reqwest::header::ETAG);
            let status = response.status().as_u16();
            let mut body = Vec::new();
            while (body.len() as u64) <= request.max_bytes {
                match response.chunk().await {
                    Ok(Some(chunk)) => body.extend_from_slice(&chunk),
                    Ok(None) => break,
                    Err(_) => return Err("terminated".to_owned()),
                }
            }
            Ok(FetchResponse { status, content_length: if content_length.is_nan() { 0.0 } else { content_length }, etag, body })
        })
    }
}

/// `responseBytes(response, maximum, label)`.
pub fn response_bytes(response: &FetchResponse, maximum: u64, label: &str) -> Result<Vec<u8>, String> {
    if !(200..300).contains(&response.status) {
        return Err(format!("{label} download failed with HTTP {}", response.status));
    }
    if response.content_length > maximum as f64 || response.body.len() as u64 > maximum {
        return Err(format!("{label} exceeds the download size limit"));
    }
    Ok(response.body.clone())
}

fn cached_pack_root(paths: &LibraryPaths, id: Option<&Value>, version: &Value) -> Result<PathBuf, String> {
    Ok(paths.packs.join(safe_id(id, "pack id")?).join(value_to_string(version)))
}

fn temporary_name() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// `materializePack(envelope, verified, paths, fetch)`: every template of the pack is downloaded, checked for size and
/// sha256 and written, with the envelope, into a staging folder that then replaces `packs/<id>/<version>`. A failure
/// leaves the previous copy in place. Answers the folder.
pub fn materialize_pack<L: WriteLane>(
    lane: &InLane<L>,
    verified: &Verified,
    paths: &LibraryPaths,
    fetch: &dyn Fetch,
) -> Result<PathBuf, String> {
    let id = verified.pack.get("id").cloned().unwrap_or(Value::Null);
    let version = verified.pack.get("version").cloned().unwrap_or(Value::Null);
    let target = cached_pack_root(paths, Some(&id), &version)?;
    let staging = paths.packs.join(format!(".staging-{}", temporary_name()));
    let io = |error: std::io::Error| error.to_string();
    mixdog_fsio::create_dir_all(lane, staging.join("templates")).map_err(io)?;
    let built = stage_pack(lane, verified, &staging, &target, fetch);
    // The staging folder is removed whatever came of it (a successful rename has already moved it).
    let _ = mixdog_fsio::remove_dir_all(lane, &staging);
    built.map(|()| target)
}

fn stage_pack<L: WriteLane>(lane: &InLane<L>, verified: &Verified, staging: &Path, target: &Path, fetch: &dyn Fetch) -> Result<(), String> {
    let io = |error: std::io::Error| error.to_string();
    for template in verified.pack.get("templates").and_then(Value::as_array).into_iter().flatten() {
        let id = text(prop(template, "id"));
        let url = text(prop(template, "url"));
        let expected = to_number_of(prop(template, "bytes"));
        let request = FetchRequest { url: &url, if_none_match: None, timeout: Duration::from_secs(30), max_bytes: expected as u64 };
        let response = fetch.get(&request)?;
        let bytes = response_bytes(&response, expected as u64, &format!("Office design template {id}"))?;
        if bytes.len() as f64 != expected {
            return Err(format!("Office design template {id} size mismatch"));
        }
        if sha256(&bytes) != text(prop(template, "sha256")) {
            return Err(format!("Office design template {id} sha256 mismatch"));
        }
        let file_path = staging.join("templates").join(format!("{id}{}", text(prop(template, "extension"))));
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        // Node's `writeFile(.., { mode: 0o600 })`: owner-only on Unix; Windows has no such mode bits.
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(lane, &file_path).map_err(io)?;
        file.write_all(&bytes).map_err(io)?;
    }
    write_json_atomic(lane, &staging.join("envelope.json"), &verified.envelope)?;
    if let Some(parent) = target.parent() {
        mixdog_fsio::create_dir_all(lane, parent).map_err(io)?;
    }
    let backup = PathBuf::from(format!("{}.previous-{}", target.display(), temporary_name()));
    let moved_existing = mixdog_fsio::rename(lane, target, &backup).is_ok();
    match mixdog_fsio::rename(lane, staging, target) {
        Ok(()) => {
            if moved_existing {
                mixdog_fsio::remove_dir_all(lane, &backup).map_err(io)?;
            }
            Ok(())
        }
        Err(error) => {
            if moved_existing {
                let _ = mixdog_fsio::rename(lane, &backup, target);
            }
            Err(error.to_string())
        }
    }
}

/// `loadCachedPack(paths, config, id, version)`: the pack cached under `packs/<id>/<version>`, its signature checked
/// again against the trusted keys and every template file checked for size and sha256. `Ok(None)` when nothing is cached.
pub fn load_cached_pack<L: WriteLane>(
    lane: &InLane<L>,
    paths: &LibraryPaths,
    config: &LibraryConfig,
    id: Option<&Value>,
    version: Option<&Value>,
) -> Result<Option<Value>, String> {
    let (Some(id), Some(version)) = (id.filter(|id| truthy(id)), version.filter(|version| truthy(version))) else { return Ok(None) };
    let root = cached_pack_root(paths, Some(id), version)?;
    let envelope = read_json(lane, &root.join("envelope.json"), Value::Null);
    if envelope.is_null() {
        return Ok(None);
    }
    let verified = verify_office_design_pack_envelope(&envelope, &config.trusted_keys)?;
    let mut templates = Vec::new();
    for template in verified.pack.get("templates").and_then(Value::as_array).into_iter().flatten() {
        let template_id = text(prop(template, "id"));
        let path = root.join("templates").join(format!("{template_id}{}", text(prop(template, "extension"))));
        let intact = mixdog_fsio::metadata(lane, &path).is_ok_and(|details| {
            details.is_file()
                && details.len() as f64 == to_number_of(prop(template, "bytes"))
                && sha256_file(lane, &path).is_ok_and(|digest| digest == text(prop(template, "sha256")))
        });
        if !intact {
            return Err(format!("Cached Office design template {template_id} failed integrity validation"));
        }
        let path_text = path.to_string_lossy().into_owned();
        let mut entry = template.as_object().cloned().unwrap_or_default();
        entry.insert("path".to_owned(), Value::String(path_text.clone()));
        entry.insert("source".to_owned(), Value::String("remote-pack".to_owned()));
        entry.insert("version".to_owned(), verified.pack.get("version").cloned().unwrap_or(Value::Null));
        let layouts: Vec<Value> = prop(template, "layouts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|layout| {
                let mut layout = layout.as_object().cloned().unwrap_or_default();
                let carried = layout.get("templateId").filter(|carried| truthy(carried)).cloned();
                layout.insert("templateId".to_owned(), carried.unwrap_or_else(|| Value::String(template_id.clone())));
                layout.insert("templatePath".to_owned(), Value::String(path_text.clone()));
                Value::Object(layout)
            })
            .collect();
        entry.insert("layouts".to_owned(), Value::Array(layouts));
        templates.push(Value::Object(entry));
    }
    let mut pack = verified.pack.as_object().cloned().unwrap_or_default();
    pack.insert("keyId".to_owned(), Value::String(verified.key_id));
    pack.insert("templates".to_owned(), Value::Array(templates));
    pack.insert("source".to_owned(), Value::String("remote-pack".to_owned()));
    Ok(Some(Value::Object(pack)))
}

/// `packSummary(pack)`.
pub fn pack_summary(pack: Option<&Value>) -> Value {
    let Some(pack) = pack else { return Value::Null };
    let count = |key: &str| prop(pack, key).and_then(Value::as_array).map_or(0, Vec::len);
    let profiles: Vec<Value> = match prop(pack, "profiles") {
        Some(Value::Object(map)) => js_object_keys(map).into_iter().map(|key| Value::String(key.clone())).collect(),
        _ => Vec::new(),
    };
    json!({
        "id": prop(pack, "id").cloned().unwrap_or(Value::Null),
        "version": prop(pack, "version").cloned().unwrap_or(Value::Null),
        "channel": prop(pack, "channel").cloned().unwrap_or(Value::Null),
        "keyId": prop(pack, "keyId").cloned().unwrap_or(Value::Null),
        "profiles": profiles,
        "layouts": count("layouts"),
        "templates": count("templates"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lenient_base64_reads_both_alphabets_and_stops_at_padding() {
        assert_eq!(base64_lenient("aGVsbG8="), b"hello");
        assert_eq!(base64_lenient("aGVs\nbG8"), b"hello");
        assert_eq!(base64_lenient("-_8="), vec![0xfb, 0xff]);
    }

    #[test]
    fn a_template_extension_is_the_last_dot_of_the_file_name() {
        assert_eq!(extension_of("/a/b/Deck.PPTX"), ".pptx");
        assert_eq!(extension_of("/a/.pptx"), "");
        assert_eq!(extension_of("/a.b/deck"), "");
    }

    #[test]
    fn an_unknown_layout_default_is_refused() {
        let layouts = json!([{ "id": "a", "kind": "cover", "defaults": { "nope": 1, "layout": 2, "also": 3 } }]);
        assert_eq!(
            normalize_layouts(Some(&layouts), "").unwrap_err(),
            "Office design layout a has unsupported default(s): nope, also"
        );
    }

    #[test]
    fn slot_and_capacity_numbers_are_bounded() {
        let layouts = json!([{
            "id": "A", "kind": " Cover ", "slots": [{ "role": "Title", "shape": 2, "type": "TEXT" }],
            "capacity": { "textSlots": 5000, "shapeCount": -1 }, "priority": 500
        }]);
        let out = normalize_layouts(Some(&layouts), "").unwrap();
        assert_eq!(out[0]["id"], "a");
        assert_eq!(out[0]["kind"], "cover");
        assert_eq!(out[0]["slots"][0], json!({ "role": "title", "type": "text", "shape": 2, "required": false }));
        assert_eq!(out[0]["capacity"]["textSlots"], 1000);
        assert_eq!(out[0]["capacity"]["shapeCount"], 0);
        assert_eq!(out[0]["priority"], 100);
    }

    #[test]
    fn a_response_over_the_limit_or_not_ok_is_refused() {
        let ok = FetchResponse { status: 200, content_length: 0.0, etag: None, body: vec![0; 4] };
        assert_eq!(response_bytes(&ok, 4, "X").unwrap().len(), 4);
        assert_eq!(response_bytes(&ok, 3, "X").unwrap_err(), "X exceeds the download size limit");
        let declared = FetchResponse { content_length: 9.0, ..ok.clone() };
        assert_eq!(response_bytes(&declared, 4, "X").unwrap_err(), "X exceeds the download size limit");
        let missing = FetchResponse { status: 404, ..ok };
        assert_eq!(response_bytes(&missing, 4, "X").unwrap_err(), "X download failed with HTTP 404");
    }
}
