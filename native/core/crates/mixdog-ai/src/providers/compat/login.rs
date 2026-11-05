//! The login flows of the key-issuing compat providers (PW §5.14, §5.15):
//! MiMo's sealed-key loopback, Command Code's Studio POST callback, and the
//! device grants of Muse Code and OpenCode Go. Each is a
//! [`LoginFlow`](mixdog_core_api::domain::login::LoginFlow) built on the
//! shared `oauth` session, loopback receiver, device poller and `Pace`.

use std::sync::Arc;

use crate::transport::HttpSend;

pub mod command_code;
pub mod mimo;
pub mod muse;
pub mod opencode_go;

pub(crate) type Http = Arc<dyn HttpSend>;
