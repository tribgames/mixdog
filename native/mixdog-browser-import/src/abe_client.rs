//! Client side of the elevated App-Bound Encryption unwrap protocol.
//!
//! The v20 master key can only be decrypted by an administrator process that
//! talks to Chrome's elevation service. We ship that elevated helper
//! (`bitwarden_chromium_import_helper.exe`) and reproduce its user-side
//! protocol here: launch the helper with the `runas` verb (which raises the
//! Windows UAC prompt), then receive the base64 master key back over a named
//! pipe. The helper answers with `!<message>` when it fails.
//!
//! The pipe name is compiled into the upstream helper (`--encrypted` is its
//! only argument), so it cannot be made unique per call without changing the
//! helper. The server therefore authenticates its peer instead: it is the first
//! instance of the pipe, rejects remote clients, and accepts a connection only
//! from the process id of the helper that was launched.

use std::{
    ffi::OsStr,
    os::windows::{ffi::OsStrExt, io::AsRawHandle},
};

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chromium_importer::chromium::ADMIN_TO_USER_PIPE_NAME;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    sync::oneshot,
    task::JoinHandle,
    time::{timeout, Duration},
};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{Pipes::GetNamedPipeClientProcessId, Threading::GetProcessId},
        UI::{
            Shell::{
                ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
            },
            WindowsAndMessaging::SW_HIDE,
        },
    },
};
use zeroize::Zeroizing;

use crate::failure::{Classify, Failure};

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

/// Aborts the wrapped task when dropped, so no path leaves the pipe server
/// running (a timeout drops a `JoinHandle` without cancelling its task).
struct AbortOnDrop<T>(JoinHandle<T>);

impl<T> Drop for AbortOnDrop<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Process id of the client connected to `server`.
fn client_process_id(server: &NamedPipeServer) -> Option<u32> {
    let mut pid = 0_u32;
    unsafe { GetNamedPipeClientProcessId(HANDLE(server.as_raw_handle() as _), &mut pid) }.ok()?;
    Some(pid)
}

/// Read the helper's single reply and acknowledge it. The reply holds the
/// base64 key, so both buffers are wiped on drop.
async fn read_reply(server: &mut NamedPipeServer) -> Option<Zeroizing<String>> {
    let mut buffer = Zeroizing::new(vec![0_u8; 64 * 1024]);
    let read = server
        .read(buffer.as_mut_slice())
        .await
        .ok()
        .filter(|read| *read > 0)?;
    let reply = Zeroizing::new(std::str::from_utf8(&buffer[..read]).ok()?.to_owned());
    // The helper waits for an acknowledgement before exiting.
    let _ = server.write_all(b"ok").await;
    Some(reply)
}

/// Serve the one expected client: only the process the launcher reports as the
/// elevated helper is read from. Any other connection is dropped unread and the
/// instance goes back to listening for the real helper.
async fn serve_helper(
    mut server: NamedPipeServer,
    helper_pid: oneshot::Receiver<u32>,
) -> Option<Zeroizing<String>> {
    // The helper may connect before `launch` has returned its pid; the
    // instance is already listening, so that connection simply waits here.
    let helper_pid = helper_pid.await.ok()?;
    loop {
        server.connect().await.ok()?;
        if client_process_id(&server) == Some(helper_pid) {
            return read_reply(&mut server).await;
        }
        server.disconnect().ok()?;
    }
}

/// Create the pipe server, start the elevated process with `launch` (which
/// returns its process id), and return the 32-byte key it writes back. The
/// helper answers with `!<message>` on failure.
async fn receive_key<F>(pipe_name: &str, wait: Duration, launch: F) -> Result<Vec<u8>>
where
    F: FnOnce() -> Result<u32>,
{
    // The server must exist before the elevated process is started so it can
    // connect immediately. `first_pipe_instance` rejects a pipe name another
    // process already owns; `max_instances(1)` then refuses every further
    // instance for as long as ours exists (the default allows unlimited
    // instances and the default ACL lets the same user create one while the
    // UAC prompt is up, which the elevated helper could connect to instead of
    // ours); `reject_remote_clients` keeps it local.
    let server = ServerOptions::new()
        .first_pipe_instance(true)
        .max_instances(1)
        .reject_remote_clients(true)
        .create(pipe_name)
        .map_err(|e| anyhow!("failed to create named pipe server: {}", e))?;

    let (helper_pid_tx, helper_pid_rx) = oneshot::channel();
    let mut server_task = AbortOnDrop(tokio::spawn(serve_helper(server, helper_pid_rx)));

    // On failure `helper_pid_tx` is dropped, which also ends the server task.
    let helper_pid = launch()?;
    let _ = helper_pid_tx.send(helper_pid);

    let reply = match timeout(wait, &mut server_task.0).await {
        Ok(Ok(Some(reply))) => reply,
        Ok(_) => return Err(anyhow!("elevated helper closed without a reply")),
        Err(_) => return Err(anyhow!("timed out waiting for the elevated helper")),
    };

    if let Some(error) = reply.strip_prefix('!') {
        return Err(anyhow!("elevated helper failed: {}", error));
    }

    // The decode error is not reported: it can echo bytes of the key text.
    let mut key = Zeroizing::new(
        BASE64_STANDARD
            .decode(reply.trim())
            .map_err(|_| anyhow!("elevated helper returned an invalid key"))?,
    );
    if key.len() != 32 {
        return Err(anyhow!(
            "elevated helper returned a {}-byte key (expected 32)",
            key.len()
        ));
    }
    Ok(std::mem::take(&mut *key))
}

