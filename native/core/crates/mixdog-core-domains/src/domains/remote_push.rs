//! The real `PushSink` of the notification service (push-notifier.ts `sendPush`): the engine has
//! decided who hears a notification; this hands it to that paired device over every push path
//! the device registered (`RemoteRuntime::deliver_push`).

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_remote::access::runtime::{PushDelivery, RemoteRuntime};
use mixdog_remote::push::native_crypto::Reason;

use crate::notify::decision::Event;
use crate::notify::engine::PushRequest;
use crate::notify::service::PushSink;

pub struct RemotePushSink {
    runtime: Arc<RemoteRuntime>,
}

impl RemotePushSink {
    pub fn new(runtime: Arc<RemoteRuntime>) -> Self {
        Self { runtime }
    }
}

/// `EVENT_OF_REASON`, inverted.
fn reason_of(event: Event) -> Reason {
    match event {
        Event::Finished => Reason::TurnFinished,
        Event::Error => Reason::TurnFailed,
        Event::Approval => Reason::ApprovalPending,
        Event::Question => Reason::InputNeeded,
    }
}

#[async_trait]
impl PushSink for RemotePushSink {
    async fn push(&self, request: &PushRequest) -> Result<(), String> {
        self.runtime
            .deliver_push(&PushDelivery {
                device_id: request.device_id.clone(),
                session_id: request.thread_id.clone(),
                title: request.title.clone(),
                body: request.body.clone(),
                reason: reason_of(request.event),
                host_id: self.runtime.host_id(),
                approval: request.approval.as_ref().map(|approval| (approval.id.clone(), approval.allow_once)),
            })
            .await
    }

    fn connected(&self) -> bool {
        self.runtime.is_connected()
    }
}
