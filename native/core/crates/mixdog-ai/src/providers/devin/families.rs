//! Effort families: the logical models the Cascade catalog serves as one wire
//! uid per effort tier (`devin-wire-models.mjs`). Siblings collapse into one
//! model from three sources, in order: the server's own family metadata, the
//! reviewed table (`reviewed_families.json`, recorded from Node's
//! `DEVIN_REVIEWED_FAMILIES`), and live `X` / `X-thinking` pairs.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::collections::HashSet;
use std::sync::LazyLock;

use mixdog_js::js_trim;
use serde::Deserialize;

use super::schema::ClientModelConfig;

/// Effort tiers least to most intensive.
pub const THINKING_EFFORTS: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];
/// Routing keys add `off` (thinking disabled), which rows expose as `none`.
const ROUTING_KEYS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/// Ladder of an automatically paired `X` / `X-thinking` family.
const PAIR_EFFORTS: [&str; 4] = ["minimal", "low", "medium", "high"];

/// Effort key → the uid that serves it.
pub type Routing = BTreeMap<String, String>;

/// Per-million-token rates that tell two SKUs apart.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Cost {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
}

impl Cost {
    fn priced(&self) -> bool {
        self.input != 0.0 || self.output != 0.0
    }
}

/// The effort surface of a model.
#[derive(Debug, Clone, PartialEq)]
pub struct Thinking {
    pub efforts: Vec<String>,
    pub default_level: Option<String>,
    /// No wire uid serves the model with thinking off.
    pub requires_effort: bool,
    pub effort_routing: Option<Routing>,
}

/// One model before it is a row: a single uid, or the collapse of a family.
#[derive(Debug, Clone, PartialEq)]
pub struct Spec {
    pub id: String,
    pub name: String,
    pub description: String,
    pub reasoning: bool,
    pub images: bool,
    pub supports_tools: bool,
    pub supports_parallel_tool_calls: bool,
    pub cost: Cost,
    pub context_window: u64,
    pub max_tokens: u64,
    pub router: bool,
    /// The uid a request without an effort goes to, when it is not `id`.
    pub request_model_id: Option<String>,
    pub thinking: Option<Thinking>,
    pub is_provider_default: bool,
}

/// What a family declares of its effort surface.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Declared {
    efforts: Vec<String>,
    #[serde(default)]
    default_level: Option<String>,
    #[serde(default)]
    requires_effort: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Family {
    id: String,
    name: String,
    /// Member uids in default priority order.
    members: Vec<String>,
    routing: Routing,
    #[serde(default)]
    default_member: Option<String>,
    #[serde(default)]
    thinking: Option<Declared>,
}

static REVIEWED: LazyLock<Vec<Family>> =
    LazyLock::new(|| serde_json::from_str(include_str!("reviewed_families.json")).expect("reviewed families"));

/// Member → family id of the reviewed table (case-insensitive; a member that
/// is its own family id is not an alias), and the family ids.
static REVIEWED_CLAIMS: LazyLock<(HashSet<String>, HashSet<String>)> = LazyLock::new(|| {
    let mut members = HashSet::new();
    let mut ids = HashSet::new();
    for family in REVIEWED.iter() {
        ids.insert(family.id.clone());
        for member in &family.members {
            if *member != family.id {
                members.insert(member.to_lowercase());
            }
        }
    }
    (members, ids)
});

fn is_reviewed_claim(id: &str) -> bool {
    REVIEWED_CLAIMS.0.contains(&id.to_lowercase()) || REVIEWED_CLAIMS.1.contains(id)
}

/// The lowercase text with every run of characters outside `[a-z0-9]`
/// replaced by `separator`, and none left at either end.
fn squash(text: &str, separator: &str) -> String {
    let mut out = String::new();
    let mut pending = false;
    for c in text.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if pending && !out.is_empty() {
                out.push_str(separator);
            }
            pending = false;
            out.push(c);
        } else {
            pending = true;
        }
    }
    out
}

fn effort_by_name(name: &str) -> Option<&'static str> {
    match name {
        "none" | "nothinking" => Some("off"),
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        _ => None,
    }
}

/// A server-declared family lane: fast service and 1M context are separate
/// lanes, effort is the lane's axis.
pub struct Lane {
    id: String,
    name: String,
    members: Vec<String>,
    routing: Routing,
    default_member: Option<String>,
}

