//! `normalizeAgentAvatar` (`runtime/shared/agent-avatar.mjs`): a stored avatar as the app
//! understands it. Only the reading half is here: the editor's image uploads are not ported.

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
