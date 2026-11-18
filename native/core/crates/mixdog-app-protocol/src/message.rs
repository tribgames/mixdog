//! The sentences of the connection code that reach a person, as stable codes with English fallbacks.
//!
//! A producer lists its sentences once with [`texts!`]: each has a `code` (the name the interface picks its own-language text by)
//! and an English template whose `{name}` slots are the parameters the sender passes. [`Text::said`] fills the template for logs
//! and for a client that does not know the code, and makes the wire [`SshMessage`]. The lists live here (`client`, and the server
//! program's) so the protocol generator can export the codes to TypeScript, where the interface's test and `check-i18n` require a
//! locale text for every code.

use std::collections::BTreeMap;
use std::fmt::Display;

use crate::v2::connections::SshMessage;

/// One sentence: its code and its English template.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Text {
    pub code: &'static str,
    pub english: &'static str,
}

/// A sentence with its parameters filled in: the English text and the wire message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Said {
    pub english: String,
    pub message: SshMessage,
}

impl Text {
    /// The sentence with `params` (`{name}` slots of the template, by name).
    pub fn said<K: AsRef<str>, V: Display>(self, params: impl IntoIterator<Item = (K, V)>) -> Said {
        let params: BTreeMap<String, String> = params.into_iter().map(|(name, value)| (name.as_ref().to_owned(), value.to_string())).collect();
        let mut english = self.english.to_owned();
        for (name, value) in &params {
            english = english.replace(&format!("{{{name}}}"), value);
        }
        Said { english, message: SshMessage { code: self.code.to_owned(), params } }
    }

    /// A sentence with no parameters.
    pub fn plain(self) -> Said {
        self.said::<&str, &str>([])
    }
}

impl SshMessage {
    /// The names a template holds (`{name}` slots).
    pub fn slots(template: &str) -> Vec<&str> {
        template.split('{').skip(1).filter_map(|rest| rest.split_once('}').map(|(name, _)| name)).collect()
    }
}

/// Lists sentences: a `const` for each and `ALL`, so a sentence cannot exist without being in the list a test pins.
#[macro_export]
macro_rules! texts {
    ($($name:ident = $code:literal, $english:literal;)*) => {
        $(pub const $name: $crate::message::Text = $crate::message::Text { code: $code, english: $english };)*
        /// Every sentence of this list.
        pub const ALL: &[$crate::message::Text] = &[$($name),*];
    };
}

