//! What this process starts ends when it ends, however it ends: a panic (`panic = "abort"`), a signal, an exit. Windows
//! has the kill-on-close job; POSIX has no such object, so a warden process does it. The process that starts children
//! installs one ([`install`]) and alone holds the write end of its input. A child it ties leads a session of its own and
//! names itself there before it execs ([`enter_session`]). When the input ends, its one writer gone, the warden kills every
//! process of each named session, then exits; a session named to end by an interrupt ([`End::Interrupt`]) has its leader
//! sent SIGINT first, and is killed once the leader has ended or its wait is over.
//!
//! A session is followed by its leader's pid and start token. While the leader runs, the token tells it from a later
//! process at its pid. Once the leader has ended, a process with the session's id is a member: a POSIX kernel gives no new
//! process a pid that is still the id of a session with a member, so the id can pass to another session only once the last
//! member has ended and the pid allocator has come round to it again (Linux and macOS hand pids out in rising order,
//! wrapping at the top). The warden looks at what it follows every second (`LOOK_EVERY`) and lets go of a session whose
//! leader's pid holds another process or that has nothing left, so an id it follows has not been free for longer than that.
//! What leaves the session is not reached: a descendant that leads a session of its own (`setsid`, a daemon), as a
//! process that breaks away from a Windows job, unless its starter names it ([`tie`]).

use std::io;
use std::sync::atomic::AtomicI32;
use std::sync::atomic::Ordering;

/// The write end of the warden's input, or -1 while none is installed.
static TIE: AtomicI32 = AtomicI32::new(-1);

/// For a pre-exec hook: makes the child the leader of a session of its own and names it to the warden, when one is
/// installed. Only async-signal-safe calls, nothing allocated. A warden that is gone fails the start: the child would
/// outlive this process.
pub fn enter_session() -> io::Result<()> {
    // SAFETY: setsid has no memory preconditions.
    if unsafe { libc::setsid() } < 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = TIE.load(Ordering::Acquire);
    if fd < 0 {
        return Ok(());
    }
    let mut line = [0u8; NAME_MAX];
    let len = name_line(std::process::id(), None, &mut line);
    // std resets SIGPIPE to its default before the hooks run: ignored around the write, an input that has no reader fails
    // the start instead of killing the child.
    // SAFETY: signal is async-signal-safe.
    unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) };
    let written = write_name(fd, &line[..len]);
    // SAFETY: as above.
    unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) };
    written
}

/// How the warden ends a session named to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum End {
    /// Every process of the session is killed at once.
    Kill,
    /// The leader is sent SIGINT, and the session is killed once the leader has ended or this long after the signal: for a
    /// server whose SIGINT is its clean stop. The other sessions are killed meanwhile.
    Interrupt(std::time::Duration),
}

/// Names to the warden, from the process that installed it, the session `pid` leads, to be ended as `end` says: a child
/// that left the session it was started in for one of its own (a server that detaches with `setsid`) then ends with this
/// process too. Nothing is named while no warden is installed.
pub fn tie(pid: u32, end: End) -> io::Result<()> {
    let fd = TIE.load(Ordering::Acquire);
    if fd < 0 {
        return Ok(());
    }
    let wait_ms = match end {
        End::Kill => None,
        End::Interrupt(wait) => Some(u32::try_from(wait.as_millis()).unwrap_or(u32::MAX)),
    };
    let mut line = [0u8; NAME_MAX];
    let len = name_line(pid, wait_ms, &mut line);
    write_name(fd, &line[..len])
}

