//! Starting a Windows child. Shared by the stdio helper binary and the core library, which each
//! compile this file.
//!
//! The child is created inside its job object (`PROC_THREAD_ATTRIBUTE_JOB_LIST`), already
//! running: there is no instant at which it exists outside the job, and nothing is left suspended
//! when this process dies at any point. It inherits exactly the handles meant for it
//! (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`), never the pipe ends of another child this process runs.
#![allow(dead_code)]

use std::ffi::OsString;
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::io::BorrowedHandle;
use std::os::windows::io::RawHandle;
use std::os::windows::process::ExitStatusExt;
use std::path::Path;
use std::path::PathBuf;
use std::process::ExitStatus;

use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::Foundation::DUPLICATE_SAME_ACCESS;
use windows_sys::Win32::Foundation::DuplicateHandle;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
use windows_sys::Win32::System::Threading::CREATE_UNICODE_ENVIRONMENT;
use windows_sys::Win32::System::Threading::CreateProcessW;
use windows_sys::Win32::System::Threading::DeleteProcThreadAttributeList;
use windows_sys::Win32::System::Threading::EXTENDED_STARTUPINFO_PRESENT;
use windows_sys::Win32::System::Threading::GetCurrentProcess;
use windows_sys::Win32::System::Threading::GetExitCodeProcess;
use windows_sys::Win32::System::Threading::INFINITE;
use windows_sys::Win32::System::Threading::InitializeProcThreadAttributeList;
use windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_HANDLE_LIST;
use windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_JOB_LIST;
use windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE;
use windows_sys::Win32::System::Threading::PROCESS_INFORMATION;
use windows_sys::Win32::System::Threading::STARTF_USESTDHANDLES;
use windows_sys::Win32::System::Threading::STARTUPINFOEXW;
use windows_sys::Win32::System::Threading::TerminateProcess;
use windows_sys::Win32::System::Threading::UpdateProcThreadAttribute;
use windows_sys::Win32::System::Threading::WaitForSingleObject;

/// What the child's standard streams are.
pub(crate) enum Stdio<'a> {
    /// These handles; `None` is the null device. They stay the caller's: the child gets its own
    /// inheritable duplicates, closed here as soon as it exists.
    Handles {
        stdin: Option<BorrowedHandle<'a>>,
        stdout: Option<BorrowedHandle<'a>>,
        stderr: Option<BorrowedHandle<'a>>,
    },
    /// The pseudo-console (an `HPCON`); the child inherits no handle at all.
    Console(isize),
}

pub(crate) struct Spawn<'a> {
    pub program: &'a str,
    /// The whole Windows command line, program first.
    pub command_line: &'a str,
    pub cwd: Option<&'a Path>,
    /// The child's whole environment; `None` is this process's own.
    pub env: Option<&'a [(OsString, OsString)]>,
    pub stdio: Stdio<'a>,
}

/// A process started by [`spawn`].
pub(crate) struct WinProcess {
    pub(crate) pid: u32,
    handle: HANDLE,
}

unsafe impl Send for WinProcess {}
unsafe impl Sync for WinProcess {}

impl WinProcess {
    pub(crate) fn id(&self) -> u32 {
        self.pid
    }

    pub(crate) fn terminate(&self, code: u32) -> io::Result<()> {
        if unsafe { TerminateProcess(self.handle, code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(crate) fn wait(&mut self) -> io::Result<ExitStatus> {
        Ok(self.wait_for(INFINITE)?.expect("an infinite wait ends with the process"))
    }

    /// The exit status if the process has ended.
    pub(crate) fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.wait_for(0)
    }

    fn wait_for(&self, milliseconds: u32) -> io::Result<Option<ExitStatus>> {
        unsafe {
            match WaitForSingleObject(self.handle, milliseconds) {
                WAIT_OBJECT_0 => {}
                WAIT_TIMEOUT => return Ok(None),
                _ => return Err(io::Error::last_os_error()),
            }
            let mut code = 0u32;
            if GetExitCodeProcess(self.handle, &mut code) == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(Some(ExitStatus::from_raw(code)))
        }
    }
}

impl AsRawHandle for WinProcess {
    fn as_raw_handle(&self) -> RawHandle {
        self.handle.cast()
    }
}

impl Drop for WinProcess {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.handle) };
    }
}

fn wide(text: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    text.as_ref().encode_wide().chain(std::iter::once(0)).collect()
}

