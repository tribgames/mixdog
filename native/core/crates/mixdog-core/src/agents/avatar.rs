//! `normalizeAgentAvatar` (`runtime/shared/agent-avatar.mjs`): a stored avatar as the app
//! understands it, and the checking of a save's `avatar` (uploads as data URLs, content-hash file
//! names). The functions run inside the editor's lane jobs.
#![allow(clippy::disallowed_methods, reason = "lane job bodies: the service runs these functions on io lanes")]

use serde_json::Map;
use serde_json::Value;
use serde_json::json;

const COLORS: [&str; 10] =
    ["#e6e6e6", "#9a9a9a", "#f06a5f", "#f59a42", "#f2c94c", "#5cc98a", "#3fc1c9", "#5b9bff", "#9b7bff", "#ef6fb0"];
const SPECIES: [&str; 7] = ["labrador", "shepherd", "terrier", "corgi", "husky", "shiba", "mixy"];
const ACCESSORIES: [&str; 6] = ["none", "collar", "glasses", "beanie", "scarf", "bow"];
const EXPRESSIONS: [&str; 4] = ["calm", "happy", "wink", "sleepy"];
/// The motion states, `idle` first.
pub(super) const STATES: [&str; 3] = ["idle", "typing", "message"];

fn retired_species(species: &str) -> &str {
    match species {
        "dalmatian" | "cat" | "bird" | "robot" => "labrador",
        other => other,
    }
}

fn retired_accessory(accessory: &str) -> &str {
    if accessory == "headset" { "glasses" } else { accessory }
}

/// `pick(value, list, fallback)`: absent is the fallback, a listed value itself, else `None`.
fn pick(value: Option<&Value>, list: &[&str], fallback: Option<&str>, retired: fn(&str) -> &str) -> Option<String> {
    match value {
        None | Some(Value::Null) => fallback.map(str::to_owned),
        Some(Value::String(text)) => {
            let text = retired(text);
            list.contains(&text).then(|| text.to_owned())
        }
        Some(_) => None,
    }
}

