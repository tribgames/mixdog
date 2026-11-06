//! A custom provider that declares more than one wire (`wires`, `modelWires`):
//! each model is sent on the wire the config selects: its `modelWires`
//! override, else the protocol's own wire.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::keepalive::KeepaliveSchedule;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireCodec;
use mixdog_core_api::domain::retry::RetryPolicy;
use mixdog_protocol::ProviderId;

use crate::providers::compat::CompatProfile;
use crate::providers::compat::profile::CredentialKind;
use crate::providers::compat::profile::LegacyWire;
use crate::providers::compat::profile::Wire;
use crate::providers::compat::wire_route::route_for;
use mixdog_core_api::domain::provider::{WireRoute, WireRouteContext, WireRouting};
use crate::providers::compat::wire_route::WireFacts;
use crate::providers::compat::wire_route::resolve_wire;

/// The served wires in `CUSTOM_PROVIDER_WIRES` order, as a static slice.
fn offered(wires: &[Wire]) -> &'static [Wire] {
    const C: Wire = Wire::Chat;
    const R: Wire = Wire::Responses;
    const M: Wire = Wire::Messages;
    let has = |w: Wire| wires.contains(&w);
    match (has(C), has(R), has(M)) {
        (true, false, false) => &[C],
        (false, true, false) => &[R],
        (false, false, true) => &[M],
        (true, true, false) => &[C, R],
        (true, false, true) => &[C, M],
        (false, true, true) => &[R, M],
        _ => &[C, R, M],
    }
}

pub struct MultiWireAdapter {
    id: ProviderId,
    engines: Vec<(Wire, Arc<dyn ProviderAdapter>)>,
    profile: CompatProfile,
    model_wires: HashMap<String, Wire>,
}

impl MultiWireAdapter {
    /// `engines`: one adapter per served wire; `protocol_wire` is the wire of
    /// the provider's protocol (the default wire).
    pub fn new(
        id: ProviderId,
        engines: Vec<(Wire, Arc<dyn ProviderAdapter>)>,
        protocol_wire: Wire,
        model_wires: HashMap<String, Wire>,
    ) -> Self {
        let served: Vec<Wire> = engines.iter().map(|(w, _)| *w).collect();
        let mut profile = CompatProfile::plain("custom", "http://127.0.0.1/v1", CredentialKind::Keyless);
        profile.default_wire = protocol_wire;
        profile.wires.offered = offered(&served);
        // Every existing session of a custom provider started on its protocol's wire.
        profile.wires.legacy = LegacyWire::Fixed(protocol_wire);
        Self { id, engines, profile, model_wires }
    }

    fn route(&self, model: &str) -> Option<Wire> {
        let facts = WireFacts {
            override_wire: self.model_wires.get(model).copied(),
            known: true,
            ..WireFacts::default()
        };
        resolve_wire(&self.profile, &facts).map(|route| route.wire)
    }

    fn engine(&self, wire: Wire) -> &Arc<dyn ProviderAdapter> {
        &self.engines.iter().find(|(w, _)| *w == wire).expect("a routed wire has an engine").1
    }

    fn default_engine(&self) -> &Arc<dyn ProviderAdapter> {
        self.engine(self.profile.default_wire)
    }
}

#[async_trait]
impl ProviderAdapter for MultiWireAdapter {
    fn id(&self) -> &ProviderId {
        &self.id
    }

    fn codec(&self) -> &dyn WireCodec {
        self.default_engine().codec()
    }

    fn retry_policy(&self) -> &RetryPolicy {
        self.default_engine().retry_policy()
    }

    fn keepalive(&self) -> &KeepaliveSchedule {
        self.default_engine().keepalive()
    }

    async fn attempt(&self, request: Arc<ModelRequest>) -> Result<Box<dyn ModelStream>, ProviderError> {
        let model = request.model.as_str();
        let Some(wire) = self.route(model) else {
            let mut err = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
            err.code = Some("MODEL_NOT_ROUTABLE".into());
            err.message = format!("[{}] model {model} is not routable: no wire it is served on is offered", self.id);
            return Err(err);
        };
        // A refusal on the selected wire is the provider's error: the wire is
        // chosen by config, never switched on the wording of a refusal.
        self.engine(wire).attempt(request).await
    }

    fn models(&self) -> Option<&dyn ModelListing> {
        self.default_engine().models()
    }

    fn wire_routing(&self) -> Option<&dyn WireRouting> {
        Some(self)
    }
}

#[async_trait]
impl WireRouting for MultiWireAdapter {
    /// The config decides: the model's `modelWires` override, else the protocol's wire.
    async fn resolve_wire_route(&self, model: &str, context: &WireRouteContext) -> Result<Option<WireRoute>, ProviderError> {
        let facts = WireFacts {
            override_wire: self.model_wires.get(model).copied(),
            known: true,
            ..WireFacts::default()
        };
        Ok(route_for(&self.profile, &self.id.to_string(), model, facts, context))
    }
}

#[cfg(test)]
pub(crate) mod tests;