/// The environment block `CreateProcessW` takes: sorted by upper-cased name, double-NUL ended.
pub(crate) fn environment_block(env: &[(OsString, OsString)]) -> Vec<u16> {
    let mut sorted: Vec<&(OsString, OsString)> = env.iter().collect();
    sorted.sort_by_key(|(k, _)| k.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (key, value) in sorted {
        block.extend(key.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    if block.len() == 1 {
        block.push(0);
    }
    block
}

/// One command-line argument, quoted by the MSVCRT rules.
pub(crate) fn quote_windows_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        return arg.to_owned();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// What std's `Command` refuses before it creates anything: a NUL in the program, an argument, the
/// directory or the environment would truncate it or inject another variable.
fn ensure_no_nuls(text: &std::ffi::OsStr) -> io::Result<()> {
    if text.encode_wide().any(|unit| unit == 0) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "nul byte found in provided data"));
    }
    Ok(())
}

fn ensure_spec_has_no_nuls(spec: &Spawn<'_>) -> io::Result<()> {
    ensure_no_nuls(spec.program.as_ref())?;
    ensure_no_nuls(spec.command_line.as_ref())?;
    if let Some(cwd) = spec.cwd {
        ensure_no_nuls(cwd.as_os_str())?;
    }
    for (key, value) in spec.env.unwrap_or_default() {
        ensure_no_nuls(key)?;
        ensure_no_nuls(value)?;
    }
    Ok(())
}

unsafe extern "system" {
    fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    fn GetWindowsDirectoryW(buffer: *mut u16, size: u32) -> u32;
}

fn system_directory(get: unsafe extern "system" fn(*mut u16, u32) -> u32) -> Option<PathBuf> {
    let mut buffer = vec![0u16; 260];
    loop {
        let length = unsafe { get(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
        match length {
            0 => return None,
            n if n < buffer.len() => return Some(PathBuf::from(OsString::from_wide(&buffer[..n]))),
            n => buffer.resize(n, 0),
        }
    }
}

/// The executable `CreateProcessW` is given, resolved as std's `Command` does (a null application
/// name would search this process's current directory, which std never does). A program with a
/// separator is a path; a bare name is looked for in the child's `PATH` when its environment is
/// replaced, then the directory of this executable, the system and Windows directories, and last
/// this process's `PATH`.
fn resolve_program(program: &str, env: Option<&[(OsString, OsString)]>) -> io::Result<Vec<u16>> {
    if program.is_empty() || program.ends_with(['/', '\\']) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "program path has no file name"));
    }
    let exists = |path: &Path| std::fs::symlink_metadata(path).is_ok();
    // Absolute at lookup, as std's `to_user_path` does, so a later change of this process's current
    // directory cannot make `CreateProcessW` pick another file. For a path the caller named, a failure
    // to do so is the error; a searched candidate that cannot be made absolute is passed over.
    let absolute = |path: &Path| std::path::absolute(path).map(wide);
    if program.contains(['/', '\\']) {
        if program.len() >= 4 && program.as_bytes()[program.len() - 4..].eq_ignore_ascii_case(b".exe") {
            return absolute(Path::new(program));
        }
        let with_exe = format!("{program}.exe");
        return absolute(Path::new(if exists(Path::new(&with_exe)) { with_exe.as_str() } else { program }));
    }
    // "If the file name does not contain an extension, .exe is appended", for searched names only.
    let file = if program.contains('.') { program.to_owned() } else { format!("{program}.exe") };
    let child_path = env.and_then(|env| env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PATH")).map(|(_, v)| v));
    let directories = child_path
        .into_iter()
        .flat_map(|paths| std::env::split_paths(paths).collect::<Vec<_>>())
        .filter(|dir| !dir.as_os_str().is_empty())
        .chain(std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf)))
        .chain(system_directory(GetSystemDirectoryW))
        .chain(system_directory(GetWindowsDirectoryW))
        .chain(
            std::env::var_os("PATH")
                .into_iter()
                .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
                .filter(|dir| !dir.as_os_str().is_empty()),
        );
    directories
        .map(|dir| dir.join(&file))
        .filter(|candidate| exists(candidate))
        .find_map(|candidate| absolute(&candidate).ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "program not found"))
}

/// A handle the child may inherit, closed on drop.
struct Inheritable(HANDLE);