fn hex12(text: &str) -> bool {
    text.len() == 12 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `AGENT_AVATAR_IMAGE_FILE`: `avatar-<12 hex>.png`.
pub(super) fn is_image_file(file: &str) -> bool {
    file.strip_prefix("avatar-").and_then(|rest| rest.strip_suffix(".png")).is_some_and(hex12)
}

/// `AGENT_AVATAR_STATE_FILE`: `<state>-<12 hex>.<png|gif|webp>`.
fn is_state_file(file: &str) -> bool {
    STATES.iter().any(|state| {
        file.strip_prefix(state)
            .and_then(|rest| rest.strip_prefix('-'))
            .and_then(|rest| [".png", ".gif", ".webp"].iter().find_map(|ext| rest.strip_suffix(ext)))
            .is_some_and(hex12)
    })
}

/// `mascotFromVariant`: an older `<ears>-<expression>-<plain|collar>` look.
fn from_variant(variant: &str) -> Option<(&'static str, &'static str, String)> {
    let parts: Vec<&str> = variant.split('-').collect();
    let [ears, expression, extra] = parts[..] else { return None };
    let species = match ears {
        "floppy" => "labrador",
        "perky" => "shepherd",
        "folded" => "terrier",
        _ => return None,
    };
    if !matches!(expression, "calm" | "happy") || !matches!(extra, "plain" | "collar") {
        return None;
    }
    Some((species, if extra == "collar" { "collar" } else { "none" }, expression.to_owned()))
}

fn custom(states: Option<&Value>) -> Option<Value> {
    let states = states?.as_object()?;
    let mut kept = Map::new();
    for state in STATES {
        let Some(file) = states.get(state).filter(|file| !file.is_null()) else { continue };
        let text = file.as_str();
        let own = text.is_some_and(|f| is_state_file(f) && f.starts_with(&format!("{state}-")));
        let legacy = state == "idle" && text.is_some_and(is_image_file);
        if !own && !legacy {
            return None;
        }
        kept.insert(state.into(), file.clone());
    }
    kept.contains_key("idle").then(|| json!({ "kind": "custom", "states": kept }))
}

/// A state image the editor writes: its path under the agent's folder and its bytes.
pub(super) struct ImageWrite {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// What a save's `avatar` came to: the record to store (`None` clears it) and the images to write.
pub(super) struct AvatarUpdate {
    pub avatar: Option<Value>,
    pub writes: Vec<ImageWrite>,
}

/// An upload's format and size, read from its header bytes (`avatarImageInfo`).
struct ImageInfo {
    format: &'static str,
    width: u32,
    height: u32,
    animated: bool,
}

fn be32(bytes: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn le16(bytes: &[u8], at: usize) -> u32 {
    u32::from(bytes[at]) | (u32::from(bytes[at + 1]) << 8)
}

fn le24(bytes: &[u8], at: usize) -> u32 {
    le16(bytes, at) | (u32::from(bytes[at + 2]) << 16)
}

fn image_info(bytes: &[u8]) -> Option<ImageInfo> {
    if bytes.len() < 30 {
        return None;
    }
    if be32(bytes, 0) == 0x8950_4e47 && be32(bytes, 4) == 0x0d0a_1a0a && &bytes[12..16] == b"IHDR" {
        let mut animated = false;
        let mut at = 8usize;
        while at + 8 <= bytes.len() {
            let kind = &bytes[at + 4..at + 8];
            if kind == b"acTL" {
                animated = true;
            }
            if kind == b"IDAT" || kind == b"IEND" {
                break;
            }
            at += 12 + be32(bytes, at) as usize;
        }
        return Some(ImageInfo { format: "png", width: be32(bytes, 16), height: be32(bytes, 20), animated });
    }
    if &bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a" {
        return Some(ImageInfo { format: "gif", width: le16(bytes, 6), height: le16(bytes, 8), animated: true });
    }
    if &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        match &bytes[12..16] {
            b"VP8X" => {
                return Some(ImageInfo { format: "webp", width: le24(bytes, 24) + 1, height: le24(bytes, 27) + 1, animated: bytes[20] & 0x02 != 0 });
            }
            b"VP8 " => {
                return Some(ImageInfo { format: "webp", width: le16(bytes, 26) & 0x3fff, height: le16(bytes, 28) & 0x3fff, animated: false });
            }
            b"VP8L" => {
                let bits = u32::from(bytes[21]) | (u32::from(bytes[22]) << 8) | (u32::from(bytes[23]) << 16) | (u32::from(bytes[24]) << 24);
                return Some(ImageInfo { format: "webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, animated: false });
            }
            _ => {}
        }
    }
    None
}

/// `agentAvatarImageProblem`: why bytes cannot be a state image, `None` when they can.
fn image_problem(bytes: &[u8]) -> Option<&'static str> {
    let Some(info) = image_info(bytes) else { return Some("must be a PNG, GIF or WebP image") };
    if bytes.len() > 1024 * 1024 {
        return Some("is larger than 1 MB");
    }
    if info.width == 0 || info.width != info.height {
        return Some("must be square");
    }
    if info.width > 512 {
        return Some("must be 512px or smaller");
    }
    None
}

/// `Buffer.from(text, 'base64')`: both alphabets, anything else skipped, decoding ends at `=`.
fn lenient_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for ch in text.chars() {
        let value = match ch {
            'A'..='Z' => ch as u32 - 'A' as u32,
            'a'..='z' => ch as u32 - 'a' as u32 + 26,
            '0'..='9' => ch as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            _ => continue,
        };
        acc = (acc << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// One uploaded image (a data URL) as checked bytes (`avatarImageUpload`).
fn image_upload(data_url: Option<&Value>, label: &str) -> Result<(Vec<u8>, ImageInfo), String> {
    let wrong = || format!("{label} must be a PNG, GIF or WebP image");
    let text = data_url.and_then(Value::as_str).ok_or_else(wrong)?;
    let (declared, rest) = ["png", "gif", "webp"]
        .iter()
        .find_map(|kind| text.strip_prefix(&format!("data:image/{kind};base64,")).map(|rest| (*kind, rest)))
        .ok_or_else(wrong)?;
    let bytes = lenient_base64(rest);
    if let Some(problem) = image_problem(&bytes) {
        return Err(format!("{label} {problem}"));
    }
    let info = image_info(&bytes).ok_or_else(wrong)?;
    if info.format != declared {
        return Err(wrong());
    }
    Ok((bytes, info))
}

fn sha12(bytes: &[u8]) -> String {
    use sha2::Digest as _;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect::<String>()[..12].to_owned()
}

/// `agentAvatarStatePath`.
pub(super) fn state_path(file: &str) -> String {
    if is_image_file(file) { file.to_owned() } else { format!("avatar/{file}") }
}

/// `avatarPosterFile`.
pub(super) fn poster_file(file: &str) -> String {
    for ext in [".png", ".gif", ".webp"] {
        if let Some(stem) = file.strip_suffix(ext) {
            return format!("{stem}.poster.png");
        }
    }
    file.to_owned()
}

/// `avatarUpdate(value, dir)`: the `avatar` of a save as the record to store and the images to
/// write; `null` clears it.
pub(super) fn avatar_update(value: &Value, dir: &std::path::Path) -> Result<AvatarUpdate, String> {
    if value.is_null() {
        return Ok(AvatarUpdate { avatar: None, writes: Vec::new() });
    }
    let as_custom;
    let custom = if value.get("kind").and_then(Value::as_str) == Some("image") && value.get("data").is_some_and(Value::is_string) {
        as_custom = json!({ "kind": "custom", "states": { "idle": { "data": value["data"] } } });
        &as_custom
    } else {
        value
    };
    let mut writes: Vec<ImageWrite> = Vec::new();
    let avatar = if custom.get("kind").and_then(Value::as_str) == Some("custom") && custom.get("states").is_some_and(Value::is_object) {
        let mut states = Map::new();
        for state in STATES {
            let entry = custom["states"].get(state);
            match entry {
                None | Some(Value::Null) => continue,
                Some(Value::String(file)) => {
                    if !file.is_empty() {
                        states.insert(state.into(), json!(file));
                    }
                    continue;
                }
                Some(_) => {}
            }
            let entry = entry.unwrap_or(&Value::Null);
            let label = format!("agent avatar {state} image");
            let (bytes, info) = image_upload(entry.get("data"), &label)?;
            let file = format!("{state}-{}.{}", sha12(&bytes), info.format);
            writes.push(ImageWrite { path: state_path(&file), bytes });
            if info.animated {
                let (poster, poster_info) = image_upload(entry.get("poster"), &format!("{label}'s first frame"))?;
                if poster_info.format != "png" || poster_info.animated {
                    return Err(format!("{label}'s first frame must be a still PNG"));
                }
                writes.push(ImageWrite { path: state_path(&poster_file(&file)), bytes: poster });
            }
            states.insert(state.into(), json!(file));
        }
        normalize_agent_avatar(&json!({ "kind": "custom", "states": states })).ok_or("agent avatar needs an idle image")?
    } else {
        normalize_agent_avatar(custom).ok_or("agent avatar must be a known mascot or an uploaded image")?
    };
    if avatar["kind"] == "custom" {
        for file in avatar["states"].as_object().into_iter().flatten().filter_map(|(_, f)| f.as_str()) {
            let path = state_path(file);
            if !writes.iter().any(|w| w.path == path) && !dir.join(&path).exists() {
                return Err("agent avatar image was not found".into());
            }
        }
    }
    Ok(AvatarUpdate { avatar: Some(avatar), writes })
}

/// `normalizeAgentAvatar(value)`; `None` when it is not an avatar.
pub(super) fn normalize_agent_avatar(value: &Value) -> Option<Value> {
    let map = value.as_object()?;
    match map.get("kind").and_then(Value::as_str) {
        Some("image") => {
            let file = map.get("file").and_then(Value::as_str).filter(|f| is_image_file(f))?;
            Some(json!({ "kind": "custom", "states": { "idle": file } }))
        }
        Some("custom") => custom(map.get("states")),
        Some("mascot") => {
            let color = map.get("color").and_then(Value::as_str).map(str::to_lowercase).unwrap_or_default();
            if !COLORS.contains(&color.as_str()) {
                return None;
            }
            let variant = map.get("variant").and_then(Value::as_str);
            let (species, accessory, expression) = if map.get("species").is_none_or(Value::is_null) && variant.is_some() {
                let (species, accessory, expression) = from_variant(variant.unwrap_or_default())?;
                (species.to_owned(), accessory.to_owned(), expression)
            } else {
                (
                    pick(map.get("species"), &SPECIES, None, retired_species)?,
                    pick(map.get("accessory"), &ACCESSORIES, Some("none"), retired_accessory)?,
                    pick(map.get("expression"), &EXPRESSIONS, Some("calm"), |s| s)?,
                )
            };
            Some(json!({ "kind": "mascot", "species": species, "accessory": accessory, "expression": expression, "color": color }))
        }
        _ => None,
    }
}
