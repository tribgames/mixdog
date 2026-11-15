//! `design/design-discipline.mjs`: the font allowlist, motif and picture shape detection, the signed visual type of a
//! slide, and the contrast repair and hue limits of a palette.

use std::collections::HashSet;
use std::sync::LazyLock;

use mixdog_js::{JsRegex, js_object_keys, js_to_lowercase, js_trim, math, number_to_string, to_number_of};
use mixdog_office_base::values::{clamp, plain_object, truthy};
use serde_json::{Map, Value, json};

use crate::{opt_prop, prop, text, text_of};

/// Typefaces that ship with Microsoft Office and render true-to-width in the LibreOffice preview used for visual QA.
const SAFE_FONT_FAMILIES: &[&str] = &[
    "Arial",
    "Calibri",
    "Cambria",
    "Times New Roman",
    "Courier New",
    "Bookman Old Style",
    "Century Schoolbook",
    // Korean
    "Malgun Gothic",
    "맑은 고딕",
    "Batang",
    "바탕",
    "Noto Sans KR",
    "Noto Serif KR",
    "본고딕",
    "본명조",
    // Global & CJK Noto Families
    "Noto Sans",
    "Noto Serif",
    "Noto Sans SC",
    "Noto Serif SC",
    "Noto Sans TC",
    "Noto Serif TC",
    "Noto Sans JP",
    "Noto Serif JP",
    "Noto Sans Arabic",
    "Noto Sans Devanagari",
    "Noto Sans Thai",
    "Noto Sans Hebrew",
    "Noto Sans Bengali",
    // Standard OS CJK Fallbacks
    "Microsoft YaHei",
    "微软雅黑",
    "Microsoft JhengHei",
    "微軟正黑體",
    "Yu Gothic",
    "游ゴシック",
    "Meiryo",
    "メイリオ",
    "PingFang SC",
    "PingFang TC",
    "Hiragino Sans",
];

static SAFE_FONT_KEYS: LazyLock<HashSet<String>> =
    LazyLock::new(|| SAFE_FONT_FAMILIES.iter().map(|name| font_family_key(name)).collect());

static WEIGHT_SUFFIX: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\s+(?:semilight|light|semibold|medium|black|thin|extrabold|display)$", "u"));

const TYPOGRAPHY_ROLES: [&str; 3] = ["display", "body", "data"];
/// Motif shapes are named so structural review can tell deliberate decoration from content that must stay legible.
const MOTIF_SHAPE_PREFIX: &str = "Mixdog Motif";

/// `isMotifShape`.
pub fn is_motif_shape(shape: &Value) -> bool {
    text(prop(shape, "name")).starts_with(MOTIF_SHAPE_PREFIX)
}

/// `isPictureShape`: Microsoft Office reports the integer MsoShapeType 13, the portable backend the element name.
pub fn is_picture_shape(shape: &Value) -> bool {
    to_number_of(prop(shape, "type")) == 13.0 || prop(shape, "type") == Some(&Value::String("p:pic".into()))
}

const SPEC_PREFIX: &str = "mixdog-spec:";

/// `signedVisualType`: the slide's visual type named by the kit's signed carriers, or an empty text.
pub fn signed_visual_type(slide: &Value) -> String {
    let signatures: Vec<Vec<String>> = crate::array_of(prop(slide, "shapes"))
        .map(|shapes| {
            shapes
                .iter()
                .map(|shape| text(prop(shape, "name")))
                .filter(|name| name.starts_with(SPEC_PREFIX))
                .map(|name| name[SPEC_PREFIX.len()..].split(':').map(str::to_owned).collect())
                .collect()
        })
        .unwrap_or_default();
    if let Some(variant) = signatures
        .iter()
        .find(|parts| parts[0] == "structure" && parts.get(1).is_some_and(|variant| !variant.is_empty()))
        .map(|parts| &parts[1])
    {
        return format!("structure:{variant}");
    }
    let has = |spec: &str| signatures.iter().any(|parts| parts[0] == spec);
    if has("chevrons") {
        return "process".into();
    }
    if has("table") {
        return "table".into();
    }
    if has("stat") {
        return "metric".into();
    }
    String::new()
}