/// Files a config under its server-declared family lane.
pub fn collect_lane(lanes: &mut Vec<Lane>, config: &ClientModelConfig, uid: &str) {
    let Some(metadata) = &config.family else { return };
    let label = js_trim(&metadata.label);
    if label.is_empty() {
        return;
    }
    let mut effort: Option<&'static str> = None;
    let mut thinking: Option<bool> = None;
    let (mut fast, mut one_million) = (false, false);
    for entry in &metadata.entries {
        let Some(value) = &entry.value else { continue };
        match squash(&entry.key, " ").as_str() {
            "fast mode" => fast = value.order == 1,
            "thinking" => thinking = Some(value.order == 1),
            "1m context" => one_million = value.order == 1,
            "effort" | "reasoning effort" => effort = effort_by_name(&squash(&value.name, "")),
            _ => {}
        }
    }
    // Paired non-thinking/thinking configs share an effort label; the
    // explicit Thinking axis decides which one is the off route.
    if thinking == Some(false) {
        effort = Some("off");
    }
    let base = squash(label, "-");
    if base.is_empty() {
        return;
    }
    let id = format!("{base}{}{}", if one_million { "-1m" } else { "" }, if fast { "-fast" } else { "" });
    let at = match lanes.iter().position(|l| l.id == id) {
        Some(at) => at,
        None => {
            lanes.push(Lane {
                name: format!("{label}{}{}", if one_million { " 1M" } else { "" }, if fast { " Fast" } else { "" }),
                id,
                members: Vec::new(),
                routing: Routing::new(),
                default_member: None,
            });
            lanes.len() - 1
        }
    };
    let lane = &mut lanes[at];
    lane.members.push(uid.to_owned());
    if lane.default_member.is_none() && (config.is_default_model_in_family || metadata.is_default_model_in_family) {
        lane.default_member = Some(uid.to_owned());
    }
    if let Some(effort) = effort {
        lane.routing.entry(effort.to_owned()).or_insert_with(|| uid.to_owned());
    }
}

/// Lanes with an effort ladder become families; the server default member is
/// hoisted first. A lane with only an off route stays uncollapsed.
fn dynamic_families(lanes: Vec<Lane>) -> Vec<Family> {
    let mut families = Vec::new();
    for lane in lanes {
        let efforts: Vec<String> =
            THINKING_EFFORTS.iter().filter(|e| lane.routing.contains_key(**e)).map(|e| (*e).to_owned()).collect();
        if efforts.is_empty() {
            continue;
        }
        let members = match &lane.default_member {
            None => lane.members.clone(),
            Some(default) => {
                std::iter::once(default.clone()).chain(lane.members.iter().filter(|m| *m != default).cloned()).collect()
            }
        };
        let default_level = lane
            .default_member
            .as_ref()
            .and_then(|default| efforts.iter().find(|e| lane.routing.get(*e) == Some(default)).cloned());
        families.push(Family {
            id: lane.id,
            name: lane.name,
            members,
            default_member: lane.default_member,
            thinking: Some(Declared { efforts, default_level, requires_effort: !lane.routing.contains_key("off") }),
            routing: lane.routing,
        });
    }
    families
}

fn is_collapsed(spec: &Spec) -> bool {
    spec.request_model_id.is_some() || spec.thinking.as_ref().is_some_and(|t| t.effort_routing.is_some())
}

/// Points an already-collapsed model at the family's declared default member
/// when that member is one of its live routes. `None`: nothing to change.
fn reconcile_default_member(spec: &Spec, family: &Family, present: Option<&HashSet<String>>) -> Option<Spec> {
    let default = family.default_member.as_ref().filter(|d| **d != spec.id)?;
    let target = match present {
        Some(present) if !present.contains(default) => family.members.iter().find(|id| present.contains(*id))?,
        _ => default,
    };
    if spec.request_model_id.as_ref() == Some(target) {
        return None;
    }
    let routing = spec.thinking.as_ref()?.effort_routing.as_ref()?;
    ROUTING_KEYS
        .iter()
        .any(|key| routing.get(*key) == Some(target))
        .then(|| Spec { request_model_id: Some(target.clone()), ..spec.clone() })
}

