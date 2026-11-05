//! The one argument of `mixdogd server-ensure`: the base64 JSON of the desktop's
//! `RemoteProgramArgs` (`apps/desktop/src/main/ssh/remote-install-program.ts`).

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;

use super::error::EnsureError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Probe,
    Ensure,
    Cleanup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupPhase {
    /// Retire the core only (progress for the UI).
    Stop,
    /// Retire the core, prove nothing runs from the install, delete.
    Remove,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelLogin {
    /// The core runs models with the server's own logins (no model proxy).
    Server,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramArgs {
    pub mode: Mode,
    /// `<version>-<build>`: the version directory name.
    pub install_id: String,
    pub version: String,
    pub build: String,
    /// The running binary was unpacked from the desktop's upload: install it.
    #[serde(default)]
    pub upload: bool,
    #[serde(default)]
    pub sha256: Option<String>,
    /// The user confirmed aborting the work the last drain listed.
    #[serde(default)]
    pub confirm_token: Option<String>,
    #[serde(default)]
    pub model_login: Option<ModelLogin>,
    #[serde(default)]
    pub phase: Option<CleanupPhase>,
    #[serde(default)]
    pub remove_user_data: bool,
    #[serde(default)]
    pub lock_wait_ms: Option<u64>,
    #[serde(default)]
    pub lock_stale_ms: Option<u64>,
}

impl ProgramArgs {
    /// The desktop wants model calls to come back to it unless the saved server chose its own
    /// logins (Node wantedModelProxy).
    pub fn wants_model_proxy(&self) -> bool {
        self.model_login != Some(ModelLogin::Server)
    }

    pub fn decode(argument: &str) -> Result<Self, EnsureError> {
        let bytes = STANDARD
            .decode(argument.trim())
            .map_err(|e| EnsureError::Arguments(format!("not base64: {e}")))?;
        serde_json::from_slice(&bytes).map_err(|e| EnsureError::Arguments(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_what_the_desktop_encodes() {
        let json = r#"{"mode":"ensure","installId":"1.4.6-abc","version":"1.4.6","build":"abc","upload":true,"sha256":"00","confirmToken":"t","modelLogin":"server"}"#;
        let args = ProgramArgs::decode(&STANDARD.encode(json)).unwrap();
        assert_eq!(args.mode, Mode::Ensure);
        assert!(args.upload);
        assert_eq!(args.confirm_token.as_deref(), Some("t"));
        assert_eq!(args.model_login, Some(ModelLogin::Server));
        assert_eq!(ProgramArgs::decode("!!").unwrap_err().code(), "protocol");
    }
}
