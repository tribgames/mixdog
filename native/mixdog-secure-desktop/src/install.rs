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

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::json;
use windows::core::PCWSTR;
use windows::Win32::Security::{
    SetFileSecurityW, DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION,
    OBJECT_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
};
use windows::Win32::Storage::FileSystem::CreateDirectoryW;
use windows::Win32::System::Services::{
    CloseServiceHandle, ControlService, CreateServiceW, DeleteService, OpenSCManagerW, OpenServiceW,
    QueryServiceStatusEx, SetServiceObjectSecurity, StartServiceW, SC_HANDLE, SC_MANAGER_ALL_ACCESS,
    SC_MANAGER_CONNECT, SC_STATUS_PROCESS_INFO, SERVICE_ALL_ACCESS, SERVICE_CONTROL_STOP,
    SERVICE_DEMAND_START, SERVICE_ERROR_NORMAL, SERVICE_QUERY_STATUS, SERVICE_RUNNING,
    SERVICE_STATUS, SERVICE_STATUS_PROCESS, SERVICE_STOP, SERVICE_STOPPED, SERVICE_STOP_PENDING,
    SERVICE_WIN32_OWN_PROCESS,
};

use crate::acl;
use crate::security::{
    binary_sddl, service_sddl, state_dir_sddl, state_file_sddl, InstallState,
};
use crate::winutil::{current_user_sid, is_win32_error, now_ms, wide, SecurityDescriptor};
use crate::{log, paths};

const DELETE_ACCESS: u32 = 0x0001_0000; // DELETE
const ERROR_ALREADY_EXISTS: u32 = 183;
const ERROR_SERVICE_DOES_NOT_EXIST: u32 = 1060;

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

fn emit(value: serde_json::Value) {
    let text = value.to_string();
    let mut stdout = std::io::stdout();
    let _ = writeln!(stdout, "{text}");
}

