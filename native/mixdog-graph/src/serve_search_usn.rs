use std::collections::HashSet;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct FileIdentity {
    pub volume: u32,
    pub file_id: u64,
}

#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
pub struct JournalCheckpoint {
    pub volume: u16,
    pub volume_serial: u32,
    pub journal_id: u64,
    pub next_usn: i64,
}

#[derive(Clone, Default)]
pub struct SyncResult {
    pub trusted: bool,
    pub volume_serial: Option<u32>,
    pub changed: HashSet<u64>,
    pub parents: HashSet<u64>,
}

#[cfg(windows)]
mod platform {
    use super::{FileIdentity, SyncResult};
    use std::collections::{HashMap, HashSet};
    use std::ffi::c_void;
    use std::fs::File;
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::os::windows::io::AsRawHandle;
    use std::path::{Path, PathBuf};
    use std::ptr::{null, null_mut};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileIdType, GetFileInformationByHandle, GetFinalPathNameByHandleW,
        GetVolumeInformationByHandleW, OpenFileById, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_ID_DESCRIPTOR, FILE_ID_DESCRIPTOR_0, FILE_NAME_NORMALIZED,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Ioctl::{
        FSCTL_QUERY_USN_JOURNAL, FSCTL_READ_UNPRIVILEGED_USN_JOURNAL, FSCTL_READ_USN_JOURNAL,
        READ_USN_JOURNAL_DATA_V0, USN_JOURNAL_DATA_V0, USN_RECORD_V2,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;

    #[derive(Clone, Copy)]
    struct JournalCursor {
        volume_serial: u32,
        journal_id: u64,
        next_usn: i64,
        last_sync: Instant,
    }

    static CURSORS: OnceLock<Mutex<HashMap<u16, JournalCursor>>> = OnceLock::new();
    static FAILURES: OnceLock<Mutex<HashMap<u16, Instant>>> = OnceLock::new();

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn cursors() -> &'static Mutex<HashMap<u16, JournalCursor>> {
        CURSORS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn failures() -> &'static Mutex<HashMap<u16, Instant>> {
        FAILURES.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn note_failure(volume: u16) {
        failures()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(volume, Instant::now());
    }

    fn open_volume(volume: u16) -> Option<OwnedHandle> {
        let path = [
            '\\' as u16,
            '\\' as u16,
            '.' as u16,
            '\\' as u16,
            volume,
            ':' as u16,
            0,
        ];
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                GENERIC_READ,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        };
        (handle != INVALID_HANDLE_VALUE).then_some(OwnedHandle(handle))
    }

    fn query_journal(handle: HANDLE) -> Option<USN_JOURNAL_DATA_V0> {
        let mut journal: USN_JOURNAL_DATA_V0 = unsafe { zeroed() };
        let mut returned = 0u32;
        let ok = unsafe {
            DeviceIoControl(
                handle,
                FSCTL_QUERY_USN_JOURNAL,
                null(),
                0,
                &mut journal as *mut _ as *mut c_void,
                size_of::<USN_JOURNAL_DATA_V0>() as u32,
                &mut returned,
                null_mut(),
            )
        };
        (ok != 0 && returned as usize >= size_of::<USN_JOURNAL_DATA_V0>()).then_some(journal)
    }

    fn volume_serial(handle: HANDLE) -> Option<u32> {
        let mut serial = 0u32;
        let ok = unsafe {
            GetVolumeInformationByHandleW(
                handle,
                null_mut(),
                0,
                &mut serial,
                null_mut(),
                null_mut(),
                null_mut(),
                0,
            )
        };
        (ok != 0).then_some(serial)
    }

    fn read_changes(
        handle: HANDLE,
        start_usn: i64,
        end_usn: i64,
        journal_id: u64,
    ) -> Option<(i64, HashSet<u64>, HashSet<u64>)> {
        let mut cursor = start_usn;
        let mut changed = HashSet::new();
        let mut parents = HashSet::new();
        let mut output = vec![0u8; 1024 * 1024];
        while cursor < end_usn {
            let input = READ_USN_JOURNAL_DATA_V0 {
                StartUsn: cursor,
                ReasonMask: u32::MAX,
                ReturnOnlyOnClose: 0,
                Timeout: 0,
                BytesToWaitFor: 0,
                UsnJournalID: journal_id,
            };
            let mut returned = 0u32;
            let mut call = |code| unsafe {
                DeviceIoControl(
                    handle,
                    code,
                    &input as *const _ as *const c_void,
                    size_of::<READ_USN_JOURNAL_DATA_V0>() as u32,
                    output.as_mut_ptr() as *mut c_void,
                    output.len() as u32,
                    &mut returned,
                    null_mut(),
                )
            };
            let mut ok = call(FSCTL_READ_UNPRIVILEGED_USN_JOURNAL);
            if ok == 0 {
                ok = call(FSCTL_READ_USN_JOURNAL);
            }
            if ok == 0 || returned < size_of::<i64>() as u32 {
                return None;
            }
            let next = unsafe { std::ptr::read_unaligned(output.as_ptr() as *const i64) };
            let mut offset = size_of::<i64>();
            while offset + 8 <= returned as usize {
                let record_length =
                    unsafe { std::ptr::read_unaligned(output.as_ptr().add(offset) as *const u32) }
                        as usize;
                if record_length == 0 || offset + record_length > returned as usize {
                    return None;
                }
                let major = unsafe {
                    std::ptr::read_unaligned(output.as_ptr().add(offset + 4) as *const u16)
                };
                if major == 2 && record_length >= size_of::<USN_RECORD_V2>() {
                    let record = unsafe {
                        std::ptr::read_unaligned(output.as_ptr().add(offset) as *const USN_RECORD_V2)
                    };
                    changed.insert(record.FileReferenceNumber);
                    parents.insert(record.ParentFileReferenceNumber);
                }
                offset += record_length;
            }
            if next <= cursor {
                return None;
            }
            cursor = next;
        }
        Some((cursor, changed, parents))
    }

