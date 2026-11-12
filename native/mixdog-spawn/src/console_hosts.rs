//! The console host a root leaves behind. Windows gives the hidden console a contained command runs in a console host
//! (`conhost.exe`), a member of the command's job that ends only after its last console client has. When the root ends on
//! its own the host is still exiting for a moment: it is no survivor (Node's `CONSOLE_HOST`, never a worker), so the tree
//! is judged once the hosts have signalled their own exit, not after a fixed wait.

use std::io;
use std::time::Duration;

use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;
use windows_sys::Win32::Foundation::ERROR_MORE_DATA;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
use windows_sys::Win32::System::JobObjects::IsProcessInJob;
use windows_sys::Win32::System::JobObjects::JOBOBJECT_BASIC_PROCESS_ID_LIST;
use windows_sys::Win32::System::JobObjects::JobObjectBasicProcessIdList;
use windows_sys::Win32::System::JobObjects::QueryInformationJobObject;
use windows_sys::Win32::System::Threading::OpenProcess;
use windows_sys::Win32::System::Threading::PROCESS_NAME_WIN32;
use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
use windows_sys::Win32::System::Threading::PROCESS_SYNCHRONIZE;
use windows_sys::Win32::System::Threading::QueryFullProcessImageNameW;
use windows_sys::Win32::System::Threading::WaitForMultipleObjects;
use windows_sys::Win32::System::Threading::WaitForSingleObject;

/// `MAXIMUM_WAIT_OBJECTS` (winnt.h): the most handles one `WaitForMultipleObjects` takes.
const MAXIMUM_WAIT_OBJECTS: usize = 64;

/// How long the console hosts of a finished root are given to signal their exit. A host outlives it only while a console
/// client is left, and every client is a member the job shows beside it, so this bounds a host that hangs.
pub(crate) const SETTLE_DEADLINE: Duration = Duration::from_secs(5);

/// An open process of a job: its pid names it until the handle closes.
struct Member(HANDLE);

impl Member {
    /// Whether it has signalled its exit.
    fn exited(&self) -> bool {
        (unsafe { WaitForSingleObject(self.0, 0) }) == WAIT_OBJECT_0
    }

    /// Whether it may be a console host on its way out: its image is `conhost.exe`, or its image can no longer be read,
    /// which Windows answers for a process already tearing down (access denied, or a device error once its image is
    /// unmapped). Either is waited on with the hosts; one that is in fact a survivor is still in the job at the deadline.
    fn may_be_exiting_host(&self) -> bool {
        let mut path = [0u16; 1024];
        let mut len = path.len() as u32;
        if unsafe { QueryFullProcessImageNameW(self.0, PROCESS_NAME_WIN32, path.as_mut_ptr(), &mut len) } == 0 {
            return true;
        }
        let path = String::from_utf16_lossy(&path[..len as usize]);
        path.rsplit('\\').next().is_some_and(|name| name.eq_ignore_ascii_case("conhost.exe"))
    }
}

impl Drop for Member {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// `job`'s processes as one look found them, each opened and confirmed a member; `None` when the job could not be
/// listed or a listed process could not be opened for a reason other than having ended.
fn members(job: HANDLE) -> Option<Vec<Member>> {
    let mut room = 32usize;
    let ids = loop {
        // The list's header (two u32s) takes one usize on 64-bit, then one usize per process.
        let mut buffer = vec![0usize; 1 + room];
        let ok = unsafe {
            QueryInformationJobObject(
                job,
                JobObjectBasicProcessIdList,
                buffer.as_mut_ptr().cast(),
                (buffer.len() * std::mem::size_of::<usize>()) as u32,
                std::ptr::null_mut(),
            )
        };
        let error = io::Error::last_os_error();
        let list = unsafe { &*buffer.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
        if ok != 0 && list.NumberOfProcessIdsInList == list.NumberOfAssignedProcesses {
            break buffer[1..1 + list.NumberOfProcessIdsInList as usize].to_vec();
        }
        if ok == 0 && error.raw_os_error() != Some(ERROR_MORE_DATA as i32) {
            return None;
        }
        room = (list.NumberOfAssignedProcesses as usize).max(room * 2);
    };
    let mut members = Vec::with_capacity(ids.len());
    for pid in ids {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE, 0, pid as u32) };
        if handle.is_null() {
            // A pid that names nothing any more ended between the list and the open.
            if io::Error::last_os_error().raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                continue;
            }
            return None;
        }
        let member = Member(handle);
        let mut inside = 0;
        if unsafe { IsProcessInJob(handle, job, &mut inside) } == 0 {
            return None;
        }
        // Otherwise the pid was freed and taken by a process outside the job.
        if inside != 0 {
            members.push(member);
        }
    }
    Some(members)
}

/// After a root that ended on its own: a job left holding nothing but console hosts and processes already exiting is
/// waited on until every one has exited, or for `deadline` at most; a job holding anything else has survivors and is not
/// waited on. `before_wait` runs
/// once it is known there are hosts to wait for.
pub(crate) fn settle(job: HANDLE, deadline: Duration, before_wait: impl FnOnce()) {
    let Some(mut members) = members(job) else {
        return;
    };
    // A member that already signalled its exit is leaving the job and is no survivor.
    members.retain(|member| !member.exited());
    if members.is_empty() || members.len() > MAXIMUM_WAIT_OBJECTS || !members.iter().all(Member::may_be_exiting_host) {
        return;
    }
    before_wait();
    let handles: Vec<HANDLE> = members.iter().map(|m| m.0).collect();
    unsafe { WaitForMultipleObjects(handles.len() as u32, handles.as_ptr(), 1, deadline.as_millis() as u32) };
}
