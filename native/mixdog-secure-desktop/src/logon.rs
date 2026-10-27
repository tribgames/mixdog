//! Credential (phone-password) authorization for the admin-gated operations.
//!
//! The unelevated app's remote fallback: instead of a UAC elevation, the app
//! runs `install`/`enroll`/`revoke` with `--logon` and writes a Windows
//! administrator password (and optionally an account name) to the child's
//! **stdin only** — never argv, environment, logs or events. This module logs
//! that account on with `LogonUserW(LOGON32_LOGON_BATCH, …)`, which returns an
//! *unfiltered* administrator token under UAC (MS SDK blog "How to launch a
//! process as a Full Administrator when UAC is enabled"; `LogonUserW` docs),
//! verifies the token is an unfiltered Administrators member
//! (`CheckTokenMembership` + `TokenElevationType`), impersonates it on a
//! dedicated thread (`ImpersonateLoggedOnUser`, allowed without
//! `SeImpersonatePrivilege` for a token from explicit credentials), runs the
//! operation under that identity, and always reverts (`RevertToSelf`). The
//! password buffers are wiped on both the stdin read and the token.
//!
//! When the phone sends no account name, the PC uses its own signed-in account
//! (`GetUserNameExW(NameSamCompatible)`); if that account is not an
//! Administrators member, it answers `not-admin` without attempting a logon
//! (the phone then shows an optional account field). Microsoft-account
//! sign-ins pass their SAM name (`COMPUTER\localname`) with the account
//! password; that and a Windows Hello PIN are documented as unverified pending
//! hardware testing (a PIN is not a password `LogonUserW` accepts).

use std::sync::atomic::{compiler_fence, Ordering};

use serde_json::json;
use windows::core::{Error, BOOL, PCWSTR, PWSTR};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Security::Authentication::Identity::{GetUserNameExW, NameSamCompatible};
use windows::Win32::Security::{
    CheckTokenMembership, DuplicateToken, GetTokenInformation, ImpersonateLoggedOnUser, LogonUserW,
    RevertToSelf, SecurityImpersonation, TokenElevationType, TokenElevationTypeFull,
    TokenElevationTypeLimited, WinBuiltinAdministratorsSid, LOGON32_LOGON_BATCH,
    LOGON32_PROVIDER_DEFAULT, PSID, TOKEN_ACCESS_MASK, TOKEN_DUPLICATE, TOKEN_ELEVATION_TYPE,
    TOKEN_QUERY,
};
use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use crate::install::{self, well_known_sid};
use crate::winutil::{wide, OwnedHandle};

// Credential field limits: Windows' documented maxima for a credential prompt.
// `CREDUI_MAX_USERNAME_LENGTH` (513) and `CREDUI_MAX_PASSWORD_LENGTH` (256)
// from wincred.h / the *CredUIPromptForCredentials* docs, in UTF-16 units.
const CREDUI_MAX_USERNAME_LENGTH: usize = 513;
const CREDUI_MAX_PASSWORD_LENGTH: usize = 256;
/// Upper bound on the stdin we will read, derived from the field maxima (both
/// fields at their UTF-16 maximum, the one-byte separator, and up to 4 UTF-8
/// bytes per unit) — not a magic number. Anything larger is rejected unread.
const STDIN_CAP: usize = (CREDUI_MAX_USERNAME_LENGTH + CREDUI_MAX_PASSWORD_LENGTH + 2) * 4;

// Win32 logon error codes (winerror.h), mapped to phone outcomes.
const ERROR_LOGON_FAILURE: u32 = 1326;
const ERROR_ACCOUNT_RESTRICTION: u32 = 1327;
const ERROR_INVALID_LOGON_HOURS: u32 = 1328;
const ERROR_INVALID_WORKSTATION: u32 = 1329;
const ERROR_PASSWORD_EXPIRED: u32 = 1330;
const ERROR_ACCOUNT_DISABLED: u32 = 1331;
const ERROR_LOGON_TYPE_NOT_GRANTED: u32 = 1385;
const ERROR_ACCOUNT_EXPIRED: u32 = 1793;
const ERROR_PASSWORD_MUST_CHANGE: u32 = 1907;
const ERROR_ACCOUNT_LOCKED_OUT: u32 = 1909;

