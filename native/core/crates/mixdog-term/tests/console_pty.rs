//! The raw console, the reader and the guard on a real terminal.
//!
//! Unix: a test program (this test binary run again on `unix_pty::pty_child`) enters the screen, turns raw mode on, reads
//! keys and a resize, and ends either on the Ctrl+C byte or on a SIGINT; the parent drives it through a pseudo-terminal and
//! replays the bytes it wrote through a VT parser: the byte stream is the recorded modes, the keys arrive as bytes, the
//! resize is reported and the terminal is back on the main screen with the cursor shown and every mouse and paste mode off.
//!
//! Windows: an ignored test checks the console mode flags on a real console (`-- --ignored windows_console_modes`).

#[cfg(unix)]
mod unix_pty {
    use std::collections::BTreeSet;
    use std::sync::mpsc::{self, RecvTimeoutError};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    use mixdog_term::console::{RawConsole, is_raw};
    use mixdog_term::guard::{CleanupConfig, SignalCleanup, StderrGuard, TerminalGuard};
    use mixdog_term::modes::{ModeEnv, TerminalModes, restore_sequence, screen_entry_sequence};
    use mixdog_term::reader::{TermEvent, spawn_reader};
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    use vte::{Params, Parser, Perform};

    const CHILD_ENV: &str = "MIXDOG_TERM_PTY_CHILD";
    const CHILD_TEST: &str = "unix_pty::pty_child";
    const LIMIT: Duration = Duration::from_secs(15);

    // ---- the child --------------------------------------------------------------------------------------------------

    /// Not a test of its own: the program the parent runs in the pseudo-terminal. It does nothing in a normal run.
    #[test]
    fn pty_child() {
        match std::env::var(CHILD_ENV).as_deref() {
            Ok("keys") => child_keys(),
            Ok("signal") => child_signal(),
            _ => {}
        }
    }

    fn child_keys() {
        let env = ModeEnv::from_process();
        let modes = TerminalModes::new(env);
        let mut stderr = StderrGuard::install();
        let raw = RawConsole::enable().expect("raw mode");
        assert!(is_raw());
        let guard = TerminalGuard::new(modes, Some(raw));
        let restorer = guard.restorer();
        restorer
            .write(&format!("{}{}{}READY\r\n", screen_entry_sequence(), env.extended_keys_on(), env.mouse_on()))
            .expect("write");
        let (tx, rx) = mpsc::channel();
        let mut reader = spawn_reader(tx);
        let mut got: Vec<u8> = Vec::new();
        let mut size = None;
        let deadline = Instant::now() + LIMIT;
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(TermEvent::Bytes(bytes)) => {
                    got.extend_from_slice(&bytes);
                    if got.contains(&3) {
                        break;
                    }
                }
                Ok(TermEvent::Resize(columns, rows)) => {
                    size = Some((columns, rows));
                    restorer.write("RESIZED\r\n").expect("write");
                }
                Ok(TermEvent::Closed) | Err(RecvTimeoutError::Disconnected) => break,
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
        eprintln!("child diagnostic line");
        reader.stop();
        drop(guard);
        stderr.restore();
        let hex: String = got.iter().map(|byte| format!("{byte:02x}")).collect();
        println!("GOT:{hex}");
        println!("SIZE:{size:?}");
        println!("RAW_AFTER:{}", is_raw());
    }

    fn child_signal() {
        let env = ModeEnv::from_process();
        let modes = TerminalModes::new(env);
        let raw = RawConsole::enable().expect("raw mode");
        let guard = TerminalGuard::new(modes, Some(raw));
        let restorer = guard.restorer();
        let mut config = CleanupConfig::new("pty-child");
        config.timeout = Duration::from_secs(5);
        config.before_cleanup = Some(restorer.hook());
        config.cleanup = Some(Arc::new(|reason| println!("CLEANUP:{reason}")));
        let _cleanup = SignalCleanup::install(config);
        restorer
            .write(&format!("{}{}{}READY\r\n", screen_entry_sequence(), env.extended_keys_on(), env.mouse_on()))
            .expect("write");
        // The signal ends the process; a program that is still here after the limit failed.
        thread::park_timeout(LIMIT);
        println!("NO-SIGNAL");
    }

    // ---- the parent -------------------------------------------------------------------------------------------------

    #[derive(Default)]
    struct Screen {
        alt: bool,
        cursor_hidden: bool,
        on: BTreeSet<u16>,
    }