fn fail(message: &str) -> i32 {
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
        Err(error) if is_win32_error(&error, ERROR_ALREADY_EXISTS) => {
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
/// down. Returns the quoted, protected path to register the service against.
/// Everything the service later runs as SYSTEM lives here, owned by
/// Administrators and writable only by SYSTEM/Administrators — never by the
/// installing user — so the user cannot swap the binary for their own code.
fn stage_protected_binary(user_sid: &str) -> Result<String, String> {
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

    // 3. Copy this executable in and lock the copy down (admin/SYSTEM-only).
    let source = std::env::current_exe().map_err(|e| format!("resolve current exe: {e}"))?;
    std::fs::copy(&source, paths::bin_exe())
        .map_err(|e| format!("copy binary to {}: {e}", paths::bin_exe().display()))?;
    let bin_sddl = binary_sddl(user_sid).ok_or("invalid user SID")?;
    apply_security(&paths::bin_exe(), &bin_sddl, owner_group_dacl())?;

    // 4. Verify the final binary path and its whole ancestry are trusted.
    acl::verify_trusted_ancestry(&paths::bin_exe())?;

    // Quoted so a space in the path cannot split the ImagePath into an
    // unquoted-service-path hijack.
    Ok(format!("\"{}\" service", paths::bin_exe().to_string_lossy()))
}

/// Write the state file (the secret) into the already-protected directory and
/// set its read-only-to-user DACL. Must run only after [`stage_protected_binary`]
/// has created and verified the directory.
fn write_protected_state(state: &InstallState) -> Result<(), String> {
    std::fs::write(paths::state_file(), state.to_json())
        .map_err(|error| format!("write state: {error}"))?;
    let sddl = state_file_sddl(&state.user_sid).ok_or("invalid user SID")?;
    apply_security(&paths::state_file(), &sddl, DACL_SECURITY_INFORMATION)
}

pub fn install() -> i32 {
    let sid = match current_user_sid() {
        Ok(sid) => sid,
        Err(error) => return fail(&format!("cannot resolve user SID: {error}")),
    };

    // Stage the binary into a protected machine directory first (this also
    // creates and verifies the directory the secret will live in), then write
    // the secret into that protected directory.
    let bin_path = match stage_protected_binary(&sid) {
        Ok(path) => path,
        Err(error) => {
            let _ = std::fs::remove_dir_all(paths::state_dir());
            return fail(&error);
        }
    };

    let state = InstallState::new(env!("CARGO_PKG_VERSION"), &sid, paths::PIPE_NAME, now_ms());
    if let Err(error) = write_protected_state(&state) {
        let _ = std::fs::remove_dir_all(paths::state_dir());
        return fail(&error);
    }

    let result = (|| -> Result<(), String> {
        let manager = unsafe { OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_ALL_ACCESS) }
            .map_err(|error| format!("open SCM (elevation required): {error}"))?;
        let manager = ScHandle(manager);

        let name = wide(paths::SERVICE_NAME);
        let display = wide(paths::SERVICE_DISPLAY_NAME);
        let bin = wide(&bin_path);
        let service = unsafe {
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
        .map_err(|error| format!("create service: {error}"))?;
        let service = ScHandle(service);

        // Grant the installing user start/stop/query so later control needs no
        // further elevation.
        if let Some(sddl) = service_sddl(&sid) {
            if let Ok(descriptor) = SecurityDescriptor::from_sddl(&sddl) {
                unsafe {
                    let _ = SetServiceObjectSecurity(
                        service.0,
                        DACL_SECURITY_INFORMATION,
                        descriptor.raw(),
                    );
                }
            }
        }

        unsafe { StartServiceW(service.0, None) }
            .map_err(|error| format!("start service: {error}"))?;
        Ok(())
    })();

    match result {
        Ok(()) => {
            log::event("install", "service installed and started");
            emit(json!({
                "ok": true,
                "installed": true,
                "running": true,
                "version": state.product_version,
            }));
            0
        }
        Err(error) => {
            // Roll back the state we wrote so a failed install leaves nothing.
            let _ = std::fs::remove_dir_all(paths::state_dir());
            fail(&error)
        }
    }
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

/// One poll slice, bounded by the service's own wait hint per the documented
/// SCM pattern: a tenth of the hint, clamped to [1s, 10s].
fn wait_slice(wait_hint: u32) -> Duration {
    Duration::from_millis((wait_hint / 10).clamp(1000, 10000) as u64)
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
    let stall_window = |hint: u32| Duration::from_millis(hint as u64).max(wait_slice(hint));
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

pub fn uninstall() -> i32 {
    log::event("uninstall", "requested");
    let mut warnings: Vec<String> = Vec::new();

    let service_result = (|| -> Result<(), String> {
        let manager =
            unsafe { OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_ALL_ACCESS) }
                .map_err(|error| format!("open SCM (elevation required): {error}"))?;
        let manager = ScHandle(manager);
        let name = wide(paths::SERVICE_NAME);
        match unsafe {
            OpenServiceW(
                manager.0,
                PCWSTR(name.as_ptr()),
                SERVICE_STOP | SERVICE_QUERY_STATUS | DELETE_ACCESS,
            )
        } {
            Ok(service) => {
                let service = ScHandle(service);
                if !stop_and_wait(&service) {
                    // Delete still proceeds (marks for removal at next release),
                    // but the caller must know the stop was not confirmed.
                    warnings.push(
                        "service did not confirm SERVICE_STOPPED within its wait hint".into(),
                    );
                }
                unsafe { DeleteService(service.0) }
                    .map_err(|error| format!("delete service: {error}"))?;
                log::event("uninstall", "service stopped and deleted");
                Ok(())
            }
            // Distinguish "not installed" (idempotent success) from a real
            // failure to open the service.
            Err(error) if is_win32_error(&error, ERROR_SERVICE_DOES_NOT_EXIST) => {
                log::event("uninstall", "service already absent");
                Ok(())
            }
            Err(error) => Err(format!("open service: {error}")),
        }
    })();

    if let Err(error) = service_result {
        return fail(&error);
    }

    // Remove the secret, state, binary, and log. A missing tree is success; any
    // other removal error is reported, not swallowed.
    match std::fs::remove_dir_all(paths::state_dir()) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => warnings.push(format!("state removal failed: {error}")),
    }

    if warnings.is_empty() {
        emit(json!({ "ok": true, "installed": false, "running": false }));
    } else {
        for warning in &warnings {
            log::event("uninstall", warning);
        }
        emit(json!({
            "ok": true,
            "installed": false,
            "running": false,
            "warnings": warnings,
        }));
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