impl Inheritable {
    fn of(source: BorrowedHandle<'_>) -> io::Result<Self> {
        let mut duplicate: HANDLE = std::ptr::null_mut();
        let process = unsafe { GetCurrentProcess() };
        let ok = unsafe {
            DuplicateHandle(
                process,
                source.as_raw_handle().cast(),
                process,
                &mut duplicate,
                0,
                1,
                DUPLICATE_SAME_ACCESS,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self(duplicate))
    }
}

impl Drop for Inheritable {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}

/// The attribute list, deleted on drop. `storage` is the list itself.
struct AttributeList {
    storage: Vec<usize>,
}

impl AttributeList {
    fn new(count: u32) -> io::Result<Self> {
        let mut size = 0usize;
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), count, 0, &mut size) };
        let mut storage = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
        if unsafe { InitializeProcThreadAttributeList(storage.as_mut_ptr().cast(), count, 0, &mut size) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { storage })
    }

    fn raw(&mut self) -> *mut std::ffi::c_void {
        self.storage.as_mut_ptr().cast()
    }

    /// `value` must stay where it is until the process is created.
    fn set(&mut self, attribute: u32, value: *const std::ffi::c_void, size: usize) -> io::Result<()> {
        let ok = unsafe {
            UpdateProcThreadAttribute(self.raw(), 0, attribute as usize, value, size, std::ptr::null_mut(), std::ptr::null())
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.raw()) };
    }
}

/// Starts `spec` inside `job`.
pub(crate) fn spawn(job: HANDLE, spec: &Spawn<'_>) -> io::Result<WinProcess> {
    spawn_with(job, spec, || {})
}

/// [`spawn`], running `created` at the first instant the OS has the child, before this returns.
pub(crate) fn spawn_observed(job: HANDLE, spec: &Spawn<'_>, observe: impl FnOnce()) -> io::Result<WinProcess> {
    spawn_with(job, spec, observe)
}

fn spawn_with(job: HANDLE, spec: &Spawn<'_>, observe: impl FnOnce()) -> io::Result<WinProcess> {
    ensure_spec_has_no_nuls(spec)?;
    let application = resolve_program(spec.program, spec.env)?;
    let null_device;
    let (flags, inherit, duplicates) = match &spec.stdio {
        Stdio::Handles { stdin, stdout, stderr } => {
            let needs_null = stdin.is_none() || stdout.is_none() || stderr.is_none();
            null_device = if needs_null {
                Some(File::options().read(true).write(true).open("NUL")?)
            } else {
                None
            };
            let one = |handle: &Option<BorrowedHandle<'_>>| match (handle, &null_device) {
                (Some(handle), _) => Inheritable::of(*handle),
                (None, Some(null)) => Inheritable::of(borrow(null)),
                (None, None) => unreachable!("a missing stream opens the null device"),
            };
            (
                CREATE_NO_WINDOW,
                1,
                Some([one(stdin)?, one(stdout)?, one(stderr)?]),
            )
        }
        Stdio::Console(_) => (0, 0, None),
    };

    let mut list = AttributeList::new(2)?;
    let job_list = [job];
    list.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, job_list.as_ptr().cast(), std::mem::size_of::<HANDLE>())?;
    let handle_list = duplicates.as_ref().map(|d| [d[0].0, d[1].0, d[2].0]);
    match (&spec.stdio, &handle_list) {
        (Stdio::Handles { .. }, Some(handles)) => {
            list.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles.as_ptr().cast(), std::mem::size_of_val(handles))?;
        }
        (Stdio::Console(console), _) => {
            list.set(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, (*console as *const std::ffi::c_void).cast(), std::mem::size_of::<isize>())?;
        }
        (Stdio::Handles { .. }, None) => unreachable!("handles carry a handle list"),
    }

    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = list.raw();
    // Without STARTF_USESTDHANDLES a child whose parent has redirected standard handles (a
    // service, a test harness) would write to them instead of its console. Null handles with a
    // pseudo-console: the child then opens the pseudo-console's own.
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    if let Some(d) = &duplicates {
        startup.StartupInfo.hStdInput = d[0].0;
        startup.StartupInfo.hStdOutput = d[1].0;
        startup.StartupInfo.hStdError = d[2].0;
    }

    let mut command_line = wide(spec.command_line);
    let environment = spec.env.map(environment_block);
    let directory = spec.cwd.map(wide);
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            inherit,
            flags | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            environment.as_ref().map_or(std::ptr::null(), |e| e.as_ptr().cast()),
            directory.as_ref().map_or(std::ptr::null(), |d| d.as_ptr()),
            &startup.StartupInfo,
            &mut info,
        )
    };
    if created == 0 {
        return Err(io::Error::last_os_error());
    }
    unsafe { CloseHandle(info.hThread) };
    let process = WinProcess {
        pid: info.dwProcessId,
        handle: info.hProcess,
    };
    observe();
    Ok(process)
}

