//! The channel bridge: `channel/call` dispatch, the bridge's own tools, and the
//! running-work registry that keeps the core alive while channels, schedules and
//! webhooks are in use.

pub mod admin;
pub mod bridge;
pub mod call;
pub mod intent;
pub mod ports;
pub mod routines_db;
pub mod running;
pub mod runtime;
pub mod service;
pub mod setup;
pub mod tools;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod intent_tests;
#[cfg(test)]
mod setup_tests;
#[cfg(test)]
mod tests_runtime;
#[cfg(test)]
mod replays_owned_runtime;
#[cfg(test)]
mod replays_call_ids;

pub use admin::{AdminDeps, AdminError, ChannelAdmin};
pub use bridge::BridgeCalls;
pub use call::{CallDispatch, CallError, CallRequest, ChannelCallHandler, ChannelClient};
pub use ports::{
    AgentRuntime, AutomationServices, ChannelSettings, PublicBase, ReqwestProbe, WebhookAutomation, WebhookListener,
    WebhookPatch, WebhookProbe, WebhookSettings,
};
pub use running::{RunningWork, WorkGuard};
pub use runtime::ChannelRuntime;
pub use service::ChannelService;
pub use tools::{ChannelLifecycle, ToolDispatch};
