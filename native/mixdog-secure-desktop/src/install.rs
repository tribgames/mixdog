//! Install / uninstall / status, plus service start/stop.
//!
//! `install` is the single elevated step: it is launched by the app with the
//! `runas` verb (one UAC prompt). It generates the per-install secret, writes
//! the ACL-protected state, creates the demand-start LocalSystem service,
//! widens the service's DACL so the installing user can start/stop/query it
//! without another prompt, and starts it. `uninstall` stops and deletes the
//! service and removes every file. `status` needs no elevation: the default
//! service DACL already lets a normal user query it, and the state file grants
//! the installing user read access. All results are printed as JSON for the
//! main-process client to parse.
//!
//! Install is on demand: the app runs `install` elevated only when the paired
//! phone asks for the helper or the person approves PC access in Computer Use
//! setup (never on app install or update), and `check` (no elevation) reports
//! its state for those and for the app uninstaller, which runs `uninstall`
//! elevated only when something is installed. `install` over an existing
//! registration upgrades it in place, so a helper left outdated by an app
//! update is fixed by the next request or approval.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::json;
use std::os::windows::ffi::OsStrExt;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Globalization::{CompareStringOrdinal, CSTR_EQUAL};
use windows::Win32::Foundation::{
    GetLastError, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, GENERIC_WRITE,
    HANDLE,
};
use windows::Win32::Security::{
    CreateWellKnownSid, GetTokenInformation, SetFileSecurityW, TokenElevation, WinBuiltinAdministratorsSid,
    WinHighLabelSid, DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION, OBJECT_SECURITY_INFORMATION,
    OWNER_SECURITY_INFORMATION, PSID, SECURITY_MAX_SID_SIZE, TOKEN_ELEVATION, TOKEN_QUERY, WELL_KNOWN_SID_TYPE,
};
use windows::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, MoveFileExW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_MODE,
    MOVEFILE_DELAY_UNTIL_REBOOT, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MOVE_FILE_FLAGS,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY,
    KEY_WRITE, REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SAM_FLAGS, REG_SZ,
};
use windows::Win32::System::Threading::{
    AddIntegrityLabelToBoundaryDescriptor, AddSIDToBoundaryDescriptor, ClosePrivateNamespace,
    CreateBoundaryDescriptorW, CreatePrivateNamespaceW, DeleteBoundaryDescriptor, GetCurrentProcess,
    GetExitCodeProcess, OpenProcessToken, WaitForSingleObject, INFINITE,
};
use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
use windows::Win32::System::Services::{
    ChangeServiceConfig2W, SC_ACTION, SC_ACTION_NONE, SC_ACTION_RESTART, SERVICE_CONFIG_FAILURE_ACTIONS,
    SERVICE_CONFIG_FAILURE_ACTIONS_FLAG, SERVICE_FAILURE_ACTIONSW, SERVICE_FAILURE_ACTIONS_FLAG,
    ChangeServiceConfigW, CloseServiceHandle, ControlService, CreateServiceW, DeleteService, OpenSCManagerW, OpenServiceW,
    QueryServiceStatusEx, SetServiceObjectSecurity, StartServiceW, SC_HANDLE, SC_MANAGER_ALL_ACCESS,
    SC_MANAGER_CONNECT, SC_STATUS_PROCESS_INFO, SERVICE_ALL_ACCESS, SERVICE_CONTROL_STOP,
    SERVICE_DEMAND_START, SERVICE_ERROR_NORMAL, SERVICE_QUERY_STATUS, SERVICE_RUNNING,
    SERVICE_START, SERVICE_START_PENDING, SERVICE_STATUS, SERVICE_STATUS_CURRENT_STATE,
    SERVICE_STATUS_PROCESS, SERVICE_STOP, SERVICE_STOPPED, SERVICE_STOP_PENDING,
    SERVICE_WIN32_OWN_PROCESS,
};

use crate::acl;
use crate::security::{
    binary_sddl, decode_controller_key, service_sddl, state_dir_sddl, state_file_sddl, InstallState,
};
use crate::helper::SHUTDOWN_DEADLINE;
use crate::winutil::{current_user_sid, is_win32_error, now_ms, wide, OwnedHandle, SecurityDescriptor};
use crate::{log, paths, signature};

const DELETE_ACCESS: u32 = 0x0001_0000; // DELETE
const ERROR_ALREADY_EXISTS_CODE: u32 = 183;
const ERROR_SERVICE_DOES_NOT_EXIST: u32 = 1060;

/// Exit code when the per-machine install lock is already held: another
/// elevated install/uninstall is running, so this one did nothing. The app
/// maps it to an "in progress" outcome, not a failure.
const EXIT_BUSY: i32 = 75;
/// Exit code when the service is already installed for a different Windows
/// account (the same code `check` uses for that state). Nothing was changed;
/// transferring ownership is not supported.
const EXIT_OTHER_USER: i32 = 4;
/// Exit code when the image to stage was refused: an unpinned (local/dev)
/// build, an invalid signature, a signer other than the pinned release
/// publisher, or an image that moved while it was being opened.
const EXIT_UNTRUSTED_IMAGE: i32 = 5;
/// Exit code when the image's certificate revocation status could not be
/// determined (no CRL/OCSP answer within the bounded retrieval time).
const EXIT_REVOCATION_UNKNOWN: i32 = 6;
/// Exit code of `check --controller-key k` when the helper is installed and
/// current but that phone's key is not enrolled: the phone is offered an
/// `enroll` (add its key) rather than a reinstall.
const EXIT_NOT_ENROLLED: i32 = 7;
// Exit codes of the credential-logon path (`--logon`): the typed password did
// not authenticate, the account is not an unfiltered administrator, or the
// account/policy refused this logon. The app maps each to a phone outcome.
pub(crate) const EXIT_BAD_CREDENTIALS: i32 = 10;
pub(crate) const EXIT_NOT_ADMIN: i32 = 11;
pub(crate) const EXIT_LOGON_TYPE_DENIED: i32 = 12;
pub(crate) const EXIT_ACCOUNT_LOCKED: i32 = 13;
pub(crate) const EXIT_ACCOUNT_DISABLED: i32 = 14;
pub(crate) const EXIT_POLICY_BLOCKED: i32 = 15;
// Exit codes of the delegated (unelevated, app-authorized) path (`--delegated`):
// delegation is off (never opted in, or disabled), or the service refused this
// caller / was unreachable. The app maps each to a phone outcome.
pub(crate) const EXIT_DELEGATION_DISABLED: i32 = 20;
pub(crate) const EXIT_DELEGATION_DENIED: i32 = 21;
pub(crate) const EXIT_DELEGATION_UNAVAILABLE: i32 = 22;
// No overall self-abort timer on `install`/`uninstall`/`verify-image`. Each
// external wait has its own limit instead:
// - the online revocation retrieval: `signature::REVOCATION_RETRIEVAL_TIMEOUT_MS`,
//   20 s cumulative across its CRL/OCSP retrievals;
// - each network retrieval of chain building (root auto-update, AIA issuers)
//   in `WinVerifyTrust` and in the revocation chain: Windows' default per-URL
//   retrieval timeout (`signature::WINDOWS_DEFAULT_URL_RETRIEVAL_TIMEOUT_MS`,
//   15 s), a configurable policy value that limits one retrieval at a time —
//   not the whole `WinVerifyTrust` operation, which may make several;
// - every SCM stop/start: the documented checkpoint/wait-hint pattern. By
//   design that waiter keeps going for as long as the service keeps advancing
//   its checkpoint, and gives up only after a whole wait hint without
//   progress; [`service_stop_bound`] / [`service_start_bound`] are what that
//   means for this crate's own service, not a cap the waiter enforces.
// Everything else (lock, staging, ACLs, SCM registration, registry) is local
// work with nothing external to wait on. A global timer could only abort such
// local work half-way (slow disk, AV scanning), which is worse than what it
// guards.

/// The `dwWaitHint` this crate's service reports with its single
/// SERVICE_START_PENDING before SERVICE_RUNNING, exported by `service.rs`.
use crate::service::SERVICE_START_WAIT_HINT_MS;

/// Worst case of following this service's stop with the documented pattern
/// ("Starting a Service"): the service reports STOP_PENDING with
/// `dwWaitHint = SHUTDOWN_DEADLINE` and advances its checkpoint each poll for
/// at most `SHUTDOWN_DEADLINE` (it force-kills the helper then and stops); if
/// it then stops progressing, the waiter gives up once a whole hint has passed
/// without progress, noticed at the next poll slice. So
/// `SHUTDOWN_DEADLINE + stall_window(hint) + wait_slice(hint)` = 10 + 10 + 1 s.
/// Documents (and the tests check) the per-step bound; nothing arms a timer.
/// The waiter itself, by design, keeps waiting for as long as the checkpoint
/// keeps advancing: this bound holds because this service stops advancing it
/// after `SHUTDOWN_DEADLINE`.
#[cfg_attr(not(test), allow(dead_code))]
fn service_stop_bound() -> Duration {
    let hint = SHUTDOWN_DEADLINE.as_millis() as u32;
    SHUTDOWN_DEADLINE + stall_window(hint) + wait_slice(hint)
}

/// Worst case of following this service's start: one START_PENDING with
/// [`SERVICE_START_WAIT_HINT_MS`] and no further progress before RUNNING, so a
/// stuck start is given up after a whole hint, noticed at the next slice:
/// 3 + 1 s. Documents (and the tests check) the per-step bound; as for the
/// stop, the waiter would keep going while a checkpoint advanced, by design.
#[cfg_attr(not(test), allow(dead_code))]
fn service_start_bound() -> Duration {
    stall_window(SERVICE_START_WAIT_HINT_MS) + wait_slice(SERVICE_START_WAIT_HINT_MS)
}

/// Owner + group + protected DACL, applied together so the file ends up owned by
/// Administrators with no inherited user-writable ACE.
fn owner_group_dacl() -> OBJECT_SECURITY_INFORMATION {
    OBJECT_SECURITY_INFORMATION(
        OWNER_SECURITY_INFORMATION.0 | GROUP_SECURITY_INFORMATION.0 | DACL_SECURITY_INFORMATION.0,
    )
}

/// RAII wrapper for an SC_HANDLE.
struct ScHandle(SC_HANDLE);
impl Drop for ScHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseServiceHandle(self.0);
        }
    }
}

pub(crate) fn emit(value: serde_json::Value) {
    let text = value.to_string();
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{text}");
}

pub(crate) fn fail(message: &str) -> i32 {
    emit(json!({ "ok": false, "error": message }));
    1
}

/// Apply an SDDL-derived security descriptor (owner + group + protected DACL)
/// to an existing path.
fn apply_security(path: &Path, sddl: &str, info: OBJECT_SECURITY_INFORMATION) -> Result<(), String> {
    let descriptor = SecurityDescriptor::from_sddl(sddl).map_err(|e| e.to_string())?;
    let wide_path = wide(&path.to_string_lossy());
    unsafe {
        SetFileSecurityW(PCWSTR(wide_path.as_ptr()), info, descriptor.raw())
            .ok()
            .map_err(|error| format!("set security on {}: {error}", path.display()))
    }
}

/// The chain of directories that must exist from just below an already-present
/// `base` (e.g. `%ProgramData%`) down to and including `leaf`, ordered
/// shallowest-first so they can be created top-down. `base` is assumed to exist
/// already and is **never** returned — the installer must not re-permission a
/// shared system directory such as `%ProgramData%`; only Mixdog's own
/// descendants are created with the protected DACL. Returns an error if `leaf`
/// is not under `base`.
///
/// Pure (no filesystem access); unit-tested below. The P2 fix: before this,
/// only `leaf`'s final component was created, so a fresh machine whose
/// `%ProgramData%\Mixdog` did not yet exist failed the install.
fn protected_dir_chain(base: &Path, leaf: &Path) -> Result<Vec<PathBuf>, String> {
    let relative = leaf
        .strip_prefix(base)
        .map_err(|_| format!("{} is not under {}", leaf.display(), base.display()))?;
    let mut chain = Vec::new();
    let mut current = base.to_path_buf();
    for component in relative.components() {
        current = current.join(component);
        chain.push(current.clone());
    }
    Ok(chain)
}

/// Create `path` with its protected security descriptor applied atomically at
/// creation time, so there is never a window where it exists with default
/// (user-writable) permissions. If it already exists, it is accepted only after
/// it verifies as a trusted, non-reparse path, and its descriptor is re-applied.
fn create_protected_dir(path: &Path, sddl: &str) -> Result<(), String> {
    let descriptor = SecurityDescriptor::from_sddl(sddl).map_err(|e| e.to_string())?;
    let attributes = descriptor.attributes();
    let wide_path = wide(&path.to_string_lossy());
    match unsafe { CreateDirectoryW(PCWSTR(wide_path.as_ptr()), Some(&attributes)) } {
        Ok(()) => Ok(()),
        Err(error) if is_win32_error(&error, ERROR_ALREADY_EXISTS_CODE) => {
            // Reject an existing directory that is a reparse point or is owned /
            // writable by an untrusted principal, then re-assert our descriptor.
            acl::verify_trusted_ancestry(path)
                .map_err(|reason| format!("existing {} is not trusted: {reason}", path.display()))?;
            apply_security(path, sddl, owner_group_dacl())
        }
        Err(error) => Err(format!("create {}: {error}", path.display())),
    }
}

/// Install the service binary into a protected machine directory and lock it
/// down. The bytes come from a source image already verified and held open by
/// the caller ([`signature::verify_source`]), never re-read from a path a
/// user-level process could have swapped. Returns the quoted, protected path to
/// register the service against. Everything the service later runs as SYSTEM
/// lives here, owned by Administrators and writable only by SYSTEM/Administrators
/// — never by the installing user — so the user cannot swap the binary for
/// their own code.
fn stage_protected_binary(user_sid: &str, image: &[u8]) -> Result<String, String> {
    let dir_sddl = state_dir_sddl(user_sid).ok_or("invalid user SID")?;

    // 1. Create every directory from just below %ProgramData% down to the bin
    //    subdirectory, top-down and each atomically protected — the
    //    intermediate %ProgramData%\Mixdog may not exist on a fresh machine.
    //    %ProgramData% itself is the pre-existing base and is left untouched.
    let base = paths::program_data_root();
    for dir in protected_dir_chain(&base, &paths::bin_dir())? {
        create_protected_dir(&dir, &dir_sddl)?;
    }

    // 2. Verify the state dir, the bin dir, and every ancestor are trusted and
    //    not redirected — before any secret is written.
    acl::verify_trusted_ancestry(&paths::state_dir())?;
    acl::verify_trusted_ancestry(&paths::bin_dir())?;

    // 3. Write the verified bytes into the protected dir and lock the copy down
    //    (admin/SYSTEM-only). These are the exact bytes WinVerifyTrust accepted.
    std::fs::write(paths::bin_exe(), image)
        .map_err(|e| format!("write binary to {}: {e}", paths::bin_exe().display()))?;
    let bin_sddl = binary_sddl(user_sid).ok_or("invalid user SID")?;
    apply_security(&paths::bin_exe(), &bin_sddl, owner_group_dacl())?;

    // 4. Verify the final binary path and its whole ancestry are trusted.
    acl::verify_trusted_ancestry(&paths::bin_exe())?;

    // Quoted so a space in the path cannot split the ImagePath into an
    // unquoted-service-path hijack.
    Ok(format!("\"{}\" service", paths::bin_exe().to_string_lossy()))
}

/// Hold on the per-machine install lock while an elevated operation runs.
enum InstallLock {
    /// This process created the lock; it is released when dropped (or when the
    /// process exits).
    Held(#[allow(dead_code)] PrivateNamespace),
    /// Another elevated install/uninstall holds it right now.
    Busy,
    /// The boundary refused this caller: it is not an elevated administrator.
    Denied,
    /// The lock could not be set up.
    Error(String),
}

/// A private object namespace this process created; closing it destroys it.
struct PrivateNamespace(HANDLE);

impl Drop for PrivateNamespace {
    fn drop(&mut self) {
        const PRIVATE_NAMESPACE_FLAG_DESTROY: u32 = 1;
        unsafe {
            let _ = ClosePrivateNamespace(self.0, PRIVATE_NAMESPACE_FLAG_DESTROY);
        }
    }
}

/// A boundary descriptor, deleted on drop.
struct Boundary(HANDLE);

impl Drop for Boundary {
    fn drop(&mut self) {
        unsafe { DeleteBoundaryDescriptor(self.0) }
    }
}

/// A well-known SID in a buffer of the documented maximum size.
pub(crate) fn well_known_sid(kind: WELL_KNOWN_SID_TYPE) -> Result<[u8; SECURITY_MAX_SID_SIZE as usize], String> {
    let mut sid = [0u8; SECURITY_MAX_SID_SIZE as usize];
    let mut size = sid.len() as u32;
    unsafe { CreateWellKnownSid(kind, None, Some(PSID(sid.as_mut_ptr().cast())), &mut size) }
        .map_err(|error| format!("build the install lock boundary SID: {error}"))?;
    Ok(sid)
}

/// The install lock's name (boundary and namespace alias).
const INSTALL_LOCK_NAME: &str = "MixdogSecureDesktopInstall";
/// Only SYSTEM and Administrators may open the namespace.
const INSTALL_LOCK_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;BA)";