/// Replaces each family's live members with one logical model at the
/// position of the family's first occurrence; other models pass through in
/// order.
fn collapse(specs: Vec<Spec>, families: &[Family]) -> Vec<Spec> {
    let mut by_id: HashMap<&str, &Spec> = HashMap::new();
    for spec in &specs {
        by_id.entry(spec.id.as_str()).or_insert(spec);
    }
    let mut replacement: HashMap<String, Spec> = HashMap::new();
    let mut family_of: HashMap<String, String> = HashMap::new();

    for family in families {
        let existing = by_id.get(family.id.as_str()).copied();
        let existing_collapsed = existing.is_some_and(is_collapsed);
        let raw_present: Vec<&String> = family
            .members
            .iter()
            .filter(|id| by_id.contains_key(id.as_str()) && !(**id == family.id && existing_collapsed))
            .collect();
        if raw_present.is_empty() {
            // Already collapsed upstream of this table: only the default may move.
            if let Some(existing) = existing.filter(|_| existing_collapsed)
                && let Some(refreshed) = reconcile_default_member(existing, family, None)
            {
                family_of.insert(family.id.clone(), family.id.clone());
                replacement.insert(family.id.clone(), refreshed);
            }
            continue;
        }
        for id in &raw_present {
            family_of.insert((*id).clone(), family.id.clone());
        }
        if existing.is_some() {
            family_of.insert(family.id.clone(), family.id.clone());
        }
        let present: HashSet<String> = raw_present.iter().map(|id| (*id).clone()).collect();
        if let Some(existing) = existing.filter(|_| existing_collapsed) {
            // Mixed input: the collapsed model wins and raw members are dropped.
            let kept = reconcile_default_member(existing, family, Some(&present)).unwrap_or_else(|| existing.clone());
            replacement.insert(family.id.clone(), kept);
            continue;
        }
        let members: Vec<&Spec> = raw_present.iter().map(|id| by_id[id.as_str()]).collect();
        let mut routing = Routing::new();
        let mut has_effort_route = false;
        for key in ROUTING_KEYS {
            let Some(target) = family.routing.get(key).filter(|t| present.contains(*t)) else { continue };
            routing.insert(key.to_owned(), target.clone());
            has_effort_route |= key != "off";
        }
        // Routing efforts to a live member means the family reasons.
        let reasoning = members.iter().any(|m| m.reasoning) || has_effort_route;
        let mut collapsed = members[0].clone();
        collapsed.id = family.id.clone();
        collapsed.name = family.name.clone();
        collapsed.reasoning = reasoning;
        collapsed.images = members.iter().any(|m| m.images);
        collapsed.context_window = members.iter().map(|m| m.context_window).max().unwrap_or_default();
        collapsed.max_tokens = members.iter().map(|m| m.max_tokens).max().unwrap_or_default();
        if members.iter().any(|m| m.is_provider_default) {
            collapsed.is_provider_default = true;
        }
        let default_wire = family
            .default_member
            .as_ref()
            .filter(|d| present.contains(*d))
            .unwrap_or(raw_present[0]);
        collapsed.request_model_id = (*default_wire != family.id).then(|| default_wire.clone());
        // A single-uid family keeps `reasoning` but has no tier to select.
        collapsed.thinking = match (&family.thinking, reasoning) {
            (Some(declared), true) => Some(Thinking {
                efforts: declared.efforts.clone(),
                default_level: declared.default_level.clone(),
                requires_effort: declared.requires_effort,
                effort_routing: (!routing.is_empty()).then_some(routing),
            }),
            _ => None,
        };
        replacement.insert(family.id.clone(), collapsed);
    }

    if replacement.is_empty() {
        return specs;
    }
    let mut emitted = HashSet::new();
    let mut out = Vec::new();
    for spec in specs {
        match family_of.get(&spec.id) {
            None => out.push(spec),
            Some(family_id) => {
                if !emitted.insert(family_id.clone()) {
                    continue;
                }
                if let Some(family_spec) = replacement.get(family_id) {
                    out.push(family_spec.clone());
                }
            }
        }
    }
    out
}

const PAIR_TOKENS: [&str; 3] = ["thinking", "reasoning", "reasoner"];

fn is_token_byte(byte: u8) -> bool {
    byte.is_ascii_digit() || byte.is_ascii_lowercase()
}