/// The sentences `mixdog-ssh` and `mixdog-connections` say (connect, cleanup, forget, forwards).
pub mod client {
    crate::texts! {
        SERVER_NOT_READY = "server-not-ready", "The server on {name} is not ready to accept connections. Try connecting again.";
        SERVER_NOT_READY_UNNAMED = "server-not-ready-unnamed", "The server is not ready to accept connections. Try connecting again.";
        NO_SSH_RESPONSE = "server-no-ssh-response", "The server on {name} did not respond over SSH. Try connecting again.";
        SERVER_REFUSED_APP = "server-refused-app", "The server on {name} did not accept this app: {error}";
        FOREIGN_PROGRAM = "foreign-program-answered", "Another program answered over SSH on {name} instead of the server the app started. The connection was stopped and nothing was sent to it. Connect again to start over.";
        CONNECTION_NOT_READY = "ssh-connection-not-ready", "The SSH connection to {name} is not ready after {ms} ms.";
        CONNECTION_CLOSED = "ssh-connection-closed", "The SSH connection to {name} is closed.";
        SERVER_CONNECTION_CLOSED = "server-connection-closed", "The connection to the server is closed.";
        LINK_CLOSED = "link-closed", "The connection to {name} was closed.";
        RECONNECT_OFF = "reconnect-off", "Automatic reconnection is off for this server.";
        FOLDER_CONTROL_CHARACTERS = "folder-control-characters", "The server folder must not contain control characters.";
        FOLDER_NOT_ABSOLUTE = "folder-not-absolute", "The server folder must be an absolute server path: {folder}";
        APP_LACKS_FILES = "app-lacks-install-files", "This app does not include the files needed to install on a server.";
        APP_OLDER_THAN_SERVER = "app-older-than-server", "This app ({client}) is older than the version on {display} ({server}). Update the app on this PC, then reconnect.";
        SERVER_VERSION_MISMATCH = "server-version-mismatch", "The version running on {display} ({server}) does not match this app ({client}). Reconnect to install the matching version on the server.";
        PASSWORD_REFUSED = "password-refused", "The password was not accepted. Check it and try again.";
        PASSPHRASE_REFUSED = "passphrase-refused", "The passphrase for the key was not accepted. Check it and try again.";
        CODE_REFUSED = "code-refused", "The code was not accepted. Check it and try again.";
        NO_BOOTSTRAP_RESULT = "bootstrap-no-result", "The server did not answer the install check. Try connecting again.";
        NO_PLATFORM = "bootstrap-no-platform", "The server did not say which system it runs. Try connecting again.";
        BOOTSTRAP_EXITED = "bootstrap-exited", "The install check on the server stopped unexpectedly (status {status}). Try connecting again.";
        SERVER_RUNS_WINDOWS = "server-runs-windows", "The server runs Windows. Servers need Linux (x64 or arm64, glibc) or macOS (x64 or arm64).";
        SERVER_SYSTEM_UNSUPPORTED = "server-system-unsupported", "The server is {found}. Servers need Linux (x64 or arm64, glibc) or macOS (x64 or arm64).";
        INSTALL_ID_UNSAFE = "install-id-unsafe", "The install name is not a safe folder name: {id}";
        UPLOAD_NEEDS_CHECKSUMS = "upload-needs-checksums", "An upload needs the checksum of the files and of their bundle.";
        INSTALL_NO_GZIP = "install-no-gzip", "gzip was not found on the server.";
        INSTALL_NO_TAR = "install-no-tar", "tar was not found on the server.";
        INSTALL_NO_CHECKSUM_TOOL = "install-no-checksum-tool", "Neither sha256sum nor shasum was found on the server.";
        UPLOAD_NOT_STORED = "upload-not-stored", "The uploaded files could not be stored on the server.";
        UPLOAD_CHECKSUM_MISMATCH = "upload-checksum-mismatch", "The uploaded files do not match their checksum.";
        UPLOAD_FOLDER_FAILED = "upload-folder-failed", "The upload folder could not be created on the server.";
        UPLOAD_NOT_UNPACKED = "upload-not-unpacked", "The uploaded files could not be unpacked on the server.";
        UPLOAD_NO_PROGRAM = "upload-no-program", "The uploaded files do not contain the server program.";
        INSTALL_MISSING = "install-missing", "The app is not installed on the server and must be uploaded.";
        HOST_KEYS_UNREADABLE = "host-keys-unreadable", "The SSH host keys saved on this PC could not be read: {error}";
        HOST_KEYS_NEWER_VERSION = "host-keys-newer-version", "The SSH host keys saved on this PC were written by a newer version of the app. Update the app and try again. ({error})";
        HOST_KEYS_MALFORMED = "host-keys-malformed", "The SSH host keys saved on this PC contain an entry the app cannot read. Fix or remove that entry in the known_hosts file, then try again. ({error})";
        SSH_SETTINGS_NOT_UPDATED = "ssh-settings-not-updated", "The SSH settings on this PC could not be updated: {error}";
        HOST_KEY_CHANGED_WHILE_CONFIRMING = "host-key-changed-while-confirming", "The server presented another key while this one was being confirmed. Check the server again.";
        HOST_KEY_REVOKED_WHILE_CONFIRMING = "host-key-revoked-while-confirming", "This server's key was revoked while you were confirming it, so it was not saved. Check the server again.";
        HOST_KEYS_CHANGED_WHILE_CONFIRMING = "host-keys-changed-while-confirming", "The saved host keys changed while you were confirming this key, so it was not saved. Check the server again.";
        SAVED_ENTRY_REMOVAL_FAILED = "saved-entry-removal-failed", "The saved entry for {name} could not be removed.";
        SERVER_UPGRADE_REQUIRED = "server-upgrade-required", "The app on the server ({server}) does not offer the connection this app needs. Remove it from the server and connect again to install a matching version.";
        HOST_KEY_MANUAL_EDIT ="host-key-manual-edit", "This host key is also listed in an entry the app did not add, or in several entries, so it cannot be replaced automatically. Edit the known_hosts file by hand, then try again. ({path})";
        SSH_CONFIG_UNREADABLE = "ssh-config-unreadable", "ssh could not read its configuration for this address.";
        PROXY_HOST_UNREADABLE = "proxy-host-unreadable", "The host name cannot be read through a proxy.";
        NO_KEY_TO_SAVE = "no-key-to-save", "There is no key to save.";
        NO_KEY_TO_REPLACE = "no-key-to-replace", "There is no key to replace.";
        SERVER_NOT_SAVED = "server-not-saved", "This SSH server is no longer saved.";
        CLEANUP_NOTHING_RUNNING = "cleanup-nothing-running", "Nothing was running on the server.";
        CLEANUP_STOPPED = "cleanup-stopped", "Stopped what was running on the server (process {pid}).";
        CLEANUP_LEFT_RUNNING = "cleanup-left-running", "Left process {pid} running: it could not be confirmed as the app’s.";
        CLEANUP_REMOVED = "cleanup-removed", "Removed {removed}.";
        CLEANUP_REMOVED_KEPT = "cleanup-removed-kept", "Removed {removed}; kept {kept}.";
        CLEANUP_REMOVED_NOTHING = "cleanup-removed-nothing", "Removed nothing.";
        CLEANUP_REMOVED_NOTHING_KEPT = "cleanup-removed-nothing-kept", "Removed nothing; kept {kept}.";
        CONNECT_FIRST = "connect-first", "Connect to {name} to manage its logins.";
        PC_ACCOUNTS = "pc-accounts", "{name} uses this PC's accounts. Switch it to server accounts to manage its logins.";
        FORWARD_CONNECTION_CLOSED = "forward-connection-closed", "The SSH connection is closed.";
        FORWARD_CONNECTION_NOT_READY = "forward-connection-not-ready", "The SSH connection is not ready after {ms} ms.";
    }
}