/// Acquire the machine-wide install lock so two elevated installs can never
/// overlap: **creating** a private object namespace is the lock. Its boundary
/// requires the Administrators SID and the High mandatory label, and "the
/// caller must be within the specified boundary for the create operation to
/// succeed" (Microsoft Learn, *Object Namespaces*; `CreatePrivateNamespaceW`);
/// a process "can create a private namespace only with an integrity level that
/// is equal to or lower than" its own, which is the documented protection
/// "against squatting attacks by lower integrity-level processes"
/// (`AddIntegrityLabelToBoundaryDescriptor`). So a standard user — or an
/// administrator's unelevated, medium-integrity process, whose Administrators
/// SID is deny-only — cannot pre-create it to block installs, unlike a `Global`
/// named mutex. Only the creator holds it (nothing ever opens it), and it goes
/// away when the creator closes it or exits, so `ERROR_ALREADY_EXISTS` means
/// another elevated install is running right now.
fn acquire_install_lock() -> InstallLock {
    let name = wide(INSTALL_LOCK_NAME);
    let raw = unsafe { CreateBoundaryDescriptorW(PCWSTR(name.as_ptr()), 0) };
    if raw.is_invalid() {
        return InstallLock::Error(format!(
            "create the install lock boundary (error {})",
            unsafe { GetLastError() }.0
        ));
    }
    let mut boundary = Boundary(raw);
    let (mut admins, mut high) =
        match (well_known_sid(WinBuiltinAdministratorsSid), well_known_sid(WinHighLabelSid)) {
            (Ok(admins), Ok(high)) => (admins, high),
            (Err(error), _) | (_, Err(error)) => return InstallLock::Error(error),
        };
    if let Err(error) = unsafe { AddSIDToBoundaryDescriptor(&mut boundary.0, PSID(admins.as_mut_ptr().cast())) } {
        return InstallLock::Error(format!("add Administrators to the install lock boundary: {error}"));
    }
    if let Err(error) =
        unsafe { AddIntegrityLabelToBoundaryDescriptor(&mut boundary.0, PSID(high.as_mut_ptr().cast())) }
    {
        return InstallLock::Error(format!("add the High label to the install lock boundary: {error}"));
    }
    let descriptor = match SecurityDescriptor::from_sddl(INSTALL_LOCK_SDDL) {
        Ok(descriptor) => descriptor,
        Err(error) => return InstallLock::Error(format!("install lock security: {error}")),
    };
    let attributes = descriptor.attributes();
    let handle = unsafe {
        CreatePrivateNamespaceW(Some(&attributes), boundary.0 .0 as *const _, PCWSTR(name.as_ptr()))
    };
    if !handle.is_invalid() {
        return InstallLock::Held(PrivateNamespace(handle));
    }
    match unsafe { GetLastError() } {
        ERROR_ALREADY_EXISTS => InstallLock::Busy,
        ERROR_ACCESS_DENIED => InstallLock::Denied,
        other => InstallLock::Error(format!("create the install lock (error {})", other.0)),
    }
}

/// Map a lock that was not acquired to this command's exit.
fn lock_refused(lock: InstallLock) -> i32 {
    match lock {
        InstallLock::Busy => {
            emit(json!({ "ok": false, "error": "another secure-desktop install is already running" }));
            EXIT_BUSY
        }
        InstallLock::Denied => fail("the install lock requires an elevated administrator"),
        InstallLock::Error(error) => fail(&error),
        InstallLock::Held(_) => unreachable!("a held lock is not a refusal"),
    }
}

/// Whether an existing registration belongs to a different Windows account:
/// registered, and its readable state records another SID. A registration with
/// no readable state has no owner left to protect (it cannot serve anyone), so
/// it is repaired. Pure; unit-tested.
fn owned_by_other_user(service_registered: bool, recorded_owner: Option<&str>, installer_sid: &str) -> bool {
    service_registered && recorded_owner.is_some_and(|owner| !owner.eq_ignore_ascii_case(installer_sid))
}

/// The SID an existing install recorded (readable elevated: the state DACL
/// grants Administrators), or `None` without a valid state file.
fn recorded_owner() -> Option<String> {
    std::fs::read_to_string(paths::state_file())
        .ok()
        .and_then(|text| InstallState::from_json(&text).ok())
        .map(|state| state.user_sid)
}

/// Whether the service is registered.
fn service_registered() -> Result<bool, String> {
    open_manager(SC_MANAGER_CONNECT)
        .and_then(|manager| open_service(&manager, SERVICE_QUERY_STATUS))
        .map(|service| service.is_some())
}

/// Refuse to act on another Windows account's install: nothing was changed.
fn refuse_other_user(operation: &str) -> i32 {
    log::event(operation, "refused: the service is installed for another Windows account");
    emit(json!({
        "ok": false,
        "otherUser": true,
        "error": "the secure-desktop service is installed for another Windows account",
    }));
    EXIT_OTHER_USER
}

/// Report a refused source image with its exit code (5 untrusted, 6 revocation
/// status unknown).
fn refuse_image(refusal: &signature::Refusal) -> i32 {
    emit(json!({ "ok": false, "error": refusal.message() }));
    match refusal {
        signature::Refusal::Untrusted(_) => EXIT_UNTRUSTED_IMAGE,
        signature::Refusal::RevocationUnknown(_) => EXIT_REVOCATION_UNKNOWN,
    }
}

/// The temp sibling [`write_protected_state`] writes before the atomic replace.
const STATE_TEMP_NAME: &str = "state.json.tmp";

/// Whether `name` is a state temp file a crashed write may have left behind:
/// [`STATE_TEMP_NAME`], or an earlier build's `state.<pid>.tmp`. Pure.
fn is_state_temp_name(name: &str) -> bool {
    name.starts_with("state.") && name.ends_with(".tmp")
}

/// Remove every leftover state temp file in `dir` (a crash between create and
/// replace leaves one). Called under the install lock before each write, so it
/// never races a live write.
fn remove_leftover_state_temps(dir: &Path) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|error| format!("list {}: {error}", dir.display()))?;
    for entry in entries.flatten() {
        if entry.file_name().to_str().is_some_and(is_state_temp_name) {
            std::fs::remove_file(entry.path())
                .map_err(|error| format!("remove leftover {}: {error}", entry.path().display()))?;
        }
    }
    Ok(())
}

/// Create `path` as a **new** file (`CREATE_NEW`: never reuse a pre-planted
/// one) carrying `sddl` as its security descriptor from the moment it exists
/// (`CreateFileW` with `SECURITY_ATTRIBUTES`, so the parent's inheritable ACEs
/// never apply to it, not even briefly), then write `bytes` through that same
/// handle and flush them to disk (`FlushFileBuffers` via `sync_all`).
fn create_protected_file(path: &Path, bytes: &[u8], sddl: &str) -> Result<(), String> {
    use std::io::Write as _;
    use std::os::windows::io::FromRawHandle as _;
    let descriptor = SecurityDescriptor::from_sddl(sddl).map_err(|error| error.to_string())?;
    let attributes = descriptor.attributes();
    let wide_path = wide(&path.to_string_lossy());
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide_path.as_ptr()),
            GENERIC_WRITE.0,
            FILE_SHARE_MODE(0),
            Some(&attributes),
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    }
    .map_err(|error| format!("create {}: {error}", path.display()))?;
    // The File owns (and closes) the handle from here.
    let mut file = unsafe { std::fs::File::from_raw_handle(handle.0) };
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("write {}: {error}", path.display()))
}

/// Write the state file into the already-protected directory with its
/// read-only-to-user DACL. Must run only after [`stage_protected_binary`] has
/// created and verified the directory, and under the install lock.
///
/// What it holds: the installing user's SID, versions, the enrolled phones'
/// **public** keys, the delegation policy — and the 32-byte pipe `secret`.
/// The secret *is* sensitive, but by design it is shared with exactly one
/// principal besides SYSTEM/Administrators: the installing user, whose app
/// must read it to run the mutual HMAC handshake on the helper pipe (`probe`,
/// the desktop client). So that user keeps read-only access (it can never
/// write the file, so it cannot change keys or policy), and every other user
/// is excluded. See `security::state_file_sddl`.
///
/// The temp sibling is created with that final DACL (never weaker, even for a
/// moment), written and flushed through its own handle, then atomically
/// swapped in, so a concurrent reader (the running helper re-reading the key
/// set) sees either the old file or the whole new one, never partial JSON. A
/// temp a crash left behind is removed first.
fn write_protected_state(state: &InstallState) -> Result<(), String> {
    let final_path = paths::state_file();
    let dir = final_path.parent().ok_or("the state file has no parent directory")?;
    let sddl = state_file_sddl(&state.user_sid).ok_or("invalid user SID")?;
    remove_leftover_state_temps(dir)?;
    let temp = dir.join(STATE_TEMP_NAME);
    let result =
        create_protected_file(&temp, state.to_json().as_bytes(), &sddl).and_then(|()| atomic_replace(&temp, &final_path));
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// Atomically replace `to` with `from` (create `to` if absent), flushed to disk:
/// `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`.
fn atomic_replace(from: &Path, to: &Path) -> Result<(), String> {
    let wide_from = wide(&from.to_string_lossy());
    let wide_to = wide(&to.to_string_lossy());
    unsafe {
        MoveFileExW(
            PCWSTR(wide_from.as_ptr()),
            PCWSTR(wide_to.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| format!("atomically replace the state file: {error}"))
}

/// Open the service control manager with `access`.
fn open_manager(access: u32) -> Result<ScHandle, String> {
    unsafe { OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), access) }
        .map(ScHandle)
        .map_err(|error| {
            if access == SC_MANAGER_CONNECT {
                format!("open SCM: {error}")
            } else {
                format!("open SCM (elevation required): {error}")
            }
        })
}

/// Open the bridge service with `access`; `None` when it is not registered.
fn open_service(manager: &ScHandle, access: u32) -> Result<Option<ScHandle>, String> {
    let name = wide(paths::SERVICE_NAME);
    match unsafe { OpenServiceW(manager.0, PCWSTR(name.as_ptr()), access) } {
        Ok(service) => Ok(Some(ScHandle(service))),
        Err(error) if is_win32_error(&error, ERROR_SERVICE_DOES_NOT_EXIST) => Ok(None),
        Err(error) => Err(format!("open service: {error}")),
    }
}

/// Stop an already-registered service (an older bridge being upgraded) so its
/// protected binary can be replaced. Nothing registered is success.
fn stop_existing_service() -> Result<(), String> {
    let manager = open_manager(SC_MANAGER_ALL_ACCESS)?;
    match open_service(&manager, SERVICE_STOP | SERVICE_QUERY_STATUS)? {
        Some(service) if !stop_and_wait(&service) => {
            Err("existing service did not confirm SERVICE_STOPPED within its wait hint".into())
        }
        _ => Ok(()),
    }
}

/// Why a service whose stop was not confirmed is left registered.
const SERVICE_NOT_STOPPED: &str = "the service did not confirm SERVICE_STOPPED (no checkpoint progress for its whole wait hint, or its status could not be read); it stays registered, and its files, software SAS marker and uninstall entry are kept for a retry";

/// Delete the registration only after a confirmed `SERVICE_STOPPED`. Microsoft
/// Learn, *DeleteService*: it "marks a service for deletion … The database
/// entry is not removed until all open handles to the service have been closed
/// … and the service is not running" — on a service that has not stopped it
/// would return success while the service still runs from its files and still
/// holds the software SAS value. So an unconfirmed stop is an error and
/// `delete` is not called; callers then remove nothing else (no SAS recovery,
/// no files, no uninstall entry). Pure; unit-tested.
fn delete_after_confirmed_stop(
    stopped: bool,
    delete: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !stopped {
        return Err(SERVICE_NOT_STOPPED.into());
    }
    delete()
}

/// Stop and delete the service if it is registered; see
/// [`delete_after_confirmed_stop`] for the stop it requires first.
fn remove_service() -> Result<(), String> {
    let manager = open_manager(SC_MANAGER_ALL_ACCESS)?;
    let Some(service) =
        open_service(&manager, SERVICE_STOP | SERVICE_QUERY_STATUS | DELETE_ACCESS)?
    else {
        // Distinguish "not installed" (idempotent success) from a real failure
        // to open the service, which open_service reports as an error.
        log::event("uninstall", "service already absent");
        return Ok(());
    };
    delete_after_confirmed_stop(stop_and_wait(&service), || {
        unsafe { DeleteService(service.0) }.map_err(|error| format!("delete service: {error}"))
    })?;
    log::event("uninstall", "service stopped and deleted");
    Ok(())
}

/// Resolve a `SoftwareSASGeneration` value the stopped service left behind
/// (`crate::service::recover_software_sas`), so the value never outlives its
/// marker in the state directory. Must run after the service has stopped and
/// before the state directory is removed; on failure the directory (and the
/// marker) is kept so a retry can still resolve it.
fn recover_software_sas() -> Result<(), String> {
    match crate::service::recover_software_sas() {
        Ok(outcome) => {
            log::event("uninstall", &format!("software SAS marker resolved: {outcome:?}"));
            Ok(())
        }
        Err(error) => Err(format!(
            "the software SAS policy could not be restored ({error}); the state folder and its marker are kept for a retry"
        )),
    }
}

/// The cleanup state after a removal/rollback: everything gone, or something
/// left behind. "Incomplete" is deliberately distinct from "not installed" so
/// the caller never reports a half-removed install as clean.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Cleanup {
    Clean,
    Incomplete,
}

impl Cleanup {
    fn label(self) -> &'static str {
        match self {
            Cleanup::Clean => "clean",
            Cleanup::Incomplete => "incomplete",
        }
    }
}

/// The files may be deleted only when the service is confirmed stopped and its
/// registration is gone, so a still-registered or still-running service never
/// loses the binary it runs as SYSTEM.
fn may_remove_files(service_removed: &Result<(), String>) -> bool {
    service_removed.is_ok()
}

/// Decide the cleanup state from the two removal results and collect every
/// problem into `problems` (pure; unit-tested). Either failure is incomplete.
fn cleanup_outcome(
    service_removed: &Result<(), String>,
    files_removed: &Result<(), String>,
    problems: &mut Vec<String>,
) -> Cleanup {
    let mut clean = true;
    if let Err(error) = service_removed {
        problems.push(format!("service removal failed: {error}"));
        clean = false;
    }
    if let Err(error) = files_removed {
        problems.push(format!("state removal failed: {error}"));
        clean = false;
    }
    if clean {
        Cleanup::Clean
    } else {
        Cleanup::Incomplete
    }
}

/// Roll a failed install back. If the service is confirmed stopped and its
/// registration removed, the SAS marker is resolved and the files and entry go
/// too (a clean not-installed state); otherwise all of them are kept so the
/// still-registered (possibly still running) service keeps a working binary,
/// and the result is reported as an explicit incomplete cleanup rather than a
/// silent not-installed.
fn fail_and_roll_back(error: &str) -> i32 {
    let (cleanup, problems) = roll_back(&mut ThisMachine);
    for problem in &problems {
        log::event("install", problem);
    }
    emit(json!({
        "ok": false,
        "error": error,
        "cleanup": cleanup.label(),
        "warnings": problems,
    }));
    1
}

/// The removal steps of [`fail_and_roll_back`], over an [`UninstallTarget`] so
/// the unconfirmed-stop path is testable without the SCM.
fn roll_back(target: &mut impl UninstallTarget) -> (Cleanup, Vec<String>) {
    let mut problems = Vec::new();
    let service_removed = target.remove_service();
    let files_removed = if may_remove_files(&service_removed) {
        target
            .recover_software_sas()
            .and_then(|()| target.remove_state_dir(&mut problems))
            .and_then(|()| target.remove_apps_entry())
    } else {
        Err(FILES_KEPT_FOR_SERVICE.into())
    };
    let cleanup = cleanup_outcome(&service_removed, &files_removed, &mut problems);
    (cleanup, problems)
}

