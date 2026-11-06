//! Which wire a gateway model is reached on (`wire-route.mjs`). One answer
//! per provider and model, in this order: a wire the session already pinned,
//! (for a session that predates the table) the wire it started on, the user's
//! per-model override, the catalog's wire for the model (the models.dev SDK
//! package, [`wire_of_package`]), the single wire the roster advertises, the
//! profile's model-family table, the provider default, then the provider's
//! preference. Every tier is limited to the wires the gateway offers for that
//! model. The code never reads a model id itself: the family and legacy
//! patterns are rows of the profile ([`WireOffer`]). When nothing describes
//! the model, the provider default (or a `cold` family) applies and the route
//! says `Unknown`, so a session never pins a guess.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use mixdog_js::JsRegex;

use super::profile::{CompatProfile, LegacyWire, Wire, WireOffer};

/// Why a wire was chosen.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RouteSource {
    Pinned,
    Override,
    Catalog,
    Endpoints,
    Family,
    Default,
    /// The wire a session that predates the table started on.
    Legacy,
    /// Nothing describes the model; the conventional wire, never pinned.
    Unknown,
}

impl RouteSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pinned => "pinned",
            Self::Override => "override",
            Self::Catalog => "catalog",
            Self::Endpoints => "endpoints",
            Self::Family => "family",
            Self::Default => "default",
            Self::Legacy => "legacy",
            Self::Unknown => "unknown",
        }
    }
}

/// `pattern.test(id)` for a profile row; each pattern is compiled once.
fn id_matches(pattern: &'static str, id: &str) -> bool {
    static COMPILED: Mutex<Option<HashMap<&'static str, Arc<JsRegex>>>> = Mutex::new(None);
    let regex = {
        let mut cache = COMPILED.lock().unwrap_or_else(PoisonError::into_inner);
        cache
            .get_or_insert_with(HashMap::new)
            .entry(pattern)
            .or_insert_with(|| Arc::new(JsRegex::new_static(pattern, "i")))
            .clone()
    };
    regex.is_match(id)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Route {
    pub wire: Wire,
    pub source: RouteSource,
}

/// What is known about one model.
#[derive(Clone, Copy, Debug, Default)]
pub struct WireFacts<'a> {
    /// The routing id (an alias slug stays the alias).
    pub model: &'a str,
    /// The wire the session started on.
    pub keep: Option<Wire>,
    /// A session that predates the table: the wire it started on.
    pub legacy: bool,
    /// The user's per-model wire.
    pub override_wire: Option<Wire>,
    /// The wire the catalog assigns (see [`wire_of_package`]).
    pub catalog_wire: Option<Wire>,
    /// The wires the roster advertises for the model.
    pub endpoints: Option<&'a [Wire]>,
    /// False when no roster row or cached row describes the model at all.
    pub known: bool,
    /// An agent/tool session, or a send carrying tools.
    pub agent: bool,
    /// Wires that must not be chosen (the one a send was just refused on).
    pub exclude: &'a [Wire],
}

/// The wire models.dev's `npm` package names (`WIRE_API_BY_NPM`); no package
/// means Chat.
pub fn wire_of_package(package: Option<&str>) -> Option<Wire> {
    match package? {
        "@ai-sdk/openai" => Some(Wire::Responses),
        "@ai-sdk/anthropic" => Some(Wire::Messages),
        "@ai-sdk/google" => Some(Wire::Gemini),
        "@ai-sdk/openai-compatible" => Some(Wire::Chat),
        _ => None,
    }
}

/// The route a hook answers with, from the facts the adapter gathered and the
/// caller's context (`resolveWireRoute`).
pub fn route_for(
    profile: &CompatProfile,
    provider: &str,
    model: &str,
    facts: WireFacts<'_>,
    context: &mixdog_core_api::domain::provider::WireRouteContext,
) -> Option<mixdog_core_api::domain::provider::WireRoute> {
    let exclude: Vec<Wire> = context.exclude.iter().filter_map(|w| Wire::parse(w)).collect();
    let facts = WireFacts {
        model,
        agent: context.agent,
        legacy: context.legacy,
        keep: context.keep.as_deref().and_then(Wire::parse),
        exclude: &exclude,
        ..facts
    };
    resolve_wire(profile, &facts).map(|route| mixdog_core_api::domain::provider::WireRoute {
        wire: route.wire.as_str().to_owned(),
        source: route.source.as_str().to_owned(),
        profile_id: format!("{provider}:{}", route.wire.as_str()),
    })
}

