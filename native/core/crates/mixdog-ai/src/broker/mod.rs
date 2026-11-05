//! `ModelBroker`: the single send loop above the adapters (SPEC §4.9), and the
//! server side of the model proxy.
//!
//! An adapter performs exactly one attempt. The broker admits the request once
//! on its lane, runs attempts, asks the one [`RetryDecider`] after every
//! failure and waits the decided delay. The delay is the only timer, it is
//! data from a `RetryPolicy` row or server advice, and it ends at once when the
//! caller cancels.
//!
//! [`RetryDecider`]: mixdog_core_api::domain::retry::RetryDecider

mod proxy;
mod send;

pub use proxy::ModelProxyTransport;
pub use proxy::ProxyError;
pub use proxy::execute_via_proxy;
pub use send::AttemptSink;
pub use send::ModelBroker;
pub use send::SendError;
pub use send::SendRequest;