/// Why a rollback removed no files.
const FILES_KEPT_FOR_SERVICE: &str =
    "left in place (with the software SAS marker and the uninstall entry) because the service was not confirmed stopped and removed";

/// The phone's control-grant key from `--controller-key <base64url>`, as `check`
/// takes it (the first one; none is fine). A flag without a value, or a value
/// that is not an uncompressed P-256 point (`security::decode_controller_key`),
/// is an error. Pure; unit-tested.
fn controller_key_arg(args: &[String]) -> Result<Option<String>, String> {
    let Some(position) = args.iter().position(|arg| arg == "--controller-key") else {
        return Ok(None);
    };
    let key = args.get(position + 1).ok_or("--controller-key needs a value")?;
    decode_controller_key(key).ok_or("the controller key is not an uncompressed P-256 point (base64url)")?;
    Ok(Some(key.trim().to_string()))
}

/// Every `flag <value>` on the command line, each value validated as an
/// uncompressed P-256 point; `noun` names the key in the error. Zero is allowed.
/// Pure; unit-tested.
fn collect_flag_keys(args: &[String], flag: &str, noun: &str) -> Result<Vec<String>, String> {
    let mut keys = Vec::new();
    let mut index = 0;
    while index < args.len() {
        if args[index] == flag {
            let key = args.get(index + 1).ok_or_else(|| format!("{flag} needs a value"))?;
            decode_controller_key(key)
                .ok_or_else(|| format!("the {noun} is not an uncompressed P-256 point (base64url)"))?;
            keys.push(key.trim().to_string());
            index += 2;
        } else {
            index += 1;
        }
    }
    Ok(keys)
}

/// Every `--controller-key <value>`. Zero is allowed (`install` may install the
/// helper with no key yet). Pure; unit-tested.
fn collect_controller_keys(args: &[String]) -> Result<Vec<String>, String> {
    collect_flag_keys(args, "--controller-key", "controller key")
}

/// Every `--revoke-key <value>`. Used by `enroll` to apply pending revokes in
/// the same elevation. Pure; unit-tested.
fn collect_revoke_keys(args: &[String]) -> Result<Vec<String>, String> {
    collect_flag_keys(args, "--revoke-key", "revoke key")
}


/// Whether the command line asked for the credential-logon path (`--logon`):
/// the unelevated app runs the operation under an administrator token obtained
/// from a password on stdin, instead of a UAC elevation.
fn wants_logon(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--logon")
}

/// The install state an install writes: freshly built and enrolling `keys`
/// (zero or more). Pure; unit-tested.
fn install_state_for(user_sid: &str, keys: &[String], now_ms: u64) -> Result<InstallState, String> {
    InstallState::new(env!("CARGO_PKG_VERSION"), user_sid, paths::PIPE_NAME, now_ms).with_controller_keys(keys)
}

/// `install [--controller-key k]...` (zero or more keys) under one UAC
/// elevation, or — with `--logon` — under an administrator token logged on
/// from a password on stdin (the unelevated app's remote fallback).
pub fn install(args: &[String]) -> i32 {
    // Collected (and validated) before the lock. Zero keys is allowed: the
    // helper installs but refuses all input until a key is enrolled.
    let keys = match collect_controller_keys(args) {
        Ok(keys) => keys,
        Err(error) => return fail(&error),
    };
    if wants_logon(args) {
        return crate::logon::with_credential_logon(move || perform_install(&keys));
    }
    perform_install(&keys)
}

/// `enroll --controller-key k [--controller-key k2 …] [--revoke-key r …]`: add
/// each phone's key to an installed helper (and apply pending revokes in the
/// same step), keeping the rest. Three authorization sources:
/// - a UAC elevation (default),
/// - `--logon`: an administrator token logged on from a password on stdin
///   (the remote password fallback),
/// - `--delegated`: the unelevated, app-authorized path, honored only when the
///   SYSTEM service's stored delegation policy allows this signed app. The
///   delegated pipe op carries exactly one key and no revokes.
pub fn enroll(args: &[String]) -> i32 {
    let add = match collect_controller_keys(args) {
        Ok(add) => add,
        Err(error) => return fail(&error),
    };
    let remove = match collect_revoke_keys(args) {
        Ok(remove) => remove,
        Err(error) => return fail(&error),
    };
    if add.is_empty() && remove.is_empty() {
        return fail("enroll needs at least one --controller-key or --revoke-key");
    }
    if wants_delegated(args) {
        if !remove.is_empty() {
            return fail("the delegated enroll takes no --revoke-key");
        }
        return perform_delegated("enroll", &add);
    }
    if wants_logon(args) {
        return crate::logon::with_credential_logon(move || perform_key_change(&add, &remove));
    }
    perform_key_change(&add, &remove)
}

/// `revoke --controller-key k [--controller-key k2 …]`: remove each phone's
/// key, keeping the rest. Same three authorization sources as [`enroll`]; the
/// delegated pipe op carries exactly one key.
pub fn revoke(args: &[String]) -> i32 {
    let remove = match collect_controller_keys(args) {
        Ok(remove) => remove,
        Err(error) => return fail(&error),
    };
    if remove.is_empty() {
        return fail("revoke needs at least one --controller-key");
    }
    if wants_delegated(args) {
        return perform_delegated("revoke", &remove);
    }
    if wants_logon(args) {
        return crate::logon::with_credential_logon(move || perform_key_change(&[], &remove));
    }
    perform_key_change(&[], &remove)
}

/// Apply the adds and removes under one authorization (one UAC prompt, or one
/// logon). Takes the install lock, then the shared mutation.
fn perform_key_change(add: &[String], remove: &[String]) -> i32 {
    let _auth = match authorize_key_change() {
        Ok(auth) => auth,
        Err(code) => return code,
    };
    apply_key_change(add, remove)
}

/// Run one delegated op (exactly one key) through the service's delegation
/// pipe, unelevated. The client authenticates the service is SYSTEM and the
/// service authenticates this app; see [`crate::delegation`].
fn perform_delegated(op: &str, keys: &[String]) -> i32 {
    match keys {
        [key] => crate::delegation::request_key_change(op, key),
        _ => fail("the delegated path takes exactly one --controller-key"),
    }
}

/// Whether the command line asked for the delegated (unelevated, app-authorized)
/// path (`--delegated`).
fn wants_delegated(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--delegated")
}

/// `disable-delegation`: an elevated (UAC or `--logon`) security disable. Turns
/// off app-delegated enroll/revoke at once — the service re-reads the policy on
/// every request — while keeping the recorded app identity for audit.
/// Re-enabling needs an elevated `install`.
pub fn disable_delegation(args: &[String]) -> i32 {
    if wants_logon(args) {
        return crate::logon::with_credential_logon(perform_disable_delegation);
    }
    perform_disable_delegation()
}

fn perform_disable_delegation() -> i32 {
    let _auth = match authorize_key_change() {
        Ok(auth) => auth,
        Err(code) => return code,
    };
    if let Err(code) = confirm_installed_and_ours() {
        return code;
    }
    let mut state = match std::fs::read_to_string(paths::state_file()) {
        Ok(text) => match InstallState::from_json(&text) {
            Ok(state) => state,
            Err(error) => return fail(&error),
        },
        Err(error) => return fail(&format!("read install state: {error}")),
    };
    state.disable_delegation();
    if let Err(error) = write_protected_state(&state) {
        return fail(&error);
    }
    log::event("disable-delegation", "app delegation disabled");
    emit(json!({ "ok": true, "delegationEnabled": false }));
    0
}