/// `None` when the gateway offers the model on no wire.
pub fn resolve_wire(profile: &CompatProfile, facts: &WireFacts<'_>) -> Option<Route> {
    let offer = &profile.wires;
    let advertised: Vec<Wire> = offer
        .offered
        .iter()
        .copied()
        .filter(|w| facts.endpoints.is_none_or(|e| e.contains(w)))
        .filter(|w| !facts.exclude.contains(w))
        .collect();
    let usable = |wire: Wire| advertised.contains(&wire);
    let route = |wire, source| Some(Route { wire, source });
    // A wire the session already pinned stays while the model is still offered
    // on it (a model nothing describes keeps its pin: no metadata, no change).
    if let Some(keep) = facts.keep {
        let pool: &[Wire] = if facts.known { &advertised } else { offer.offered };
        if pool.contains(&keep) {
            return route(keep, RouteSource::Pinned);
        }
    }
    // The preferred advertised wire when the default is not one of them.
    let preferred = || {
        let order = if offer.preference.is_empty() { offer.offered } else { offer.preference };
        order.iter().copied().find(|w| usable(*w))
    };
    // Nothing describes the model: the gateway's conventional wire, flagged so
    // a session never pins the guess. A family that is certain without
    // metadata outranks it.
    let unknown = || {
        let cold = offer.families.iter().find(|f| f.cold && id_matches(f.pattern, facts.model) && usable(f.wire));
        let wire = cold.map(|f| f.wire).or_else(|| if usable(profile.default_wire) { Some(profile.default_wire) } else { preferred() });
        wire.and_then(|wire| route(wire, RouteSource::Unknown))
    };
    if facts.legacy {
        if !facts.known {
            return unknown();
        }
        // The wire a pre-table session started on, while the model still offers
        // it; otherwise the fresh resolution below (never an unadvertised wire).
        let catalog = facts.catalog_wire.filter(|w| usable(*w));
        let wire = legacy_wire(offer, facts.model, catalog, &advertised);
        if usable(wire) {
            return route(wire, RouteSource::Legacy);
        }
    }
    if let Some(wire) = facts.override_wire.filter(|w| usable(*w)) {
        return route(wire, RouteSource::Override);
    }
    if !facts.known {
        return unknown();
    }
    if let Some(wire) = facts.catalog_wire.filter(|w| usable(*w)) {
        return route(wire, RouteSource::Catalog);
    }
    if facts.endpoints.is_some() && advertised.len() == 1 {
        return route(advertised[0], RouteSource::Endpoints);
    }
    let family = offer
        .families
        .iter()
        .find(|f| id_matches(f.pattern, facts.model) && (!f.agent_only || facts.agent) && usable(f.wire));
    if let Some(family) = family {
        return route(family.wire, RouteSource::Family);
    }
    if usable(profile.default_wire) {
        return route(profile.default_wire, RouteSource::Default);
    }
    preferred().and_then(|wire| route(wire, RouteSource::Endpoints))
}