fn borrow(file: &File) -> BorrowedHandle<'_> {
    use std::os::windows::io::AsHandle;
    file.as_handle()
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::JobObjects::CreateJobObjectW;

    fn ping() -> String {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
        format!("{root}\\System32\\PING.EXE")
    }

    /// The error kind `spawn` refuses `program`/`command_line`/`env` with. A child that does start
    /// is killed, and the test fails.
    fn refusal(program: &str, command_line: &str, env: Option<&[(OsString, OsString)]>) -> io::ErrorKind {
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        assert!(!job.is_null());
        let started = spawn(
            job,
            &Spawn {
                program,
                command_line,
                cwd: None,
                env,
                stdio: Stdio::Handles { stdin: None, stdout: None, stderr: None },
            },
        );
        let kind = match started {
            Ok(process) => {
                let _ = process.terminate(1);
                unsafe { CloseHandle(job) };
                panic!("the spawn was accepted");
            }
            Err(error) => error.kind(),
        };
        unsafe { CloseHandle(job) };
        kind
    }

    #[test]
    fn a_nul_in_an_environment_value_is_refused() {
        let env = [(OsString::from("A"), OsString::from("x\0B=injected"))];
        let line = format!("{} -n 1 127.0.0.1", ping());
        assert_eq!(refusal(&ping(), &line, Some(&env)), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn a_nul_in_an_argument_is_refused() {
        let line = format!("{} -n 1\0 127.0.0.1", ping());
        assert_eq!(refusal(&ping(), &line, None), io::ErrorKind::InvalidInput);
    }

    /// An executable that is only in this process's current directory is not found: std's `Command`
    /// never searched it, and a null application name makes `CreateProcessW` do so.
    #[test]
    fn a_program_only_in_the_current_directory_is_not_found() {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        let name = format!("mixdog-cwd-only-{}", std::process::id());
        let dir = std::env::temp_dir().join(&name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::copy(ping(), dir.join(format!("{name}.exe"))).unwrap();
        // A process of its own, started in that directory, so no other test sees it as current. It is
        // created inside `job`: ending the job ends it and anything it started, on every path below.
        let exe = std::env::current_exe().unwrap().to_string_lossy().into_owned();
        let line = format!("\"{exe}\" --exact winspawn::tests::cwd_only_child --nocapture");
        let mut env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
        env.push((OsString::from("MIXDOG_CWD_ONLY"), OsString::from(&name)));
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        assert!(!job.is_null());
        let started = spawn(
            job,
            &Spawn {
                program: &exe,
                command_line: &line,
                cwd: Some(&dir),
                env: Some(&env),
                stdio: Stdio::Handles { stdin: None, stdout: None, stderr: None },
            },
        );
        let outcome = match &started {
            Ok(child) => child.wait_for(60_000).map_err(|error| error.to_string()),
            Err(error) => Err(error.to_string()),
        };
        unsafe { TerminateJobObject(job, 1) };
        if let Ok(child) = &started {
            // Ended above if it had not ended by itself: its directory is free once it is gone.
            let _ = child.wait_for(10_000);
        }
        unsafe { CloseHandle(job) };
        let _ = std::fs::remove_dir_all(&dir);
        let status = outcome.expect("the child check could not be started or waited for").expect("the child check did not finish within 60 s");
        assert!(status.success(), "the child check failed: {status}");
    }

    /// The body of the test above, run in the process it starts; a no-op in a normal run.
    #[test]
    fn cwd_only_child() {
        let Some(name) = std::env::var_os("MIXDOG_CWD_ONLY") else { return };
        let name = name.to_string_lossy().into_owned();
        let env = [(OsString::from("PATH"), OsString::new())];
        assert_eq!(refusal(&name, &name, Some(&env)), io::ErrorKind::NotFound);
    }

    #[test]
    fn a_relative_program_path_is_resolved_to_an_absolute_one() {
        for program in ["relative\\dir\\tool.exe", "relative\\dir\\tool"] {
            let resolved = resolve_program(program, None).unwrap();
            let path = PathBuf::from(OsString::from_wide(&resolved[..resolved.len() - 1]));
            assert!(path.is_absolute(), "{program} resolved to {path:?}");
        }
    }
}