    pub fn volume_for_path(path: &Path) -> Option<u16> {
        let text = path.as_os_str().to_string_lossy();
        let bytes = text.as_bytes();
        if bytes.len() < 2 || bytes[1] != b':' || !bytes[0].is_ascii_alphabetic() {
            return None;
        }
        Some((bytes[0] as char).to_ascii_uppercase() as u16)
    }

    pub fn file_identity(file: &File) -> Option<FileIdentity> {
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
        let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &mut info) };
        (ok != 0).then_some(FileIdentity {
            volume: info.dwVolumeSerialNumber,
            file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        })
    }

    pub fn metadata_and_identity(path: &Path) -> Option<(std::fs::Metadata, Option<FileIdentity>)> {
        let file = File::open(path).ok()?;
        let metadata = file.metadata().ok()?;
        let identity = file_identity(&file);
        Some((metadata, identity))
    }

    pub fn path_identity(path: &Path) -> Option<FileIdentity> {
        let wide = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                null_mut(),
            )
        };
        let handle = (handle != INVALID_HANDLE_VALUE).then_some(OwnedHandle(handle))?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
        let ok = unsafe { GetFileInformationByHandle(handle.0, &mut info) };
        (ok != 0).then_some(FileIdentity {
            volume: info.dwVolumeSerialNumber,
            file_id: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
        })
    }

    pub fn resolve_file_ids(volume: u16, ids: &HashSet<u64>) -> Option<Vec<PathBuf>> {
        let volume = open_volume(volume)?;
        let mut paths = Vec::new();
        for &file_id in ids {
            let descriptor = FILE_ID_DESCRIPTOR {
                dwSize: size_of::<FILE_ID_DESCRIPTOR>() as u32,
                Type: FileIdType,
                Anonymous: FILE_ID_DESCRIPTOR_0 {
                    FileId: file_id as i64,
                },
            };
            let handle = unsafe {
                OpenFileById(
                    volume.0,
                    &descriptor,
                    FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    null(),
                    FILE_FLAG_BACKUP_SEMANTICS,
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                continue;
            }
            let handle = OwnedHandle(handle);
            let required =
                unsafe { GetFinalPathNameByHandleW(handle.0, null_mut(), 0, FILE_NAME_NORMALIZED) };
            if required == 0 {
                continue;
            }
            let mut buffer = vec![0u16; required as usize + 1];
            let written = unsafe {
                GetFinalPathNameByHandleW(
                    handle.0,
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    FILE_NAME_NORMALIZED,
                )
            };
            if written == 0 || written as usize >= buffer.len() {
                continue;
            }
            paths.push(PathBuf::from(std::ffi::OsString::from_wide(
                &buffer[..written as usize],
            )));
        }
        Some(paths)
    }

    pub fn sync_volume(volume: u16) -> SyncResult {
        if failures()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&volume)
            .is_some_and(|failed_at| failed_at.elapsed() < Duration::from_secs(30))
        {
            return SyncResult::default();
        }
        let previous = {
            let state = cursors().lock().unwrap_or_else(|error| error.into_inner());
            state.get(&volume).copied()
        };
        if let Some(previous) = previous {
            if previous.last_sync.elapsed() < Duration::from_millis(100) {
                return SyncResult {
                    trusted: true,
                    volume_serial: Some(previous.volume_serial),
                    changed: HashSet::new(),
                    parents: HashSet::new(),
                };
            }
        }
        let Some(handle) = open_volume(volume) else {
            cursors()
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&volume);
            note_failure(volume);
            return SyncResult::default();
        };
        let Some(journal) = query_journal(handle.0) else {
            cursors()
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&volume);
            note_failure(volume);
            return SyncResult::default();
        };
        let Some(serial) = volume_serial(handle.0) else {
            cursors()
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&volume);
            note_failure(volume);
            return SyncResult::default();
        };
        failures()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&volume);
        let Some(previous) = previous else {
            cursors()
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(
                    volume,
                    JournalCursor {
                        volume_serial: serial,
                        journal_id: journal.UsnJournalID,
                        next_usn: journal.NextUsn,
                        last_sync: Instant::now(),
                    },
                );
            return SyncResult {
                trusted: true,
                volume_serial: Some(serial),
                changed: HashSet::new(),
                parents: HashSet::new(),
            };
        };
        if previous.journal_id != journal.UsnJournalID
            || previous.next_usn < journal.FirstUsn
            || previous.next_usn > journal.NextUsn
        {
            cursors()
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&volume);
            note_failure(volume);
            return SyncResult::default();
        }
        let Some((next_usn, changed, parents)) = read_changes(
            handle.0,
            previous.next_usn,
            journal.NextUsn,
            journal.UsnJournalID,
        ) else {
            cursors()
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&volume);
            note_failure(volume);
            return SyncResult::default();
        };
        cursors()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                volume,
                JournalCursor {
                    volume_serial: serial,
                    journal_id: journal.UsnJournalID,
                    next_usn,
                    last_sync: Instant::now(),
                },
            );
        SyncResult {
            trusted: true,
            volume_serial: Some(serial),
            changed,
            parents,
        }
    }

    pub fn journal_checkpoints() -> Vec<super::JournalCheckpoint> {
        cursors()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|(&volume, cursor)| super::JournalCheckpoint {
                volume,
                volume_serial: cursor.volume_serial,
                journal_id: cursor.journal_id,
                next_usn: cursor.next_usn,
            })
            .collect()
    }

    pub fn restore_journal_checkpoints(checkpoints: &[super::JournalCheckpoint]) {
        let mut state = cursors().lock().unwrap_or_else(|error| error.into_inner());
        for checkpoint in checkpoints {
            let restored = JournalCursor {
                volume_serial: checkpoint.volume_serial,
                journal_id: checkpoint.journal_id,
                next_usn: checkpoint.next_usn,
                last_sync: Instant::now() - Duration::from_secs(1),
            };
            match state.get_mut(&checkpoint.volume) {
                Some(current)
                    if current.volume_serial == restored.volume_serial
                        && current.journal_id == restored.journal_id =>
                {
                    current.next_usn = current.next_usn.min(restored.next_usn);
                    current.last_sync = restored.last_sync;
                }
                Some(current) => *current = restored,
                None => {
                    state.insert(checkpoint.volume, restored);
                }
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{FileIdentity, SyncResult};
    use std::fs::File;
    use std::path::Path;

    pub fn volume_for_path(_path: &Path) -> Option<u16> {
        None
    }

    pub fn file_identity(_file: &File) -> Option<FileIdentity> {
        None
    }

    pub fn metadata_and_identity(path: &Path) -> Option<(std::fs::Metadata, Option<FileIdentity>)> {
        std::fs::metadata(path)
            .ok()
            .map(|metadata| (metadata, None))
    }

    pub fn path_identity(_path: &Path) -> Option<FileIdentity> {
        None
    }

    pub fn resolve_file_ids(
        _volume: u16,
        _ids: &std::collections::HashSet<u64>,
    ) -> Option<Vec<std::path::PathBuf>> {
        None
    }

    pub fn sync_volume(_volume: u16) -> SyncResult {
        SyncResult::default()
    }

    pub fn journal_checkpoints() -> Vec<super::JournalCheckpoint> {
        Vec::new()
    }

    pub fn restore_journal_checkpoints(_checkpoints: &[super::JournalCheckpoint]) {}
}

pub use platform::{
    file_identity, journal_checkpoints, metadata_and_identity, path_identity, resolve_file_ids,
    restore_journal_checkpoints, sync_volume, volume_for_path,
};

#[cfg(all(test, windows))]
mod tests {
    use super::{file_identity, path_identity, resolve_file_ids, sync_volume, volume_for_path};
    use std::collections::HashSet;
    use std::fs::{self, File};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn journal_reports_a_closed_file_change_when_available() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "mixdog-usn-change-{}-{nonce}.txt",
            std::process::id()
        ));
        fs::write(&path, b"before").expect("initial write");
        let file = File::open(&path).expect("open");
        let identity = file_identity(&file).expect("file identity");
        let parent_identity =
            path_identity(path.parent().expect("parent")).expect("parent identity");
        let volume = volume_for_path(&path).expect("drive volume");
        let first = sync_volume(volume);
        if !first.trusted {
            return;
        }
        drop(file);

        fs::write(&path, b"after").expect("changed write");
        let second = sync_volume(volume);
        assert!(second.trusted);
        assert!(second.changed.contains(&identity.file_id));
        assert!(second.parents.contains(&parent_identity.file_id));
        let resolved =
            resolve_file_ids(volume, &HashSet::from([identity.file_id])).expect("resolve file ids");
        let expected = path.to_string_lossy();
        assert!(resolved.iter().any(|candidate| {
            candidate
                .to_string_lossy()
                .trim_start_matches(r"\\?\")
                .eq_ignore_ascii_case(expected.trim_start_matches(r"\\?\"))
        }));
        fs::remove_file(path).expect("cleanup");
    }
}
