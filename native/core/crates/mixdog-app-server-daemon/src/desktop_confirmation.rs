//! The desktop's inherited pipes are not discovery or RPC endpoints. This channel carries
//! only the confirmation of one fixed setting, not a general request or a reusable credential.

use std::io::{Read as _, Write as _};
use std::sync::Arc;

use mixdog_core_api::ids::Method;
use mixdog_core_api::{CallContext, CoreHandle, CoreRequest, CoreState};
use mixdog_core_config::config::DESKTOP_CONFIRMATION_CALLER;

const ENABLE: &[u8] = b"allow-all-actions\n";

pub(crate) fn start(core: Arc<dyn CoreHandle>, work: tokio::runtime::Handle) {
    // Stdin may be idle for the daemon's lifetime; it must not occupy an executor or lane.
    if let Err(error) = std::thread::Builder::new().name("desktop-confirmation".into()).spawn(move || {
        let mut input = std::io::stdin().lock();
        let mut command = [0; ENABLE.len()];
        while input.read_exact(&mut command).is_ok() && command.as_slice() == ENABLE {
            let applied = work.block_on(async {
                if *core.lifecycle().borrow() != CoreState::Serving {
                    return false;
                }
                let method = Method("config/setDeveloperOption");
                let Some(config) = core.domain_for(method.as_str()) else { return false };
                config
                    .call(CoreRequest {
                        method,
                        params: serde_json::json!({ "id": "allowAllActions", "enabled": true }),
                        op: None,
                        ctx: CallContext::internal(DESKTOP_CONFIRMATION_CALLER),
                    })
                    .await
                    .is_ok()
            });
            let mut output = std::io::stdout().lock();
            if output.write_all(if applied { b"Y" } else { b"N" }).and_then(|()| output.flush()).is_err() {
                break;
            }
        }
    }) {
        tracing::warn!(%error, "desktop confirmation pipe unavailable");
    }
}