/// Why a logon did not yield a usable admin token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LogonFailure {
    /// Wrong account or password (`ERROR_LOGON_FAILURE`).
    BadCredentials,
    /// The account lacks the "Log on as a batch job" right
    /// (`ERROR_LOGON_TYPE_NOT_GRANTED`).
    LogonTypeDenied,
    /// The account is locked out (`ERROR_ACCOUNT_LOCKED_OUT`).
    AccountLocked,
    /// The account is disabled (`ERROR_ACCOUNT_DISABLED`).
    AccountDisabled,
    /// A policy on the account refused the logon (hours, workstation, expired
    /// or must-change password, expired account, other restriction).
    PolicyBlocked,
    /// Any other error.
    Other,
}

/// Map a Win32 logon error to a [`LogonFailure`]. Pure; unit-tested.
fn logon_failure_for(code: u32) -> LogonFailure {
    match code {
        ERROR_LOGON_FAILURE => LogonFailure::BadCredentials,
        ERROR_LOGON_TYPE_NOT_GRANTED => LogonFailure::LogonTypeDenied,
        ERROR_ACCOUNT_LOCKED_OUT => LogonFailure::AccountLocked,
        ERROR_ACCOUNT_DISABLED => LogonFailure::AccountDisabled,
        ERROR_ACCOUNT_RESTRICTION
        | ERROR_INVALID_LOGON_HOURS
        | ERROR_INVALID_WORKSTATION
        | ERROR_PASSWORD_EXPIRED
        | ERROR_PASSWORD_MUST_CHANGE
        | ERROR_ACCOUNT_EXPIRED => LogonFailure::PolicyBlocked,
        _ => LogonFailure::Other,
    }
}

/// The exit code and fixed outcome label for a failure — derived only from the
/// failure, never from any credential, so nothing secret is echoed. Pure.
fn logon_outcome(failure: LogonFailure) -> (i32, &'static str) {
    match failure {
        LogonFailure::BadCredentials => (install::EXIT_BAD_CREDENTIALS, "bad-credentials"),
        LogonFailure::LogonTypeDenied => (install::EXIT_LOGON_TYPE_DENIED, "logon-type-denied"),
        LogonFailure::AccountLocked => (install::EXIT_ACCOUNT_LOCKED, "account-locked"),
        LogonFailure::AccountDisabled => (install::EXIT_ACCOUNT_DISABLED, "account-disabled"),
        LogonFailure::PolicyBlocked => (install::EXIT_POLICY_BLOCKED, "policy-blocked"),
        LogonFailure::Other => (1, "failed"),
    }
}

fn report_logon_failure(failure: LogonFailure) -> i32 {
    let (code, label) = logon_outcome(failure);
    install::emit(json!({ "ok": false, "logon": label }));
    code
}

fn report_not_admin() -> i32 {
    install::emit(json!({ "ok": false, "logon": "not-admin" }));
    install::EXIT_NOT_ADMIN
}

/// Whether a logon token is an *unfiltered* administrator: an Administrators
/// member whose elevation type is not the filtered (limited) token. Pure;
/// unit-tested. A standard user is not a member; a UAC-filtered token is
/// `TokenElevationTypeLimited` and is rejected.
fn admits_full_admin(is_member: bool, elevation_type: TOKEN_ELEVATION_TYPE) -> bool {
    is_member && elevation_type != TokenElevationTypeLimited
}

/// A password in a NUL-terminated UTF-16 buffer, wiped on drop.
struct Password(Vec<u16>);

impl Password {
    fn pcwstr(&self) -> PCWSTR {
        PCWSTR(self.0.as_ptr())
    }
}

impl Drop for Password {
    fn drop(&mut self) {
        secure_zero_u16(&mut self.0);
    }
}

