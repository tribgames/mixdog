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