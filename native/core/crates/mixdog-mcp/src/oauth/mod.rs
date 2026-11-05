//! MCP OAuth: the sign-in of an HTTP/SSE server that needs one. Credentials live in the shared
//! Node-compatible keychain (`mixdog-secrets`) (one entry per server URL, or per connector account); requests carry the stored
//! token only to the server's own endpoints, a refused token is renewed from its refresh token,
//! and an explicit sign-in runs as a [`LoginFlow`](mixdog_core_api::domain::login::LoginFlow)
//! with a loopback callback (or a pasted redirect URL for a remote sign-in).

pub mod account;
pub mod callback;
pub mod page;
pub mod protocol;
pub mod session;
pub mod shared;
pub mod store;

pub use account::AccountMode;
pub use session::McpLoginFlow;
pub use session::McpOAuth;
pub use session::OAuthEnv;
pub use shared::OAuthError;
pub use mixdog_secrets::default_store;
pub use store::MemoryStore;
pub use store::SecretStore;
