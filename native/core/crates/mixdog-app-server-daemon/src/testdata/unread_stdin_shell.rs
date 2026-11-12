//! A stand-in shell that never reads its input, built as `pwsh.exe` by `record-shell-unread-stdin.mjs` and by the replay
//! (`exec.rs`, `a_shell_that_never_reads_its_input_is_held_and_limited_as_nodes`): it prints a line, waits 30 s and exits 0,
//! whatever its arguments.

fn main() {
    println!("standin|started");
    std::thread::sleep(std::time::Duration::from_secs(30));
    println!("standin|ended");
}