/// Launch the elevated helper with the `runas` verb (one UAC prompt) and return
/// the decrypted 32-byte v20 master key.
pub async fn unwrap_app_bound_key(
    admin_exe: &str,
    app_bound_encrypted_key: &str,
) -> Result<Vec<u8>> {
    unwrap_with(
        ADMIN_TO_USER_PIPE_NAME,
        Duration::from_secs(WAIT_FOR_ADMIN_TIMEOUT_SECS),
        app_bound_encrypted_key,
        || launch_admin(admin_exe, app_bound_encrypted_key),
    )
    .await
}

async fn unwrap_with<F>(
    pipe_name: &str,
    wait: Duration,
    app_bound_encrypted_key: &str,
    launch: F,
) -> Result<Vec<u8>>
where
    F: FnOnce() -> Result<u32>,
{
    if !is_base64(app_bound_encrypted_key) {
        return Err(Failure::DataUnreadable.into());
    }
    // Detail text (a helper's own reply, an OS error) is dropped: only the
    // fixed class is ever reported.
    receive_key(pipe_name, wait, launch)
        .await
        .classify(Failure::ElevationFailed)
}

/// Launch the helper elevated and return its process id, which is the only
/// client the pipe server will accept.
fn launch_admin(admin_exe: &str, encrypted: &str) -> Result<u32> {
    let exe_wide = to_wide(admin_exe);
    let verb_wide = to_wide("runas");
    let parameters_wide = to_wide(&format!(r#"--encrypted "{}""#, encrypted));

    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        lpVerb: PCWSTR(verb_wide.as_ptr()),
        lpFile: PCWSTR(exe_wide.as_ptr()),
        lpParameters: PCWSTR(parameters_wide.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe { ShellExecuteExW(&mut info) }
        .map_err(|e| anyhow!("failed to launch the elevated helper: {}", e))?;
    if info.hProcess.0.is_null() {
        return Err(anyhow!("the elevated helper did not report a process handle"));
    }
    let pid = unsafe { GetProcessId(info.hProcess) };
    unsafe {
        let _ = CloseHandle(info.hProcess);
    }
    if pid == 0 {
        return Err(anyhow!("could not determine the elevated helper's process id"));
    }
    Ok(pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::windows::named_pipe::ClientOptions;

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

    fn test_pipe_name() -> String {
        format!(r"\\.\pipe\mixdog-abe-test-{:016x}", rand::random::<u64>())
    }

    /// Stands in for the elevated helper: connects, sends `reply`, and returns
    /// how many acknowledgement bytes came back (0 if the server hung up).
    async fn fake_helper(pipe_name: String, reply: String) -> usize {
        let mut client = ClientOptions::new().open(&pipe_name).unwrap();
        // The write itself fails if the server already hung up on this client.
        let _ = client.write_all(reply.as_bytes()).await;
        let mut ack = [0_u8; 2];
        client.read(&mut ack).await.unwrap_or(0)
    }

    #[tokio::test]
    async fn accepts_the_key_from_the_launched_helper() {
        let name = test_pipe_name();
        let key = [7_u8; 32];
        let reply = BASE64_STANDARD.encode(key);
        let mut helper = None;
        let received = receive_key(&name, Duration::from_secs(10), || {
            helper = Some(tokio::spawn(fake_helper(name.clone(), reply)));
            Ok(std::process::id())
        })
        .await
        .unwrap();
        assert_eq!(received, key);
        helper.unwrap().await.unwrap();
    }

    #[tokio::test]
    async fn ignores_a_client_that_is_not_the_launched_helper() {
        let name = test_pipe_name();
        let reply = BASE64_STANDARD.encode([7_u8; 32]);
        let mut impostor = None;
        // The launcher reports a different pid than the connecting process.
        let error = receive_key(&name, Duration::from_millis(500), || {
            impostor = Some(tokio::spawn(fake_helper(name.clone(), reply)));
            Ok(std::process::id().wrapping_add(1))
        })
        .await
        .expect_err("a key from another process must not be accepted");
        assert!(error.to_string().contains("timed out"), "{error}");
        // The impostor was hung up on, never acknowledged.
        assert_eq!(impostor.unwrap().await.unwrap(), 0);
    }

    #[tokio::test]
    async fn surfaces_a_helper_failure_and_rejects_a_wrong_length_key() {
        for (reply, expected) in [
            ("!boom".to_string(), "elevated helper failed: boom"),
            (BASE64_STANDARD.encode([1_u8; 16]), "16-byte key"),
            ("not base64!".to_string(), "invalid key"),
        ] {
            let name = test_pipe_name();
            let error = receive_key(&name, Duration::from_secs(10), || {
                tokio::spawn(fake_helper(name.clone(), reply));
                Ok(std::process::id())
            })
            .await
            .expect_err("bad replies must be errors");
            assert!(error.to_string().contains(expected), "{error}");
        }
    }

    #[tokio::test]
    async fn refuses_a_pipe_name_that_already_has_a_server() {
        let name = test_pipe_name();
        let _squatter = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&name)
            .unwrap();
        let mut launched = false;
        let error = receive_key(&name, Duration::from_millis(100), || {
            launched = true;
            Ok(std::process::id())
        })
        .await
        .expect_err("a pre-existing server must be refused");
        assert!(!launched);
        assert!(error.to_string().contains("named pipe server"), "{error}");
    }

    #[tokio::test]
    async fn no_second_instance_can_be_created_while_the_server_is_open() {
        let name = test_pipe_name();
        let mut second_instance_refused = None;
        // What a same-user attacker could try while the UAC prompt is up: a
        // second instance of our pipe, with default options or with the same
        // single-instance limit and first-instance flag cleared.
        let error = receive_key(&name, Duration::from_millis(200), || {
            let default_options = ServerOptions::new().create(&name).is_err();
            let matching_limit = ServerOptions::new().max_instances(1).create(&name).is_err();
            second_instance_refused = Some(default_options && matching_limit);
            Ok(std::process::id())
        })
        .await
        .expect_err("nothing connects, so the call times out");
        assert!(error.to_string().contains("timed out"), "{error}");
        assert_eq!(second_instance_refused, Some(true));
    }

    #[tokio::test]
    async fn elevation_errors_are_reported_only_as_a_fixed_class() {
        use crate::failure::user_message;
        const ENCRYPTED: &str = "QVBQQgEAAADQjJ3fARXREYx6AMBPwpfr";
        const FIXED: &str = "Elevation was cancelled or failed.";

        // A launch failure whose OS text carries a path.
        let name = test_pipe_name();
        let error = unwrap_with(&name, Duration::from_secs(10), ENCRYPTED, || {
            Err(anyhow!(r"failed to launch C:\Users\SECRET\helper.exe"))
        })
        .await
        .unwrap_err();
        assert_eq!(user_message(&error), FIXED);
        assert!(!format!("{error:?}").contains("SECRET"), "{error:?}");

        // A helper that replies with its own error text.
        let name = test_pipe_name();
        let error = unwrap_with(&name, Duration::from_secs(10), ENCRYPTED, || {
            tokio::spawn(fake_helper(name.clone(), "!SECRET helper detail".to_string()));
            Ok(std::process::id())
        })
        .await
        .unwrap_err();
        assert_eq!(user_message(&error), FIXED);
        assert!(!format!("{error:?}").contains("SECRET"), "{error:?}");

        // Timeout and a wrong-length key are the same class.
        let name = test_pipe_name();
        let error = unwrap_with(&name, Duration::from_millis(100), ENCRYPTED, || Ok(1))
            .await
            .unwrap_err();
        assert_eq!(user_message(&error), FIXED);

        // Bad Local State input is a data problem, and never launches anything.
        let name = test_pipe_name();
        let invalid = unwrap_with(&name, Duration::from_secs(10), "not base64!", || {
            panic!("must not launch the helper")
        })
        .await
        .unwrap_err();
        assert_eq!(user_message(&invalid), "Chrome data could not be read.");
    }

    #[tokio::test]
    async fn failed_launch_is_reported_without_waiting() {
        let name = test_pipe_name();
        let error = receive_key(&name, Duration::from_secs(10), || {
            Err(anyhow!("launch refused"))
        })
        .await
        .expect_err("launch failure must propagate");
        assert!(error.to_string().contains("launch refused"));
    }
}