/// How an enroll/revoke was authorized to change the key set. Authorization is
/// kept separate from the mutation ([`mutate_key_set`]) so each source is one
/// isolated arm.
enum KeyChangeAuth {
    /// Under the install lock: an elevated administrator (one UAC prompt), the
    /// impersonated batch-logon token, or the SYSTEM service applying a
    /// delegated change it has already authenticated. Holding the lock
    /// serializes against installs/uninstalls and is kept for the change.
    Elevated(#[allow(dead_code)] PrivateNamespace),
}

/// Take the install lock, which only an elevated administrator, the logon
/// token, or SYSTEM (the service) can — an ordinary unelevated process cannot
/// (its Administrators SID is deny-only). This is the privilege-escalation
/// guard for the CLI paths; the delegated path adds the service's app
/// authentication *before* it calls in as SYSTEM.
fn authorize_key_change() -> Result<KeyChangeAuth, i32> {
    match acquire_install_lock() {
        InstallLock::Held(lock) => Ok(KeyChangeAuth::Elevated(lock)),
        refused => Err(lock_refused(refused)),
    }
}

/// The authorized mutation for the CLI paths (elevated UAC or logon): confirm
/// the install is ours, then apply the adds and removes and report. The caller
/// already holds a [`KeyChangeAuth`].
fn apply_key_change(add: &[String], remove: &[String]) -> i32 {
    if let Err(code) = confirm_installed_and_ours() {
        return code;
    }
    match mutate_key_set(add, remove) {
        Ok(changed) => {
            emit(json!({ "ok": true, "installed": true, "changed": changed }));
            0
        }
        Err(error) => fail(&error),
    }
}

/// Confirm the helper is installed and this operation may change it: SYSTEM (the
/// service, on the delegated path, having already authenticated the installing
/// user) is always allowed; otherwise the acting user must be the install's
/// recorded owner. Returns the refusal exit code on failure.
fn confirm_installed_and_ours() -> Result<(), i32> {
    let sid = current_user_sid().map_err(|error| fail(&format!("cannot resolve user SID: {error}")))?;
    let registered = service_registered().map_err(|error| fail(&error))?;
    if !registered {
        return Err(fail("the secure-desktop helper is not installed; install it before enrolling a key"));
    }
    // SYSTEM is the service applying a delegated change for the verified
    // installing user; the owner check only guards against a *different user*
    // taking over, which SYSTEM is not.
    if !crate::security::is_system_sid(&sid) && owned_by_other_user(registered, recorded_owner().as_deref(), &sid) {
        return Err(refuse_other_user("enroll"));
    }
    Ok(())
}

/// Apply adds and removes to the key set in one read/write; returns whether the
/// set changed. Removes are applied first, so an enroll-plus-pending-revoke in
/// one elevation cannot drop a key it just added. The only thing written is the
/// key set. Shared by every authorization source (CLI and the delegated pipe),
/// so the mutation is identical however it was authorized.
fn mutate_key_set(add: &[String], remove: &[String]) -> Result<bool, String> {
    let mut state = match std::fs::read_to_string(paths::state_file()) {
        Ok(text) => InstallState::from_json(&text)?,
        Err(error) => return Err(format!("read install state: {error}")),
    };
    let mut changed = false;
    for key in remove {
        changed |= state.revoke_key(key);
    }
    for key in add {
        changed |= state.enroll_key(key)?;
    }
    if changed {
        write_protected_state(&state)?;
        log::event("key-change", &format!("controller key set updated (+{} -{})", add.len(), remove.len()));
    }
    Ok(changed)
}

/// The delegated (unelevated, app-authorized) mutation the service runs after
/// it has authenticated the calling app: take the install lock as SYSTEM, then
/// apply exactly one add or one remove through the shared [`mutate_key_set`].
/// Returns whether the set changed, or an error string for the pipe reply. It
/// never emits to stdout (the service has no console peer).
pub(crate) fn apply_delegated_key_change(op: &str, key: &str, expected: &signature::SignerPolicy) -> Result<bool, String> {
    let _auth = match authorize_key_change() {
        Ok(auth) => auth,
        Err(_) => return Err("the install lock is held or unavailable".into()),
    };
    confirm_installed_and_ours().map_err(|_| "the helper is not installed for this account".to_string())?;
    // Re-read the delegation policy UNDER the lock: a `disable-delegation` (or
    // a signer-policy change) that completed while the caller was being
    // authenticated must be honored, not raced past. The policy read in
    // `delegation::evaluate` was before the lock; this is the authoritative one.
    let state = match std::fs::read_to_string(paths::state_file()) {
        Ok(text) => InstallState::from_json(&text)?,
        Err(error) => return Err(format!("read install state: {error}")),
    };
    if !delegation_still_authorized(&state, expected) {
        return Err("app delegation was disabled or changed before the request was applied".into());
    }
    match op {
        "enroll" => mutate_key_set(std::slice::from_ref(&key.to_string()), &[]),
        "revoke" => mutate_key_set(&[], std::slice::from_ref(&key.to_string())),
        other => Err(format!("unknown delegated operation {other:?}")),
    }
}

/// Whether the stored delegation policy still authorizes `expected` — enabled,
/// and the same app signer. The under-lock guard against a disable racing an
/// in-flight delegated request. Pure; unit-tested.
fn delegation_still_authorized(state: &InstallState, expected: &signature::SignerPolicy) -> bool {
    state.delegation.authorized_signer() == Some((expected.subject.as_str(), expected.profile_eku.as_str()))
}

fn perform_install(keys: &[String]) -> i32 {
    let _lock = match acquire_install_lock() {
        InstallLock::Held(lock) => lock,
        refused => return lock_refused(refused),
    };

    let sid = match current_user_sid() {
        Ok(sid) => sid,
        Err(error) => return fail(&format!("cannot resolve user SID: {error}")),
    };

    // Ownership is decided here, under the lock, before anything changes: a
    // service another Windows account installed is never taken over (the
    // unelevated `check` reports the same state, but it ran before the prompt
    // and outside the lock).
    let registered = match service_registered() {
        Ok(registered) => registered,
        Err(error) => return fail(&error),
    };
    if owned_by_other_user(registered, recorded_owner().as_deref(), &sid) {
        return refuse_other_user("install");
    }

    // Never trust a path in the user-writable app folder: hold the running
    // image itself open against writers/deleters, verify it against the
    // release signer pinned at build time (and its chain for revocation), and
    // stage exactly those bytes. An unpinned (local/dev) build is refused here.
    let verified = match signature::verify_own_image() {
        Ok(verified) => verified,
        Err(refusal) => {
            log::event("install", &format!("refused the source image: {}", refusal.message()));
            return refuse_image(&refusal);
        }
    };
    log::event("install", &format!("source image verified (signer {:?})", verified.subject));

    // An existing registration is upgraded in place: the running service holds
    // its binary open, so stop it before the protected copy is replaced. If it
    // will not stop, the old install is left exactly as it was.
    if let Err(error) = stop_existing_service() {
        return fail(&error);
    }

    // Stage the verified bytes into a protected machine directory first (this
    // also creates and verifies the directory the secret will live in), then
    // write the secret into that protected directory.
    let bin_path = match stage_protected_binary(&sid, &verified.bytes) {
        Ok(path) => path,
        Err(error) => return fail_and_roll_back(&error),
    };

    let mut state = match install_state_for(&sid, keys, now_ms()) {
        Ok(state) => state,
        Err(error) => return fail_and_roll_back(&error),
    };
    // Opt in to app delegation (the "approve once, then paired phones
    // auto-enroll" model). The authorized app signer is this build's release
    // signer, which the Mixdog app and this helper share; a build with no pin
    // never reaches here (the image was verified above). A later elevated
    // `install` re-enables it after a security disable.
    match signature::release_signer_policy() {
        Ok(policy) => state.enable_delegation(&policy.subject, &policy.profile_eku),
        Err(error) => return fail_and_roll_back(&format!("record the delegation signer: {error}")),
    }
    if let Err(error) = write_protected_state(&state) {
        return fail_and_roll_back(&error);
    }

    let result = (|| -> Result<ScHandle, String> {
        let manager = open_manager(SC_MANAGER_ALL_ACCESS)?;

        let name = wide(paths::SERVICE_NAME);
        let display = wide(paths::SERVICE_DISPLAY_NAME);
        let bin = wide(&bin_path);
        let service = match open_service(&manager, SERVICE_ALL_ACCESS)? {
            // Upgrade: re-assert the registration against the protected copy.
            Some(service) => {
                unsafe {
                    ChangeServiceConfigW(
                        service.0,
                        SERVICE_WIN32_OWN_PROCESS,
                        SERVICE_DEMAND_START,
                        SERVICE_ERROR_NORMAL,
                        PCWSTR(bin.as_ptr()),
                        PCWSTR::null(),
                        None,
                        PCWSTR::null(),
                        PCWSTR::null(), // account unchanged (LocalSystem)
                        PCWSTR::null(),
                        PCWSTR(display.as_ptr()),
                    )
                }
                .map_err(|error| format!("reconfigure service: {error}"))?;
                service
            }
            None => ScHandle(
                unsafe {
                    CreateServiceW(
                        manager.0,
                        PCWSTR(name.as_ptr()),
                        PCWSTR(display.as_ptr()),
                        SERVICE_ALL_ACCESS,
                        SERVICE_WIN32_OWN_PROCESS,
                        SERVICE_DEMAND_START,
                        SERVICE_ERROR_NORMAL,
                        PCWSTR(bin.as_ptr()),
                        PCWSTR::null(),
                        None,
                        PCWSTR::null(),
                        PCWSTR::null(), // LocalSystem
                        PCWSTR::null(),
                    )
                }
                .map_err(|error| format!("create service: {error}"))?,
            ),
        };

        // Grant the installing user start/stop/query so later control needs no
        // further elevation. Without it the user could never start the
        // demand-start service, so a failure is an install failure (rolled
        // back), not a silently degraded install.
        let sddl = service_sddl(&sid).ok_or("invalid user SID for the service security")?;
        let descriptor = SecurityDescriptor::from_sddl(&sddl)
            .map_err(|error| format!("build the service security: {error}"))?;
        unsafe { SetServiceObjectSecurity(service.0, DACL_SECURITY_INFORMATION, descriptor.raw()) }
            .map_err(|error| format!("set the service security: {error}"))?;

        set_failure_actions(&service)?;
        write_apps_entry()?;

        unsafe { StartServiceW(service.0, None) }
            .map_err(|error| format!("start service: {error}"))?;
        Ok(service)
    })();

    let service = match result {
        Ok(service) => service,
        Err(error) => return fail_and_roll_back(&error),
    };
    // StartService returns while the service is still START_PENDING: report
    // `running` only once the SCM confirms it (the same bounded waiter as
    // `start`). The install is complete either way; a service that is not
    // confirmed running is started on demand later.
    let started = wait_until_running(
        || query_process_status(&service).map(|status| ServiceProgress::of(&status)),
        std::thread::sleep,
        Instant::now,
    );
    let mut report = json!({
        "ok": true,
        "installed": true,
        "running": started == StartWait::Running,
        "version": state.product_version,
    });
    if let Some(reason) = start_failure(started) {
        log::event("install", &format!("service installed; not confirmed running: {reason}"));
        report["warning"] = json!(reason);
    } else {
        log::event("install", "service installed and running");
    }
    emit(report);
    0
}

/// Query the service's process status, or `None` if the query fails.
fn query_process_status(service: &ScHandle) -> Option<SERVICE_STATUS_PROCESS> {
    let mut buffer = [0u8; std::mem::size_of::<SERVICE_STATUS_PROCESS>()];
    let mut needed = 0u32;
    unsafe {
        QueryServiceStatusEx(service.0, SC_STATUS_PROCESS_INFO, Some(&mut buffer), &mut needed)
    }
    .ok()?;
    Some(unsafe { *(buffer.as_ptr() as *const SERVICE_STATUS_PROCESS) })
}

/// One poll slice, as written in Microsoft Learn "Starting a Service"
/// (`DoStartSvc`): "A good interval is one-tenth of the wait hint but not less
/// than 1 second and not more than 10 seconds."
fn wait_slice(wait_hint: u32) -> Duration {
    Duration::from_millis((wait_hint / 10).clamp(1000, 10000) as u64)
}

/// How long a pending service may go without advancing its checkpoint before
/// it counts as stalled: exactly its wait hint, as in the same sample
/// (`GetTickCount() - dwStartTickCount > ssStatus.dwWaitHint` — "No progress
/// made within the wait hint").
fn stall_window(wait_hint: u32) -> Duration {
    Duration::from_millis(wait_hint as u64)
}

/// Stop the service and wait for `SERVICE_STOPPED`, bounded by the service's
/// reported wait hint and checkpoint progress (never a fixed sleep). Returns
/// whether the service confirmed it stopped.
fn stop_and_wait(service: &ScHandle) -> bool {
    let mut status = SERVICE_STATUS::default();
    let _ = unsafe { ControlService(service.0, SERVICE_CONTROL_STOP, &mut status) };

    let Some(mut info) = query_process_status(service) else {
        return false;
    };
    if info.dwCurrentState == SERVICE_STOPPED {
        return true;
    }
    // Poll every slice, but treat the stop as stalled only when the checkpoint
    // has not advanced for the service's whole wait hint (the documented SCM
    // pattern); one slice is a tenth of it and would misreport a slow, healthy
    // graceful helper shutdown.
    let mut previous_checkpoint = info.dwCheckPoint;
    let mut deadline = Instant::now() + stall_window(info.dwWaitHint);
    while info.dwCurrentState == SERVICE_STOP_PENDING {
        std::thread::sleep(wait_slice(info.dwWaitHint));
        info = match query_process_status(service) {
            Some(info) => info,
            None => return false,
        };
        if info.dwCurrentState == SERVICE_STOPPED {
            return true;
        }
        if info.dwCheckPoint > previous_checkpoint {
            // The service is making progress: extend the window by its own hint.
            previous_checkpoint = info.dwCheckPoint;
            deadline = Instant::now() + stall_window(info.dwWaitHint);
        } else if Instant::now() > deadline {
            return false; // stalled past its own wait hint
        }
    }
    info.dwCurrentState == SERVICE_STOPPED
}

/// Restart policy, matching Chrome Remote Desktop's host service: restart
/// after 60 s, at most three times, with the failure count reset daily.
///
/// Source (reference parity, the cited standard pattern): the Chrome Remote
/// Desktop host installer, upstream Chromium `remoting/host/win/chromoting.wxs`,
/// whose `util:ServiceConfig` restarts the host service on the first, second
/// and subsequent failures after 60 s with a 1-day failure-count reset.
const RESTART_DELAY_MS: u32 = 60_000;
const RESTART_ATTEMPTS: usize = 3;
const FAILURE_RESET_SECONDS: u32 = 24 * 60 * 60;

/// The SCM recovery actions and their reset period. Pure; unit-tested.
///
/// `SERVICE_FAILURE_ACTIONSW` (Microsoft Learn, Remarks): "When the service
/// fails for the Nth time, the service controller performs the action
/// specified in element [N-1] of the lpsaActions array. If N is greater than
/// cActions, the service controller repeats the last action in the array."
/// Three restarts alone would therefore restart every minute forever; the
/// trailing `SC_ACTION_NONE` is what makes the fourth and every later failure
/// (until the daily reset) leave the service stopped.
fn restart_policy() -> ([SC_ACTION; RESTART_ATTEMPTS + 1], u32) {
    let restart = SC_ACTION { Type: SC_ACTION_RESTART, Delay: RESTART_DELAY_MS };
    let stay_stopped = SC_ACTION { Type: SC_ACTION_NONE, Delay: 0 };
    ([restart, restart, restart, stay_stopped], FAILURE_RESET_SECONDS)
}

/// Configure SCM recovery with `ChangeServiceConfig2W` (Microsoft Learn):
/// - `SERVICE_CONFIG_FAILURE_ACTIONS` with `SERVICE_FAILURE_ACTIONSW`:
///   `dwResetPeriod` in seconds "after which to reset the failure count to
///   zero", one `SC_ACTION_RESTART` per attempt with its `Delay` in
///   milliseconds (the handle needs `SERVICE_START` access, which
///   `SERVICE_ALL_ACCESS` includes);
/// - `SERVICE_CONFIG_FAILURE_ACTIONS_FLAG` with
///   `fFailureActionsOnNonCrashFailures = TRUE`, so the actions also run when
///   the service reaches SERVICE_STOPPED with a non-zero exit code, not only
///   when its process dies without reporting SERVICE_STOPPED.
fn set_failure_actions(service: &ScHandle) -> Result<(), String> {
    let (mut actions, reset_seconds) = restart_policy();
    let failure_actions = SERVICE_FAILURE_ACTIONSW {
        dwResetPeriod: reset_seconds,
        lpRebootMsg: PWSTR::null(),
        lpCommand: PWSTR::null(),
        cActions: actions.len() as u32,
        lpsaActions: actions.as_mut_ptr(),
    };
    unsafe {
        ChangeServiceConfig2W(
            service.0,
            SERVICE_CONFIG_FAILURE_ACTIONS,
            Some(&failure_actions as *const SERVICE_FAILURE_ACTIONSW as *const _),
        )
    }
    .map_err(|error| format!("set the service failure actions: {error}"))?;
    let non_crash = SERVICE_FAILURE_ACTIONS_FLAG { fFailureActionsOnNonCrashFailures: true.into() };
    unsafe {
        ChangeServiceConfig2W(
            service.0,
            SERVICE_CONFIG_FAILURE_ACTIONS_FLAG,
            Some(&non_crash as *const SERVICE_FAILURE_ACTIONS_FLAG as *const _),
        )
    }
    .map_err(|error| format!("set the service failure-actions flag: {error}"))
}

/// The machine's Apps & Features entry for the installed service. Its
/// `UninstallString` runs the **protected copy** — the only `uninstall` left
/// once the app folder is gone (an unattended `/S` app uninstall never prompts
/// and so leaves the service) — and it lives under HKLM, writable only by
/// administrators, so a user cannot redirect it.
const APPS_ENTRY_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MixdogSecureDesktop";
/// The entry's name in Settings > Apps, the same as the exe's `FileDescription`
/// (build.rs) that the UAC prompt shows. Only a value: the key above never
/// depends on it, so an install or update rewrites it in place and uninstall
/// finds the entry under any earlier name.
const APPS_ENTRY_DISPLAY_NAME: &str = "Mixdog 원격 접근";
/// The argument the Apps & Features entry passes: the only `uninstall` that
/// asks for elevation itself (Settings launches entries unelevated). Every
/// other caller — the app uninstaller, scripts — passes plain `uninstall` and
/// is never prompted by the bridge.
const FROM_APPS_ARG: &str = "--from-apps";

/// A registry value of the Apps & Features entry.
#[derive(Debug, Clone, PartialEq, Eq)]
enum EntryValue {
    Text(String),
    Number(u32),
}

/// The Apps & Features entry's values ("Uninstall Registry Key", Microsoft
/// Learn). Pure; unit-tested.
fn apps_entry_values(bin_exe: &str, version: &str) -> Vec<(&'static str, EntryValue)> {
    vec![
        ("DisplayName", EntryValue::Text(APPS_ENTRY_DISPLAY_NAME.into())),
        ("DisplayVersion", EntryValue::Text(version.into())),
        ("Publisher", EntryValue::Text("Mixdog".into())),
        ("DisplayIcon", EntryValue::Text(format!("\"{bin_exe}\""))),
        ("UninstallString", EntryValue::Text(format!("\"{bin_exe}\" uninstall {FROM_APPS_ARG}"))),
        ("NoModify", EntryValue::Number(1)),
        ("NoRepair", EntryValue::Number(1)),
    ]
}

/// Write the Apps & Features entry (64-bit HKLM view).
fn write_apps_entry() -> Result<(), String> {
    let key_name = wide(APPS_ENTRY_KEY);
    let mut key = HKEY::default();
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(key_name.as_ptr()),
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            REG_SAM_FLAGS(KEY_WRITE.0 | KEY_WOW64_64KEY.0),
            None,
            &mut key,
            None,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("create the Apps & Features entry (error {})", status.0));
    }
    let result = apps_entry_values(&paths::bin_exe().to_string_lossy(), env!("CARGO_PKG_VERSION"))
        .into_iter()
        .try_for_each(|(name, value)| {
            let name_wide = wide(name);
            let (kind, data) = match &value {
                EntryValue::Text(text) => (REG_SZ, wide(text).iter().flat_map(|unit| unit.to_le_bytes()).collect::<Vec<u8>>()),
                EntryValue::Number(number) => (REG_DWORD, number.to_le_bytes().to_vec()),
            };
            let status = unsafe { RegSetValueExW(key, PCWSTR(name_wide.as_ptr()), None, kind, Some(&data)) };
            if status == ERROR_SUCCESS {
                Ok(())
            } else {
                Err(format!("write the Apps & Features entry's {name} (error {})", status.0))
            }
        });
    unsafe {
        let _ = RegCloseKey(key);
    }
    result
}

/// Remove the Apps & Features entry; an absent entry is success.
fn remove_apps_entry() -> Result<(), String> {
    let key_name = wide(APPS_ENTRY_KEY);
    let status = unsafe { RegDeleteTreeW(HKEY_LOCAL_MACHINE, PCWSTR(key_name.as_ptr())) };
    if status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        Err(format!("remove the Apps & Features entry (error {})", status.0))
    }
}

/// Whether this process runs with an elevated token.
fn process_is_elevated() -> Result<bool, String> {
    let mut token = HANDLE::default();
    unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }
        .map_err(|error| format!("open own token: {error}"))?;
    let token = OwnedHandle::new(token).ok_or("own token handle is invalid")?;
    let mut elevation = TOKEN_ELEVATION::default();
    let mut size = 0u32;
    unsafe {
        GetTokenInformation(
            token.get(),
            TokenElevation,
            Some(&mut elevation as *mut TOKEN_ELEVATION as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        )
    }
    .map_err(|error| format!("query own elevation: {error}"))?;
    Ok(elevation.TokenIsElevated != 0)
}

