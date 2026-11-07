//! The `remoteAccess` domain: the desktop's remote-access operations (`desktop-service.ts`
//! `remoteAccess*` and `remote-push-methods.ts`), served over the [`RemoteRuntime`]. Every
//! result and refusal sentence is today's: a setting returns the settings view, `rotate` and
//! `revokeClient` return the descriptor, `resolveClaim` a boolean, the rest `null` or `true`.
//!
//! `resolveClaim` carries `claimId` and `approve`, `pairCode` its `action`; `input` is the operation's
//! argument list as the Node dispatcher received it for `settleOwedControllerKeys` `[keys, unknown]`; `registerNativePush`
//! carries the one record; `deliverScreenControllerKey` the key itself. The paired device of a
//! phone-side call is the credential id the relay named for the caller's connection.
//!
//! The three Web Push methods are the PC-signed path the phone still uses while it knows no relay
//! key (push-notification-bridge.ts); they keep their store, key and refusal sentences.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::params::{
    RemoteAccessActivateParams, RemoteAccessDeliverScreenControllerKeyParams, RemoteAccessRegisterNativePushParams, RemoteAccessRemoveNativePushParams,
    RemoteAccessRegisterPushSubscriptionParams, RemoteAccessRemovePushSubscriptionParams,
    RemoteAccessPairCodeParams, RemoteAccessResolveClaimParams, RemoteAccessRevokeClientParams, RemoteAccessSetClientAliasParams,
    RemoteAccessSetEnabledParams, RemoteAccessSetNameParams, RemoteAccessSettleOwedControllerKeysParams,
};
use mixdog_core_api::call::Caller;
use mixdog_core_api::ids::{ConnectionId, Method};
use mixdog_core_api::service::{Admit, DomainService};
use mixdog_core_api::{CoreError, CoreRequest, Reply};
use mixdog_remote::access::runtime::{RemoteError, RemoteRuntime};
use mixdog_remote::registry::{DeviceRegistry, LinkKind};
use serde_json::{Value, json};

use mixdog_core_base::support::OpScopes;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::wrong_method;

const DOMAIN: &str = "remoteAccess";

pub struct RemoteAccessService {
    runtime: Arc<RemoteRuntime>,
    registry: Arc<DeviceRegistry>,
    ops: OpScopes,
}

fn refused(error: RemoteError) -> CoreError {
    match error {
        RemoteError::NotRunning => failed(DOMAIN, error.to_string()),
        RemoteError::Invalid(message) => failed(DOMAIN, message),
        RemoteError::Failed(message) => failed(DOMAIN, message),
    }
}

fn invalid(message: &str) -> CoreError {
    failed(DOMAIN, message)
}

/// `[a, b]`: the argument list of an operation.
fn arguments(input: &Value) -> &[Value] {
    input.as_array().map_or(&[], Vec::as_slice)
}


impl RemoteAccessService {
    pub fn new(runtime: Arc<RemoteRuntime>, registry: Arc<DeviceRegistry>, ops: OpScopes) -> Self {
        Self { runtime, registry, ops }
    }

    /// The credential id of the paired device behind the caller's connection; empty for a
    /// local connection or an unknown one (`client.credentialId()`).
    fn credential_id(&self, req: &CoreRequest) -> String {
        let Caller::Connection(id) = &req.ctx.caller else { return String::new() };
        match self.registry.describe(id.0) {
            Some(found) if matches!(found.kind, LinkKind::Phone | LinkKind::RemoteDesktop) => found.credential,
            _ => String::new(),
        }
    }

    async fn descriptor(&self) -> Result<Value, CoreError> {
        self.runtime.descriptor().await.map_err(refused)
    }

    async fn set_enabled(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: RemoteAccessSetEnabledParams = decode(req)?;
        self.ops
            .run(
                req,
                None,
                || async { view(self.runtime.set_enabled(params.enabled).await.map_err(refused)?) },
                || async { view(self.runtime.settings()) },
            )
            .await
    }

    async fn set_name(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: RemoteAccessSetNameParams = decode(req)?;
        self.ops
            .run(
                req,
                None,
                || async { view(self.runtime.set_name(&params.name).await.map_err(refused)?) },
                || async { view(self.runtime.settings()) },
            )
            .await
    }