pub const MAX_FONT_FAMILIES_PER_SLIDE: u32 = 3;
pub const MAX_ACCENT_HUE_FAMILIES: u32 = 2;
pub const STATE_ROLES: [&str; 4] = ["positive", "warning", "critical", "informative"];
const STATE_HUES: [(&str, f64); 4] = [("positive", 150.0), ("warning", 40.0), ("critical", 5.0), ("informative", 215.0)];
const TEXT_CONTRAST_MINIMUM: f64 = 4.5;
const LARGE_TEXT_CONTRAST_MINIMUM: f64 = 3.0;
const LARGE_TEXT_POINT_SIZE: u32 = 24;

/// `fontFamilyKey`: quotes dropped, trimmed, lower-cased, and a trailing weight word removed.
pub fn font_family_key(name: &str) -> String {
    let lowered = js_to_lowercase(js_trim(&name.replace('"', "")));
    match WEIGHT_SUFFIX.find(&lowered) {
        Some(range) => lowered[..range.start].to_owned(),
        None => lowered,
    }
}

/// `isSafeFontFamily`.
pub fn is_safe_font_family(name: &str) -> bool {
    let key = font_family_key(name);
    !key.is_empty() && SAFE_FONT_KEYS.contains(&key)
}

/// What [`normalize_typography_tokens`] answers.
#[derive(Debug, Clone, PartialEq)]
pub struct TypographyTokens {
    pub typography: Map<String, Value>,
    pub replaced: Vec<Value>,
    pub family_count: usize,
}

