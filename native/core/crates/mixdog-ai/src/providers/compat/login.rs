use std::sync::Arc;

use crate::transport::HttpSend;

pub mod command_code;
pub mod mimo;
pub mod muse;
pub mod opencode_go;

pub(crate) type Http = Arc<dyn HttpSend>;