/// Bare twin id of a thinking variant: a trailing `-thinking`, else the first
/// `-thinking` / `-reasoning` / `-reasoner` token that is not negated
/// (`non-thinking`, `no-thinking`) and not part of a longer word.
fn thinking_twin_base_id(id: &str) -> Option<String> {
    let lower = id.to_ascii_lowercase();
    if lower.ends_with("-thinking") {
        let base = &id[..id.len() - "-thinking".len()];
        return (!base.is_empty()).then(|| base.to_owned());
    }
    let bytes = lower.as_bytes();
    for token in PAIR_TOKENS {
        let needle = format!("-{token}");
        let mut from = 0;
        while from < lower.len() {
            let Some(found) = lower[from..].find(&needle) else { break };
            let index = from + found;
            let end = index + needle.len();
            let mut word_start = index;
            while word_start > 0 && is_token_byte(bytes[word_start - 1]) {
                word_start -= 1;
            }
            let preceding = &lower[word_start..index];
            if !bytes.get(end).is_some_and(|b| is_token_byte(*b)) && preceding != "non" && preceding != "no" {
                let stripped = format!("{}{}", &id[..index], &id[end..]);
                return (!stripped.is_empty()).then_some(stripped);
            }
            from = index + 1;
        }
    }
    None
}

/// Every live `X` + `X-thinking` pair not claimed by the reviewed table,
/// unless both carry real, different prices (distinct SKUs). Off routes to
/// `X`, every effort to the thinking twin.
fn thinking_pair_families(specs: &[Spec]) -> Vec<Family> {
    let mut by_id: HashMap<&str, &Spec> = HashMap::new();
    for spec in specs {
        by_id.entry(spec.id.as_str()).or_insert(spec);
    }
    let mut families = Vec::new();
    for spec in specs {
        let Some(base_id) = thinking_twin_base_id(&spec.id).filter(|b| *b != spec.id) else { continue };
        let Some(base) = by_id.get(base_id.as_str()).copied() else { continue };
        if is_reviewed_claim(&spec.id) || is_reviewed_claim(&base_id) {
            continue;
        }
        if spec.cost.priced()
            && base.cost.priced()
            && (spec.cost.input != base.cost.input
                || spec.cost.output != base.cost.output
                || spec.cost.cache_read != base.cost.cache_read)
        {
            continue;
        }
        // A surface already carried by either twin wins. Otherwise no
        // per-class ladder applies: Devin trusts only the thinking surface its
        // catalog reports, and raw configs report none.
        let baked = spec.thinking.as_ref().or(base.thinking.as_ref()).filter(|t| !t.efforts.is_empty());
        let surface = match baked {
            Some(t) => Declared { efforts: t.efforts.clone(), default_level: t.default_level.clone(), requires_effort: false },
            None => Declared { efforts: PAIR_EFFORTS.iter().map(|e| (*e).to_owned()).collect(), default_level: None, requires_effort: false },
        };
        let mut routing = Routing::from([("off".to_owned(), base.id.clone())]);
        for effort in &surface.efforts {
            routing.insert(effort.clone(), spec.id.clone());
        }
        families.push(Family {
            id: base.id.clone(),
            name: base.name.clone(),
            members: vec![base.id.clone(), spec.id.clone()],
            routing,
            default_member: None,
            thinking: Some(surface),
        });
    }
    families
}

/// The catalog's models: effort siblings collapsed, from the server's family
/// metadata first, then the reviewed table, then live thinking pairs.
/// `lanes` are the configs' declared lanes; `account_default` the account's
/// starting uid.
pub fn collapse_all(specs: Vec<Spec>, lanes: Vec<Lane>, account_default: &str) -> Vec<Spec> {
    let declared = dynamic_families(lanes);
    let mut models = if declared.is_empty() { specs } else { collapse(specs, &declared) };
    models = collapse(models, &REVIEWED);
    let pairs = thinking_pair_families(&models);
    if !pairs.is_empty() {
        models = collapse(models, &pairs);
    }
    // The account default outranks its family's own default when an effort
    // routes to it: the family starts on that uid and effort.
    let index = models
        .iter()
        .position(|s| s.is_provider_default && s.thinking.as_ref().is_some_and(|t| t.effort_routing.is_some()));
    if let Some(index) = index {
        let family = &mut models[index];
        let thinking = family.thinking.as_mut().expect("selected for its thinking");
        let routing = thinking.effort_routing.as_ref().expect("selected for its routing");
        let effort = THINKING_EFFORTS
            .iter()
            .find(|level| routing.get(**level).map(String::as_str) == Some(account_default))
            .map(|level| (*level).to_owned());
        if let Some(effort) = effort {
            thinking.default_level = Some(effort);
            family.request_model_id = (family.id != account_default).then(|| account_default.to_owned());
        }
    }
    models
}