    async fn set_client_alias(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: RemoteAccessSetClientAliasParams = decode(req)?;
        self.ops
            .run(
                req,
                None,
                || async {
                    self.runtime.set_client_alias(&params.client_id, &params.alias).await.map_err(refused)?;
                    Ok(Value::Null)
                },
                || async { Ok(Value::Null) },
            )
            .await
    }

    /// The whole `remote` section value (`RemoteSectionValue`, camelCase): what a client that holds the section as a stub reads.
    fn state_value(&self) -> Result<Value, CoreError> {
        serde_json::to_value(self.runtime.section_value()).map_err(|error| failed(DOMAIN, error.to_string()))
    }

    /// A window asking: the client list is asked for first when the leg has not answered one (what `descriptor()` did).
    async fn state(&self, _req: &CoreRequest) -> Result<Reply, CoreError> {
        self.runtime.list_if_unanswered().await;
        Ok(Reply::Value(self.state_value()?))
    }

    /// Node's `remoteAccessInfo` with `activate`: `remote.start(true)`. A start that fails is not this call's failure (Node
    /// caught it, reported `remote-access-status {status: "failed"}` and scheduled the retry; the runtime does the same), so
    /// the answer is the state as it stands, which shows the relay not live.
    async fn activate(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let _params: RemoteAccessActivateParams = decode(req)?;
        self.ops
            .run(
                req,
                None,
                || async {
                    let _ = self.runtime.start(true).await;
                    self.runtime.list_if_unanswered().await;
                    self.state_value()
                },
                || async { self.state_value() },
            )
            .await
    }

    async fn rotate(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        self.ops
            .run(
                req,
                None,
                || async {
                    self.runtime.rotate().await.map_err(refused)?;
                    self.descriptor().await
                },
                || self.descriptor(),
            )
            .await
    }

    async fn resolve_claim(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: RemoteAccessResolveClaimParams = decode(req)?;
        self.ops
            .run(
                req,
                None,
                || async { Ok(json!(self.runtime.resolve_claim(&params.claim_id, params.approve).await.map_err(refused)?)) },
                || async { Ok(json!(false)) },
            )
            .await
    }

    /// `action` is `ensure`, `renew` or `release`, as the settings screen asks.
    async fn pair_code(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: RemoteAccessPairCodeParams = decode(req)?;
        if !matches!(params.action.as_str(), "ensure" | "renew" | "release") {
            return Err(CoreError::InvalidParams { path: "action".into(), expected: "ensure, renew or release".into() });
        }
        self.ops
            .run(
                req,
                None,
                || async { self.runtime.pair_code(&params.action).await.map_err(refused) },
                || async { Ok(Value::Null) },
            )
            .await
    }

    async fn revoke_client(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: RemoteAccessRevokeClientParams = decode(req)?;
        self.ops
            .run(
                req,
                None,
                || async { self.runtime.revoke_client(&params.client_id).await.map_err(refused) },
                || self.descriptor(),
            )
            .await
    }