/// The Apps & Features path: Settings starts the entry unelevated, so ask for
/// elevation once — the user just chose "Uninstall" there — and run the plain
/// `uninstall` elevated from this same protected copy, waiting for it.
/// Returns its exit code, or `ERROR_CANCELLED` (1223) when the prompt was
/// declined.
fn uninstall_elevated_from_apps() -> i32 {
    const ERROR_CANCELLED: u32 = 1223;
    let image = match std::env::current_exe() {
        Ok(image) => image,
        Err(error) => return fail(&format!("resolve own image: {error}")),
    };
    let file = wide(&image.to_string_lossy());
    let verb = wide("runas");
    let parameters = wide("uninstall");
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
        lpVerb: PCWSTR(verb.as_ptr()),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(parameters.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    if let Err(error) = unsafe { ShellExecuteExW(&mut info) } {
        if is_win32_error(&error, ERROR_CANCELLED) {
            emit(json!({ "ok": false, "error": "the administrator prompt was declined" }));
            return ERROR_CANCELLED as i32;
        }
        return fail(&format!("run the elevated uninstall: {error}"));
    }
    let Some(process) = OwnedHandle::new(info.hProcess) else {
        return fail("the elevated uninstall has no process handle");
    };
    unsafe { WaitForSingleObject(process.get(), INFINITE) };
    let mut code = 0u32;
    match unsafe { GetExitCodeProcess(process.get(), &mut code) } {
        Ok(()) => code as i32,
        Err(error) => fail(&format!("read the elevated uninstall's exit code: {error}")),
    }
}

pub fn uninstall(args: &[String]) -> i32 {
    if args.iter().any(|arg| arg == FROM_APPS_ARG) {
        match process_is_elevated() {
            Ok(true) => {}
            Ok(false) => return uninstall_elevated_from_apps(),
            Err(error) => return fail(&error),
        }
    }
    uninstall_elevated()
}

fn uninstall_elevated() -> i32 {
    log::event("uninstall", "requested");
    let _lock = match acquire_install_lock() {
        InstallLock::Held(lock) => lock,
        refused => return lock_refused(refused),
    };
    uninstall_from(&mut ThisMachine)
}

/// What `uninstall` reads and removes, so its order — ownership before any
/// removal — is testable without the SCM.
trait UninstallTarget {
    /// The elevated caller's SID.
    fn caller_sid(&self) -> Result<String, String>;
    fn service_registered(&self) -> Result<bool, String>;
    /// The SID an existing install recorded.
    fn recorded_owner(&self) -> Option<String>;
    /// Stop and delete the service; an error (nothing else may be removed
    /// then) unless it is confirmed stopped and deleted, or absent.
    fn remove_service(&mut self) -> Result<(), String>;
    fn recover_software_sas(&mut self) -> Result<(), String>;
    fn remove_state_dir(&mut self, warnings: &mut Vec<String>) -> Result<(), String>;
    fn remove_apps_entry(&mut self) -> Result<(), String>;
}

/// The real service and state on this machine.
struct ThisMachine;

impl UninstallTarget for ThisMachine {
    fn caller_sid(&self) -> Result<String, String> {
        current_user_sid().map_err(|error| format!("cannot resolve user SID: {error}"))
    }
    fn service_registered(&self) -> Result<bool, String> {
        service_registered()
    }
    fn recorded_owner(&self) -> Option<String> {
        recorded_owner()
    }
    fn remove_service(&mut self) -> Result<(), String> {
        remove_service()
    }
    fn recover_software_sas(&mut self) -> Result<(), String> {
        recover_software_sas()
    }
    fn remove_state_dir(&mut self, warnings: &mut Vec<String>) -> Result<(), String> {
        let state = paths::state_dir();
        let unique = format!("{}-{}", std::process::id(), now_ms());
        let parking = parking_dir_for(&state, &unique)
            .ok_or_else(|| format!("{} has no parent directory", state.display()))?;
        let image = std::env::current_exe().ok();
        remove_tree_around_image(&mut RealRemovalFs, &state, image.as_deref(), &parking, warnings).map(|parked| {
            if let Some(parked) = parked {
                warnings.push(format!(
                    "the running uninstaller was moved to {} and is deleted at the next restart",
                    parked.display()
                ));
            }
        })
    }
    fn remove_apps_entry(&mut self) -> Result<(), String> {
        remove_apps_entry()
    }
}

/// The filesystem steps of removing the state tree, behind a trait so the
/// parking, cross-volume and failure paths are testable with a fake.
trait RemovalFs {
    /// Create a new, empty, admin-only directory; an existing one is an error.
    fn create_parking_dir(&mut self, dir: &Path) -> Result<(), String>;
    /// Rename on the same volume; never copies, so it fails across volumes.
    fn rename(&mut self, from: &Path, to: &Path) -> Result<(), String>;
    /// Remove a directory tree; a missing tree is success.
    fn remove_tree(&mut self, dir: &Path) -> Result<(), String>;
    fn remove_empty_dir(&mut self, dir: &Path) -> Result<(), String>;
    /// Register `path` for deletion at the next restart.
    fn delete_at_restart(&mut self, path: &Path) -> Result<(), String>;
}

/// SYSTEM and Administrators only, owner Administrators, nothing inherited
/// from the parent: the parking directory is created with it atomically.
const PARKING_DIR_SDDL: &str = "O:BAG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";

struct RealRemovalFs;

impl RemovalFs for RealRemovalFs {
    fn create_parking_dir(&mut self, dir: &Path) -> Result<(), String> {
        let descriptor = SecurityDescriptor::from_sddl(PARKING_DIR_SDDL).map_err(|error| error.to_string())?;
        let attributes = descriptor.attributes();
        let wide_dir = wide(&dir.to_string_lossy());
        // No "already exists" acceptance: the name is unique, so an existing
        // directory is someone else's and is never reused.
        unsafe { CreateDirectoryW(PCWSTR(wide_dir.as_ptr()), Some(&attributes)) }.map_err(|error| error.to_string())
    }
    fn rename(&mut self, from: &Path, to: &Path) -> Result<(), String> {
        let (wide_from, wide_to) = (wide(&from.to_string_lossy()), wide(&to.to_string_lossy()));
        // No MOVEFILE_COPY_ALLOWED: a move to another volume fails instead of
        // copying (and the running image could not be deleted after a copy).
        unsafe { MoveFileExW(PCWSTR(wide_from.as_ptr()), PCWSTR(wide_to.as_ptr()), MOVE_FILE_FLAGS(0)) }
            .map_err(|error| error.to_string())
    }
    fn remove_tree(&mut self, dir: &Path) -> Result<(), String> {
        remove_tree(dir)
    }
    fn remove_empty_dir(&mut self, dir: &Path) -> Result<(), String> {
        std::fs::remove_dir(dir).map_err(|error| error.to_string())
    }
    fn delete_at_restart(&mut self, path: &Path) -> Result<(), String> {
        let wide_path = wide(&path.to_string_lossy());
        unsafe { MoveFileExW(PCWSTR(wide_path.as_ptr()), PCWSTR::null(), MOVEFILE_DELAY_UNTIL_REBOOT) }
            .map_err(|error| error.to_string())
    }
}

/// The parking directory for an uninstall: a uniquely named sibling of the
/// state directory (`%ProgramData%\Mixdog\SecureDesktop.uninstalled-<unique>`).
/// Same parent directory as the image's tree, so the same volume, and under
/// the protected `%ProgramData%\Mixdog`. Pure; unit-tested.
fn parking_dir_for(state: &Path, unique: &str) -> Option<PathBuf> {
    let name = state.file_name()?.to_string_lossy();
    Some(state.parent()?.join(format!("{name}.uninstalled-{unique}")))
}

/// Join a primary error with the errors of its recovery steps.
fn with_recovery(error: String, recovery: impl IntoIterator<Item = Result<(), String>>) -> String {
    recovery
        .into_iter()
        .filter_map(Result::err)
        .fold(error, |message, problem| format!("{message}; {problem}"))
}

/// Remove the state tree. When the running image lives inside it (the Apps &
/// Features uninstall runs the protected copy itself), that image cannot be
/// deleted while it runs, but it can be renamed:
/// 1. create the unique, admin-only `parking` directory beside the tree;
/// 2. rename the image into it (same volume; the file keeps its own protected
///    DACL). If that fails — e.g. a different volume — nothing has been
///    removed and the tree stays whole;
/// 3. **at once** register the parked image, then its directory, for deletion
///    at restart (`MoveFileExW` + `MOVEFILE_DELAY_UNTIL_REBOOT`: "If
///    lpExistingFileName refers to a directory, the system removes the
///    directory at restart only if the directory is empty"; pending operations
///    run in the order registered, so the file goes first). If the image cannot
///    be scheduled it is moved back, so it is never left parked unscheduled;
/// 4. remove the tree, so a later `check` sees nothing installed. If that
///    fails the image is moved back where it was when possible, so the Apps &
///    Features entry (kept by the caller on any failure) still runs it.
///
/// Returns the parked path when it was used.
fn remove_tree_around_image(
    fs: &mut impl RemovalFs,
    state: &Path,
    image: Option<&Path>,
    parking: &Path,
    warnings: &mut Vec<String>,
) -> Result<Option<PathBuf>, String> {
    let Some(image) = image.filter(|image| is_within(state, image)) else {
        return fs.remove_tree(state).map(|()| None);
    };
    let file_name = image.file_name().ok_or("the running uninstaller has no file name")?;
    let parked = parking.join(file_name);
    let left_in_place = |error: String| format!("{error}; the install files were left in place");

    fs.create_parking_dir(parking)
        .map_err(|error| left_in_place(format!("create the parking directory {}: {error}", parking.display())))?;
    if let Err(error) = fs.rename(image, &parked) {
        let primary = format!("move the running uninstaller to {}: {error}", parked.display());
        return Err(left_in_place(with_recovery(primary, [remove_parking(fs, parking)])));
    }
    if let Err(error) = fs.delete_at_restart(&parked) {
        let primary = format!("schedule {} for deletion at restart: {error}", parked.display());
        let restored = restore_image(fs, &parked, image);
        let parking_removed = if restored.is_ok() { remove_parking(fs, parking) } else { Ok(()) };
        return Err(left_in_place(with_recovery(primary, [restored, parking_removed])));
    }
    if let Err(error) = fs.delete_at_restart(parking) {
        warnings.push(format!(
            "the empty admin-only directory {} is not deleted at restart: {error}",
            parking.display()
        ));
    }
    if let Err(error) = fs.remove_tree(state) {
        let primary = format!("remove {}: {error}", state.display());
        return Err(with_recovery(primary, [restore_image(fs, &parked, image)]));
    }
    Ok(Some(parked))
}

/// Whether `path` is `tree` or lies below it, compared the way Windows
/// compares file names.
///
/// Both are first canonicalized with `std::fs::canonicalize`, which on Windows
/// opens the file and returns `GetFinalPathNameByHandleW`'s final path, so 8.3
/// short names, `.`/`..` and links resolve the same way for both. Only when
/// both resolve are the canonical forms used (mixing a `\\?\` canonical form
/// with a plain one would never match); otherwise the given paths are
/// compared. Components are then compared on component boundaries with
/// `CompareStringOrdinal(..., bIgnoreCase = TRUE)` (Microsoft Learn, "Handling
/// Sorting in Your Applications": ordinal, case-insensitive comparison is the
/// one for file names, which NTFS matches with its upcase table, not a
/// linguistic or locale-dependent comparison).
fn is_within(tree: &Path, path: &Path) -> bool {
    let (tree, path) = match (std::fs::canonicalize(tree), std::fs::canonicalize(path)) {
        (Ok(tree), Ok(path)) => (tree, path),
        _ => (tree.to_path_buf(), path.to_path_buf()),
    };
    let mut path_components = path.components();
    tree.components().all(|component| {
        path_components.next().is_some_and(|other| {
            let left: Vec<u16> = component.as_os_str().encode_wide().collect();
            let right: Vec<u16> = other.as_os_str().encode_wide().collect();
            let result = unsafe { CompareStringOrdinal(&left, &right, true) };
            result == CSTR_EQUAL
        })
    })
}

/// Move a parked image back to where it ran from.
fn restore_image(fs: &mut impl RemovalFs, parked: &Path, image: &Path) -> Result<(), String> {
    fs.rename(parked, image).map_err(|error| {
        format!("the running uninstaller stays at {} and could not be moved back: {error}", parked.display())
    })
}

/// Remove the (empty) parking directory after a step failed.
fn remove_parking(fs: &mut impl RemovalFs, parking: &Path) -> Result<(), String> {
    fs.remove_empty_dir(parking)
        .map_err(|error| format!("remove the empty parking directory {}: {error}", parking.display()))
}

/// Remove a directory tree; a missing tree is success.
fn remove_tree(path: &Path) -> Result<(), String> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// The locked part of `uninstall`. Ownership is decided first, under the lock
/// and before anything is removed: another Windows account's install is
/// refused with [`EXIT_OTHER_USER`], exactly as `install` refuses it (the app
/// uninstaller's own `check` ran unelevated and outside the lock).
fn uninstall_from(target: &mut impl UninstallTarget) -> i32 {
    let sid = match target.caller_sid() {
        Ok(sid) => sid,
        Err(error) => return fail(&error),
    };
    let registered = match target.service_registered() {
        Ok(registered) => registered,
        Err(error) => return fail(&error),
    };
    if owned_by_other_user(registered, target.recorded_owner().as_deref(), &sid) {
        return refuse_other_user("uninstall");
    }

    let mut problems: Vec<String> = Vec::new();
    let service_removed = target.remove_service();

    // If the service was not confirmed stopped, or its registration could not
    // be removed, it may still run and must keep its binary: report an
    // incomplete cleanup and keep the SAS marker, the files and the uninstall
    // entry, rather than leaving a registered service pointing at a deleted
    // binary or recovering the SAS value under a live service.
    if let Err(ref error) = service_removed {
        log::event("uninstall", error);
        emit(json!({
            "ok": false,
            "error": error,
            "cleanup": Cleanup::Incomplete.label(),
            "warnings": problems,
        }));
        return 1;
    }

    // With the service stopped, resolve a SoftwareSASGeneration value it left
    // (a crash between setting and removing it) while its marker still exists;
    // if that fails, the state folder and the marker stay for a retry. The
    // Apps & Features entry goes only after the files are gone: while any file
    // cleanup fails it stays, so the removal can be retried from there.
    let leftovers = target
        .recover_software_sas()
        .and_then(|()| target.remove_state_dir(&mut problems))
        .and_then(|()| target.remove_apps_entry());
    let cleanup = cleanup_outcome(&service_removed, &leftovers, &mut problems);
    for problem in &problems {
        log::event("uninstall", problem);
    }
    match cleanup {
        Cleanup::Clean => emit(json!({ "ok": true, "installed": false, "running": false, "warnings": problems })),
        // The service is gone, but some files remain; distinct from a clean
        // not-installed so the leftover is never hidden.
        Cleanup::Incomplete => emit(json!({
            "ok": true,
            "installed": false,
            "running": false,
            "cleanup": Cleanup::Incomplete.label(),
            "warnings": problems,
        })),
    }
    0
}

/// Open the service read-only and report installed / running / version.
pub fn status() -> i32 {
    let version = std::fs::read_to_string(paths::state_file())
        .ok()
        .and_then(|text| InstallState::from_json(&text).ok())
        .map(|state| state.product_version);

    let manager = match unsafe { OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT) }
    {
        Ok(manager) => ScHandle(manager),
        Err(error) => return fail(&format!("open SCM: {error}")),
    };
    let name = wide(paths::SERVICE_NAME);
    let service = match unsafe { OpenServiceW(manager.0, PCWSTR(name.as_ptr()), SERVICE_QUERY_STATUS) }
    {
        // Not installed is a normal, expected answer.
        Err(error) if is_win32_error(&error, ERROR_SERVICE_DOES_NOT_EXIST) => {
            emit(json!({ "ok": true, "installed": false, "running": false, "version": version }));
            return 0;
        }
        // Any other open error is a real fault, reported as such.
        Err(error) => return fail(&format!("open service: {error}")),
        Ok(service) => ScHandle(service),
    };

    let running = query_process_status(&service)
        .is_some_and(|status| status.dwCurrentState == SERVICE_RUNNING);

    emit(json!({ "ok": true, "installed": true, "running": running, "version": version }));
    0
}

/// How the on-disk install state reads for the *current* user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StateStatus {
    /// Present, parseable, and enrolls the requesting phone's key (any key
    /// when the check names none).
    Valid,
    /// Present and parseable, but enrolls no controller key (an install from
    /// before control grants) or a different phone's key than the one asking:
    /// the helper would refuse that phone's input, so it needs an update.
    Unenrolled,
    /// Present but not parseable (corruption, wrong schema).
    Invalid,
    /// No state file.
    Missing,
    /// Present but this user is denied read — the hallmark of an install owned
    /// by a different Windows account (the state DACL grants only the
    /// installing user read).
    AccessDenied,
}

/// What `check` found, as the installer's decision input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallCheck {
    /// Registered, state readable, and the protected copy is this binary.
    Current,
    /// Neither a registration nor any state: nothing to install over or remove.
    Missing,
    /// Anything in between for *this* user: an older binary, unreadable/invalid
    /// state, or a partial install. `install` repairs it; `uninstall` removes it.
    Stale,
    /// Registered, but owned by a different Windows account (its state is
    /// readable only by that user). A request must not silently take it over.
    OtherUser,
    /// Installed and current, but the requesting phone's key is not enrolled:
    /// an `enroll` adds it (no reinstall). Only ever returned when `check` was
    /// given `--controller-key`.
    NotEnrolled,
}

impl InstallCheck {
    /// Exit codes the installer branches on: 0 current, 1 missing, 2 stale,
    /// 4 other-user, 7 not-enrolled (3 is reserved for "could not determine",
    /// see [`check`]).
    fn exit_code(self) -> i32 {
        match self {
            InstallCheck::Current => 0,
            InstallCheck::Missing => 1,
            InstallCheck::Stale => 2,
            InstallCheck::OtherUser => 4,
            InstallCheck::NotEnrolled => EXIT_NOT_ENROLLED,
        }
    }

    fn label(self) -> &'static str {
        match self {
            InstallCheck::Current => "current",
            InstallCheck::Missing => "missing",
            InstallCheck::Stale => "stale",
            InstallCheck::OtherUser => "other-user",
            InstallCheck::NotEnrolled => "not-enrolled",
        }
    }
}

/// The pure decision behind `check`. "Current" is a byte-for-byte match of the
/// protected copy with the binary being run, so any bridge change shipped by an
/// app update is reinstalled without relying on a version bump. A registered
/// service whose state this user cannot read is another account's install.
fn install_check(
    service_registered: bool,
    state: StateStatus,
    state_dir_present: bool,
    binary_matches: bool,
) -> InstallCheck {
    match state {
        StateStatus::AccessDenied if service_registered => InstallCheck::OtherUser,
        _ if !service_registered && !state_dir_present => InstallCheck::Missing,
        StateStatus::Valid if service_registered && binary_matches => InstallCheck::Current,
        // Installed and current, but this phone's key is not enrolled: the
        // helper only needs that one key added, not a reinstall.
        StateStatus::Unenrolled if service_registered && binary_matches => InstallCheck::NotEnrolled,
        _ => InstallCheck::Stale,
    }
}

/// Whether a parsed state enrolls a controller key, and the requesting phone's
/// key when one is named (compared as decoded points). Pure; unit-tested.
fn enrollment_status(state: &InstallState, requested: Option<&str>) -> StateStatus {
    match requested {
        Some(key) if state.is_key_enrolled(key) => StateStatus::Valid,
        Some(_) => StateStatus::Unenrolled,
        None if state.controller_keys_bytes().is_empty() => StateStatus::Unenrolled,
        None => StateStatus::Valid,
    }
}