/// `PROFILES[..].legacy`: `catalog` is the catalog's wire when the model is
/// still offered on it; `advertised` the wires left after narrowing.
fn legacy_wire(offer: &WireOffer, model: &str, catalog: Option<Wire>, advertised: &[Wire]) -> Wire {
    match offer.legacy {
        LegacyWire::Fixed(wire) => wire,
        LegacyWire::Catalog { except, patterns, otherwise } => {
            if let Some(wire) = catalog.filter(|w| *w != except) {
                return wire;
            }
            patterns.iter().find(|(pattern, _)| id_matches(pattern, model)).map_or(otherwise, |(_, wire)| *wire)
        }
        LegacyWire::Advertised { prefer, fallback } => {
            if advertised.contains(&prefer) || !advertised.contains(&fallback) { prefer } else { fallback }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> WireFacts<'static> {
        WireFacts { known: true, ..WireFacts::default() }
    }

    #[test]
    fn the_catalog_package_decides_before_the_default() {
        let go = CompatProfile::opencode_go();
        for (package, wire) in [
            (Some("@ai-sdk/openai"), Wire::Responses),
            (Some("@ai-sdk/anthropic"), Wire::Messages),
            (Some("@ai-sdk/google"), Wire::Gemini),
            (Some("@ai-sdk/openai-compatible"), Wire::Chat),
        ] {
            let route = resolve_wire(&go, &WireFacts { catalog_wire: wire_of_package(package), ..facts() }).unwrap();
            assert_eq!((route.wire, route.source), (wire, RouteSource::Catalog), "{package:?}");
        }
        // A package that names no wire says nothing (Node: null), so the family table decides.
        assert_eq!(wire_of_package(Some("@other/sdk")), None);
        assert_eq!(wire_of_package(None), None);
        // A wire the gateway does not offer is never chosen.
        let ds = CompatProfile::deepseek();
        let route = resolve_wire(&ds, &WireFacts { catalog_wire: Some(Wire::Responses), ..facts() }).unwrap();
        assert_eq!(route.source, RouteSource::Default);
    }

    #[test]
    fn override_pin_and_exclusion_order() {
        let or = CompatProfile::openrouter();
        let route = resolve_wire(&or, &WireFacts { override_wire: Some(Wire::Messages), ..facts() }).unwrap();
        assert_eq!((route.wire, route.source), (Wire::Messages, RouteSource::Override));
        let route = resolve_wire(&or, &WireFacts { keep: Some(Wire::Responses), override_wire: Some(Wire::Messages), ..facts() }).unwrap();
        assert_eq!(route.source, RouteSource::Pinned);
        // The wire a send was just refused on is not chosen again.
        let route = resolve_wire(&or, &WireFacts { override_wire: Some(Wire::Messages), exclude: &[Wire::Messages], ..facts() }).unwrap();
        assert_eq!(route.wire, Wire::Chat);
    }

    #[test]
    fn deepseek_tool_sessions_use_messages_and_one_shots_chat() {
        let ds = CompatProfile::deepseek();
        let model = "deepseek-v4-pro";
        let route = resolve_wire(&ds, &WireFacts { model, agent: true, ..facts() }).unwrap();
        assert_eq!((route.wire, route.source), (Wire::Messages, RouteSource::Family));
        assert_eq!(resolve_wire(&ds, &WireFacts { model, agent: false, ..facts() }).unwrap().wire, Wire::Chat);
    }

    #[test]
    fn command_code_follows_its_advertised_endpoints() {
        let cc = CompatProfile::command_code_oauth();
        let only = |wires: &'static [Wire]| resolve_wire(&cc, &WireFacts { endpoints: Some(wires), ..facts() }).unwrap();
        assert_eq!(only(&[Wire::Messages]).wire, Wire::Messages);
        assert_eq!(only(&[Wire::Responses]).wire, Wire::Responses);
        assert_eq!(only(&[Wire::Messages, Wire::Chat]).wire, Wire::Chat);
        assert_eq!(only(&[Wire::Messages, Wire::Responses]).wire, Wire::Messages);
        assert!(resolve_wire(&cc, &WireFacts { endpoints: Some(&[]), ..facts() }).is_none(), "advertised nowhere");
    }

    #[test]
    fn muse_code_is_responses_only() {
        let muse = CompatProfile::muse_code_oauth();
        for facts in [
            facts(),
            WireFacts { catalog_wire: Some(Wire::Chat), ..facts() },
            WireFacts { override_wire: Some(Wire::Chat), agent: true, ..facts() },
            WireFacts { known: false, ..WireFacts::default() },
        ] {
            assert_eq!(resolve_wire(&muse, &facts).unwrap().wire, Wire::Responses);
        }
    }

    #[test]
    fn an_undescribed_model_gets_the_default_flagged_unknown() {
        let go = CompatProfile::opencode_go();
        let route = resolve_wire(&go, &WireFacts { known: false, ..WireFacts::default() }).unwrap();
        assert_eq!((route.wire, route.source), (Wire::Chat, RouteSource::Unknown));
    }
}