    impl Perform for Screen {
        fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], _ignore: bool, action: char) {
            if intermediates.first() != Some(&b'?') || !matches!(action, 'h' | 'l') {
                return;
            }
            let set = action == 'h';
            for param in params.iter() {
                let Some(&mode) = param.first() else {
                    continue;
                };
                match mode {
                    1049 => self.alt = set,
                    25 => self.cursor_hidden = !set,
                    other => {
                        if set {
                            self.on.insert(other);
                        } else {
                            self.on.remove(&other);
                        }
                    }
                }
            }
        }
    }

    fn replay(bytes: &[u8]) -> Screen {
        let mut screen = Screen::default();
        Parser::new().advance(&mut screen, bytes);
        screen
    }

    struct Run {
        output: Arc<Mutex<Vec<u8>>>,
        writer: Box<dyn std::io::Write + Send>,
        child: Box<dyn portable_pty::Child + Send + Sync>,
        master: Box<dyn portable_pty::MasterPty + Send>,
    }

    fn start(scenario: &str, stderr_log: &std::path::Path) -> Run {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut command = CommandBuilder::new(std::env::current_exe().expect("current exe"));
        command.args(["--exact", CHILD_TEST, "--nocapture", "--test-threads=1"]);
        command.env(CHILD_ENV, scenario);
        command.env("MIXDOG_TUI_STDERR_LOG", stderr_log);
        command.env("MIXDOG_TUI_EXTENDED_KEYS", "1");
        command.env("TERM", "xterm-256color");
        for name in ["WT_SESSION", "MIXDOG_TUI_MOUSE", "MIXDOG_TUI_ALLOW_STDERR"] {
            command.env_remove(name);
        }
        let child = pair.slave.spawn_command(command).expect("spawn the test program");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let writer = pair.master.take_writer().expect("writer");
        let output = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&output);
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            // The read ends with an error or end of file when the program exits.
            while let Ok(n) = std::io::Read::read(&mut reader, &mut buf) {
                if n == 0 {
                    break;
                }
                sink.lock().unwrap().extend_from_slice(&buf[..n]);
            }
        });
        Run { output, writer, child, master: pair.master }
    }

    impl Run {
        fn bytes(&self) -> Vec<u8> {
            self.output.lock().unwrap().clone()
        }

        fn wait_for(&self, needle: &str) {
            let deadline = Instant::now() + LIMIT;
            while Instant::now() < deadline {
                if contains(&self.bytes(), needle.as_bytes()) {
                    return;
                }
                thread::park_timeout(Duration::from_millis(10));
            }
            panic!("{needle:?} did not appear in {:?}", String::from_utf8_lossy(&self.bytes()));
        }

        fn wait_for_exit(&mut self) -> u32 {
            let deadline = Instant::now() + LIMIT;
            while Instant::now() < deadline {
                if let Some(status) = self.child.try_wait().expect("try_wait") {
                    // The reader thread drains what the program wrote before it exited.
                    thread::park_timeout(Duration::from_millis(200));
                    return status.exit_code();
                }
                thread::park_timeout(Duration::from_millis(10));
            }
            let _ = self.child.kill();
            panic!("the test program did not exit; output {:?}", String::from_utf8_lossy(&self.bytes()));
        }
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        position(haystack, needle).is_some()
    }

    fn position(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|window| window == needle)
    }

    fn expected_env() -> ModeEnv {
        let vars = |name: &str| (name == "MIXDOG_TUI_EXTENDED_KEYS").then(|| "1".to_string());
        ModeEnv::from_vars(vars)
    }

    fn assert_back_on_the_main_screen(output: &[u8]) {
        let screen = replay(output);
        assert!(!screen.alt, "still on the alternate screen");
        assert!(!screen.cursor_hidden, "the cursor is hidden");
        for mode in [1000u16, 1002, 1003, 1005, 1006, 1015, 2004] {
            assert!(!screen.on.contains(&mode), "mode {mode} is still on");
        }
        assert!(contains(output, restore_sequence().as_bytes()), "the restore sequence was not written");
    }

    #[test]
    fn keys_a_resize_and_ctrl_c_through_a_pty() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("stderr.log");
        let mut run = start("keys", &log);
        run.wait_for("READY");
        run.master.resize(PtySize { rows: 30, cols: 100, pixel_width: 0, pixel_height: 0 }).expect("resize");
        run.wait_for("RESIZED");
        std::io::Write::write_all(&mut run.writer, b"ab\x03").expect("keys");
        std::io::Write::flush(&mut run.writer).expect("flush");
        assert_eq!(run.wait_for_exit(), 0, "output {:?}", String::from_utf8_lossy(&run.bytes()));
        let output = run.bytes();

        let env = expected_env();
        let entry = screen_entry_sequence();
        let entered = position(&output, entry.as_bytes()).expect("the screen entry was written");
        let enabled = format!("{}{}", env.extended_keys_on(), env.mouse_on());
        assert!(contains(&output, enabled.as_bytes()), "the extended keys and mouse modes were not written");
        let restored = position(&output, restore_sequence().as_bytes()).expect("the restore was written");
        assert!(entered < restored);
        assert!(contains(&output, b"GOT:616203"), "the keys did not arrive as bytes: {:?}", String::from_utf8_lossy(&output));
        assert!(contains(&output, b"SIZE:Some((100, 30))"), "the resize was not reported");
        assert!(contains(&output, b"RAW_AFTER:false"));
        assert!(position(&output, b"GOT:").unwrap() > restored, "the report was written after the restore");
        assert_back_on_the_main_screen(&output);

        let logged = mixdog_fsio::read_to_string(&mixdog_fsio::Unlaned, &log).expect("the stderr log");
        assert!(logged.contains("child diagnostic line"), "{logged:?}");
        assert!(!String::from_utf8_lossy(&output).contains("child diagnostic line"), "stderr reached the screen");
    }

    #[test]
    fn a_sigint_restores_the_terminal_and_exits_with_130() {
        let dir = tempfile::tempdir().unwrap();
        let mut run = start("signal", &dir.path().join("stderr.log"));
        run.wait_for("READY");
        let pid = run.child.process_id().expect("pid");
        // SAFETY: sends SIGINT to the child this test started.
        assert_eq!(unsafe { libc::kill(i32::try_from(pid).expect("pid"), libc::SIGINT) }, 0);
        assert_eq!(run.wait_for_exit(), 130, "output {:?}", String::from_utf8_lossy(&run.bytes()));
        let output = run.bytes();
        assert!(contains(&output, b"CLEANUP:SIGINT"));
        assert!(!contains(&output, b"NO-SIGNAL"));
        let restored = position(&output, restore_sequence().as_bytes()).expect("the restore was written");
        assert!(position(&output, b"CLEANUP:SIGINT").unwrap() > restored, "the cleanup ran before the restore");
        assert_back_on_the_main_screen(&output);
    }
}

