//! A scripted shell for tests that compare a tab's text with Node's recording. The tab runs over pipes (`TerminalConfig::piped`), and
//! the child writes back exactly the lines it is sent, each ended `\r\n`, and exits with the code of a line `@exit <code>`. Nothing else
//! reaches the replay window, so what a tab holds is what the test said. Every wait is on the tab's own feed: a line is
//! over when the feed carried its echo, the exit when the feed carried the exit event.

use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_protocol::ProcessHandle;

use crate::manager::LocalProcessManager;
use crate::terminal::SpawnProfile;
use crate::terminal::TerminalTabs;

/// The scripted shell. With arguments, so the tab layer adds no shell integration of its own; on Windows it is PowerShell, so
/// the tab's label is the one Node recorded.
pub fn profile() -> SpawnProfile {
    #[cfg(windows)]
    {
        use base64::Engine;
        let script = "$in = [Console]::In; $out = [Console]::Out; while ($null -ne ($l = $in.ReadLine())) { if ($l -match '^@exit (\\d+)$') { exit [int]$Matches[1] }; $out.Write($l + [char]13 + [char]10); $out.Flush() }";
        let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        SpawnProfile {
            path: "powershell.exe".into(),
            args: vec!["-NoProfile".into(), "-NonInteractive".into(), "-EncodedCommand".into(), base64::engine::general_purpose::STANDARD.encode(utf16)],
            env: Vec::new(),
        }
    }
    #[cfg(not(windows))]
    SpawnProfile {
        path: "sh".into(),
        args: vec!["-c".into(), r#"while IFS= read -r l; do case "$l" in '@exit '*) exit "${l#@exit }";; esac; printf '%s\r\n' "$l"; done"#.into()],
        env: Vec::new(),
    }
}

/// Set (non-empty) in the environment of a `mixdogd` built with `scripted-shell`: every terminal tab runs [`framed_profile`] over pipes in
/// place of the shell it planned, its output read one scripted chunk at a time ([`Frames`]). The tab layer (shell plan, marker scanner,
/// replay buffer, exit line, relay framing) runs unchanged on what the scripted shell writes; Node's recording runs the same program in
/// place of node-pty and hands its terminal manager one data event per chunk (benchmarks/rust-core/recorders/lib/scripted-pty.mjs).
#[cfg(feature = "scripted-shell")]
pub const SCRIPTED_SHELL_VAR: &str = "MIXDOG_TERMINAL_SCRIPTED_SHELL";

/// What ends each chunk the framed scripted shell writes (ASCII RS); never part of a chunk.
#[cfg(feature = "scripted-shell")]
pub const FRAME_END: u8 = 0x1e;

/// The framed scripted shell: each line it reads is written back as chunks, each ended [`FRAME_END`] and flushed on its own. A line
/// `@chunks <a>|<b>|…` writes the chunks `<a>`, `<b>`, …, so one chunk can hold several lines and one line can span chunks; any other
/// line is one chunk, itself ended `\r\n`; in every chunk `\n`, `\e` and `\a` (a backslash and a letter) are written as `\r\n`, ESC and
/// BEL (so a chunk can carry shell-integration markers); `@exit <code>` exits with `code`.
/// The same program as benchmarks/rust-core/recorders/lib/scripted-pty.mjs `SCRIPTED_SHELL`, byte for byte.
#[cfg(feature = "scripted-shell")]
pub fn framed_profile() -> SpawnProfile {
    #[cfg(windows)]
    {
        use base64::Engine;
        let script = "$in = [Console]::In; $out = [Console]::Out; $nl = [string][char]13 + [char]10; $esc = [string][char]27; $bel = [string][char]7; $end = [string][char]30; while ($null -ne ($l = $in.ReadLine())) { if ($l -match '^@exit (\\d+)$') { exit [int]$Matches[1] }; if ($l -match '^@chunks (.*)$') { $chunks = $Matches[1].Split('|') } else { $chunks = @($l + '\\n') }; foreach ($c in $chunks) { $out.Write($c.Replace('\\n', $nl).Replace('\\e', $esc).Replace('\\a', $bel) + $end); $out.Flush() } }";
        let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        SpawnProfile {
            path: "powershell.exe".into(),
            args: vec!["-NoProfile".into(), "-NonInteractive".into(), "-EncodedCommand".into(), base64::engine::general_purpose::STANDARD.encode(utf16)],
            env: Vec::new(),
        }
    }
    #[cfg(not(windows))]
    SpawnProfile {
        path: "awk".into(),
        args: vec![
            r#"/^@exit [0-9]+$/ { exit substr($0, 7) + 0 } { if (sub(/^@chunks /, "")) n = split($0, c, "|"); else { n = 1; c[1] = $0 "\\n" } for (i = 1; i <= n; i++) { gsub(/\\n/, "\r\n", c[i]); gsub(/\\e/, "\033", c[i]); gsub(/\\a/, "\007", c[i]); printf "%s\036", c[i]; fflush() } }"#.into(),
        ],
        env: Vec::new(),
    }
}

/// `request` with the framed scripted shell over pipes in place of its program and PTY, while [`SCRIPTED_SHELL_VAR`] is set; true when
/// it was put in place, so the spawn reads its output through [`Frames`].
#[cfg(feature = "scripted-shell")]
pub(crate) fn in_place_of(request: &mut mixdog_core_api::domain::process::SpawnRequest) -> bool {
    if std::env::var_os(SCRIPTED_SHELL_VAR).is_none_or(|value| value.is_empty()) {
        return false;
    }
    let shell = framed_profile();
    request.command = mixdog_core_api::domain::process::CommandSpec::Argv { program: shell.path, args: shell.args };
    request.pty = None;
    true
}

/// The framed scripted shell's output pipe, read one chunk per `read` whatever the pipe joined or split: each `read` returns exactly the
/// bytes of the next chunk without its [`FRAME_END`] (a chunk longer than the caller's buffer, in reads of that buffer's size), so each
/// chunk is one read of the process manager's reader and one output the tab takes, as each is one data event in Node's recording. What
/// the shell left unended when the pipe closed is returned last.
#[cfg(feature = "scripted-shell")]
pub(crate) struct Frames {
    pipe: Box<dyn std::io::Read + Send>,
    pending: Vec<u8>,
    ended: bool,
}

#[cfg(feature = "scripted-shell")]
impl Frames {
    pub(crate) fn new(pipe: Box<dyn std::io::Read + Send>) -> Self {
        Self { pipe, pending: Vec::new(), ended: false }
    }
}

#[cfg(feature = "scripted-shell")]
impl std::io::Read for Frames {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let end = self.pending.iter().position(|byte| *byte == FRAME_END);
            if end == Some(0) {
                self.pending.remove(0);
                continue;
            }
            if let Some(end) = end.or(self.ended.then_some(self.pending.len())) {
                let n = end.min(out.len());
                out[..n].copy_from_slice(&self.pending[..n]);
                let whole = n == end && n < self.pending.len();
                self.pending.drain(..n + usize::from(whole));
                return Ok(n);
            }
            let mut buffer = [0u8; 8 * 1024];
            match self.pipe.read(&mut buffer) {
                Ok(0) => self.ended = true,
                Ok(n) => self.pending.extend_from_slice(&buffer[..n]),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => return Err(error),
                // As the reader takes an error for the end: what was read before it still goes out.
                Err(_) => self.ended = true,
            }
        }
    }
}

