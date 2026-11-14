//! The cursor lease the watchdog holds (MixCursorThemeLease and
//! MixWindowsCursorThemeApi, CursorTheme.cs:1-111): every standard role is
//! saved, replaced by a transparent cursor, and put back when the lease ends.

use std::ffi::c_void;
use windows::core::PCWSTR;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::UI::WindowsAndMessaging::{
    CopyImage, CreateCursor, DestroyCursor, LoadCursorW, SetSystemCursor, SystemParametersInfoW, HCURSOR,
    IMAGE_CURSOR, IMAGE_FLAGS, SPI_SETCURSORS, SYSTEM_CURSOR_ID, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
};

/// Every standard role: a busy, resize or not-allowed cursor left out would
/// show the real pointer under the overlay arrow (CursorTheme.cs:327-328).
pub const ROLES: [u32; 14] = [
    32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650, 32651,
];

/// A saved cursor, as the API names it.
pub type Backup = isize;

/// What the lease needs of the system (MixCursorThemeApi).
pub trait CursorApi {
    /// A copy of the role's current cursor; None when there is none.
    fn save(&self, role: u32) -> Option<Backup>;
    fn apply(&self, role: u32) -> Result<(), String>;
    fn restore(&self, role: u32, backup: Backup) -> bool;
    /// Reloads the user's configured scheme, never a hard-coded default.
    fn reset_configured_scheme(&self) -> bool;
    fn free(&self, backup: Backup);
}

pub const RESTORE_FAILED: &str = "input_cleanup_unconfirmed: system cursor restoration failed";

/// The saved roles and the ones already replaced. The lease stays owned by the
/// watchdog even when an apply fails: what changed is still put back.
pub struct Lease<A: CursorApi> {
    api: A,
    backups: Vec<(u32, Backup)>,
    changed: Vec<u32>,
}

impl<A: CursorApi> Lease<A> {
    /// Saves every role; one that cannot be saved frees the rest and fails.
    pub fn new(api: A, roles: &[u32]) -> Result<Lease<A>, String> {
        let mut lease = Lease { api, backups: Vec::new(), changed: Vec::new() };
        for &role in roles {
            match lease.api.save(role) {
                Some(backup) => lease.backups.push((role, backup)),
                None => {
                    // Nothing was changed yet, so freeing the saved copies is all there is to undo.
                    let _ = lease.dispose();
                    return Err("cursor backup unavailable".into());
                }
            }
        }
        Ok(lease)
    }

    pub fn activate(&mut self) -> Result<(), String> {
        for &(role, _) in &self.backups {
            self.changed.push(role);
            self.api.apply(role)?;
        }
        Ok(())
    }

    /// Puts the replaced roles back, newest first. A role that stays replaced
    /// falls back to reloading the configured scheme; when that fails too the
    /// lease keeps what it holds so a retry can try again.
    pub fn dispose(&mut self) -> Result<(), String> {
        let mut restored = true;
        for index in (0..self.changed.len()).rev() {
            let role = self.changed[index];
            let backup = self.backups.iter().find(|(saved, _)| *saved == role).map(|(_, backup)| *backup);
            if backup.is_some_and(|backup| self.api.restore(role, backup)) {
                self.changed.remove(index);
            } else {
                restored = false;
            }
        }
        if !restored {
            if !self.api.reset_configured_scheme() {
                return Err(RESTORE_FAILED.into());
            }
            self.changed.clear();
        }
        for (_, backup) in self.backups.drain(..) {
            self.api.free(backup);
        }
        Ok(())
    }
}

/// The system's cursors.
pub struct WinCursorApi;

/// Fully transparent artwork (AND plane all ones, XOR plane all zeros).
const AND_PLANE: [u8; 128] = [0xFF; 128];
const XOR_PLANE: [u8; 128] = [0; 128];
const ARTWORK_SIZE: i32 = 32;

fn handle_of(backup: Backup) -> HANDLE {
    HANDLE(backup as *mut c_void)
}

impl CursorApi for WinCursorApi {
    fn save(&self, role: u32) -> Option<Backup> {
        // SAFETY: the role is a predefined cursor id, which LoadCursorW takes in the name slot.
        let cursor = unsafe { LoadCursorW(None, PCWSTR(role as usize as *const u16)) }.ok()?;
        // SAFETY: the shared cursor handle is valid; the copy is ours to free.
        let copy = unsafe { CopyImage(HANDLE(cursor.0), IMAGE_CURSOR, 0, 0, IMAGE_FLAGS(0)) }.ok()?;
        Some(copy.0 as Backup)
    }

    fn apply(&self, role: u32) -> Result<(), String> {
        // SAFETY: the planes outlive the call and hold 32x32 monochrome bits each.
        let cursor = unsafe {
            CreateCursor(None, 0, 0, ARTWORK_SIZE, ARTWORK_SIZE, AND_PLANE.as_ptr().cast(), XOR_PLANE.as_ptr().cast())
        }
        .map_err(|_| "cursor artwork unavailable".to_string())?;
        // SAFETY: SetSystemCursor consumes the non-shared cursor on success; on failure it is ours to free.
        if unsafe { SetSystemCursor(cursor, SYSTEM_CURSOR_ID(role)) }.is_err() {
            let _ = unsafe { DestroyCursor(cursor) };
            return Err("cursor replacement unavailable".into());
        }
        Ok(())
    }

