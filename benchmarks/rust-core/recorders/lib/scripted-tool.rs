// A scripted `gh`, `winget`, `soffice.com` or `git` for the phone-scm replay against a built mixdogd.
//
// The recorder copies this one executable under those names. It does what the recording's Node host did with the same tools:
// it asks the replay driver (PHONE_SCM_SHIM=host:port), which answers from fixtures/phone-scm/gh-script.json, and prints the
// answer and exits with the scripted code. For the login flow (a PTY child) the driver keeps the connection open and sends the
// output and the exit when the scenario says so. Only `git --version` is scripted; every other git command runs the real git
// (PHONE_SCM_REAL_GIT) with this process's own streams.
//
// Wire: the shim sends `tool`, `cwd` (hex), then `argc` and each argument (hex) and three env values (hex), one per line; the
// driver answers lines `O <hex>` (stdout), `E <hex>` (stderr) and `X <code>` (exit).
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::process::{Command, exit};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).unwrap()).collect()
}

fn main() {
    let program = std::env::current_exe().unwrap();
    let name = program.file_name().unwrap().to_string_lossy().to_lowercase();
    let tool = name.strip_suffix(".exe").unwrap_or(&name).to_owned();
    let args: Vec<String> = std::env::args_os().skip(1).map(|arg| arg.to_string_lossy().into_owned()).collect();
    if tool == "git" && args != ["--version"] {
        // PHONE_SCM_HANG_FILE names a file holding one word: a git given that word as an argument never answers, until it is killed
        // (the scripted world's `git status` that does not return).
        if let Ok(word) = std::fs::read_to_string(std::env::var("PHONE_SCM_HANG_FILE").unwrap_or_default()) {
            let word = word.trim();
            if !word.is_empty() && args.iter().any(|arg| arg == word) {
                loop {
                    std::thread::park();
                }
            }
        }
        let status = Command::new(std::env::var("PHONE_SCM_REAL_GIT").unwrap()).args(&args).status().unwrap();
        exit(status.code().unwrap_or(1));
    }
    let mut stream = TcpStream::connect(std::env::var("PHONE_SCM_SHIM").unwrap()).unwrap();
    let cwd = std::env::current_dir().unwrap();
    let mut request = format!("{tool}\n{}\n{}\n", hex(cwd.to_string_lossy().as_bytes()), args.len());
    for arg in &args {
        request.push_str(&format!("{}\n", hex(arg.as_bytes())));
    }
    for key in ["GH_PROMPT_DISABLED", "BROWSER", "GH_BROWSER"] {
        request.push_str(&format!("{}\n", hex(std::env::var(key).unwrap_or_default().as_bytes())));
    }
    stream.write_all(request.as_bytes()).unwrap();
    for line in BufReader::new(stream).lines() {
        let line = line.unwrap();
        let (kind, rest) = line.split_at(1);
        let rest = rest.trim();
        match kind {
            "O" => {
                std::io::stdout().write_all(&unhex(rest)).unwrap();
                std::io::stdout().flush().unwrap();
            }
            "E" => {
                std::io::stderr().write_all(&unhex(rest)).unwrap();
                std::io::stderr().flush().unwrap();
            }
            _ => exit(rest.parse().unwrap()),
        }
    }
    exit(1);
}