#[cfg(all(test, feature = "scripted-shell"))]
mod tests {
    use std::io::Read;

    /// A pipe that hands out the given pieces, one per read.
    struct Pieces(std::collections::VecDeque<&'static [u8]>);
    impl Read for Pieces {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let Some(piece) = self.0.pop_front() else { return Ok(0) };
            out[..piece.len()].copy_from_slice(piece);
            Ok(piece.len())
        }
    }

    #[test]
    fn each_read_is_one_chunk_whatever_the_pipe_joined_or_split() {
        let pipe = Pieces([&b"one\r\ntwo\r\n\x1esp"[..], b"l", b"it\x1e\x1elast\x1eun", b"ended"].into());
        let mut frames = super::Frames::new(Box::new(pipe));
        let mut buffer = [0u8; 64];
        let mut reads = Vec::new();
        loop {
            let n = frames.read(&mut buffer).unwrap();
            if n == 0 {
                break;
            }
            reads.push(String::from_utf8(buffer[..n].to_vec()).unwrap());
        }
        assert_eq!(reads, ["one\r\ntwo\r\n", "split", "last", "unended"]);
    }
}

/// Sends `lines` to the tab and returns once its feed carried them back, so the replay window holds them.
pub async fn say(tabs: &TerminalTabs, manager: &LocalProcessManager, id: &str, lines: &[&str]) {
    let wanted: String = lines.iter().map(|line| format!("{line}\r\n")).collect();
    let mut events = manager.subscribe(&ProcessHandle::from(id), None).expect("subscribe");
    if let Some(pending) = tabs.write(id, &lines.iter().map(|line| format!("{line}\n")).collect::<String>()) {
        pending.finish().await;
    }
    let mut seen = String::new();
    while seen.len() < wanted.len() {
        match events.next().await.expect("the feed outlives the wait") {
            ProcessEvent::Output { bytes, .. } => seen.push_str(&String::from_utf8_lossy(&bytes)),
            ProcessEvent::Exited { .. } => panic!("the scripted shell exited while it was spoken to"),
        }
    }
    assert_eq!(seen, wanted, "the scripted shell echoes exactly what it was sent");
}

/// Has the tab's scripted shell exit with `code`, and returns once its feed carried the exit.
pub async fn exit(tabs: &TerminalTabs, manager: &LocalProcessManager, id: &str, code: u8) {
    let mut events = manager.subscribe(&ProcessHandle::from(id), None).expect("subscribe");
    if let Some(pending) = tabs.write(id, &format!("@exit {code}\n")) {
        pending.finish().await;
    }
    loop {
        if let ProcessEvent::Exited { .. } = events.next().await.expect("the feed ends with the exit") {
            return;
        }
    }
}