    fn restore(&self, role: u32, backup: Backup) -> bool {
        // SAFETY: the backup is a cursor this lease saved and has not freed.
        let Ok(copy) = (unsafe { CopyImage(handle_of(backup), IMAGE_CURSOR, 0, 0, IMAGE_FLAGS(0)) }) else {
            return false;
        };
        let cursor = HCURSOR(copy.0);
        // SAFETY: SetSystemCursor consumes the copy on success; on failure it is ours to free.
        if unsafe { SetSystemCursor(cursor, SYSTEM_CURSOR_ID(role)) }.is_ok() {
            return true;
        }
        let _ = unsafe { DestroyCursor(cursor) };
        false
    }

    fn reset_configured_scheme(&self) -> bool {
        // SAFETY: SPI_SETCURSORS takes no buffer; it reloads the scheme without writing the registry.
        unsafe { SystemParametersInfoW(SPI_SETCURSORS, 0, None, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0)) }.is_ok()
    }

    fn free(&self, backup: Backup) {
        // SAFETY: the backup is a cursor this lease saved and frees once.
        let _ = unsafe { DestroyCursor(HCURSOR(backup as *mut c_void)) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    /// A cursor table that logs every call; `broken` roles refuse to restore
    /// and `scheme_fails` makes the last resort fail too.
    #[derive(Default)]
    struct Fake {
        log: Rc<RefCell<Vec<String>>>,
        unsaved: Vec<u32>,
        unappliable: Vec<u32>,
        broken: Rc<RefCell<Vec<u32>>>,
        scheme_fails: bool,
    }

    impl CursorApi for Fake {
        fn save(&self, role: u32) -> Option<Backup> {
            self.log.borrow_mut().push(format!("save {role}"));
            (!self.unsaved.contains(&role)).then_some(role as Backup + 1000)
        }
        fn apply(&self, role: u32) -> Result<(), String> {
            self.log.borrow_mut().push(format!("apply {role}"));
            if self.unappliable.contains(&role) {
                return Err("no".into());
            }
            Ok(())
        }
        fn restore(&self, role: u32, backup: Backup) -> bool {
            self.log.borrow_mut().push(format!("restore {role} {backup}"));
            !self.broken.borrow().contains(&role)
        }
        fn reset_configured_scheme(&self) -> bool {
            self.log.borrow_mut().push("scheme".into());
            !self.scheme_fails
        }
        fn free(&self, backup: Backup) {
            self.log.borrow_mut().push(format!("free {backup}"));
        }
    }

    #[test]
    fn a_lease_saves_then_applies_and_restores_in_reverse() {
        let fake = Fake::default();
        let log = fake.log.clone();
        let mut lease = Lease::new(fake, &[1, 2]).expect("saved");
        lease.activate().expect("applied");
        lease.dispose().expect("restored");
        assert_eq!(
            *log.borrow(),
            ["save 1", "save 2", "apply 1", "apply 2", "restore 2 1002", "restore 1 1001", "free 1001", "free 1002"]
        );
    }

    #[test]
    fn a_role_that_cannot_be_saved_frees_the_saved_ones_and_changes_nothing() {
        let fake = Fake { unsaved: vec![2], ..Fake::default() };
        let log = fake.log.clone();
        assert_eq!(Lease::new(fake, &[1, 2, 3]).err().as_deref(), Some("cursor backup unavailable"));
        assert_eq!(*log.borrow(), ["save 1", "save 2", "free 1001"]);
    }

    #[test]
    fn an_apply_that_fails_still_leaves_the_replaced_roles_to_restore() {
        let fake = Fake { unappliable: vec![2], ..Fake::default() };
        let log = fake.log.clone();
        let mut lease = Lease::new(fake, &[1, 2, 3]).expect("saved");
        assert!(lease.activate().is_err());
        lease.dispose().expect("restored");
        // Role 2 was marked changed before its apply failed, so it is put back too; role 3 never was.
        assert!(log.borrow().iter().any(|call| call == "restore 2 1002"));
        assert!(!log.borrow().iter().any(|call| call.starts_with("restore 3")));
    }

    #[test]
    fn a_role_that_will_not_restore_resets_the_configured_scheme() {
        let fake = Fake { broken: Rc::new(RefCell::new(vec![1])), ..Fake::default() };
        let log = fake.log.clone();
        let mut lease = Lease::new(fake, &[1, 2]).expect("saved");
        lease.activate().expect("applied");
        lease.dispose().expect("the scheme reset recovers it");
        let calls = log.borrow();
        let scheme = calls.iter().position(|call| call == "scheme").expect("reset");
        let last_restore = calls.iter().rposition(|call| call.starts_with("restore")).expect("restores");
        assert!(last_restore < scheme, "the scheme is only the last resort: {calls:?}");
    }

    #[test]
    fn a_failed_scheme_reset_keeps_the_lease_for_a_retry() {
        let fake = Fake { broken: Rc::new(RefCell::new(vec![1])), scheme_fails: true, ..Fake::default() };
        let broken = fake.broken.clone();
        let log = fake.log.clone();
        let mut lease = Lease::new(fake, &[1]).expect("saved");
        lease.activate().expect("applied");
        assert_eq!(lease.dispose(), Err(RESTORE_FAILED.to_string()));
        assert!(!log.borrow().iter().any(|call| call.starts_with("free")), "the backup is kept");
        broken.borrow_mut().clear();
        lease.dispose().expect("the retry restores it");
        assert!(log.borrow().iter().any(|call| call == "free 1001"));
    }
}
