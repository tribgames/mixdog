//! Models the server describes by neither parameters nor modes are named by
//! their id: `<base>[-thinking][-<effort>][-fast]`. The ids sharing a base
//! are one model whose efforts and fast variants are the ids' suffixes, and a
//! request for the base picks one of them (`parseCursorVariantId`,
//! `variantGroupModel`, `selectCursorVariant`).

use mixdog_core_api::domain::provider::ProviderError;
use mixdog_js::js_trim;
use mixdog_js::locale_compare;

use super::models::CursorModel;
use super::models::invalid;

/// The efforts a suffix can name, least to most intensive.
pub const EFFORT_ORDER: [&str; 6] = ["none", "low", "medium", "high", "xhigh", "max"];
/// The order a request without an effort prefers; no suffix at all comes first.
const DEFAULT_EFFORT_ORDER: [Option<&str>; 7] =
    [None, Some("medium"), Some("high"), Some("low"), Some("none"), Some("xhigh"), Some("max")];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VariantId {
    pub id: String,
    pub base_id: String,
    pub effort: Option<String>,
    pub fast: bool,
    pub thinking: bool,
}

pub fn parse_variant_id(value: &str) -> VariantId {
    let original = js_trim(value);
    if original == "auto" || original == "default" {
        return VariantId { id: original.to_owned(), base_id: "auto".to_owned(), effort: None, fast: false, thinking: false };
    }
    let mut id = original;
    let (mut fast, mut thinking, mut effort) = (false, false, None);
    if let Some(rest) = id.strip_suffix("-fast") {
        fast = true;
        id = rest;
    }
    if let Some(rest) = id.strip_suffix("-thinking") {
        thinking = true;
        id = rest;
    }
    if let Some(rest) = id.strip_suffix("-extra-high") {
        effort = Some("xhigh");
        id = rest;
    } else if let Some((name, rest)) = ["none", "low", "medium", "high", "xhigh", "max"]
        .into_iter()
        .find_map(|name| id.strip_suffix(name).and_then(|rest| rest.strip_suffix('-')).map(|rest| (name, rest)))
    {
        effort = Some(name);
        id = rest;
    }
    if let Some(rest) = id.strip_suffix("-thinking") {
        thinking = true;
        id = rest;
    }
    VariantId {
        id: original.to_owned(),
        base_id: format!("{id}{}", if thinking { "-thinking" } else { "" }),
        effort: effort.map(str::to_owned),
        fast,
        thinking,
    }
}

pub struct SlugVariant<'a> {
    pub parsed: VariantId,
    pub model: &'a CursorModel,
}

/// The ids sharing one base, in the order requests prefer them.
pub struct SlugGroup<'a> {
    pub base_id: String,
    pub variants: Vec<SlugVariant<'a>>,
}

fn preference(variant: &VariantId) -> usize {
    let rank = DEFAULT_EFFORT_ORDER.iter().position(|e| *e == variant.effort.as_deref());
    usize::from(variant.fast) * 100 + rank.unwrap_or(50)
}

/// The id-named models of a listing, grouped by base in the order their
/// bases first appear.
pub fn slug_groups<'a>(models: impl IntoIterator<Item = &'a CursorModel>) -> Vec<SlugGroup<'a>> {
    let mut groups: Vec<SlugGroup<'a>> = Vec::new();
    for model in models.into_iter().filter(|m| !m.is_parameterized()) {
        let parsed = parse_variant_id(&model.id);
        if parsed.id.is_empty() {
            continue;
        }
        match groups.iter_mut().find(|g| g.base_id == parsed.base_id) {
            Some(group) => group.variants.push(SlugVariant { parsed, model }),
            None => groups.push(SlugGroup { base_id: parsed.base_id.clone(), variants: vec![SlugVariant { parsed, model }] }),
        }
    }
    for group in &mut groups {
        group.variants.sort_by(|a, b| {
            preference(&a.parsed)
                .cmp(&preference(&b.parsed))
                .then_with(|| locale_compare(&a.parsed.id, &b.parsed.id))
        });
    }
    groups
}

/// The id that serves `effort` and speed; `None` when the group has no id at
/// the requested speed.
pub fn select_variant<'g, 'a>(
    group: &'g SlugGroup<'a>,
    effort: Option<&str>,
    fast: bool,
) -> Result<Option<&'g SlugVariant<'a>>, ProviderError> {
    let wanted = effort.map(|e| js_trim(e).to_lowercase()).filter(|e| !e.is_empty());
    if let Some(wanted) = wanted {
        if let Some(exact) = group
            .variants
            .iter()
            .find(|v| v.parsed.effort.as_deref() == Some(wanted.as_str()) && v.parsed.fast == fast)
        {
            return Ok(Some(exact));
        }
        let effort_exists = group.variants.iter().any(|v| v.parsed.effort.as_deref() == Some(wanted.as_str()));
        let base = &group.base_id;
        return Err(invalid(if fast && effort_exists {
            format!("Cursor model {base} does not offer {wanted} effort in Fast mode")
        } else {
            format!("Cursor model {base} does not offer {wanted} effort")
        }));
    }
    let same_speed: Vec<&SlugVariant<'a>> = group.variants.iter().filter(|v| v.parsed.fast == fast).collect();
    for preferred in DEFAULT_EFFORT_ORDER {
        if let Some(found) = same_speed.iter().find(|v| v.parsed.effort.as_deref() == preferred) {
            return Ok(Some(found));
        }
    }
    Ok(same_speed.first().copied())
}