/// The sentences the server program says over its `MIXDOG_NOTICE` line (`server_ensure`).
pub mod server {
    crate::texts! {
        ENSURE_INSTALL_LOCKED = "ensure-install-locked", "Another installation on the server holds {lock} ({owner}). Try again when it has finished.";
        ENSURE_INSTALL_MISSING = "ensure-install-missing", "The app is not installed on the server (install {install}) and must be uploaded.";
        ENSURE_CHECKSUM = "ensure-checksum-mismatch", "The uploaded files do not match their checksum (expected {expected}, got {actual}).";
        ENSURE_UNSAFE_ID = "ensure-unsafe-install-id", "The install name is not a safe folder name: {id}";
        ENSURE_BAD_VERSION = "ensure-bad-version", "The version is not valid: {version}";
        ENSURE_CORE_EXITED = "ensure-core-exited", "The app stopped on the server (status {status}). {log}: {tail}";
        ENSURE_CORE_NOT_READY = "ensure-core-not-ready", "The app did not become ready on the server within {seconds} s (it is still {state}). {log}: {tail}";
        ENSURE_CONTROLLER_GONE = "ensure-controller-gone", "The connection to the server closed while the app was starting; it was left starting.";
        ENSURE_CORE_CONTROL = "ensure-core-control", "Managing the app on the server failed: {detail}";
        ENSURE_INSTALL_FAILED = "ensure-install-failed", "The install on the server failed: {detail}";
        ENSURE_UNPROVEN = "ensure-unproven", "A process on the server could not be confirmed as the app’s, so it was left alone. {detail}";
        ENSURE_STOP_FAILED = "ensure-stop-failed", "The app on the server (process {pid}) did not stop.";
        ENSURE_CLIENT_OUTDATED = "ensure-client-outdated", "This app (version {desktop_version}) is older than the version on the server (version {server_version}). Update the app on this PC.";
        ENSURE_BUSY = "ensure-busy", "The version on the server ({server_version}) is still running work. Wait for it to finish, or stop it.";
        ENSURE_ARGUMENTS = "ensure-arguments", "The server program was not given usable arguments: {detail}";
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    texts! {
        GREETING = "greeting", "Hello {name}, you have {count} messages.";
        QUIET = "quiet", "Nothing to say.";
    }

    #[test]
    fn a_sentence_fills_its_slots_and_carries_its_code_and_parameters() {
        let said = GREETING.said([("name", "Ann"), ("count", "3")]);
        assert_eq!(said.english, "Hello Ann, you have 3 messages.");
        assert_eq!((said.message.code.as_str(), said.message.params.get("name").map(String::as_str)), ("greeting", Some("Ann")));
        assert_eq!(QUIET.plain().message.params.len(), 0);
        assert_eq!(ALL.len(), 2);
        assert_eq!(SshMessage::slots(GREETING.english), vec!["name", "count"]);
    }

    #[test]
    fn every_code_of_the_connection_code_is_named_once_and_in_kebab_case() {
        let mut seen = std::collections::BTreeSet::new();
        for text in client::ALL.iter().chain(server::ALL) {
            assert!(!text.code.is_empty() && text.code.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'), "{}", text.code);
            assert!(seen.insert(text.code), "code {} is used twice", text.code);
            assert!(!text.english.is_empty(), "{} has no English fallback", text.code);
        }
    }
}
