//! Which wire a gateway model is reached on (`wire-route.mjs`). One answer
//! per provider and model, in this order: a wire the session already pinned,
//! the user's per-model override, the catalog's wire for the model (the
//! models.dev SDK package, [`wire_of_package`]), the single wire the roster
//! advertises, the agent wire of a tool session, the provider default, then
//! the provider's preference. Every tier is limited to the wires the gateway
//! offers for that model. No tier reads the model id: when nothing describes
//! the model, the provider default applies and the route says `Unknown`, so
//! a session never pins a guess.

use super::profile::{CompatProfile, Wire};

/// Why a wire was chosen.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RouteSource {
    Pinned,
    Override,
    Catalog,
    Endpoints,
    Agent,
    Default,
    /// Nothing describes the model; the conventional wire, never pinned.
    Unknown,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Route {
    pub wire: Wire,
    pub source: RouteSource,
}

/// What is known about one model.
#[derive(Clone, Copy, Debug, Default)]
pub struct WireFacts<'a> {
    /// The wire the session started on.
    pub keep: Option<Wire>,
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
pub fn wire_of_package(package: Option<&str>) -> Wire {
    match package {
        Some("@ai-sdk/openai") => Wire::Responses,
        Some("@ai-sdk/anthropic") => Wire::Messages,
        Some("@ai-sdk/google") => Wire::Gemini,
        _ => Wire::Chat,
    }
}

/// `None` when the gateway offers the model on no wire.
pub fn resolve_wire(profile: &CompatProfile, facts: &WireFacts<'_>) -> Option<Route> {
    let offer = profile.wires;
    let advertised: Vec<Wire> = offer
        .offered
        .iter()
        .copied()
        .filter(|w| facts.endpoints.is_none_or(|e| e.contains(w)))
        .filter(|w| !facts.exclude.contains(w))
        .collect();
    let usable = |wire: Wire| advertised.contains(&wire);
    let route = |wire, source| Some(Route { wire, source });
    if let Some(keep) = facts.keep {
        let pool: Vec<Wire> = if facts.known {
            advertised.clone()
        } else {
            offer.offered.to_vec()
        };
        if pool.contains(&keep) {
            return route(keep, RouteSource::Pinned);
        }
    }
    if let Some(wire) = facts.override_wire.filter(|w| usable(*w)) {
        return route(wire, RouteSource::Override);
    }
    let fallback = || {
        if usable(profile.default_wire) {
            return Some(profile.default_wire);
        }
        let order = if offer.preference.is_empty() { offer.offered } else { offer.preference };
        order.iter().copied().find(|w| usable(*w))
    };
    if !facts.known {
        return fallback().and_then(|wire| route(wire, RouteSource::Unknown));
    }
    if let Some(wire) = facts.catalog_wire.filter(|w| usable(*w)) {
        return route(wire, RouteSource::Catalog);
    }
    if facts.endpoints.is_some() && advertised.len() == 1 {
        return route(advertised[0], RouteSource::Endpoints);
    }
    if facts.agent
        && let Some(wire) = offer.agent_wire.filter(|w| usable(*w))
    {
        return route(wire, RouteSource::Agent);
    }
    if usable(profile.default_wire) {
        return route(profile.default_wire, RouteSource::Default);
    }
    fallback().and_then(|wire| route(wire, RouteSource::Endpoints))
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
            (None, Wire::Chat),
        ] {
            let route = resolve_wire(&go, &WireFacts { catalog_wire: Some(wire_of_package(package)), ..facts() }).unwrap();
            assert_eq!((route.wire, route.source), (wire, RouteSource::Catalog), "{package:?}");
        }
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
        assert_eq!(resolve_wire(&ds, &WireFacts { agent: true, ..facts() }).unwrap().wire, Wire::Messages);
        assert_eq!(resolve_wire(&ds, &WireFacts { agent: false, ..facts() }).unwrap().wire, Wire::Chat);
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