#[cfg(windows)]
mod windows_console {
    use std::os::windows::io::AsRawHandle;

    use mixdog_fsio::{File, OpenOptions, Unlaned};
    use mixdog_term::console::{RawConsole, terminal_size};
    use windows_sys::Win32::System::Console::{
        ENABLE_ECHO_INPUT, ENABLE_LINE_INPUT, ENABLE_PROCESSED_INPUT, ENABLE_VIRTUAL_TERMINAL_INPUT,
        ENABLE_VIRTUAL_TERMINAL_PROCESSING, ENABLE_WINDOW_INPUT, GetConsoleMode,
    };

    fn open(name: &str) -> File {
        OpenOptions::new().read(true).write(true).open(&Unlaned, name).expect("a real console")
    }

    fn mode_of(console: &File) -> u32 {
        let mut mode = 0u32;
        // SAFETY: the handle is owned by `console` and the pointer is to a live u32.
        assert_ne!(unsafe { GetConsoleMode(console.as_raw_handle(), &mut mode) }, 0);
        mode
    }

    #[test]
    #[ignore = "needs a real console: run with -- --ignored windows_console_modes"]
    fn windows_console_modes() {
        let input = open("CONIN$");
        let output = open("CONOUT$");
        let (input_before, output_before) = (mode_of(&input), mode_of(&output));

        let raw = RawConsole::enable().expect("raw mode on a console");
        let input_raw = mode_of(&input);
        assert_eq!(input_raw & (ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_WINDOW_INPUT), ENABLE_VIRTUAL_TERMINAL_INPUT | ENABLE_WINDOW_INPUT);
        assert_eq!(input_raw & (ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT | ENABLE_PROCESSED_INPUT), 0);
        assert_ne!(mode_of(&output) & ENABLE_VIRTUAL_TERMINAL_PROCESSING, 0);
        let (columns, rows) = terminal_size().expect("the console size");
        assert!(columns > 0 && rows > 0);

        drop(raw);
        assert_eq!(mode_of(&input), input_before, "the input mode is put back");
        assert_eq!(mode_of(&output), output_before, "the output mode is put back");
    }
}
