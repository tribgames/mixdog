//! Shared OAuth plumbing (PW §6): PKCE, the credential file store, definitive
//! versus transient refresh failures, the loopback callback server and the
//! provider side of [`LoginFlow`](mixdog_core_api::domain::login::LoginFlow).
//! Provider packages supply only URLs, client ids and token-endpoint bodies.

mod callback;
pub mod device;
mod flow;
pub mod http;
pub mod lease;
pub mod loopback;
pub mod pace;
pub mod scrub;
mod pkce;
pub mod session;
mod refresh;
pub(crate) mod single_flight;
mod store;

pub use device::Poll;
pub use device::Schedule;
pub use pace::Pace;
pub use pace::SystemPace;
pub use session::FlowCtx;
pub use session::FlowGuard;
pub use session::start_session;
pub use callback::CallbackError;
pub use callback::CallbackPages;
pub use callback::CallbackServer;
pub use callback::Redirect;
pub use callback::Refusal;
pub use callback::pages;
pub use callback::redirects;
pub use callback::parse_pasted_callback;
pub use flow::AuthorizeRequest;
pub use flow::PkceLoginFlow;
pub use flow::PkceProvider;
pub use store::CredentialFile;
pub use store::CredentialIo;
pub use store::LaneUnrun;
pub use store::is_lane_unrun;
pub use store::Probe;
pub use pkce::Pkce;
pub use pkce::random_state;
pub use refresh::RefreshFailure;
pub use refresh::classify_refresh_failure;