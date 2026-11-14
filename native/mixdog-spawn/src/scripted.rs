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

/// The most bytes a frame may claim (scripted-pty.mjs `FRAME_MAX`); a header that claims more is the stand-in's error.
#[cfg(feature = "scripted-shell")]
const FRAME_MAX: usize = 1024 * 1024;

/// The longest frame header: [`FRAME_MAX`] in decimal and its `:`.
#[cfg(feature = "scripted-shell")]
const HEADER_MAX: usize = {
    let (mut digits, mut rest) = (1, FRAME_MAX / 10);
    while rest > 0 {
        digits += 1;
        rest /= 10;
    }
    digits + 1
};

/// The framed scripted shell: each line it reads is written back as chunks, each one frame flushed on its own: the chunk's length in
/// bytes in decimal, `:`, then the chunk's bytes (UTF-8), so a chunk may hold any byte and be of any length. A line
/// `@chunks <a>|<b>|…` writes the chunks `<a>`, `<b>`, … (`@chunks ` alone: one empty chunk), so one chunk can hold several lines and
/// one line can span chunks; `@fill <n>` writes one chunk of `n` bytes, `0123456789abcdef` repeated; any other line is one chunk, itself
/// ended `\r\n`; in every chunk `\n`, `\e` and `\a` (a backslash and a letter) are written as `\r\n`, ESC and BEL (so a chunk can carry
/// shell-integration markers), then `\xHH` (two lower-case hex digits) as that character; `@bytes <hex>|<hex>|…` writes each part's
/// bytes (lower-case hex, two digits a byte) as a chunk as they are, so a chunk may end inside a UTF-8 character; `@exit <code>` exits
/// with `code`.
/// The same program as benchmarks/rust-core/recorders/lib/scripted-pty.mjs `SCRIPTED_SHELL`, byte for byte. On Windows it calls no
/// cmdlet: loading one has PowerShell write a progress record (`#< CLIXML`) to the tab's output.
#[cfg(feature = "scripted-shell")]
pub fn framed_profile() -> SpawnProfile {
    #[cfg(windows)]
    {
        use base64::Engine;
        let script = "$in = [Console]::In; $out = [Console]::OpenStandardOutput(); $utf8 = [Text.Encoding]::UTF8; $nl = [string][char]13 + [char]10; $esc = [string][char]27; $bel = [string][char]7; while ($null -ne ($l = $in.ReadLine())) { if ($l -match '^@exit (\\d+)$') { exit [int]$Matches[1] }; if ($l -match '^@bytes (.*)$') { foreach ($x in $Matches[1].Split('|')) { $b = [byte[]]::new([int]($x.Length / 2)); for ($i = 0; $i -lt $b.Length; $i++) { $b[$i] = [Convert]::ToByte($x.Substring(2 * $i, 2), 16) }; $h = [Text.Encoding]::ASCII.GetBytes([string]$b.Length + ':'); $out.Write($h, 0, $h.Length); $out.Write($b, 0, $b.Length); $out.Flush() }; continue }; if ($l -match '^@fill (\\d+)$') { $n = [int]$Matches[1]; $chunks = @(('0123456789abcdef' * ($n / 16 + 1)).Substring(0, $n)) } elseif ($l -match '^@chunks (.*)$') { $chunks = $Matches[1].Split('|') } else { $chunks = @($l + '\\n') }; foreach ($c in $chunks) { $t = [regex]::Replace($c.Replace('\\n', $nl).Replace('\\e', $esc).Replace('\\a', $bel), '\\\\x([0-9a-f]{2})', { [string][char][Convert]::ToInt32($args[0].Groups[1].Value, 16) }); $b = $utf8.GetBytes($t); $h = [Text.Encoding]::ASCII.GetBytes([string]$b.Length + ':'); $out.Write($h, 0, $h.Length); $out.Write($b, 0, $b.Length); $out.Flush() } }";
        let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        SpawnProfile {
            path: "powershell.exe".into(),
            args: vec!["-NoProfile".into(), "-NonInteractive".into(), "-EncodedCommand".into(), base64::engine::general_purpose::STANDARD.encode(utf16)],
            env: Vec::new(),
        }
    }
    // `length` counts bytes in the C locale.
    #[cfg(not(windows))]
    SpawnProfile {
        path: "env".into(),
        args: vec![
            "LC_ALL=C".into(),
            "awk".into(),
            r#"function unhex(s,  o, h, d) { o = ""; h = "0123456789abcdef"; while (match(s, /\\x[0-9a-f][0-9a-f]/)) { d = (index(h, substr(s, RSTART + 2, 1)) - 1) * 16 + index(h, substr(s, RSTART + 3, 1)) - 1; o = o substr(s, 1, RSTART - 1) sprintf("%c", d); s = substr(s, RSTART + RLENGTH) } return o s } /^@exit [0-9]+$/ { exit substr($0, 7) + 0 } /^@bytes / { h = "0123456789abcdef"; n = split(substr($0, 8), c, "|"); for (i = 1; i <= n; i++) { o = ""; for (j = 1; j < length(c[i]); j += 2) o = o sprintf("%c", (index(h, substr(c[i], j, 1)) - 1) * 16 + index(h, substr(c[i], j + 1, 1)) - 1); printf "%d:%s", length(o), o; fflush() } next } { if ($0 ~ /^@fill [0-9]+$/) { m = substr($0, 7) + 0; f = ""; while (length(f) < m) f = f "0123456789abcdef"; n = 1; c[1] = substr(f, 1, m) } else if (sub(/^@chunks /, "")) { n = split($0, c, "|"); if (n == 0) { n = 1; c[1] = "" } } else { n = 1; c[1] = $0 "\\n" } for (i = 1; i <= n; i++) { gsub(/\\n/, "\r\n", c[i]); gsub(/\\e/, "\033", c[i]); gsub(/\\a/, "\007", c[i]); t = unhex(c[i]); printf "%d:%s", length(t), t; fflush() } }"#.into(),
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

/// The framed scripted shell's output pipe, read one whole frame at a time whatever the pipe joined or split and whatever the frame's
/// length or bytes ([`framed_profile`]): each frame is one output the tab takes, as each is one data event in Node's recording.
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

    /// The next frame's bytes; `None` once the pipe ended between frames. A header that is not a byte count (digits only, no sign) and
    /// `:`, one that claims more than [`FRAME_MAX`] bytes, or a pipe that ends inside a frame, is the stand-in's error (never a short
    /// chunk). The bytes are the tab's to decode, as one stream across frames (`crate::terminal::Utf8Decoder`, the tab's for its life).
    pub(crate) fn next_frame(&mut self) -> std::io::Result<Option<Vec<u8>>> {
        let broken = |what: String| std::io::Error::new(std::io::ErrorKind::InvalidData, format!("the scripted shell's output {what}"));
        loop {
            if let Some(colon) = self.pending.iter().take(HEADER_MAX).position(|byte| *byte == b':') {
                let length = std::str::from_utf8(&self.pending[..colon])
                    .ok()
                    .filter(|digits| !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
                    .and_then(|digits| digits.parse::<usize>().ok())
                    .ok_or_else(|| broken(format!("has a frame header that is not a byte count: {:?}", String::from_utf8_lossy(&self.pending[..colon]))))?;
                if length > FRAME_MAX {
                    return Err(broken(format!("has a frame of {length} bytes, more than the {FRAME_MAX} a frame may hold")));
                }
                if self.pending.len() > colon + length {
                    let frame = self.pending[colon + 1..colon + 1 + length].to_vec();
                    self.pending.drain(..colon + 1 + length);
                    return Ok(Some(frame));
                }
            } else if self.pending.len() >= HEADER_MAX {
                return Err(broken(format!("has no frame header: {:?}", String::from_utf8_lossy(&self.pending[..HEADER_MAX]))));
            }
            if self.ended {
                return match self.pending.len() {
                    0 => Ok(None),
                    n => Err(broken(format!("ended inside a frame ({n} bytes of it read)"))),
                };
            }
            let mut buffer = [0u8; 64 * 1024];
            match self.pipe.read(&mut buffer) {
                Ok(0) => self.ended = true,
                Ok(n) => self.pending.extend_from_slice(&buffer[..n]),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                // As the process manager's reader takes an error for the end.
                Err(_) => self.ended = true,
            }
        }
    }
}

#[cfg(all(test, feature = "scripted-shell"))]
mod tests {
    use std::io::Read;

    /// A pipe that hands out the given pieces, one per read.
    struct Pieces(std::collections::VecDeque<Vec<u8>>);
    impl Read for Pieces {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let Some(mut piece) = self.0.pop_front() else { return Ok(0) };
            let n = piece.len().min(out.len());
            out[..n].copy_from_slice(&piece[..n]);
            if n < piece.len() {
                self.0.push_front(piece.split_off(n));
            }
            Ok(n)
        }
    }

    fn frame(bytes: &[u8]) -> Vec<u8> {
        [format!("{}:", bytes.len()).into_bytes(), bytes.to_vec()].concat()
    }

    /// Every frame comes out whole and alone, however the pipe cut the stream: one holding RS and every other control byte, an empty one,
    /// one of 200 KiB (more than any one read of the pipe), then the end.
    #[test]
    fn each_frame_is_whole_whatever_its_bytes_or_length_or_how_the_pipe_cut_it() {
        let controls: Vec<u8> = (0u8..0x20).chain([0x7f]).collect();
        let big: Vec<u8> = b"0123456789abcdef".iter().copied().cycle().take(200 * 1024).collect();
        let stream = [frame(b"one\r\ntwo\r\n"), frame(&controls), frame(b""), frame(&big), frame(b"last")].concat();
        let pieces = [&stream[..3], &stream[3..17], &stream[17..40], &stream[40..]].map(<[u8]>::to_vec);
        let mut frames = super::Frames::new(Box::new(Pieces(pieces.into())));
        let mut got = Vec::new();
        while let Some(frame) = frames.next_frame().unwrap() {
            got.push(frame);
        }
        assert_eq!(got, [b"one\r\ntwo\r\n".to_vec(), controls, Vec::new(), big, b"last".to_vec()]);
    }

    /// What the tab makes of the frames (`TabFilter`: its one decoder pushes each frame, and finishes at the end of the output): a two-
    /// and a four-byte character each split across two frames come out whole, and a lead byte left at the end is one U+FFFD, as Node's
    /// StringDecoder makes of the same frames (scripted-pty.mjs `spawn`).
    #[test]
    fn the_frames_decode_as_one_stream_and_a_dangling_lead_byte_ends_as_one_replacement() {
        let pieces = [frame(b"a\xC3"), frame(b"\xA9"), frame(b"\xF0\x9F"), frame(b"\x98\x80"), frame(b"\xC3")].concat();
        let mut frames = super::Frames::new(Box::new(Pieces([pieces].into())));
        let mut decoder = crate::terminal::Utf8Decoder::default();
        let mut got = Vec::new();
        while let Some(frame) = frames.next_frame().unwrap() {
            got.push(decoder.push(&frame));
        }
        got.push(decoder.finish());
        assert_eq!(got, ["a", "é", "", "😀", "", "\u{FFFD}"]);
    }

    #[test]
    fn a_header_with_a_sign_or_over_the_cap_is_an_error() {
        for header in ["+1:a", "-1:a"] {
            let error = super::Frames::new(Box::new(Pieces([header.as_bytes().to_vec()].into()))).next_frame().unwrap_err();
            assert!(error.to_string().contains("not a byte count"), "{header}: {error}");
        }
        let over = format!("{}:", super::FRAME_MAX + 1).into_bytes();
        let error = super::Frames::new(Box::new(Pieces([over].into()))).next_frame().unwrap_err();
        assert!(error.to_string().contains("more than the 1048576"), "{error}");
        let at_cap = frame(&vec![b'x'; super::FRAME_MAX]);
        assert_eq!(super::Frames::new(Box::new(Pieces([at_cap].into()))).next_frame().unwrap().map(|frame| frame.len()), Some(super::FRAME_MAX));
    }

    #[test]
    fn a_pipe_that_ends_inside_a_frame_is_an_error() {
        let mut frames = super::Frames::new(Box::new(Pieces([frame(b"whole"), b"9:cut".to_vec()].into())));
        assert_eq!(frames.next_frame().unwrap(), Some(b"whole".to_vec()));
        let error = frames.next_frame().unwrap_err();
        assert!(error.to_string().contains("ended inside a frame"), "{error}");
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