/// Read the install state's status for this user (present/parseable, invalid,
/// missing, or denied).
fn read_state_status(requested_key: Option<&str>) -> StateStatus {
    match std::fs::read_to_string(paths::state_file()) {
        Ok(text) => match InstallState::from_json(&text) {
            Ok(state) => enrollment_status(&state, requested_key),
            Err(_) => StateStatus::Invalid,
        },
        Err(error) => match error.kind() {
            std::io::ErrorKind::NotFound => StateStatus::Missing,
            std::io::ErrorKind::PermissionDenied => StateStatus::AccessDenied,
            _ => StateStatus::Invalid,
        },
    }
}

/// Unelevated check of whether the installed service matches this binary.
/// Prints `{"ok":true,"check":"current|missing|stale|other-user|not-enrolled"}`
/// and exits 0/1/2/4/7; any failure to determine it prints an error and exits 3, which the
/// installer treats like "not current".
pub fn check(args: &[String]) -> i32 {
    const UNDETERMINED: i32 = 3;
    let requested_key = match controller_key_arg(args) {
        Ok(key) => key,
        Err(error) => {
            fail(&error);
            return UNDETERMINED;
        }
    };
    let registered = match open_manager(SC_MANAGER_CONNECT)
        .and_then(|manager| open_service(&manager, SERVICE_QUERY_STATUS))
    {
        Ok(service) => service.is_some(),
        Err(error) => {
            fail(&error);
            return UNDETERMINED;
        }
    };
    let state = read_state_status(requested_key.as_deref());
    let binary_matches = match (std::env::current_exe(), std::fs::read(paths::bin_exe())) {
        (Ok(current), Ok(installed)) => std::fs::read(current).is_ok_and(|bytes| bytes == installed),
        _ => false,
    };
    let outcome = install_check(registered, state, paths::state_dir().exists(), binary_matches);
    emit(json!({ "ok": true, "check": outcome.label() }));
    outcome.exit_code()
}

/// A service's progress as the SCM reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ServiceProgress {
    state: SERVICE_STATUS_CURRENT_STATE,
    checkpoint: u32,
    wait_hint: u32,
}

impl ServiceProgress {
    fn of(status: &SERVICE_STATUS_PROCESS) -> Self {
        ServiceProgress {
            state: status.dwCurrentState,
            checkpoint: status.dwCheckPoint,
            wait_hint: status.dwWaitHint,
        }
    }
}

/// Where following a start ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StartWait {
    Running,
    /// Left START_PENDING for a state other than running (e.g. it stopped).
    Settled(SERVICE_STATUS_CURRENT_STATE),
    /// Still START_PENDING with no checkpoint progress for its whole wait hint.
    Stalled,
    QueryFailed,
}

/// Follow a start to `SERVICE_RUNNING` or a terminal state, exactly as the
/// documented SCM pattern does (Microsoft Learn "Starting a Service",
/// `DoStartSvc`): poll every slice of the wait hint, restart the stall timer
/// whenever the checkpoint advances, and give up when it has not advanced
/// within the wait hint. The pattern has no overall cap, so neither does this:
/// a service that keeps reporting progress is followed; for this crate's
/// service the bound is [`service_start_bound`]. Elapsed time is
/// measured on `now`; clock and sleep are injected so tests drive a fake clock.
fn wait_until_running(
    mut query: impl FnMut() -> Option<ServiceProgress>,
    mut sleep: impl FnMut(Duration),
    mut now: impl FnMut() -> Instant,
) -> StartWait {
    let Some(mut progress) = query() else {
        return StartWait::QueryFailed;
    };
    let mut checkpoint = progress.checkpoint;
    let mut progressed_at = now();
    while progress.state == SERVICE_START_PENDING {
        sleep(wait_slice(progress.wait_hint));
        progress = match query() {
            Some(progress) => progress,
            None => return StartWait::QueryFailed,
        };
        let at = now();
        if progress.checkpoint > checkpoint {
            checkpoint = progress.checkpoint;
            progressed_at = at;
        } else if progress.state == SERVICE_START_PENDING
            && at.saturating_duration_since(progressed_at) > stall_window(progress.wait_hint)
        {
            return StartWait::Stalled;
        }
    }
    if progress.state == SERVICE_RUNNING {
        StartWait::Running
    } else {
        StartWait::Settled(progress.state)
    }
}

/// Why a followed start did not reach running; `None` when it did.
fn start_failure(outcome: StartWait) -> Option<String> {
    match outcome {
        StartWait::Running => None,
        StartWait::Settled(state) => Some(format!("the service settled in state {} instead of running", state.0)),
        StartWait::Stalled => Some("the service stopped making start progress within its wait hint".into()),
        StartWait::QueryFailed => Some("the service status could not be queried".into()),
    }
}

/// Start the already-installed service without elevation. The install granted
/// the installing user start/stop/query on the service, so this needs no UAC —
/// it is how the app brings a demand-start service back up after a reboot when
/// a remote session needs it. A normal start passes through START_PENDING, so
/// this follows it to RUNNING or a terminal state (bounded) before answering.
/// Prints `{installed, running}` and exits 0 when the service is running,
/// non-zero (with the reason) otherwise.
pub fn start() -> i32 {
    let manager = match open_manager(SC_MANAGER_CONNECT) {
        Ok(manager) => manager,
        Err(error) => return fail(&error),
    };
    let service = match open_service(&manager, SERVICE_START | SERVICE_QUERY_STATUS) {
        Ok(Some(service)) => service,
        Ok(None) => {
            emit(json!({ "ok": true, "installed": false, "running": false }));
            return 1;
        }
        Err(error) => return fail(&error),
    };

    let already_running =
        query_process_status(&service).is_some_and(|s| s.dwCurrentState == SERVICE_RUNNING);
    if !already_running {
        if let Err(error) = unsafe { StartServiceW(service.0, None) } {
            // ERROR_SERVICE_ALREADY_RUNNING (1056) is success: another caller
            // won the race. Anything else is a real failure.
            const ERROR_SERVICE_ALREADY_RUNNING: u32 = 1056;
            if !is_win32_error(&error, ERROR_SERVICE_ALREADY_RUNNING) {
                return fail(&format!("start service: {error}"));
            }
        }
    }

    let outcome = wait_until_running(
        || query_process_status(&service).map(|status| ServiceProgress::of(&status)),
        std::thread::sleep,
        Instant::now,
    );
    match start_failure(outcome) {
        None => {
            emit(json!({ "ok": true, "installed": true, "running": true }));
            0
        }
        Some(error) => {
            emit(json!({ "ok": false, "installed": true, "running": false, "error": error }));
            1
        }
    }
}