    async fn settle_owed(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: RemoteAccessSettleOwedControllerKeysParams = decode(req)?;
        let args = arguments(&params.input);
        self.ops
            .run(
                req,
                None,
                || async {
                    let keys = args
                        .first()
                        .and_then(Value::as_array)
                        .filter(|keys| keys.iter().all(Value::is_string))
                        .ok_or_else(|| invalid("The settled keys are not a list."))?;
                    let unknown = args
                        .get(1)
                        .and_then(Value::as_f64)
                        .filter(|n| n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
                        .ok_or_else(|| invalid("The settled marker is not a count."))?;
                    let keys = keys.iter().filter_map(Value::as_str).map(str::to_owned).collect();
                    // A negative count is a safe integer in Node; the roster counts from zero.
                    self.runtime.settle_owed(keys, unknown.max(0.0) as u64).await.map_err(refused)?;
                    Ok(Value::Null)
                },
                || async { Ok(Value::Null) },
            )
            .await
    }

    async fn deliver_key(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: RemoteAccessDeliverScreenControllerKeyParams = decode(req)?;
        let credential = self.credential_id(req);
        self.ops
            .run(
                req,
                None,
                || async {
                    let key = params.input.as_str().ok_or_else(|| invalid("The controller key is invalid."))?;
                    let _ = self.runtime.deliver_controller_key(&credential, key).await.map_err(refused)?;
                    Ok(json!(true))
                },
                || async { Ok(json!(true)) },
            )
            .await
    }

    async fn register_native_push(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: RemoteAccessRegisterNativePushParams = decode(req)?;
        let credential = self.credential_id(req);
        self.ops
            .run(
                req,
                None,
                || async {
                    if credential.is_empty() {
                        return Err(invalid("Native push needs a paired client."));
                    }
                    let registered = self.runtime.register_native_push(&credential, &params.input).await.map_err(refused)?;
                    Ok(json!(registered))
                },
                || async { Ok(json!(true)) },
            )
            .await
    }

    /// Not an op: it reads (and on the first ask mints) the key, as `pushPublicKey` always did.
    async fn push_public_key(&self, _req: &CoreRequest) -> Result<Reply, CoreError> {
        let key = self.runtime.push_public_key().await.map_err(refused)?;
        Ok(Reply::Value(json!(key)))
    }

    async fn register_push(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: RemoteAccessRegisterPushSubscriptionParams = decode(req)?;
        self.ops
            .run(
                req,
                None,
                || async { Ok(json!(self.runtime.register_push_subscription(&params.input).await.map_err(refused)?)) },
                || async { Ok(json!(true)) },
            )
            .await
    }

    async fn remove_push(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: RemoteAccessRemovePushSubscriptionParams = decode(req)?;
        self.ops
            .run(
                req,
                None,
                || async { Ok(json!(self.runtime.remove_push_subscription(&json!(params.endpoint)).await.map_err(refused)?)) },
                || async { Ok(json!(false)) },
            )
            .await
    }

    async fn remove_native_push(&self, req: &CoreRequest) -> Result<Reply, CoreError> {
        let params: RemoteAccessRemoveNativePushParams = decode(req)?;
        let credential = self.credential_id(req);
        self.ops
            .run(
                req,
                None,
                || async {
                    if credential.is_empty() {
                        return Err(invalid("Native push needs a paired client."));
                    }
                    let removed = self.runtime.remove_native_push(&credential, params.token.as_deref()).await.map_err(refused)?;
                    Ok(json!(removed))
                },
                || async { Ok(json!(true)) },
            )
            .await
    }
}

fn view(settings: mixdog_remote::access::settings::SettingsView) -> Result<Value, CoreError> {
    serde_json::to_value(settings).map_err(|error| failed(DOMAIN, error.to_string()))
}

#[async_trait]
impl DomainService for RemoteAccessService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            "remoteAccess/setEnabled" => self.set_enabled(&req).await,
            "remoteAccess/setName" => self.set_name(&req).await,
            "remoteAccess/setClientAlias" => self.set_client_alias(&req).await,
            "remoteAccess/rotate" => self.rotate(&req).await,
            "remoteAccess/activate" => self.activate(&req).await,
            "remoteAccess/state" => self.state(&req).await,
            "remoteAccess/resolveClaim" => self.resolve_claim(&req).await,
            "remoteAccess/pairCode" => self.pair_code(&req).await,
            "remoteAccess/revokeClient" => self.revoke_client(&req).await,
            "remoteAccess/settleOwedControllerKeys" => self.settle_owed(&req).await,
            "remoteAccess/deliverScreenControllerKey" => self.deliver_key(&req).await,
            "remoteAccess/registerNativePush" => self.register_native_push(&req).await,
            "remoteAccess/removeNativePush" => self.remove_native_push(&req).await,
            "remoteAccess/pushPublicKey" => self.push_public_key(&req).await,
            "remoteAccess/registerPushSubscription" => self.register_push(&req).await,
            "remoteAccess/removePushSubscription" => self.remove_push(&req).await,
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    fn methods(&self) -> &'static [&'static str] {
        &[
            "remoteAccess/setEnabled",
            "remoteAccess/setName",
            "remoteAccess/setClientAlias",
            "remoteAccess/rotate",
            "remoteAccess/activate",
            "remoteAccess/state",
            "remoteAccess/resolveClaim",
            "remoteAccess/pairCode",
            "remoteAccess/revokeClient",
            "remoteAccess/settleOwedControllerKeys",
            "remoteAccess/deliverScreenControllerKey",
            "remoteAccess/registerNativePush",
            "remoteAccess/removeNativePush",
            "remoteAccess/pushPublicKey",
            "remoteAccess/registerPushSubscription",
            "remoteAccess/removePushSubscription",
        ]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_remote::access::runtime::{LegLink, RemoteEvents, RuntimeConfig};
    use mixdog_remote::access::settings::AccessSettings;
    use mixdog_remote::bridge::{DialError, Dialer, Upstream};
    use mixdog_remote::pair_code::{PairCodeEffects, PairCodeView};
    use mixdog_remote::section::{RemoteSection, RemoteSectionValue};

    use super::*;
    use mixdog_core_base::support::testing::request;
    use mixdog_core_base::support::testing::scopes;
    use mixdog_core_base::support::testing::value;
    use mixdog_core_base::support::testing::with_op;

    struct NoEffects;
    impl PairCodeEffects for NoEffects {
        fn send(&mut self, _: Value) -> bool {
            false
        }
        fn publish(&mut self, _: Option<&PairCodeView>) {}
        fn wake_at(&mut self, _: u64) {}
    }

    struct NoDial;
    #[async_trait]
    impl Dialer for NoDial {
        async fn dial(&self, _: &str) -> Result<Box<dyn Upstream>, DialError> {
            Err(DialError)
        }
    }

    struct Quiet;
    impl RemoteEvents for Quiet {
        fn controller_key_delivered(&self, _: &str) {}
        fn owed_access_changed(&self) {}
        fn status(&self, _: Value) {}
    }

    /// The service over a runtime whose relay is off: nothing connects.
    async fn rig(dir: &Path) -> (RemoteAccessService, Arc<RemoteRuntime>) {
        let registry = Arc::new(DeviceRegistry::default());
        let runtime = Arc::new(RemoteRuntime::new(
            RuntimeConfig {
                dir: dir.to_path_buf(),
                relay_url: None,
                app_version: None,
                durability: mixdog_rt::testing::tokens().durability_io,
                dialer: Arc::new(NoDial),
                registry: registry.clone(),
                section: Arc::new(RemoteSection::new(Arc::new(MockStatePublisher::default()), RemoteSectionValue::default())),
                settings: Arc::new(AccessSettings::new(dir.to_path_buf(), Arc::new(|| "PC".to_owned()))),
                link: LegLink::default(),
                events: Arc::new(Quiet),
            },
            Box::new(|_| Box::new(NoEffects)),
        ));
        (RemoteAccessService::new(runtime.clone(), registry, scopes(dir, "remoteAccess").await), runtime)
    }

    fn sentence(error: &CoreError) -> String {
        format!("{error:?}")
    }

    #[tokio::test]
    async fn settings_answer_with_the_view_and_a_duplicate_op_replays_without_running() {
        let dir = tempfile::tempdir().unwrap();
        let (service, runtime) = rig(dir.path()).await;
        let named = value(&service, request("remoteAccess/setName", with_op(json!({ "name": "Desk" }), 1), Some(1))).await.unwrap();
        assert_eq!((named["name"].as_str(), named["defaultName"].as_str()), (Some("Desk"), Some("PC")));
        let off = value(&service, request("remoteAccess/setEnabled", with_op(json!({ "enabled": false }), 2), Some(2))).await.unwrap();
        assert_eq!(off["enabled"], json!(false));
        value(&service, request("remoteAccess/setName", with_op(json!({ "name": "Other" }), 3), Some(3))).await.unwrap();
        assert_eq!(runtime.settings().name, "Other");
        // The same op again answers what it recorded and does not rename the PC back.
        let again = value(&service, request("remoteAccess/setName", with_op(json!({ "name": "Desk" }), 1), Some(1))).await.unwrap();
        assert_eq!(again["name"], json!("Desk"));
        assert_eq!(runtime.settings().name, "Other");
        // The same op id with other params is a conflict, not a replay.
        let conflict = value(&service, request("remoteAccess/setName", with_op(json!({ "name": "Third" }), 1), Some(1))).await;
        assert!(matches!(conflict, Err(CoreError::OpIdConflict { .. })));
    }

    #[tokio::test]
    async fn state_is_the_whole_remote_section_and_activate_answers_it_without_activating_a_relay_less_install() {
        let dir = tempfile::tempdir().unwrap();
        let (service, _) = rig(dir.path()).await;
        value(&service, request("remoteAccess/setName", with_op(json!({ "name": "Desk" }), 1), Some(1))).await.unwrap();
        let state = value(&service, request("remoteAccess/state", json!({}), None)).await.unwrap();
        assert_eq!(state["settings"]["name"], json!("Desk"));
        for member in ["info", "settings", "claims", "clients", "controllerKeys", "owedKeys", "pairCode", "disabled"] {
            assert!(state.get(member).is_some(), "the section value has {member}");
        }
        // Node: with no relay URL `start(true)` returns before it activates anything, and the answer is the state.
        let activated = value(&service, request("remoteAccess/activate", with_op(json!({}), 2), Some(2))).await.unwrap();
        assert_eq!(activated, state);
        assert!(!dir.path().join("remote-activated.json").exists());
        // Only the user's own switch-off is `disabled`: an install that never chose is not off.
        assert_eq!(state["disabled"], json!(false));
        value(&service, request("remoteAccess/setEnabled", with_op(json!({ "enabled": false }), 3), Some(3))).await.unwrap();
        let off = value(&service, request("remoteAccess/state", json!({}), None)).await.unwrap();
        assert_eq!(off["disabled"], json!(true));
    }
    #[tokio::test]
    async fn the_web_push_methods_refuse_with_todays_sentence_while_the_relay_is_off() {
        let dir = tempfile::tempdir().unwrap();
        let (service, _) = rig(dir.path()).await;
        let unavailable = "Push notifications are unavailable on this connection.";
        let key = value(&service, request("remoteAccess/pushPublicKey", json!({}), None)).await.unwrap_err();
        assert!(sentence(&key).contains(unavailable), "{key:?}");
        let register = value(
            &service,
            request("remoteAccess/registerPushSubscription", with_op(json!({ "input": { "endpoint": "https://push.example/x" } }), 3), Some(3)),
        )
        .await
        .unwrap_err();
        assert!(sentence(&register).contains(unavailable), "{register:?}");
        let remove = value(
            &service,
            request("remoteAccess/removePushSubscription", with_op(json!({ "endpoint": "https://push.example/x" }), 4), Some(4)),
        )
        .await
        .unwrap_err();
        assert!(sentence(&remove).contains(unavailable), "{remove:?}");
    }

    #[tokio::test]
    async fn phone_side_calls_need_a_paired_connection_and_arguments_are_checked() {
        let dir = tempfile::tempdir().unwrap();
        let (service, _) = rig(dir.path()).await;
        // The caller is no phone: there is no credential to register a token for.
        let native = value(&service, request("remoteAccess/registerNativePush", with_op(json!({ "input": {} }), 5), Some(5)))
            .await
            .unwrap_err();
        assert!(sentence(&native).contains("Native push needs a paired client."), "{native:?}");
        // A claim nobody is asking about is not resolved.
        let claim = value(&service, request("remoteAccess/resolveClaim", with_op(json!({ "claimId": "nope", "approve": true }), 6), Some(6))).await.unwrap();
        assert_eq!(claim, json!(false));
        let owed = value(
            &service,
            request("remoteAccess/settleOwedControllerKeys", with_op(json!({ "input": [["k"], "x"] }), 7), Some(7)),
        )
        .await
        .unwrap_err();
        assert!(sentence(&owed).contains("The settled marker is not a count."), "{owed:?}");
        assert!(matches!(service.call(request("remoteAccess/nope", json!({}), None)).await, Err(CoreError::InvalidParams { .. })));
    }
}
