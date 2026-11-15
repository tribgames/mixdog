//! The native push frames of the desktop leg (`native-push-bind`, `native-push-unbind`, `native-push`) and what a revocation takes
//! with them, registered with [`crate::legs::dispatch`]. The associations, the limit and the sender are [`NativePushService`]'s;
//! this is the leg's side: which frames reach it, the paired-client check over the device store, and where the answer goes.

use std::sync::Arc;


use super::bindings::Admitted;
use super::{NativePushService, PairedClients};
use crate::legs::dispatch::{CapabilityOffer, Dispatch, Handler, HandlerFuture, LegCall, Rejected, RevokeHook};
use crate::store::DeviceStore;

impl PairedClients for DeviceStore {
    /// `store.hasClient(deviceId, clientId) === true`.
    fn has_client(&self, device_id: &str, client_id: &str) -> bool {
        DeviceStore::has_client(self, device_id, client_id)
    }
}

/// A revoked browser or desktop leaves no association a send could still use.
struct DropBindings(Arc<NativePushService>);

impl RevokeHook for DropBindings {
    fn device_revoked(&self, device_id: &str) {
        self.0.drop_bindings(device_id, None);
    }

    fn client_revoked(&self, device_id: &str, client_id: &str) {
        self.0.drop_bindings(device_id, Some(client_id));
    }
}

/// Registers native push with the desktop leg: the platforms the relay can deliver to in `relay-capabilities` (`nativePush` and
/// `nativePushPlatforms` are sent only when there is at least one), the three frame types, and the revocation hook.
///
/// A send is answered when the platform has answered, not inline: it runs beside the leg's reader, so one slow push never holds back
/// the frames behind it (Node did not wait for it either). The answer goes to the live leg of the device.
pub fn register(dispatch: &Dispatch, service: &Arc<NativePushService>) -> Result<(), Rejected> {
    let offered = Arc::clone(service);
    dispatch.register_capability(Arc::new(move || CapabilityOffer {
        native_push_platforms: offered.platforms().into_iter().map(str::to_owned).collect(),
        ..CapabilityOffer::default()
    }));

    let bind = Arc::clone(service);
    let bind_handler: Handler = Arc::new(move |call: LegCall| -> HandlerFuture {
        let service = Arc::clone(&bind);
        Box::pin(async move { service.bind(&call.device_id, call.hub.store(), &call.message) })
    });
    dispatch.register("native-push-bind", bind_handler)?;

    let unbind = Arc::clone(service);
    let unbind_handler: Handler = Arc::new(move |call: LegCall| -> HandlerFuture {
        let service = Arc::clone(&unbind);
        Box::pin(async move { service.unbind(&call.device_id, &call.message) })
    });
    dispatch.register("native-push-unbind", unbind_handler)?;

    let send = Arc::clone(service);
    let send_handler: Handler = Arc::new(move |call: LegCall| -> HandlerFuture {
        let service = Arc::clone(&send);
        Box::pin(async move {
            // The refusals are answered here, in frame order; only a send that waits for the network is spawned.
            match service.admit(&call.device_id, call.hub.store(), &call.message) {
                None => {}
                Some(Admitted::Refused(result)) => {
                    call.hub.send_to_desktop(&call.device_id, &result);
                }
                Some(Admitted::Send(request)) => {
                    let later = Arc::clone(&call.later);
                    later.run(
                        "relay-native-push",
                        Box::pin(async move {
                            let result = service.deliver(&call.device_id, &call.message, request).await;
                            call.hub.send_to_desktop(&call.device_id, &result);
                        }),
                    );
                }
            }
        })
    });
    dispatch.register("native-push", send_handler)?;

    dispatch.register_revoke_hook(Arc::new(DropBindings(Arc::clone(service))));
    Ok(())
}