/// Overwrite a UTF-16 buffer with zeros, not optimized away (the
/// `SecureZeroMemory` equivalent).
fn secure_zero_u16(buffer: &mut [u16]) {
    for unit in buffer.iter_mut() {
        unsafe { std::ptr::write_volatile(unit, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

/// Overwrite a byte buffer with zeros, not optimized away.
fn secure_zero_u8(buffer: &mut [u8]) {
    for byte in buffer.iter_mut() {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

/// A parsed credential: an optional account name and the password.
struct Credential {
    user: Option<String>,
    password: Password,
}

/// Parse `<user>\n<password>` from stdin bytes: the first newline splits the
/// (possibly empty) account name from the password, which is the exact
/// remainder (never trimmed). An empty name means "use the PC's own account".
/// Enforces the documented field maxima. Pure; unit-tested.
fn parse_credential(bytes: &[u8]) -> Result<Credential, String> {
    if bytes.len() > STDIN_CAP {
        return Err("credential input is too large".into());
    }
    let newline = bytes
        .iter()
        .position(|&byte| byte == b'\n')
        .ok_or("credential input must be <user>\\n<password>")?;
    let user = std::str::from_utf8(&bytes[..newline])
        .map_err(|_| "username is not valid UTF-8")?
        .trim();
    let password =
        std::str::from_utf8(&bytes[newline + 1..]).map_err(|_| "password is not valid UTF-8")?;
    if password.is_empty() {
        return Err("password is empty".into());
    }
    if password.encode_utf16().count() > CREDUI_MAX_PASSWORD_LENGTH {
        return Err("password exceeds the maximum length".into());
    }
    let user = if user.is_empty() {
        None
    } else {
        if user.encode_utf16().count() > CREDUI_MAX_USERNAME_LENGTH {
            return Err("username exceeds the maximum length".into());
        }
        if user.contains('\0') {
            return Err("username contains a NUL".into());
        }
        Some(user.to_string())
    };
    let password = Password(password.encode_utf16().chain(std::iter::once(0)).collect());
    Ok(Credential { user, password })
}

/// Read a bounded credential from stdin; the raw buffer is wiped on every exit.
fn read_stdin_credential() -> Result<Credential, String> {
    // Preallocated to the bound, so the read never reallocates and leaves an
    // unwiped copy of the bytes behind.
    let mut buffer = Vec::with_capacity(STDIN_CAP + 1);
    read_credential_from(std::io::stdin(), &mut buffer)
}

/// Read at most `STDIN_CAP + 1` bytes from `reader` into `buffer` and parse
/// them. `buffer` is wiped before returning on **every** path — success, parse
/// error, and a read error after a partial read (`read_to_end` keeps the bytes
/// it read before failing). Unit-tested with a failing reader.
fn read_credential_from<R: std::io::Read>(
    reader: R,
    buffer: &mut Vec<u8>,
) -> Result<Credential, String> {
    use std::io::Read;
    let result = reader
        .take((STDIN_CAP + 1) as u64)
        .read_to_end(buffer)
        .map_err(|error| format!("read credential from stdin: {error}"))
        .and_then(|_| parse_credential(buffer));
    secure_zero_u8(buffer);
    result
}

/// Split `DOMAIN\user` / `.\user` into a domain and account; a plain `user` or
/// a `user@upn` keeps a NULL domain, as `LogonUserW` documents. Pure.
fn split_logon_name(user: &str) -> (Option<String>, String) {
    match user.find('\\') {
        Some(index) => (
            Some(user[..index].to_string()),
            user[index + 1..].to_string(),
        ),
        None => (None, user.to_string()),
    }
}

/// Why a logon was not even attempted.
#[derive(Debug)]
enum Prelogon {
    /// The PC's own account is not an administrator (own-account case only).
    NotAdmin,
    /// The PC's own account name could not be resolved.
    ResolveFailed(String),
}

/// Decide which account to log on as. An explicit name is used as sent. With
/// no name, the PC's own signed-in account is used, but only if it is an
/// administrator — otherwise `not-admin` is returned without a logon. Pure;
/// unit-tested through injected closures.
fn resolve_logon_user(
    requested: Option<&str>,
    own_account: impl FnOnce() -> Option<String>,
    own_is_admin: impl FnOnce() -> bool,
) -> Result<String, Prelogon> {
    match requested {
        Some(user) => Ok(user.to_string()),
        None => {
            if !own_is_admin() {
                return Err(Prelogon::NotAdmin);
            }
            own_account().ok_or_else(|| {
                Prelogon::ResolveFailed(
                    "could not determine the signed-in Windows account; send the account name"
                        .into(),
                )
            })
        }
    }
}

/// Reverts the current thread's impersonation on drop, so every exit path —
/// return or panic — reverts. The revert closure is injected for testing.
struct RevertOnDrop<F: FnMut()>(F);

impl<F: FnMut()> Drop for RevertOnDrop<F> {
    fn drop(&mut self) {
        (self.0)();
    }
}

/// Impersonate, run `body`, and revert on every path. If impersonation fails
/// there is nothing to revert. Testable with injected closures.
fn run_impersonated<R>(
    impersonate: impl FnOnce() -> Result<(), String>,
    revert: impl FnMut(),
    body: impl FnOnce() -> R,
) -> Result<R, String> {
    impersonate()?;
    let _guard = RevertOnDrop(revert);
    Ok(body())
}

/// The whole credential path for one admin operation: read the credential,
/// resolve the account, and run `body` under the logged-on administrator.
/// Returns the operation's exit code, or a logon/not-admin exit code.
pub fn with_credential_logon(body: impl FnOnce() -> i32 + Send + 'static) -> i32 {
    let credential = match read_stdin_credential() {
        Ok(credential) => credential,
        Err(error) => return install::fail(&error),
    };
    let user = match resolve_logon_user(
        credential.user.as_deref(),
        resolve_own_account,
        current_account_is_admin,
    ) {
        Ok(user) => user,
        Err(Prelogon::NotAdmin) => return report_not_admin(),
        Err(Prelogon::ResolveFailed(error)) => return install::fail(&error),
    };
    // A dedicated thread owns the impersonation and the password, so the
    // identity never leaks to other threads and the password is wiped when the
    // thread ends.
    std::thread::spawn(move || logon_impersonate_run(user, credential.password, body))
        .join()
        .unwrap_or_else(|_| install::fail("the credential operation thread panicked"))
}

fn logon_impersonate_run(user: String, password: Password, body: impl FnOnce() -> i32) -> i32 {
    let (domain, account) = split_logon_name(&user);
    let account_w = wide(&account);
    let domain_w = domain.as_deref().map(wide);
    let mut token = HANDLE::default();
    let logon = unsafe {
        LogonUserW(
            PCWSTR(account_w.as_ptr()),
            domain_w
                .as_ref()
                .map_or(PCWSTR::null(), |value| PCWSTR(value.as_ptr())),
            password.pcwstr(),
            LOGON32_LOGON_BATCH,
            LOGON32_PROVIDER_DEFAULT,
            &mut token,
        )
    };
    // LogonUserW has copied the password; wipe ours now.
    drop(password);
    if let Err(error) = logon {
        return report_logon_failure(logon_failure_for(win32_code(&error)));
    }
    let token = match OwnedHandle::new(token) {
        Some(token) => token,
        None => return install::fail("logon returned no token"),
    };
    let is_member = unsafe { token_is_admin_member(token.get()) };
    let elevation = unsafe { token_elevation_type(token.get()) };
    if !admits_full_admin(is_member, elevation) {
        return report_not_admin();
    }
    match run_impersonated(
        || unsafe { ImpersonateLoggedOnUser(token.get()) }.map_err(|error| error.to_string()),
        || {
            let _ = unsafe { RevertToSelf() };
        },
        body,
    ) {
        Ok(code) => code,
        Err(error) => install::fail(&format!("impersonate the logon token: {error}")),
    }
}

/// The plain Win32 code carried by a `windows` error (HRESULT_FROM_WIN32).
fn win32_code(error: &Error) -> u32 {
    (error.code().0 as u32) & 0xFFFF
}

/// Whether a (primary) token is an enabled Administrators member. Duplicates
/// it to an impersonation token, as `CheckTokenMembership` requires.
unsafe fn token_is_admin_member(primary: HANDLE) -> bool {
    let mut impersonation = HANDLE::default();
    if DuplicateToken(primary, SecurityImpersonation, &mut impersonation).is_err() {
        return false;
    }
    let Some(impersonation) = OwnedHandle::new(impersonation) else {
        return false;
    };
    let Ok(mut admins) = well_known_sid(WinBuiltinAdministratorsSid) else {
        return false;
    };
    let mut is_member = BOOL::default();
    if CheckTokenMembership(
        Some(impersonation.get()),
        PSID(admins.as_mut_ptr().cast()),
        &mut is_member,
    )
    .is_err()
    {
        return false;
    }
    is_member.as_bool()
}

/// A token's elevation type (`TokenElevationTypeDefault` on any error).
unsafe fn token_elevation_type(token: HANDLE) -> TOKEN_ELEVATION_TYPE {
    let mut elevation = TOKEN_ELEVATION_TYPE::default();
    let mut needed = 0u32;
    let _ = GetTokenInformation(
        token,
        TokenElevationType,
        Some(&mut elevation as *mut _ as *mut core::ffi::c_void),
        std::mem::size_of::<TOKEN_ELEVATION_TYPE>() as u32,
        &mut needed,
    );
    elevation
}

/// Whether the account running this (unelevated) process is a local
/// administrator: a full or filtered (limited) token means an admin account;
/// otherwise the real membership of the process token is checked.
fn current_account_is_admin() -> bool {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ACCESS_MASK(TOKEN_QUERY.0 | TOKEN_DUPLICATE.0),
            &mut token,
        )
        .is_err()
        {
            return false;
        }
        let Some(token) = OwnedHandle::new(token) else {
            return false;
        };
        let elevation = token_elevation_type(token.get());
        if elevation == TokenElevationTypeFull || elevation == TokenElevationTypeLimited {
            return true;
        }
        token_is_admin_member(token.get())
    }
}

/// The PC's own signed-in account in SAM-compatible form (`COMPUTER\user` or
/// `DOMAIN\user`), for the no-account-name case.
fn resolve_own_account() -> Option<String> {
    unsafe {
        let mut size = 0u32;
        // First call fails and reports the required size (including the NUL).
        let _ = GetUserNameExW(NameSamCompatible, None, &mut size);
        if size == 0 {
            return None;
        }
        let mut buffer = vec![0u16; size as usize];
        if !GetUserNameExW(
            NameSamCompatible,
            Some(PWSTR(buffer.as_mut_ptr())),
            &mut size,
        ) {
            return None;
        }
        String::from_utf16(&buffer[..size as usize])
            .ok()
            .filter(|name| !name.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use windows::Win32::Security::TokenElevationTypeDefault;

    #[test]
    fn win32_errors_map_to_outcomes() {
        assert_eq!(
            logon_failure_for(ERROR_LOGON_FAILURE),
            LogonFailure::BadCredentials
        );
        assert_eq!(
            logon_failure_for(ERROR_LOGON_TYPE_NOT_GRANTED),
            LogonFailure::LogonTypeDenied
        );
        assert_eq!(
            logon_failure_for(ERROR_ACCOUNT_LOCKED_OUT),
            LogonFailure::AccountLocked
        );
        assert_eq!(
            logon_failure_for(ERROR_ACCOUNT_DISABLED),
            LogonFailure::AccountDisabled
        );
        assert_eq!(
            logon_failure_for(ERROR_PASSWORD_EXPIRED),
            LogonFailure::PolicyBlocked
        );
        assert_eq!(logon_failure_for(0xDEAD), LogonFailure::Other);
        // Each outcome maps to a distinct exit code and a fixed label (no echo).
        assert_eq!(
            logon_outcome(LogonFailure::BadCredentials),
            (install::EXIT_BAD_CREDENTIALS, "bad-credentials")
        );
        assert_eq!(
            logon_outcome(LogonFailure::LogonTypeDenied).0,
            install::EXIT_LOGON_TYPE_DENIED
        );
    }

    #[test]
    fn only_an_unfiltered_admin_token_is_accepted() {
        assert!(admits_full_admin(true, TokenElevationTypeFull));
        assert!(admits_full_admin(true, TokenElevationTypeDefault));
        assert!(
            !admits_full_admin(true, TokenElevationTypeLimited),
            "a UAC-filtered token is not admin"
        );
        assert!(
            !admits_full_admin(false, TokenElevationTypeFull),
            "a standard user is not admin"
        );
    }

    #[test]
    fn stdin_credential_parses_within_bounds() {
        let parsed = parse_credential(b"DOMAIN\\admin\nhunter2").unwrap();
        assert_eq!(parsed.user.as_deref(), Some("DOMAIN\\admin"));
        assert_eq!(String::from_utf16_lossy(&parsed.password.0), "hunter2\0");
        // No account name: user is None (the PC resolves its own).
        assert!(parse_credential(b"\np4ss").unwrap().user.is_none());
        // Password is the exact remainder, not trimmed, and may contain spaces.
        assert_eq!(
            String::from_utf16_lossy(&parse_credential(b"u\np ss ").unwrap().password.0),
            "p ss \0"
        );
        // No newline, empty password, over-long fields and over-cap input are refused.
        assert!(parse_credential(b"nouserseparator").is_err());
        assert!(parse_credential(b"u\n").is_err());
        assert!(parse_credential(
            format!("u\n{}", "x".repeat(CREDUI_MAX_PASSWORD_LENGTH + 1)).as_bytes()
        )
        .is_err());
        assert!(parse_credential(
            format!("{}\np", "u".repeat(CREDUI_MAX_USERNAME_LENGTH + 1)).as_bytes()
        )
        .is_err());
        assert!(parse_credential(&vec![b'a'; STDIN_CAP + 1]).is_err());
    }

    #[test]
    fn split_logon_name_separates_a_domain() {
        assert_eq!(split_logon_name("user"), (None, "user".to_string()));
        assert_eq!(
            split_logon_name("user@contoso.com"),
            (None, "user@contoso.com".to_string())
        );
        assert_eq!(
            split_logon_name(".\\user"),
            (Some(".".to_string()), "user".to_string())
        );
        assert_eq!(
            split_logon_name("DOMAIN\\user"),
            (Some("DOMAIN".to_string()), "user".to_string())
        );
    }

    #[test]
    fn an_explicit_user_is_used_as_sent_without_touching_the_pc_account() {
        let resolved = Cell::new(false);
        let admin_checked = Cell::new(false);
        let user = resolve_logon_user(
            Some("DOMAIN\\admin"),
            || {
                resolved.set(true);
                None
            },
            || {
                admin_checked.set(true);
                false
            },
        )
        .unwrap();
        assert_eq!(user, "DOMAIN\\admin");
        assert!(
            !resolved.get() && !admin_checked.get(),
            "the PC's own account is not consulted"
        );
    }

    #[test]
    fn with_no_user_the_pc_resolves_its_own_admin_account() {
        let user = resolve_logon_user(None, || Some("PC\\owner".to_string()), || true).unwrap();
        assert_eq!(user, "PC\\owner");
    }

    #[test]
    fn a_non_admin_own_account_is_not_admin_without_a_logon() {
        let resolved = Cell::new(false);
        let result = resolve_logon_user(
            None,
            || {
                resolved.set(true);
                Some("PC\\user".to_string())
            },
            || false,
        );
        assert!(matches!(result, Err(Prelogon::NotAdmin)));
        assert!(
            !resolved.get(),
            "a non-admin own account is rejected before resolving a name or logging on"
        );
    }

    #[test]
    fn impersonation_reverts_on_every_path() {
        // Normal return.
        let reverted = Cell::new(false);
        let out = run_impersonated(|| Ok(()), || reverted.set(true), || 7).unwrap();
        assert_eq!(out, 7);
        assert!(reverted.get(), "revert runs after the body returns");
        // Failed impersonation: nothing to revert, and the error propagates.
        let reverted = Cell::new(false);
        assert!(run_impersonated::<i32>(|| Err("no".into()), || reverted.set(true), || 0).is_err());
        assert!(
            !reverted.get(),
            "no revert when impersonation never happened"
        );
        // Panicking body: the guard still reverts during unwind.
        let reverted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = reverted.clone();
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_impersonated(
                || Ok(()),
                || flag.store(true, Ordering::SeqCst),
                || panic!("boom"),
            )
            .map(|_: ()| ())
        }));
        assert!(caught.is_err());
        assert!(
            reverted.load(Ordering::SeqCst),
            "revert runs even when the body panics"
        );
    }

    #[test]
    fn a_stdin_read_error_still_wipes_the_partial_buffer() {
        /// Yields part of a credential, then fails.
        struct PartialThenError(bool);
        impl std::io::Read for PartialThenError {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                if self.0 {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "pipe closed",
                    ));
                }
                self.0 = true;
                let bytes = b"admin\nhunter2";
                out[..bytes.len()].copy_from_slice(bytes);
                Ok(bytes.len())
            }
        }
        let mut buffer = Vec::with_capacity(STDIN_CAP + 1);
        assert!(read_credential_from(PartialThenError(false), &mut buffer).is_err());
        assert!(
            !buffer.is_empty(),
            "the partial read was kept, so the wipe is observable"
        );
        assert!(
            buffer.iter().all(|&byte| byte == 0),
            "wiped on the read-error path"
        );
        // The parse-error and success paths wipe too.
        let mut buffer = Vec::with_capacity(STDIN_CAP + 1);
        assert!(read_credential_from(&b"no-newline"[..], &mut buffer).is_err());
        assert!(buffer.iter().all(|&byte| byte == 0));
        let mut buffer = Vec::with_capacity(STDIN_CAP + 1);
        assert!(read_credential_from(&b"admin\nhunter2"[..], &mut buffer).is_ok());
        assert!(buffer.iter().all(|&byte| byte == 0));
    }

    #[test]
    fn secure_zero_clears_a_buffer() {
        let mut secret = [0x41u16; 8];
        secure_zero_u16(&mut secret);
        assert!(secret.iter().all(|&unit| unit == 0));
        let mut bytes = [0x42u8; 8];
        secure_zero_u8(&mut bytes);
        assert!(bytes.iter().all(|&byte| byte == 0));
    }
}