/// `normalizeTypographyTokens`: the requested face is kept; a face outside the safe list is an advisory (recipients
/// without it see a substitute), listed in `replaced` with `applied` equal to `requested`.
pub fn normalize_typography_tokens(requested: Option<&Value>, fallback: Option<&Value>) -> TypographyTokens {
    let mut typography = match fallback {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let empty = Value::Object(Map::new());
    let source = requested.filter(|value| plain_object(value)).unwrap_or(&empty);
    let mut replaced = Vec::new();
    for role in TYPOGRAPHY_ROLES {
        let value = js_trim(&text(prop(source, role))).to_owned();
        if value.is_empty() {
            continue;
        }
        typography.insert(role.to_owned(), Value::String(value.clone()));
        if !is_safe_font_family(&value) {
            replaced.push(json!({ "role": role, "requested": value, "applied": value }));
        }
    }
    let families: HashSet<String> = TYPOGRAPHY_ROLES
        .iter()
        .map(|role| font_family_key(&text(typography.get(*role))))
        .filter(|key| !key.is_empty())
        .collect();
    TypographyTokens { typography, replaced, family_count: families.len() }
}

/// The `[0-9A-F]{6}` of a colour written with or without `#`, upper-cased.
pub(crate) fn normalized_hex(value: &str) -> Option<String> {
    let upper = value.strip_prefix('#').unwrap_or(value).to_uppercase();
    (upper.chars().count() == 6 && upper.chars().all(|c| c.is_ascii_hexdigit())).then_some(upper)
}

fn hex_to_rgb(value: &str) -> Option<[f64; 3]> {
    let normalized = normalized_hex(value)?;
    let channel = |offset: usize| f64::from(u8::from_str_radix(&normalized[offset..offset + 2], 16).unwrap_or(0));
    Some([channel(0), channel(2), channel(4)])
}

fn is_hex(value: &Value) -> bool {
    hex_to_rgb(&text_of(value)).is_some()
}

fn rgb_to_hex(channels: [f64; 3]) -> String {
    channels.iter().map(|channel| format!("{:02X}", math::round(clamp(*channel, 0.0, 255.0)) as u32)).collect()
}

#[derive(Debug, Clone, Copy)]
struct Hsl {
    hue: f64,
    saturation: f64,
    lightness: f64,
}

fn hex_to_hsl(value: &str) -> Option<Hsl> {
    let rgb = hex_to_rgb(value)?;
    let [red, green, blue] = rgb.map(|channel| channel / 255.0);
    let maximum = red.max(green).max(blue);
    let minimum = red.min(green).min(blue);
    let lightness = (maximum + minimum) / 2.0;
    let delta = maximum - minimum;
    if delta == 0.0 {
        return Some(Hsl { hue: 0.0, saturation: 0.0, lightness: lightness * 100.0 });
    }
    let saturation = delta / (1.0 - (2.0 * lightness - 1.0).abs());
    let mut hue = (red - green) / delta + 4.0;
    if maximum == red {
        hue = ((green - blue) / delta) % 6.0;
    } else if maximum == green {
        hue = (blue - red) / delta + 2.0;
    }
    hue = (hue * 60.0 + 360.0) % 360.0;
    Some(Hsl { hue, saturation: saturation * 100.0, lightness: lightness * 100.0 })
}

/// `hslToHex`: upper-case hex of a hue (degrees), saturation and lightness (percent).
pub fn hsl_to_hex(hue: f64, saturation: f64, lightness: f64) -> String {
    let h = ((hue % 360.0) + 360.0) % 360.0;
    let s = clamp(saturation, 0.0, 100.0) / 100.0;
    let l = clamp(lightness, 0.0, 100.0) / 100.0;
    let chroma = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let segment = h / 60.0;
    let secondary = chroma * (1.0 - ((segment % 2.0) - 1.0).abs());
    let floor = segment.floor();
    let index = if floor.is_nan() || floor > 5.0 { 5 } else { floor as usize };
    let (red, green, blue) = match index {
        0 => (chroma, secondary, 0.0),
        1 => (secondary, chroma, 0.0),
        2 => (0.0, chroma, secondary),
        3 => (0.0, secondary, chroma),
        4 => (secondary, 0.0, chroma),
        _ => (chroma, 0.0, secondary),
    };
    let offset = l - chroma / 2.0;
    rgb_to_hex([(red + offset) * 255.0, (green + offset) * 255.0, (blue + offset) * 255.0])
}

/// `relativeLuminance`: the WCAG luminance of a hex colour, absent when it is not one.
pub fn relative_luminance(value: &str) -> Option<f64> {
    let rgb = hex_to_rgb(value)?;
    let [red, green, blue] = rgb.map(|channel| {
        let scaled = channel / 255.0;
        if scaled <= 0.04045 { scaled / 12.92 } else { math::pow((scaled + 0.055) / 1.055, 2.4) }
    });
    Some(0.2126 * red + 0.7152 * green + 0.0722 * blue)
}

/// `contrastRatio`: the WCAG ratio of two hex colours to two decimals, absent when either is not one.
pub fn contrast_ratio(foreground: &str, background: &str) -> Option<f64> {
    let front = relative_luminance(foreground)?;
    let back = relative_luminance(background)?;
    let lighter = front.max(back);
    let darker = front.min(back);
    Some(math::round(((lighter + 0.05) / (darker + 0.05)) * 100.0) / 100.0)
}

fn contrast_of(foreground: &Value, background: &Value) -> Option<f64> {
    contrast_ratio(&text_of(foreground), &text_of(background))
}

/// Steps the lightness of `color` toward `direction` until it clears `minimum` against `against`. The colour as written
/// is returned when it already clears it.
pub(crate) fn adjust_lightness_for_contrast(color: &Value, against: &Value, minimum: f64, direction: f64) -> Value {
    let Some(hsl) = hex_to_hsl(&text_of(color)) else {
        return color.clone();
    };
    let mut candidate = color.clone();
    let mut lightness = hsl.lightness;
    for _ in 0..40 {
        if contrast_of(&candidate, against).is_some_and(|ratio| ratio >= minimum) {
            return candidate;
        }
        lightness = clamp(lightness + direction * 2.5, 0.0, 100.0);
        candidate = Value::String(hsl_to_hex(hsl.hue, hsl.saturation, lightness));
        if lightness == 0.0 || lightness == 100.0 {
            break;
        }
    }
    candidate
}

fn color(colors: &Map<String, Value>, role: &str) -> Value {
    colors.get(role).cloned().unwrap_or(Value::Null)
}

fn ensure_contrast(colors: &mut Map<String, Value>, foreground_role: &str, background_role: &str, minimum: f64, adjustments: &mut Vec<Value>) {
    let foreground = color(colors, foreground_role);
    let background = color(colors, background_role);
    let Some(ratio) = contrast_of(&foreground, &background) else {
        return;
    };
    if ratio >= minimum {
        return;
    }
    // A mid-toned field cannot be answered by pushing the ink further the way it already leans: white has nowhere
    // lighter to go. Both directions are measured, the ink keeps leaning away from the field when that works, and the
    // better answer is taken when it does not.
    let preferred = if relative_luminance(&text_of(&background)).unwrap_or(0.0) >= 0.5 { -1.0 } else { 1.0 };
    let candidates: Vec<(Value, f64)> = [preferred, -preferred]
        .iter()
        .map(|direction| {
            let candidate = adjust_lightness_for_contrast(&foreground, &background, minimum, *direction);
            let measured = contrast_of(&candidate, &background).unwrap_or(0.0);
            (candidate, measured)
        })
        .collect();
    let best = candidates.iter().find(|(_, measured)| *measured >= minimum).unwrap_or_else(|| {
        candidates.iter().skip(1).fold(&candidates[0], |left, right| if right.1 > left.1 { right } else { left })
    });
    let repaired = best.0.clone();
    if repaired != foreground {
        colors.insert(foreground_role.to_owned(), repaired.clone());
        adjustments.push(json!({
            "role": foreground_role,
            "from": foreground,
            "to": repaired,
            "reason": format!(
                "{foreground_role} on {background_role} measured {}:1; {}:1 is required.",
                number_to_string(ratio),
                number_to_string(minimum)
            ),
        }));
    }
}

/// What [`normalize_palette_tokens`] answers.
#[derive(Debug, Clone, PartialEq)]
pub struct PaletteTokens {
    pub colors: Map<String, Value>,
    pub adjustments: Vec<Value>,
}

/// `normalizePaletteTokens`: repairs only what makes text unreadable or the deck look unfinished (pure black fields,
/// background tints that are too saturated, foreground roles that fail WCAG against their field), then derives the
/// paired tints and the four state colours. Hue choices stay untouched so explicit brand palettes survive.
pub fn normalize_palette_tokens(source: &Value) -> PaletteTokens {
    let mut colors = match source {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    let mut adjustments: Vec<Value> = Vec::new();
    let hsl_of = |colors: &Map<String, Value>, role: &str| hex_to_hsl(&text(colors.get(role)));
    if let Some(inverse) = hsl_of(&colors, "inverse")
        && (inverse.lightness < 7.0 || inverse.saturation < 8.0)
    {
        let hue = if inverse.saturation < 8.0 { hsl_of(&colors, "accent").map_or(216.0, |accent| accent.hue) } else { inverse.hue };
        let repaired = hsl_to_hex(
            hue,
            clamp(inverse.saturation.max(22.0), 12.0, 40.0),
            clamp(inverse.lightness.max(10.0), 10.0, 20.0),
        );
        adjustments.push(json!({
            "role": "inverse",
            "from": color(&colors, "inverse"),
            "to": repaired,
            "reason": "Dark fields stay tinted between 10% and 20% lightness; pure black reads as unfinished.",
        }));
        colors.insert("inverse".into(), Value::String(repaired));
    }
    if let Some(canvas) = hsl_of(&colors, "canvas")
        && (canvas.lightness < 90.0 || canvas.saturation > 22.0)
    {
        let repaired = hsl_to_hex(canvas.hue, canvas.saturation.min(18.0), canvas.lightness.max(95.0));
        adjustments.push(json!({
            "role": "canvas",
            "from": color(&colors, "canvas"),
            "to": repaired,
            "reason": "Light canvases stay near-white with low saturation.",
        }));
        colors.insert("canvas".into(), Value::String(repaired));
    }
    ensure_contrast(&mut colors, "ink", "canvas", 7.0, &mut adjustments);
    ensure_contrast(&mut colors, "muted", "canvas", TEXT_CONTRAST_MINIMUM, &mut adjustments);
    // Muted copy also lands on surface panels, so it must clear the darkest one.
    for panel in ["surface", "surface2"] {
        if is_hex(&color(&colors, panel)) {
            ensure_contrast(&mut colors, "muted", panel, TEXT_CONTRAST_MINIMUM, &mut adjustments);
        }
    }
    ensure_contrast(&mut colors, "onInverse", "inverse", TEXT_CONTRAST_MINIMUM, &mut adjustments);
    // onAccent is the ink every composer puts on an accent field, including 10pt table values and headers, so it has
    // to clear the readable minimum rather than the large-text one.
    ensure_contrast(&mut colors, "onAccent", "accent", TEXT_CONTRAST_MINIMUM, &mut adjustments);
    // A second dark step gives panels and cards on a dark field a planned tone.
    if let Some(dark_field) = hsl_of(&colors, "inverse")
        && !is_hex(&color(&colors, "inverse2"))
    {
        let second = hsl_to_hex(dark_field.hue, dark_field.saturation, clamp(dark_field.lightness + 7.0, 14.0, 30.0));
        colors.insert("inverse2".into(), Value::String(second));
    }
    // Accents are tuned for light canvases; on the dark field the same hue needs a lighter step to stay legible, so
    // each accent gets a paired tint. Each tint clears the hardest field of its kind.
    let dark_panel = if is_hex(&color(&colors, "inverse2")) { color(&colors, "inverse2") } else { color(&colors, "inverse") };
    let light_panel = if is_hex(&color(&colors, "surface2")) { color(&colors, "surface2") } else { color(&colors, "canvas") };
    for role in ["accent", "accent2"] {
        if !is_hex(&color(&colors, role)) {
            continue;
        }
        let light_key = format!("{role}Light");
        if !is_hex(&color(&colors, &light_key)) && is_hex(&dark_panel) {
            let tint = adjust_lightness_for_contrast(&color(&colors, role), &dark_panel, TEXT_CONTRAST_MINIMUM, 1.0);
            colors.insert(light_key, tint);
        }
        let deep_key = format!("{role}Deep");
        if !is_hex(&color(&colors, &deep_key)) && is_hex(&light_panel) {
            let tint = adjust_lightness_for_contrast(&color(&colors, role), &light_panel, TEXT_CONTRAST_MINIMUM, -1.0);
            colors.insert(deep_key, tint);
        }
    }
    // Four state colours on fixed hues, each as a solid mark, a weak field under a state word and the word itself.
    for (role, hue) in STATE_HUES {
        if !is_hex(&color(&colors, role)) {
            let solid = Value::String(hsl_to_hex(hue, 65.0, 48.0));
            let canvas = color(&colors, "canvas");
            let mark = if is_hex(&canvas) {
                adjust_lightness_for_contrast(&solid, &canvas, LARGE_TEXT_CONTRAST_MINIMUM, -1.0)
            } else {
                solid
            };
            colors.insert(role.to_owned(), mark);
        }
        let weak_key = format!("{role}Weak");
        if !is_hex(&color(&colors, &weak_key)) {
            colors.insert(weak_key.clone(), Value::String(hsl_to_hex(hue, 45.0, 92.0)));
        }
        let text_key = format!("{role}Text");
        if !is_hex(&color(&colors, &text_key)) {
            let mut word = Value::String(hsl_to_hex(hue, 30.0, 34.0));
            for field in [color(&colors, "canvas"), light_panel.clone(), color(&colors, &weak_key)] {
                if is_hex(&field) {
                    word = adjust_lightness_for_contrast(&word, &field, TEXT_CONTRAST_MINIMUM, -1.0);
                }
            }
            colors.insert(text_key, word);
        }
    }
    PaletteTokens { colors, adjustments }
}

fn palette_slots(colors: &Map<String, Value>) -> Value {
    let raw = |role: &str| match colors.get(role) {
        Some(value) if truthy(value) => value.clone(),
        _ => Value::String(String::new()),
    };
    json!({
        "dominant": raw("accent"),
        "secondary": raw("accent2"),
        "darkField": raw("inverse"),
        "lightField": raw("canvas"),
        "softAccent": raw("surface"),
        "mutedText": raw("muted"),
    })
}

fn hue_family(value: &str) -> Option<u32> {
    let hsl = hex_to_hsl(value)?;
    if hsl.saturation < 35.0 || hsl.lightness < 18.0 || hsl.lightness > 88.0 {
        return None;
    }
    Some((((hsl.hue + 15.0) % 360.0) / 30.0).floor() as u32)
}

/// `saturatedHueFamilies`: the distinct 30-degree hue families of the saturated mid-tone colours, in first-seen order.
pub fn saturated_hue_families<S: AsRef<str>>(values: &[S]) -> Vec<u32> {
    let mut families = Vec::new();
    for value in values {
        if let Some(family) = hue_family(value.as_ref())
            && !families.contains(&family)
        {
            families.push(family);
        }
    }
    families
}

/// `designDisciplineBrief`: the typography roles, palette slots, colour roles and the rules the design is held to.
pub fn design_discipline_brief(tokens: Option<&Value>) -> Value {
    let empty = Value::Object(Map::new());
    let typography = opt_prop(tokens, "typography").filter(|value| plain_object(value)).unwrap_or(&empty);
    let colors_value = opt_prop(tokens, "colors").filter(|value| plain_object(value)).unwrap_or(&empty);
    let colors = colors_value.as_object().expect("an object");
    let face = |role: &str| match prop(typography, role) {
        Some(value) if truthy(value) => value.clone(),
        _ => Value::String(String::new()),
    };
    json!({
        "typographyRoles": { "display": face("display"), "body": face("body"), "data": face("data") },
        "paletteSlots": palette_slots(colors),
        "colorRoles": js_object_keys(colors),
        "rules": [
            format!("Text uses fontRole display/body/data only; at most {MAX_FONT_FAMILIES_PER_SLIDE} families per slide."),
            "Colors use colorRole/fillRole/lineRole from the palette; free hex values are rejected.",
            format!(
                "Dominant color carries 60-70% of visual weight; saturated accents stay within {MAX_ACCENT_HUE_FAMILIES} hue families per deck and under 10% of the canvas."
            ),
            format!(
                "Text contrast against its field is at least {}:1 ({}:1 from {LARGE_TEXT_POINT_SIZE}pt).",
                number_to_string(TEXT_CONTRAST_MINIMUM),
                number_to_string(LARGE_TEXT_CONTRAST_MINIMUM)
            ),
            "Content slides occupy at least two of three horizontal bands; leftover blank space is a defect, not negative space.",
            "Evidence images sit in a contained frame; bleed images under text carry a scrim.",
            "No accent stripes, title underlines, or equal card grids.",
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn palette(entries: &[(&str, &str)]) -> Value {
        Value::Object(entries.iter().map(|(key, value)| ((*key).to_owned(), json!(value))).collect())
    }

    fn colors_of(entries: &[(&str, &str)]) -> Map<String, Value> {
        normalize_palette_tokens(&palette(entries)).colors
    }

    fn ratio(colors: &Map<String, Value>, foreground: &str, background: &str) -> f64 {
        contrast_of(&color(colors, foreground), &color(colors, background)).expect("hex colours")
    }

    #[test]
    fn font_keys_drop_quotes_and_weight_words() {
        assert_eq!(font_family_key("\"Segoe UI\" Semilight"), "segoe ui");
        assert_eq!(font_family_key("  Noto Sans KR  "), "noto sans kr");
        assert_eq!(font_family_key("Aptos Display"), "aptos");
        assert!(is_safe_font_family("calibri light"));
        assert!(!is_safe_font_family(""));
    }

    #[test]
    fn tokens_keep_requested_typefaces_and_surface_unsafe_ones_as_advisories() {
        let typography = normalize_typography_tokens(
            Some(&json!({ "display": "Aptos Display", "body": "Segoe UI", "data": "Courier New" })),
            Some(&json!({ "display": "Cambria", "body": "Calibri", "data": "Arial" })),
        );
        assert_eq!(
            Value::Object(typography.typography.clone()),
            json!({ "display": "Aptos Display", "body": "Segoe UI", "data": "Courier New" })
        );
        let pairs: Vec<(String, String)> = typography
            .replaced
            .iter()
            .map(|entry| (text(prop(entry, "requested")), text(prop(entry, "applied"))))
            .collect();
        assert_eq!(
            pairs,
            [("Aptos Display".to_owned(), "Aptos Display".to_owned()), ("Segoe UI".to_owned(), "Segoe UI".to_owned())]
        );
        assert!(!is_safe_font_family("Consolas"));
        assert!(is_safe_font_family("맑은 고딕"));
        assert!(is_safe_font_family("Noto Sans KR"));
        assert!(is_safe_font_family("Noto Sans"));
        assert!(is_safe_font_family("본고딕"));
    }

    #[test]
    fn palettes_stay_readable() {
        let result = normalize_palette_tokens(&palette(&[
            ("canvas", "FFFFFF"),
            ("ink", "111111"),
            ("muted", "A0A0A0"),
            ("accent", "2563EB"),
            ("accent2", "F59E0B"),
            ("surface", "F1F5F9"),
            ("surface2", "E2E8F0"),
            ("inverse", "000000"),
            ("onAccent", "FFFFFF"),
            ("onInverse", "FFFFFF"),
        ]));
        let colors = &result.colors;
        assert_ne!(colors["inverse"], json!("000000"));
        assert!(ratio(colors, "muted", "surface2") >= 4.5);
        assert!(ratio(colors, "accentLight", "inverse2") >= 4.5);
        assert!(ratio(colors, "accent2Deep", "surface2") >= 4.5);
        assert!(result.adjustments.iter().any(|entry| prop(entry, "role") == Some(&json!("inverse"))));
        assert!(result.adjustments.iter().any(|entry| prop(entry, "role") == Some(&json!("muted"))));
        // The four state colours derive when a pack sets none: the word clears the canvas, the light panel and its
        // own field, the mark clears the canvas, and the words and fields add no saturated hue family beside the accents.
        for role in STATE_ROLES {
            let word = text(colors.get(&format!("{role}Text")));
            let weak = text(colors.get(&format!("{role}Weak")));
            for field in ["FFFFFF", "E2E8F0", weak.as_str()] {
                assert!(contrast_ratio(&word, field).expect("hex") >= 4.5, "{role} text on {field}");
            }
            assert!(contrast_ratio(&text(colors.get(role)), "FFFFFF").expect("hex") >= 3.0, "{role} mark on the canvas");
        }
        let accents = [text(colors.get("accent")), text(colors.get("accent2"))];
        let mut with_states: Vec<String> = accents.to_vec();
        for role in STATE_ROLES {
            with_states.push(text(colors.get(&format!("{role}Text"))));
            with_states.push(text(colors.get(&format!("{role}Weak"))));
        }
        assert_eq!(
            saturated_hue_families(&with_states).len(),
            saturated_hue_families(&accents).len(),
            "state words and fields stay under the saturated band"
        );
        assert_eq!(
            colors_of(&[("canvas", "FFFFFF"), ("ink", "111111"), ("critical", "B00020")])["critical"],
            json!("B00020"),
            "a pack-set state color is kept"
        );
    }

    #[test]
    fn on_accent_clears_the_readable_minimum() {
        // onAccent carries 10pt table values in the composers: a mid-toned accent cannot be answered by lightening
        // white any further, so the repair has to reach for dark ink instead.
        for accent in ["73A527", "27A56A", "D89224", "1F7A55"] {
            let repaired = colors_of(&[
                ("canvas", "F8F9F6"),
                ("ink", "17221C"),
                ("muted", "66716B"),
                ("accent", accent),
                ("inverse", "132C24"),
                ("onAccent", "FFFFFF"),
                ("onInverse", "FFFFFF"),
            ]);
            assert!(ratio(&repaired, "onAccent", "accent") >= 4.5, "{} on {accent}", text(repaired.get("onAccent")));
        }
    }

    #[test]
    fn hue_families_count_saturated_mid_tones() {
        assert_eq!(saturated_hue_families(&["60A5FA", "A3E635", "A78BFA"]).len(), 3);
        assert!(saturated_hue_families(&["F5F7FA", "0B1220"]).is_empty());
    }

    #[test]
    fn hex_and_hsl_round_trip() {
        assert_eq!(hsl_to_hex(0.0, 100.0, 50.0), "FF0000");
        assert_eq!(hsl_to_hex(-120.0, 100.0, 50.0), "0000FF");
        assert_eq!(hsl_to_hex(360.0, 0.0, 100.0), "FFFFFF");
        assert_eq!(contrast_ratio("#ffffff", "000000"), Some(21.0));
        assert_eq!(contrast_ratio("nope", "000000"), None);
    }

    #[test]
    fn shapes_are_read_by_name_and_type() {
        assert!(is_motif_shape(&json!({ "name": "Mixdog Motif 1" })));
        assert!(!is_motif_shape(&json!({})));
        assert!(is_picture_shape(&json!({ "type": 13 })));
        assert!(is_picture_shape(&json!({ "type": "13" })));
        assert!(is_picture_shape(&json!({ "type": "p:pic" })));
        assert!(!is_picture_shape(&json!({ "type": "p:sp" })));
        let slide = |names: &[&str]| json!({ "shapes": names.iter().map(|name| json!({ "name": name })).collect::<Vec<_>>() });
        assert_eq!(signed_visual_type(&slide(&["mixdog-spec:structure:timeline", "mixdog-spec:table"])), "structure:timeline");
        assert_eq!(signed_visual_type(&slide(&["mixdog-spec:structure", "mixdog-spec:chevrons"])), "process");
        assert_eq!(signed_visual_type(&slide(&["mixdog-spec:table:x", "mixdog-spec:stat"])), "table");
        assert_eq!(signed_visual_type(&slide(&["mixdog-spec:stat"])), "metric");
        assert_eq!(signed_visual_type(&slide(&["Title"])), "");
        assert_eq!(signed_visual_type(&json!({})), "");
    }

    #[test]
    fn the_brief_names_roles_slots_and_rules() {
        let brief = design_discipline_brief(Some(&json!({
            "typography": { "display": "Cambria", "body": "Calibri" },
            "colors": { "accent": "1F7A55", "canvas": "FFFFFF" },
        })));
        assert_eq!(brief["typographyRoles"], json!({ "display": "Cambria", "body": "Calibri", "data": "" }));
        assert_eq!(brief["paletteSlots"]["dominant"], json!("1F7A55"));
        assert_eq!(brief["paletteSlots"]["secondary"], json!(""));
        assert_eq!(brief["colorRoles"], json!(["accent", "canvas"]));
        assert_eq!(brief["rules"][3], json!("Text contrast against its field is at least 4.5:1 (3:1 from 24pt)."));
        assert_eq!(design_discipline_brief(None)["colorRoles"], json!([]));
    }
}
