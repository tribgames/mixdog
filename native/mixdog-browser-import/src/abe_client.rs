//! Client side of the elevated App-Bound Encryption unwrap protocol.
//!
//! The v20 master key can only be decrypted by an administrator process that
//! talks to Chrome's elevation service. We ship that elevated helper
//! (`bitwarden_chromium_import_helper.exe`) and reproduce its user-side
//! protocol here: launch the helper with the `runas` verb (which raises the
//! Windows UAC prompt), then receive the base64 master key back over a named
//! pipe. The helper answers with `!<message>` when it fails.

use std::{ffi::OsStr, os::windows::ffi::OsStrExt};

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chromium_importer::chromium::ADMIN_TO_USER_PIPE_NAME;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::ServerOptions,
    sync::mpsc::channel,
    time::{timeout, Duration},
};
use windows::{
    core::PCWSTR,
    Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_HIDE},
};

/// `app_bound_encrypted_key` from Local State is a base64 of APPB-prefixed
/// blobs (a few hundred bytes). Cap well under the Windows command-line limit.
const MAX_ENCRYPTED_LEN: usize = 4 * 1024;
const WAIT_FOR_ADMIN_TIMEOUT_SECS: u64 = 30;

/// Returns true only for canonical standard Base64 under the size cap.
///
/// SECURITY: `encrypted` is embedded verbatim into the `runas` command line, so
/// any character outside the Base64 alphabet (notably `"`, `\`, space, `&`,
/// `|`, `;`, `<`, `>`, `^`) must be rejected here to prevent command injection
/// into the elevated helper. `BASE64_STANDARD` rejects whitespace and
/// non-alphabet bytes; do not swap in a tolerant engine.
fn is_base64(input: &str) -> bool {
    input.len() <= MAX_ENCRYPTED_LEN && BASE64_STANDARD.decode(input).is_ok()
}

fn to_wide(value: &str) -> Vec<u16> {
    OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Launch the elevated helper and return the decrypted 32-byte v20 master key.
pub async fn unwrap_app_bound_key(admin_exe: &str, app_bound_encrypted_key: &str) -> Result<Vec<u8>> {
    if !is_base64(app_bound_encrypted_key) {
        return Err(anyhow!("app-bound key is not valid base64"));
    }

    let (tx, mut rx) = channel::<String>(1);

    // The server must exist before the helper is launched so the elevated
    // process can connect immediately. `first_pipe_instance` guards against a
    // stale server left by a previous run.
    let mut server = ServerOptions::new()
        .first_pipe_instance(true)
        .create(ADMIN_TO_USER_PIPE_NAME)
        .map_err(|e| anyhow!("failed to create named pipe server: {}", e))?;

    let server_task = tokio::spawn(async move {
        if server.connect().await.is_err() {
            return;
        }
        let mut buffer = vec![0_u8; 64 * 1024];
        if let Ok(read) = server.read(&mut buffer).await {
            if read > 0 {
                let message = String::from_utf8_lossy(&buffer[..read]).to_string();
                // The helper waits for an acknowledgement before exiting.
                let _ = server.write_all(b"ok").await;
                let _ = tx.try_send(message);
            }
        }
    });

    let launch = launch_admin(admin_exe, app_bound_encrypted_key);
    if let Err(error) = launch {
        server_task.abort();
        return Err(error);
    }

    let message = timeout(
        Duration::from_secs(WAIT_FOR_ADMIN_TIMEOUT_SECS),
        rx.recv(),
    )
    .await;
    server_task.abort();

    let message = match message {
        Ok(Some(message)) => message,
        Ok(None) => return Err(anyhow!("elevated helper closed without a reply")),
        Err(_) => return Err(anyhow!("timed out waiting for the elevated helper")),
    };

    if let Some(error) = message.strip_prefix('!') {
        return Err(anyhow!("elevated helper failed: {}", error));
    }

    let key = BASE64_STANDARD
        .decode(message.trim())
        .map_err(|e| anyhow!("elevated helper returned an invalid key: {}", e))?;
    if key.len() != 32 {
        return Err(anyhow!(
            "elevated helper returned a {}-byte key (expected 32)",
            key.len()
        ));
    }
    Ok(key)
}

fn launch_admin(admin_exe: &str, encrypted: &str) -> Result<()> {
    let exe_wide = to_wide(admin_exe);
    let verb_wide = to_wide("runas");
    let parameters_wide = to_wide(&format!(r#"--encrypted "{}""#, encrypted));

    let hinstance = unsafe {
        ShellExecuteW(
            None,
            PCWSTR(verb_wide.as_ptr()),
            PCWSTR(exe_wide.as_ptr()),
            PCWSTR(parameters_wide.as_ptr()),
            None,
            SW_HIDE,
        )
    };
    // ShellExecuteW returns a value <= 32 on failure.
    if hinstance.0 as usize <= 32 {
        return Err(anyhow!(
            "failed to launch the elevated helper (code {})",
            hinstance.0 as usize
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_canonical_base64() {
        assert!(is_base64("QVBQQgEAAADQjJ3fARXREYx6AMBPwpfr"));
        assert!(is_base64(""));
    }

    #[test]
    fn rejects_shell_metacharacters() {
        for bad in [
            r#"abc"def"#,
            r"abc\def",
            "abc def",
            "abc&def",
            "abc|def",
            "abc;def",
            "abc^def",
        ] {
            assert!(!is_base64(bad), "expected rejection of: {bad:?}");
        }
    }

    #[test]
    fn rejects_oversized_input() {
        assert!(!is_base64(&"A".repeat(MAX_ENCRYPTED_LEN + 1)));
    }
}