/// One write of a name to the warden's input, again when interrupted. A name is at most PIPE_BUF bytes, so the write is whole
/// or fails, whatever other processes write at the same time. Async-signal-safe.
fn write_name(fd: i32, name: &[u8]) -> io::Result<()> {
    loop {
        // SAFETY: write is async-signal-safe; `name` outlives it.
        if unsafe { libc::write(fd, name.as_ptr().cast(), name.len()) } >= 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

/// The longest name: a pid, a space, a wait in milliseconds, a newline.
const NAME_MAX: usize = 22;

/// A name for the warden's input, into `out`: `pid` in decimal, then for a session ended by an interrupt a space and its
/// wait in milliseconds, then a newline; the length. Nothing is allocated.
fn name_line(pid: u32, wait_ms: Option<u32>, out: &mut [u8; NAME_MAX]) -> usize {
    let mut at = put_decimal(pid, out, 0);
    if let Some(wait_ms) = wait_ms {
        out[at] = b' ';
        at = put_decimal(wait_ms, out, at + 1);
    }
    out[at] = b'\n';
    at + 1
}

/// `n` in decimal into `out` from `at`; the position after it.
fn put_decimal(n: u32, out: &mut [u8], at: usize) -> usize {
    let mut digits = [0u8; 10];
    let (mut rest, mut count) = (n, 0);
    loop {
        digits[count] = b'0' + (rest % 10) as u8;
        rest /= 10;
        count += 1;
        if rest == 0 {
            break;
        }
    }
    for (offset, digit) in digits[..count].iter().rev().enumerate() {
        out[at + offset] = *digit;
    }
    at + count
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
pub use watch::install;
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub use watch::serve;

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod watch {
    use std::collections::HashMap;
    use std::collections::HashSet;
    use std::io::Read;
    use std::io::Write;
    use std::os::fd::AsFd;
    use std::os::fd::AsRawFd;
    use std::os::fd::IntoRawFd;
    use std::os::unix::process::CommandExt;
    use std::time::Duration;
    use std::time::Instant;

    use super::*;
    use crate::osproc::OsReader;
    use crate::osproc::OsSignals;
    use crate::tree::Identity;
    use crate::tree::Reader;
    use crate::tree::Row;
    use crate::tree::Signals;
    use crate::tree::Table;

    /// How often the followed sessions are looked at. The leader's start token settles every case in which a process holds
    /// the session's id as its pid: it is the named leader, or another process, which means the session emptied and is let
    /// go, never killed. It cannot settle a session whose leader has ended and whose id only members hold: those may be of
    /// another session if this one emptied, the pid allocator came round to the id again (it hands pids out in rising order
    /// and skips those in use), and the new process there made a session of its own and ended before its members did.
    /// Looking every second lets an emptied session go within a second, so that takes about `pid_max` process starts in
    /// that second (32 768 is the kernel's default, about 33 000 starts; systemd raises it to 4 194 304 on 64-bit systems;
    /// macOS wraps at 99 999) and the owner ending before the next look. It is made unlikely, not impossible.
    const LOOK_EVERY: Duration = Duration::from_secs(1);

    /// How often a leader sent SIGINT is looked at while its end is waited for, as the core's own stop looks at the
    /// postmaster it stopped.
    const ENDED_POLL: Duration = Duration::from_millis(50);

    /// Starts the warden as `program args…`, a program that runs [`serve`], and ties to this process every child started
    /// after it through [`enter_session`]. Called once, before the first child.
    pub fn install(program: &std::path::Path, args: &[&str]) -> io::Result<()> {
        // Both ends close on exec: no child holds the write end, so the input ends when this process does.
        let (input, tie) = std::io::pipe()?;
        let mut command = std::process::Command::new(program);
        command.args(args).stdin(input).stdout(std::process::Stdio::null());
        // A session of its own: what a terminal sends this process's group does not end the warden first.
        // SAFETY: the hook only calls the async-signal-safe setsid.
        unsafe {
            command.pre_exec(|| if libc::setsid() < 0 { Err(io::Error::last_os_error()) } else { Ok(()) });
        }
        let mut warden = command.spawn()?;
        drop(command);
        TIE.store(tie.into_raw_fd(), Ordering::Release);
        std::thread::Builder::new().name("mixdog-warden".to_owned()).spawn(move || {
            let status = warden.wait();
            let _ = writeln!(
                std::io::stderr(),
                "[mixdog-spawn] the warden ended before its owner ({status:?}): a child started from now on fails to start, nothing would end it with this process"
            );
        })?;
        Ok(())
    }

    /// The warden's program: follows the sessions its owner's children name until its input ends, then ends them (the
    /// module's doc). Fails when the process table cannot be read at the end.
    pub fn serve() -> std::process::ExitCode {
        let ended = std::io::stdin().as_fd().try_clone_to_owned().and_then(|input| watch(std::fs::File::from(input)));
        match ended {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(error) => {
                let _ = writeln!(std::io::stderr(), "mixdogd warden: {error}");
                std::process::ExitCode::FAILURE
            }
        }
    }

    /// A session as it was named: its id, which is its leader's pid, the leader's start token if the leader could still be
    /// read then, and the wait of an [`End::Interrupt`].
    struct Session {
        sid: u32,
        token: Option<String>,
        interrupt: Option<Duration>,
    }

    pub(super) fn watch(mut input: impl Read + AsFd) -> io::Result<()> {
        let mut followed: Vec<Session> = Vec::new();
        let mut line: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        let mut next_look = Instant::now();
        loop {
            // With nothing followed nothing needs looking at: the wait is for the next name or the end.
            let wait =
                if followed.is_empty() { -1 } else { i32::try_from(next_look.saturating_duration_since(Instant::now()).as_millis()).unwrap_or(i32::MAX) };
            let mut ready = libc::pollfd { fd: input.as_fd().as_raw_fd(), events: libc::POLLIN, revents: 0 };
            // A wait that fails (an interrupt, a passing lack of memory) is waited again.
            // SAFETY: one pollfd, alive across the call.
            if unsafe { libc::poll(&mut ready, 1, wait) } > 0 {
                // A read that fails ends the following as the end of the input does: nothing more can be named.
                match input.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => named(&chunk[..read], &mut line, &mut followed),
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }
            if Instant::now() >= next_look {
                look(&mut followed);
                next_look = Instant::now() + LOOK_EVERY;
            }
        }
        end(&followed)
    }

    /// Follows the session named by each line `bytes` ends; `line` holds what came of a line not ended yet.
    fn named(bytes: &[u8], line: &mut Vec<u8>, followed: &mut Vec<Session>) {
        for &byte in bytes {
            if byte != b'\n' {
                line.push(byte);
                continue;
            }
            let parsed = std::str::from_utf8(line).ok().and_then(|text| {
                let (pid, wait_ms) = match text.split_once(' ') {
                    Some((pid, wait_ms)) => (pid, Some(wait_ms.parse::<u64>().ok()?)),
                    None => (text, None),
                };
                Some((pid.parse::<u32>().ok()?, wait_ms.map(Duration::from_millis)))
            });
            if let Some((sid, interrupt)) = parsed {
                followed.push(Session { sid, token: OsReader::identity(sid), interrupt });
            }
            line.clear();
        }
    }

    /// Lets go of the sessions that have ended. The table is read only for a session whose leader is gone; a row or a table
    /// that cannot be read lets nothing go.
    fn look(followed: &mut Vec<Session>) {
        let mut members: Option<Option<HashMap<u32, Vec<Identity>>>> = None;
        followed.retain(|session| {
            let Ok(leader) = OsReader.row(session.sid) else { return true };
            held(session, leader, || {
                members
                    .get_or_insert_with(|| OsReader.table().ok().map(|table| sessions(&table)))
                    .as_ref()
                    .is_none_or(|members| members.contains_key(&session.sid))
            })
        });
    }

    /// Every readable process by its session id.
    fn sessions(table: &Table) -> HashMap<u32, Vec<Identity>> {
        let mut sessions: HashMap<u32, Vec<Identity>> = HashMap::new();
        for proc in table.procs() {
            // SAFETY: getsid has no memory preconditions.
            let sid = unsafe { libc::getsid(proc.pid as libc::pid_t) };
            if sid > 0 {
                sessions.entry(sid as u32).or_default().push(Identity { pid: proc.pid, token: proc.token.clone() });
            }
        }
        sessions
    }

    /// Whether `session` may still hold a process, from the row of its leader's pid: the leader is the process that was named,
    /// or is gone and something still has the session's id (`occupied`). Another process at the leader's pid means the session
    /// emptied first.
    fn held(session: &Session, leader: Row, occupied: impl FnOnce() -> bool) -> bool {
        match leader {
            Row::Readable(proc) => session.token.as_ref() == Some(&proc.token),
            Row::Absent | Row::Unreadable => occupied(),
        }
    }

    /// Ends the held sessions: the leader of each one named to end by an interrupt is sent SIGINT, every other session is
    /// killed, then each interrupted leader is waited for until it has ended or its wait is over, and its session is killed.
    /// A session whose leader is gone, or could not be signalled, is killed at once.
    fn end(followed: &[Session]) -> io::Result<()> {
        let table: Table = OsReader.table()?;
        let sessions = sessions(&table);
        let held: Vec<&Session> = followed.iter().filter(|session| held(session, table.row(session.sid), || sessions.contains_key(&session.sid))).collect();
        let interrupted: Vec<(&Session, Instant)> = held
            .iter()
            .filter_map(|session| {
                let wait = session.interrupt?;
                interrupt(session).then(|| (*session, Instant::now() + wait))
            })
            .collect();
        let at_once: HashSet<u32> = held.iter().map(|session| session.sid).filter(|sid| !interrupted.iter().any(|(session, _)| session.sid == *sid)).collect();
        kill_sessions(&at_once)?;
        for (session, until) in &interrupted {
            while leader_runs(session) {
                let left = until.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                std::thread::sleep(ENDED_POLL.min(left));
            }
        }
        kill_sessions(&interrupted.iter().map(|(session, _)| session.sid).collect())
    }

    /// SIGINT to the session's leader, sent only once its row, read right before, shows the process that was named (as a
    /// kill by identity is checked); whether it was sent.
    fn interrupt(session: &Session) -> bool {
        matches!(OsReader.row(session.sid), Ok(Row::Readable(proc)) if session.token.as_ref() == Some(&proc.token))
            // SAFETY: a signal to the pid whose row just showed the named leader.
            && unsafe { libc::kill(session.sid as libc::pid_t, libc::SIGINT) } == 0
    }

    /// Whether the named leader still runs: its row shows its token, or cannot be read.
    fn leader_runs(session: &Session) -> bool {
        match OsReader.row(session.sid) {
            Ok(Row::Readable(proc)) => session.token.as_ref() == Some(&proc.token),
            Ok(Row::Absent) => false,
            Ok(Row::Unreadable) | Err(_) => true,
        }
    }

    /// Kills every process of the sessions `held`, round after round until a table shows none that was not signalled yet: a
    /// process forked by a member before the member's kill shows in the next round. One signalled that has not ended yet
    /// (in an uninterruptible wait, or not ours to signal) is not waited for.
    fn kill_sessions(held: &HashSet<u32>) -> io::Result<()> {
        if held.is_empty() {
            return Ok(());
        }
        let mut signalled: HashSet<Identity> = HashSet::new();
        loop {
            let sessions = sessions(&OsReader.table()?);
            let members: Vec<Identity> =
                held.iter().filter_map(|sid| sessions.get(sid)).flatten().filter(|member| !signalled.contains(*member)).cloned().collect();
            if members.is_empty() {
                return Ok(());
            }
            for member in members {
                OsSignals.kill_identified(&member);
                signalled.insert(member);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tests that hold the warden's input, one at a time.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn a_name_is_written_in_decimal_with_its_wait_and_newline() {
        let mut line = [0u8; NAME_MAX];
        let len = name_line(0, None, &mut line);
        assert_eq!(&line[..len], b"0\n");
        let len = name_line(u32::MAX, None, &mut line);
        assert_eq!(&line[..len], b"4294967295\n");
        let len = name_line(u32::MAX, Some(u32::MAX), &mut line);
        assert_eq!(&line[..len], b"4294967295 4294967295\n");
    }

    /// The defect this catches: a server tied to stop on SIGINT (the memory's PostgreSQL) was killed at once when its owner
    /// ended, losing what its clean stop keeps.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn an_interrupted_session_gets_its_sigint_and_is_killed_only_after_its_wait() {
        use std::os::fd::IntoRawFd;
        use std::os::unix::process::CommandExt;
        use std::os::unix::process::ExitStatusExt;

        let _serial = SERIAL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (input, tie_end) = std::io::pipe().unwrap();
        TIE.store(tie_end.into_raw_fd(), Ordering::Release);
        let warden = std::thread::spawn(move || watch::watch(input));
        let leader = |script: &str| {
            let mut shell = std::process::Command::new("sh");
            shell.args(["-c", script]);
            // SAFETY: the hook only calls the async-signal-safe setsid.
            unsafe { shell.pre_exec(|| if libc::setsid() < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }) };
            shell.spawn().unwrap()
        };
        let mut stops = leader("trap 'exit 7' INT; while :; do sleep 0.1; done");
        let mut ignores = leader("trap '' INT; while :; do sleep 0.1; done");
        tie(stops.id(), End::Interrupt(std::time::Duration::from_secs(30))).unwrap();
        tie(ignores.id(), End::Interrupt(std::time::Duration::from_millis(300))).unwrap();
        // The owner's end: the last writer of the warden's input closes.
        // SAFETY: the descriptor is the write end stored above, closed once.
        unsafe { libc::close(TIE.swap(-1, Ordering::AcqRel)) };
        warden.join().unwrap().unwrap();
        assert_eq!(stops.wait().unwrap().code(), Some(7), "the leader stopped on its SIGINT");
        assert_eq!(ignores.wait().unwrap().signal(), Some(libc::SIGKILL), "a leader still running after its wait was killed");
    }

    /// The defect this catches: a child of a process that aborted kept running, with the background job it started.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn a_tied_session_and_its_background_job_end_when_the_owner_is_gone() {
        use std::io::BufRead;
        use std::io::Read;
        use std::os::fd::IntoRawFd;
        use std::os::unix::process::CommandExt;
        use std::os::unix::process::ExitStatusExt;

        let _serial = SERIAL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let (input, tie) = std::io::pipe().unwrap();
        TIE.store(tie.into_raw_fd(), Ordering::Release);
        let warden = std::thread::spawn(move || watch::watch(input));
        let mut shell = std::process::Command::new("sh");
        shell.args(["-c", "sleep 600 & echo $!; wait"]).stdout(std::process::Stdio::piped());
        // SAFETY: the hook is enter_session, async-signal-safe.
        unsafe { shell.pre_exec(enter_session) };
        let mut shell = shell.spawn().unwrap();
        let mut output = std::io::BufReader::new(shell.stdout.take().unwrap());
        let mut job = String::new();
        output.read_line(&mut job).unwrap();
        let job: libc::pid_t = job.trim().parse().unwrap();
        // The owner's end: the last writer of the warden's input closes.
        // SAFETY: the descriptor is the write end stored above, closed once.
        unsafe { libc::close(TIE.swap(-1, Ordering::AcqRel)) };
        warden.join().unwrap().unwrap();
        // The background job holds the shell's output too: the output ends when both have ended.
        let (done, ended) = std::sync::mpsc::channel();
        std::thread::spawn(move || drop(done.send(output.read_to_end(&mut Vec::new()))));
        if ended.recv_timeout(std::time::Duration::from_secs(10)).is_err() {
            // SAFETY: a signal to the job this test started.
            unsafe { libc::kill(job, libc::SIGKILL) };
            panic!("the background job of the tied session outlived its owner");
        }
        assert_eq!(shell.wait().unwrap().signal(), Some(libc::SIGKILL), "the session's leader was killed");
    }
}