/// Unelevated: run the verification `install` applies to its source image —
/// without a path, to this running image (the release workflow runs it on the
/// packaged, signed helper; the app runs it before asking for elevation);
/// with a path, to that file. Read-only; exits 0 when it would be accepted,
/// [`EXIT_UNTRUSTED_IMAGE`] / [`EXIT_REVOCATION_UNKNOWN`] with the reason
/// otherwise.
pub fn verify_image(args: &[String]) -> i32 {
    let result = match args.first() {
        Some(path) => signature::verify_file(Path::new(path)),
        None => signature::verify_own_image(),
    };
    match result {
        Ok(verified) => {
            emit(json!({ "ok": true, "signer": verified.subject }));
            0
        }
        Err(refusal) => refuse_image(&refusal),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh, uniquely named directory under `%TEMP%` (`create_dir` fails if
    /// it exists, so nothing pre-existing is ever reused or cleared).
    fn unique_temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("mixdog-sd-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir(&dir).unwrap();
        dir
    }

    /// The DACL of `path` as SDDL, read back from disk.
    fn dacl_sddl(path: &Path) -> String {
        use windows::Win32::Foundation::{LocalFree, HLOCAL};
        use windows::Win32::Security::Authorization::{
            ConvertSecurityDescriptorToStringSecurityDescriptorW, GetNamedSecurityInfoW, SDDL_REVISION_1,
            SE_FILE_OBJECT,
        };
        use windows::Win32::Security::PSECURITY_DESCRIPTOR;
        let wide_path = wide(&path.to_string_lossy());
        unsafe {
            let mut descriptor = PSECURITY_DESCRIPTOR::default();
            let status = GetNamedSecurityInfoW(
                PCWSTR(wide_path.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                None,
                None,
                None,
                None,
                &mut descriptor,
            );
            assert_eq!(status, ERROR_SUCCESS);
            let mut text = PWSTR::null();
            ConvertSecurityDescriptorToStringSecurityDescriptorW(
                descriptor,
                SDDL_REVISION_1,
                DACL_SECURITY_INFORMATION,
                &mut text,
                None,
            )
            .unwrap();
            let sddl = text.to_string().unwrap();
            let _ = LocalFree(Some(HLOCAL(text.0 as *mut _)));
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            sddl
        }
    }

    #[test]
    fn a_state_temp_is_created_new_with_its_final_dacl_and_leftovers_are_removed() {
        let dir = unique_temp_dir("state");
        let user = current_user_sid().unwrap();
        // The final, protected DACL (the user keeps full access only so the
        // test can clean up; the real state grants it FR).
        let sddl = format!("D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;{user})");
        let temp = dir.join(STATE_TEMP_NAME);
        create_protected_file(&temp, b"{\"x\":1}", &sddl).unwrap();
        assert_eq!(std::fs::read(&temp).unwrap(), b"{\"x\":1}");
        // Born with exactly that descriptor: protected, nothing inherited from %TEMP%.
        assert_eq!(dacl_sddl(&temp), sddl);
        // CREATE_NEW: a pre-existing (possibly pre-planted) file is never reused.
        assert!(create_protected_file(&temp, b"other", &sddl).is_err());
        assert_eq!(std::fs::read(&temp).unwrap(), b"{\"x\":1}");
        // A crash's leftovers (this name and an earlier build's) go on the next
        // locked write; the live state file and unrelated files are kept.
        std::fs::write(dir.join("state.4242.tmp"), b"old").unwrap();
        std::fs::write(dir.join("state.json"), b"live").unwrap();
        std::fs::write(dir.join("other.tmp"), b"keep").unwrap();
        remove_leftover_state_temps(&dir).unwrap();
        assert!(!temp.exists() && !dir.join("state.4242.tmp").exists());
        assert!(dir.join("state.json").exists() && dir.join("other.tmp").exists());
        // The replace swaps in a whole new file.
        create_protected_file(&temp, b"new", &sddl).unwrap();
        atomic_replace(&temp, &dir.join("state.json")).unwrap();
        assert_eq!(std::fs::read(dir.join("state.json")).unwrap(), b"new");
        assert!(!temp.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_state_temp_names_are_leftovers() {
        assert!(is_state_temp_name(STATE_TEMP_NAME));
        assert!(is_state_temp_name("state.1234.tmp"));
        assert!(!is_state_temp_name("state.json"));
        assert!(!is_state_temp_name("other.tmp"));
        assert!(!is_state_temp_name("sas-policy-marker.json"));
    }

    #[test]
    fn check_reports_missing_only_when_nothing_is_left() {
        assert_eq!(install_check(false, StateStatus::Missing, false, false), InstallCheck::Missing);
        assert_eq!(install_check(false, StateStatus::Missing, false, false).exit_code(), 1);
        // A leftover state directory without a registration still needs the
        // elevated step (install repairs it, uninstall removes it).
        assert_eq!(install_check(false, StateStatus::Valid, true, true), InstallCheck::Stale);
    }

    #[test]
    fn check_reports_current_only_for_a_complete_matching_install() {
        assert_eq!(install_check(true, StateStatus::Valid, true, true), InstallCheck::Current);
        assert_eq!(install_check(true, StateStatus::Valid, true, true).exit_code(), 0);
    }

    #[test]
    fn check_reports_stale_for_a_different_binary_or_unusable_state() {
        // An app update that ships a different bridge binary.
        assert_eq!(install_check(true, StateStatus::Valid, true, false), InstallCheck::Stale);
        // State invalid/corrupt.
        assert_eq!(install_check(true, StateStatus::Invalid, true, true), InstallCheck::Stale);
        // Registered, but the state directory is gone.
        assert_eq!(install_check(true, StateStatus::Missing, false, false), InstallCheck::Stale);
        assert_eq!(install_check(true, StateStatus::Valid, true, false).exit_code(), 2);
    }

    #[test]
    fn check_reports_other_user_for_a_registered_install_whose_state_is_denied() {
        // Registered + state unreadable (denied) by this account = another
        // user's install; a request must not silently take it over.
        assert_eq!(install_check(true, StateStatus::AccessDenied, true, false), InstallCheck::OtherUser);
        assert_eq!(install_check(true, StateStatus::AccessDenied, true, false).exit_code(), 4);
        // Denied state with no registration is not "other-user": nothing owns
        // the machine's SCM slot, so install can repair it.
        assert_eq!(install_check(false, StateStatus::AccessDenied, true, false), InstallCheck::Stale);
    }

    /// A valid controller key: base64url of an uncompressed P-256 point.
    fn controller_key(fill: u8) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([&[4u8][..], &[fill; 64][..]].concat())
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn install_collects_zero_or_more_controller_keys_and_refuses_invalid_ones() {
        // Zero keys is allowed now (the helper installs but refuses input
        // until a key is enrolled).
        assert_eq!(collect_controller_keys(&args(&[])), Ok(vec![]));
        assert_eq!(collect_controller_keys(&args(&["--controller-key"])).is_err(), true);
        assert_eq!(collect_controller_keys(&args(&["--controller-key", "not-a-key"])).is_err(), true);
        let compressed = {
            use base64::Engine as _;
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([&[2u8][..], &[7u8; 32][..]].concat())
        };
        assert!(collect_controller_keys(&args(&["--controller-key", &compressed])).is_err());
        // Several valid keys collect in order.
        let (a, b) = (controller_key(7), controller_key(9));
        assert_eq!(
            collect_controller_keys(&args(&["--controller-key", &a, "--controller-key", &b])),
            Ok(vec![a.clone(), b.clone()])
        );
        // `--revoke-key` collects the pending revokes enroll applies.
        assert_eq!(collect_revoke_keys(&args(&["--revoke-key", &a, "--revoke-key", &b])), Ok(vec![a, b]));
        assert!(collect_revoke_keys(&args(&["--revoke-key", "nope"])).is_err());
        assert_eq!(collect_revoke_keys(&args(&[])), Ok(vec![]));
    }

    #[test]
    fn install_writes_every_enrolled_key_into_the_state() {
        let (a, b) = (controller_key(7), controller_key(9));
        let state = install_state_for("S-1-5-21-1-2-3-1001", &[a.clone(), b.clone()], 1).unwrap();
        let parsed = InstallState::from_json(&state.to_json()).unwrap();
        assert!(parsed.is_key_enrolled(&a) && parsed.is_key_enrolled(&b));
        assert_eq!(enrollment_status(&parsed, Some(&a)), StateStatus::Valid);
        // A zero-key install parses and reads unenrolled.
        let empty = install_state_for("S-1-5-21-1-2-3-1001", &[], 1).unwrap();
        assert_eq!(enrollment_status(&empty, None), StateStatus::Unenrolled);
        assert!(install_state_for("S-1-5-21-1-2-3-1001", &["bad".into()], 1).is_err());
    }

    #[test]
    fn a_current_install_without_any_key_only_needs_an_enroll() {
        // A zero-key install is current but enrolls nobody: the answer is
        // not-enrolled (add a key), never a reinstall; a different binary is
        // still stale.
        let bare = InstallState::new("0.1.0", "S-1-5-21-1-2-3-1001", paths::PIPE_NAME, 0);
        assert_eq!(enrollment_status(&bare, None), StateStatus::Unenrolled);
        assert_eq!(enrollment_status(&bare, Some(&controller_key(7))), StateStatus::Unenrolled);
        let outcome = install_check(true, enrollment_status(&bare, None), true, true);
        assert_eq!((outcome, outcome.exit_code()), (InstallCheck::NotEnrolled, 7));
        let outcome = install_check(true, enrollment_status(&bare, None), true, false);
        assert_eq!((outcome, outcome.exit_code()), (InstallCheck::Stale, 2));
    }

    #[test]
    fn a_phone_whose_key_is_not_enrolled_is_offered_enroll_not_a_reinstall() {
        // Two phones enrolled; a third asks.
        let (a, b, c) = (controller_key(7), controller_key(9), controller_key(11));
        let installed = install_state_for("S-1-5-21-1-2-3-1001", &[a.clone(), b.clone()], 1).unwrap();
        // Either enrolled phone (or a check naming none) is current…
        assert_eq!(install_check(true, enrollment_status(&installed, Some(&a)), true, true).exit_code(), 0);
        assert_eq!(install_check(true, enrollment_status(&installed, Some(&b)), true, true).exit_code(), 0);
        assert_eq!(install_check(true, enrollment_status(&installed, None), true, true).exit_code(), 0);
        // …the third sees not-enrolled (exit 7: add my key), not stale…
        assert_eq!(
            install_check(true, enrollment_status(&installed, Some(&c)), true, true),
            InstallCheck::NotEnrolled
        );
        assert_eq!(install_check(true, enrollment_status(&installed, Some(&c)), true, true).exit_code(), 7);
        // …but a different *binary* is still stale for that phone (reinstall).
        assert_eq!(install_check(true, enrollment_status(&installed, Some(&c)), true, false).exit_code(), 2);
    }

    #[test]
    fn enroll_and_revoke_add_and_remove_only_their_own_key() {
        let (a, b) = (controller_key(7), controller_key(9));
        let mut state = install_state_for("S-1-5-21-1-2-3-1001", &[a.clone()], 1).unwrap();
        assert_eq!(state.enroll_key(&b), Ok(true));
        assert!(state.is_key_enrolled(&a) && state.is_key_enrolled(&b));
        assert!(state.revoke_key(&a));
        assert!(!state.is_key_enrolled(&a) && state.is_key_enrolled(&b));
    }

    #[test]
    fn a_disable_or_signer_change_fails_the_under_lock_delegation_recheck() {
        let expected = signature::SignerPolicy {
            subject: "CN=TRIBGAMES".into(),
            profile_eku: "1.3.6.1.4.1.311.97.1.2.3".into(),
        };
        let mut state = InstallState::new("0.1.0", "S-1-5-21-1-2-3-1001", paths::PIPE_NAME, 0);
        state.enable_delegation(&expected.subject, &expected.profile_eku);
        assert!(delegation_still_authorized(&state, &expected), "enabled + matching signer");
        // A security disable that lands during an in-flight request fails the recheck.
        state.disable_delegation();
        assert!(!delegation_still_authorized(&state, &expected), "a disable is honored");
        // A changed authorized signer fails it too.
        let mut changed = InstallState::new("0.1.0", "S-1-5-21-1-2-3-1001", paths::PIPE_NAME, 0);
        changed.enable_delegation("CN=OTHER", &expected.profile_eku);
        assert!(!delegation_still_authorized(&changed, &expected), "a signer change is honored");
    }

    #[test]
    fn enroll_and_revoke_require_the_elevated_or_logon_path() {
        // The admin-gated ops take the install lock first; an unelevated
        // process cannot (its Administrators SID is deny-only), so no
        // unelevated path can add or remove a key. When the test process is
        // elevated the lock would succeed and touch real state, so only the
        // unelevated case is asserted (the lock itself is covered elsewhere).
        if process_is_elevated().expect("query own elevation") {
            return;
        }
        let key = controller_key(7);
        assert_eq!(enroll(&args(&["--controller-key", &key])), 1, "unelevated enroll is refused at the lock");
        assert_eq!(revoke(&args(&["--controller-key", &key])), 1, "unelevated revoke is refused at the lock");
    }

    #[test]
    fn rollback_is_clean_only_when_both_removals_succeed() {
        let mut problems = Vec::new();
        assert_eq!(cleanup_outcome(&Ok(()), &Ok(()), &mut problems), Cleanup::Clean);
        assert!(problems.is_empty());
    }

    #[test]
    fn rollback_keeps_files_and_reports_incomplete_when_the_service_cannot_be_removed() {
        // The files may only be deleted once the registration is gone.
        assert!(!may_remove_files(&Err("delete service: denied".into())));
        assert!(may_remove_files(&Ok(())));

        let mut problems = Vec::new();
        let service_removed: Result<(), String> = Err("delete service: denied".into());
        // Files are kept in place (not attempted) when the service remains.
        let files_removed: Result<(), String> = Err(FILES_KEPT_FOR_SERVICE.into());
        assert_eq!(
            cleanup_outcome(&service_removed, &files_removed, &mut problems),
            Cleanup::Incomplete
        );
        assert!(problems.iter().any(|p| p.contains("service removal failed")));
        assert!(problems.iter().any(|p| p.contains("state removal failed")));
    }

    #[test]
    fn rollback_reports_incomplete_when_only_file_removal_fails() {
        let mut problems = Vec::new();
        let outcome = cleanup_outcome(&Ok(()), &Err("state removal failed: busy".into()), &mut problems);
        assert_eq!(outcome, Cleanup::Incomplete);
        assert_eq!(problems.len(), 1);
        assert!(problems[0].contains("state removal failed"));
    }

    #[test]
    fn dir_chain_walks_every_missing_level_below_the_base() {
        let base = Path::new(r"C:\ProgramData");
        let leaf = Path::new(r"C:\ProgramData\Mixdog\SecureDesktop\bin");
        let chain = protected_dir_chain(base, leaf).unwrap();
        assert_eq!(
            chain,
            vec![
                PathBuf::from(r"C:\ProgramData\Mixdog"),
                PathBuf::from(r"C:\ProgramData\Mixdog\SecureDesktop"),
                PathBuf::from(r"C:\ProgramData\Mixdog\SecureDesktop\bin"),
            ]
        );
    }

    #[test]
    fn dir_chain_never_includes_the_preexisting_base() {
        let base = Path::new(r"C:\ProgramData");
        // Even when leaf == base, the shared base is never returned for
        // (re-)permissioning.
        assert!(protected_dir_chain(base, base).unwrap().is_empty());
        // The real install target's first created level is %ProgramData%\Mixdog.
        let chain = protected_dir_chain(base, Path::new(r"C:\ProgramData\Mixdog")).unwrap();
        assert_eq!(chain, vec![PathBuf::from(r"C:\ProgramData\Mixdog")]);
    }

    #[test]
    fn dir_chain_rejects_a_leaf_outside_the_base() {
        let base = Path::new(r"C:\ProgramData");
        assert!(protected_dir_chain(base, Path::new(r"C:\Windows\Temp")).is_err());
    }

    #[test]
    fn install_refuses_only_a_registration_recorded_for_another_account() {
        let me = "S-1-5-21-1-2-3-1001";
        let other = "S-1-5-21-1-2-3-1002";
        assert!(owned_by_other_user(true, Some(other), me));
        assert!(!owned_by_other_user(true, Some(me), me));
        assert!(!owned_by_other_user(true, Some(&me.to_lowercase()), me));
        // No registration: another account's leftover state is repaired.
        assert!(!owned_by_other_user(false, Some(other), me));
        // Registered without a readable state: no owner is left to protect.
        assert!(!owned_by_other_user(true, None, me));
    }

    #[test]
    fn the_install_lock_is_exclusive_and_cannot_be_squatted_without_elevation() {
        let elevated = process_is_elevated().expect("query own elevation");
        match acquire_install_lock() {
            InstallLock::Held(first) => {
                assert!(elevated, "an unelevated process must not be able to create (squat) the install lock");
                assert!(matches!(acquire_install_lock(), InstallLock::Busy), "a second install sees it busy");
                drop(first);
                assert!(matches!(acquire_install_lock(), InstallLock::Held(_)), "closing it releases it");
            }
            InstallLock::Denied => {
                assert!(!elevated, "an elevated administrator must be able to take the install lock")
            }
            InstallLock::Busy => panic!("the install lock is busy with no install running"),
            InstallLock::Error(error) => panic!("install lock: {error}"),
        }
    }

    fn progress(state: SERVICE_STATUS_CURRENT_STATE, checkpoint: u32) -> ServiceProgress {
        ServiceProgress { state, checkpoint, wait_hint: 2000 }
    }

    /// Answers `states` in order, then repeats the last one.
    fn replay(states: Vec<ServiceProgress>) -> impl FnMut() -> Option<ServiceProgress> {
        let mut index = 0;
        move || {
            let state = states[index.min(states.len() - 1)];
            index += 1;
            Some(state)
        }
    }

    /// Run the waiter on a fake clock that only the injected sleep advances;
    /// returns the outcome and every slice slept.
    fn wait_on_fake_clock(query: impl FnMut() -> Option<ServiceProgress>) -> (StartWait, Vec<Duration>) {
        let clock = std::cell::Cell::new(Instant::now());
        let slept = std::cell::RefCell::new(Vec::new());
        let outcome = wait_until_running(
            query,
            |slice| {
                clock.set(clock.get() + slice);
                slept.borrow_mut().push(slice);
            },
            || clock.get(),
        );
        (outcome, slept.into_inner())
    }

    #[test]
    fn start_follows_start_pending_to_running() {
        let (outcome, slept) = wait_on_fake_clock(
            replay(vec![
                progress(SERVICE_START_PENDING, 1),
                progress(SERVICE_START_PENDING, 2),
                progress(SERVICE_RUNNING, 0),
            ]),
        );
        assert_eq!(outcome, StartWait::Running);
        // One slice per pending poll: a tenth of the 2 s hint, clamped to 1 s.
        assert_eq!(slept, vec![Duration::from_secs(1); 2]);
    }

    #[test]
    fn the_poll_slice_is_a_tenth_of_the_hint_within_one_and_ten_seconds() {
        assert_eq!(wait_slice(0), Duration::from_secs(1));
        assert_eq!(wait_slice(30_000), Duration::from_secs(3));
        assert_eq!(wait_slice(600_000), Duration::from_secs(10));
        assert_eq!(stall_window(2_000), Duration::from_secs(2));
    }

    #[test]
    fn a_start_that_keeps_progressing_is_followed_like_the_documented_pattern() {
        // No overall cap: 100 progressing polls (100 s), then running.
        let mut polls = 0;
        let (outcome, slept) = wait_on_fake_clock(move || {
            polls += 1;
            Some(if polls > 100 { progress(SERVICE_RUNNING, 0) } else { progress(SERVICE_START_PENDING, polls) })
        });
        assert_eq!(outcome, StartWait::Running);
        assert_eq!(slept.iter().sum::<Duration>(), Duration::from_secs(100));
    }

    #[test]
    fn start_reports_an_already_running_service_without_waiting() {
        let (outcome, slept) = wait_on_fake_clock(replay(vec![progress(SERVICE_RUNNING, 0)]));
        assert_eq!(outcome, StartWait::Running);
        assert!(slept.is_empty());
    }

    #[test]
    fn start_reports_a_service_that_stops_instead_of_running() {
        let (outcome, _) = wait_on_fake_clock(
            replay(vec![progress(SERVICE_START_PENDING, 1), progress(SERVICE_STOPPED, 0)]),
        );
        assert_eq!(outcome, StartWait::Settled(SERVICE_STOPPED));
    }

    #[test]
    fn start_gives_up_when_the_checkpoint_stalls_past_the_wait_hint() {
        let (outcome, slept) = wait_on_fake_clock(replay(vec![progress(SERVICE_START_PENDING, 1)]));
        assert_eq!(outcome, StartWait::Stalled);
        // Stalled once more than the whole 2 s hint passed without progress.
        assert_eq!(slept.iter().sum::<Duration>(), Duration::from_secs(3));
    }

    #[test]
    fn start_reports_a_failed_status_query() {
        assert_eq!(wait_on_fake_clock(|| None).0, StartWait::QueryFailed);
    }

    /// An in-memory machine for `uninstall_from`, recording what was removed.
    struct FakeMachine {
        caller: &'static str,
        registered: bool,
        owner: Option<&'static str>,
        removed_service: bool,
        removed_files: bool,
        removed_entry: bool,
        files_fail: bool,
        sas_fail: bool,
        /// The stop never confirms SERVICE_STOPPED.
        stop_unconfirmed: bool,
        /// Removal steps in the order they ran.
        steps: Vec<&'static str>,
    }

    impl FakeMachine {
        fn new(registered: bool, owner: Option<&'static str>) -> Self {
            FakeMachine {
                caller: ME,
                registered,
                owner,
                removed_service: false,
                removed_files: false,
                removed_entry: false,
                files_fail: false,
                sas_fail: false,
                stop_unconfirmed: false,
                steps: Vec::new(),
            }
        }
    }

    impl UninstallTarget for FakeMachine {
        fn caller_sid(&self) -> Result<String, String> {
            Ok(self.caller.into())
        }
        fn service_registered(&self) -> Result<bool, String> {
            Ok(self.registered)
        }
        fn recorded_owner(&self) -> Option<String> {
            self.owner.map(str::to_string)
        }
        fn remove_service(&mut self) -> Result<(), String> {
            self.steps.push("stop+delete service");
            let removed_service = &mut self.removed_service;
            delete_after_confirmed_stop(!self.stop_unconfirmed, || {
                *removed_service = true;
                Ok(())
            })
        }
        fn recover_software_sas(&mut self) -> Result<(), String> {
            self.steps.push("recover software SAS");
            if self.sas_fail {
                return Err("the software SAS policy could not be restored (access denied)".into());
            }
            Ok(())
        }
        fn remove_state_dir(&mut self, _warnings: &mut Vec<String>) -> Result<(), String> {
            self.steps.push("remove state folder");
            if self.files_fail {
                return Err("move the running uninstaller: not the same device".into());
            }
            self.removed_files = true;
            Ok(())
        }
        fn remove_apps_entry(&mut self) -> Result<(), String> {
            self.steps.push("remove entry");
            self.removed_entry = true;
            Ok(())
        }
    }

    const ME: &str = "S-1-5-21-1-2-3-1001";
    const OTHER: &str = "S-1-5-21-1-2-3-1002";

    #[test]
    fn uninstall_recovers_the_software_sas_after_the_stop_and_before_the_state_folder_goes() {
        let mut machine = FakeMachine::new(true, Some(ME));
        assert_eq!(uninstall_from(&mut machine), 0);
        assert_eq!(
            machine.steps,
            ["stop+delete service", "recover software SAS", "remove state folder", "remove entry"]
        );
    }

    #[test]
    fn a_failed_software_sas_recovery_keeps_the_marker_folder_and_the_entry() {
        let mut machine = FakeMachine::new(true, Some(ME));
        machine.sas_fail = true;
        // The service is gone; cleanup is reported incomplete, and the state
        // folder (with the marker) and the entry stay for a retry.
        assert_eq!(uninstall_from(&mut machine), 0);
        assert_eq!(machine.steps, ["stop+delete service", "recover software SAS"]);
        assert!(!machine.removed_files && !machine.removed_entry);
    }

    #[test]
    fn an_unconfirmed_stop_never_deletes_the_registration() {
        let mut deleted = false;
        let result = delete_after_confirmed_stop(false, || {
            deleted = true;
            Ok(())
        });
        assert_eq!(result, Err(SERVICE_NOT_STOPPED.to_string()));
        assert!(!deleted, "DeleteService on a running service only marks it");
        assert_eq!(delete_after_confirmed_stop(true, || Ok(())), Ok(()));
    }

    #[test]
    fn uninstall_after_an_unconfirmed_stop_keeps_the_marker_the_files_and_the_entry() {
        let mut machine = FakeMachine::new(true, Some(ME));
        machine.stop_unconfirmed = true;
        assert_eq!(uninstall_from(&mut machine), 1);
        // Nothing after the stop ran: no SAS recovery, no file removal, no
        // entry removal, and the registration stays.
        assert_eq!(machine.steps, ["stop+delete service"]);
        assert!(!machine.removed_service && !machine.removed_files && !machine.removed_entry);
    }

    #[test]
    fn rollback_after_an_unconfirmed_stop_keeps_the_marker_the_files_and_the_entry() {
        let mut machine = FakeMachine::new(true, Some(ME));
        machine.stop_unconfirmed = true;
        let (cleanup, problems) = roll_back(&mut machine);
        assert_eq!(cleanup, Cleanup::Incomplete);
        assert_eq!(machine.steps, ["stop+delete service"]);
        assert!(!machine.removed_service && !machine.removed_files && !machine.removed_entry);
        assert!(problems.iter().any(|p| p.contains(SERVICE_NOT_STOPPED)));
        assert!(problems.iter().any(|p| p.contains(FILES_KEPT_FOR_SERVICE)));
    }

    #[test]
    fn rollback_after_a_confirmed_stop_recovers_the_sas_before_the_files_and_the_entry() {
        let mut machine = FakeMachine::new(true, Some(ME));
        let (cleanup, problems) = roll_back(&mut machine);
        assert_eq!(cleanup, Cleanup::Clean, "{problems:?}");
        assert_eq!(
            machine.steps,
            ["stop+delete service", "recover software SAS", "remove state folder", "remove entry"]
        );
    }

    #[test]
    fn every_external_wait_has_its_own_bound() {
        // Stop: SHUTDOWN_DEADLINE of progress, then a whole hint without
        // progress, noticed at the next slice (hint/10 clamped to [1, 10] s).
        assert_eq!(SHUTDOWN_DEADLINE, Duration::from_secs(10));
        assert_eq!(service_stop_bound(), Duration::from_secs(10 + 10 + 1));
        // Start: one 3 s hint without progress, noticed at the next 1 s slice.
        assert_eq!(service_start_bound(), Duration::from_secs(3 + 1));
        // Online revocation retrieval: Windows' default cumulative bound.
        assert_eq!(signature::REVOCATION_RETRIEVAL_TIMEOUT_MS, 20_000);
        // Chain-building fetches (root auto-update, AIA issuers) in both
        // WinVerifyTrust and the revocation chain: Windows' default per-URL
        // bound, which neither call overrides or disables.
        assert_eq!(signature::WINDOWS_DEFAULT_URL_RETRIEVAL_TIMEOUT_MS, 15_000);
        const WTD_CACHE_ONLY_URL_RETRIEVAL: u32 = 0x1000;
        assert_eq!(signature::wintrust_provider_flags().0 & WTD_CACHE_ONLY_URL_RETRIEVAL, 0);
    }

    #[test]
    fn the_start_bound_covers_the_slowest_start_the_waiter_accepts() {
        // One START_PENDING with the service's 3 s hint, then no progress.
        let clock = std::cell::Cell::new(Instant::now());
        let started = clock.get();
        let outcome = wait_until_running(
            || Some(ServiceProgress { state: SERVICE_START_PENDING, checkpoint: 1, wait_hint: SERVICE_START_WAIT_HINT_MS }),
            |slice| clock.set(clock.get() + slice),
            || clock.get(),
        );
        assert_eq!(outcome, StartWait::Stalled);
        assert!(clock.get() - started <= service_start_bound());
    }

    #[test]
    fn the_stop_bound_covers_the_slowest_stop_the_waiter_accepts() {
        // Drive the documented waiter's stall rule on a fake clock against the
        // service's worst case: progress every poll for SHUTDOWN_DEADLINE, then
        // none. It gives up no later than the derived bound.
        let hint = SHUTDOWN_DEADLINE.as_millis() as u32;
        let (mut elapsed, mut progressed_at) = (Duration::ZERO, Duration::ZERO);
        loop {
            elapsed += wait_slice(hint);
            if elapsed <= SHUTDOWN_DEADLINE {
                progressed_at = elapsed;
            } else if elapsed - progressed_at > stall_window(hint) {
                break;
            }
        }
        assert!(elapsed <= service_stop_bound(), "{elapsed:?}");
    }

    #[test]
    fn uninstall_refuses_another_accounts_install_before_removing_anything() {
        let mut machine = FakeMachine::new(true, Some(OTHER));
        assert_eq!(uninstall_from(&mut machine), EXIT_OTHER_USER);
        assert!(!machine.removed_service, "the other account's service must stay registered");
        assert!(!machine.removed_files, "the other account's state must stay in place");
        assert!(!machine.removed_entry, "the other account's Apps & Features entry must stay");
    }

    #[test]
    fn uninstall_keeps_the_apps_entry_when_file_cleanup_fails() {
        let mut machine = FakeMachine::new(true, Some(ME));
        machine.files_fail = true;
        // The service is gone (exit 0, cleanup reported incomplete), but the
        // entry stays so the removal can be retried from Apps & Features.
        assert_eq!(uninstall_from(&mut machine), 0);
        assert!(machine.removed_service);
        assert!(!machine.removed_entry, "the entry must stay while files remain");
    }

    /// The action the SCM takes on the `failure`-th failure (1-based) since the
    /// count was last reset, as `SERVICE_FAILURE_ACTIONSW` documents it: element
    /// [N-1], and "If N is greater than cActions, the service controller repeats
    /// the last action in the array."
    fn scm_action_for_failure(actions: &[SC_ACTION], failure: usize) -> SC_ACTION {
        actions[failure.min(actions.len()) - 1]
    }

    #[test]
    fn the_service_restarts_three_times_then_stays_stopped_until_the_daily_reset() {
        let (actions, reset_seconds) = restart_policy();
        for failure in 1..=3 {
            let action = scm_action_for_failure(&actions, failure);
            assert_eq!((action.Type, action.Delay), (SC_ACTION_RESTART, 60_000), "failure {failure}");
        }
        for failure in 4..=50 {
            assert_eq!(scm_action_for_failure(&actions, failure).Type, SC_ACTION_NONE, "failure {failure}");
        }
        assert_eq!(reset_seconds, 86_400);
        // The defect this guards against: three restarts alone repeat the last
        // restart for every later failure.
        assert_eq!(scm_action_for_failure(&actions[..3], 4).Type, SC_ACTION_RESTART);
    }

    #[test]
    fn the_apps_entry_uninstalls_through_the_protected_copy() {
        let exe = r"C:\ProgramData\Mixdog\SecureDesktop\bin\mixdog-secure-desktop.exe";
        let values = apps_entry_values(exe, "1.2.3");
        let value = |name: &str| values.iter().find(|(key, _)| *key == name).map(|(_, value)| value.clone());
        // Quoted, so a space in the path cannot split it; the only verb that
        // asks for elevation itself.
        assert_eq!(
            value("UninstallString"),
            Some(EntryValue::Text(format!("\"{exe}\" uninstall --from-apps")))
        );
        assert_eq!(value("DisplayVersion"), Some(EntryValue::Text("1.2.3".into())));
        assert_eq!(value("NoModify"), Some(EntryValue::Number(1)));
        assert_eq!(value("NoRepair"), Some(EntryValue::Number(1)));
        assert_eq!(value("DisplayName"), Some(EntryValue::Text("Mixdog 원격 접근".into())));
        // The key an earlier install wrote (under the old display name) is the
        // same key, so an update rewrites it and uninstall still finds it.
        assert_eq!(
            APPS_ENTRY_KEY,
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\MixdogSecureDesktop"
        );
    }

    /// A fake filesystem: a set of existing paths on volumes named by their
    /// first component, an operation log, and injectable failures.
    #[derive(Default)]
    struct FakeFs {
        files: std::collections::BTreeSet<PathBuf>,
        log: Vec<String>,
        fail_create: bool,
        fail_schedule: Vec<PathBuf>,
        fail_remove_tree: bool,
        fail_restore: bool,
    }

    fn volume(path: &Path) -> std::path::Component<'_> {
        path.components().next().unwrap()
    }

    impl RemovalFs for FakeFs {
        fn create_parking_dir(&mut self, dir: &Path) -> Result<(), String> {
            self.log.push(format!("mkdir {}", dir.display()));
            if self.fail_create || !self.files.insert(dir.to_path_buf()) {
                return Err("cannot create".into());
            }
            Ok(())
        }
        fn rename(&mut self, from: &Path, to: &Path) -> Result<(), String> {
            self.log.push(format!("move {} -> {}", from.display(), to.display()));
            if volume(from) != volume(to) {
                return Err("The system cannot move the file to a different disk drive. (os error 17)".into());
            }
            if self.fail_restore && to.starts_with(Path::new("C:/state")) {
                return Err("bin directory is gone".into());
            }
            if !self.files.remove(from) {
                return Err("not found".into());
            }
            self.files.insert(to.to_path_buf());
            Ok(())
        }
        fn remove_tree(&mut self, dir: &Path) -> Result<(), String> {
            self.log.push(format!("rmtree {}", dir.display()));
            if self.fail_remove_tree {
                return Err("access denied".into());
            }
            self.files.retain(|path| !path.starts_with(dir));
            Ok(())
        }
        fn remove_empty_dir(&mut self, dir: &Path) -> Result<(), String> {
            self.log.push(format!("rmdir {}", dir.display()));
            self.files.remove(dir);
            Ok(())
        }
        fn delete_at_restart(&mut self, path: &Path) -> Result<(), String> {
            self.log.push(format!("delete-at-restart {}", path.display()));
            if self.fail_schedule.iter().any(|failing| failing == path) {
                return Err("access denied".into());
            }
            Ok(())
        }
    }

    const STATE: &str = r"C:\state";
    const IMAGE: &str = r"C:\state\bin\helper.exe";
    const PARKING: &str = r"C:\state.uninstalled-1";
    const PARKED: &str = r"C:\state.uninstalled-1\helper.exe";

    fn fake_install() -> FakeFs {
        let mut fs = FakeFs::default();
        fs.files.extend([PathBuf::from(IMAGE), PathBuf::from("C:/state/state.json")]);
        fs
    }

    fn remove(fs: &mut FakeFs, parking: &str, warnings: &mut Vec<String>) -> Result<Option<PathBuf>, String> {
        remove_tree_around_image(fs, Path::new(STATE), Some(Path::new(IMAGE)), Path::new(parking), warnings)
    }

    #[test]
    fn the_parking_directory_is_a_unique_sibling_of_the_state_directory() {
        let state = Path::new(r"C:\ProgramData\Mixdog\SecureDesktop");
        let parking = parking_dir_for(state, "42-7").unwrap();
        assert_eq!(parking, Path::new(r"C:\ProgramData\Mixdog\SecureDesktop.uninstalled-42-7"));
        // Same parent directory as the image's tree, so the same volume, and
        // not inside the tree that is about to be removed.
        assert_eq!(parking.parent(), state.parent());
        assert!(!parking.starts_with(state));
        assert_eq!(parking_dir_for(Path::new(r"C:\"), "1"), None);
    }

    #[test]
    fn the_running_image_is_parked_and_scheduled_before_the_tree_is_removed() {
        let mut fs = fake_install();
        let mut warnings = Vec::new();
        assert_eq!(remove(&mut fs, PARKING, &mut warnings), Ok(Some(PathBuf::from(PARKED))));
        assert_eq!(
            fs.log,
            [
                format!("mkdir {PARKING}"),
                format!("move {IMAGE} -> {PARKED}"),
                format!("delete-at-restart {PARKED}"),
                format!("delete-at-restart {PARKING}"),
                format!("rmtree {STATE}"),
            ]
        );
        assert!(warnings.is_empty());
        // Only the parked (scheduled) image and its directory are left.
        assert_eq!(fs.files, [PathBuf::from(PARKING), PathBuf::from(PARKED)].into_iter().collect());
    }

    #[test]
    fn a_parking_place_on_another_volume_leaves_everything_in_place() {
        let mut fs = fake_install();
        let before = fs.files.clone();
        let error = remove(&mut fs, "D:/parking", &mut Vec::new()).unwrap_err();
        assert!(error.contains("different disk drive"), "{error}");
        assert!(error.contains("left in place"), "{error}");
        // Nothing scheduled, nothing removed; only the empty parking directory
        // it had created is removed again.
        assert!(!fs.log.iter().any(|op| op.starts_with("delete-at-restart") || op.starts_with("rmtree")));
        assert_eq!(fs.log.last().unwrap(), "rmdir D:/parking");
        assert_eq!(fs.files, before);
    }

    #[test]
    fn an_unusable_parking_directory_leaves_everything_in_place() {
        let mut fs = fake_install();
        fs.fail_create = true;
        let before = fs.files.clone();
        assert!(remove(&mut fs, PARKING, &mut Vec::new()).is_err());
        assert_eq!(fs.log, [format!("mkdir {PARKING}")]);
        assert_eq!(fs.files, before);
    }

    #[test]
    fn an_image_that_cannot_be_scheduled_is_moved_back_and_never_left_parked() {
        let mut fs = fake_install();
        fs.fail_schedule = vec![PathBuf::from(PARKED)];
        let before = fs.files.clone();
        let error = remove(&mut fs, PARKING, &mut Vec::new()).unwrap_err();
        assert!(error.contains("schedule") && error.contains("left in place"), "{error}");
        assert!(fs.log.contains(&format!("move {PARKED} -> {IMAGE}")));
        assert!(!fs.log.iter().any(|op| op.starts_with("rmtree")));
        assert_eq!(fs.files, before);
    }

    #[test]
    fn an_unscheduled_empty_parking_directory_is_only_a_warning() {
        let mut fs = fake_install();
        fs.fail_schedule = vec![PathBuf::from(PARKING)];
        let mut warnings = Vec::new();
        assert_eq!(remove(&mut fs, PARKING, &mut warnings), Ok(Some(PathBuf::from(PARKED))));
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("empty admin-only directory"), "{}", warnings[0]);
    }

    #[test]
    fn a_failed_tree_removal_moves_the_image_back_for_a_retry() {
        let mut fs = fake_install();
        fs.fail_remove_tree = true;
        let error = remove(&mut fs, PARKING, &mut Vec::new()).unwrap_err();
        assert!(error.contains("access denied"), "{error}");
        // Scheduled before the failing removal, then moved back so the kept
        // Apps & Features entry still runs it.
        let scheduled = fs.log.iter().position(|op| *op == format!("delete-at-restart {PARKED}")).unwrap();
        let removal = fs.log.iter().position(|op| *op == format!("rmtree {STATE}")).unwrap();
        assert!(scheduled < removal);
        assert_eq!(fs.log.last().unwrap(), &format!("move {PARKED} -> {IMAGE}"));
        assert!(fs.files.contains(Path::new(IMAGE)));
    }

    #[test]
    fn a_failed_tree_removal_that_cannot_move_back_reports_the_scheduled_image() {
        let mut fs = fake_install();
        fs.fail_remove_tree = true;
        fs.fail_restore = true;
        let error = remove(&mut fs, PARKING, &mut Vec::new()).unwrap_err();
        assert!(error.contains("could not be moved back"), "{error}");
        // It stays parked, and was scheduled for deletion before anything failed.
        assert!(fs.files.contains(Path::new(PARKED)));
        assert!(fs.log.contains(&format!("delete-at-restart {PARKED}")));
    }

    #[test]
    fn an_image_whose_path_differs_only_in_case_is_still_parked() {
        let mut fs = fake_install();
        let image = Path::new(r"c:\STATE\Bin\HELPER.exe");
        fs.files.insert(image.to_path_buf());
        let result = remove_tree_around_image(&mut fs, Path::new(STATE), Some(image), Path::new(PARKING), &mut Vec::new());
        // Parked (not the direct removal that would fail on the running image).
        assert_eq!(result, Ok(Some(PathBuf::from(r"C:\state.uninstalled-1\HELPER.exe"))));
        assert_eq!(fs.log[0], format!("mkdir {PARKING}"));
    }

    #[test]
    fn containment_is_case_insensitive_on_component_boundaries_only() {
        assert!(is_within(Path::new(r"C:\ProgramData\Mixdog\SecureDesktop"), Path::new(r"c:\PROGRAMDATA\mixdog\securedesktop\bin\x.exe")));
        assert!(is_within(Path::new(r"C:\State"), Path::new(r"c:\state")));
        // A sibling sharing a name prefix is not inside.
        assert!(!is_within(Path::new(r"C:\state"), Path::new(r"C:\state.uninstalled-1\x.exe")));
        assert!(!is_within(Path::new(r"C:\state\bin"), Path::new(r"C:\state")));
        assert!(!is_within(Path::new(r"C:\state"), Path::new(r"D:\state\x.exe")));
    }

    #[test]
    fn containment_compares_canonical_paths_of_existing_files() {
        let root = std::env::temp_dir().join(format!("mixdog-sd-case-{}-{}", std::process::id(), now_ms()));
        let image = root.join("Bin").join("Helper.exe");
        std::fs::create_dir_all(image.parent().unwrap()).unwrap();
        std::fs::write(&image, b"x").unwrap();
        // Different case and a `..` detour; both resolve through the real files.
        let upper = PathBuf::from(root.to_string_lossy().to_uppercase());
        let detour = root.join("Bin").join("..").join("bin").join("HELPER.EXE");
        assert!(is_within(&upper, &detour));
        assert!(!is_within(&root.join("Bin").join("Helper.exe"), &root));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn removing_the_tree_from_outside_it_deletes_it_directly() {
        let mut fs = fake_install();
        let outside = Path::new("C:/app/helper.exe");
        let result = remove_tree_around_image(&mut fs, Path::new(STATE), Some(outside), Path::new(PARKING), &mut Vec::new());
        assert_eq!(result, Ok(None));
        assert_eq!(fs.log, [format!("rmtree {STATE}")]);
        assert!(fs.files.is_empty());
    }

    #[test]
    fn uninstall_removes_the_callers_own_ownerless_or_leftover_install() {
        // Its own install; a registration with no readable state; another
        // account's leftover state with no registration.
        for (registered, owner) in [(true, Some(ME)), (true, None), (false, Some(OTHER))] {
            let mut machine = FakeMachine::new(registered, owner);
            assert_eq!(uninstall_from(&mut machine), 0);
            assert!(machine.removed_service && machine.removed_files && machine.removed_entry);
        }
    }
}
