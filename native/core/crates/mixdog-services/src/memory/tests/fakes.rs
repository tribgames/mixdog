//! Stand-ins for processes a test needs alive, named as a postmaster is told by.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]

use std::path::Path;

/// A process that stays alive and answers nothing, whose image is named `image_name` (a postmaster is told by its image's name, `isPostgresPid`). It is ended when
/// this guard goes, whatever the test did.
pub struct Fake(std::process::Child);

impl Fake {
    pub fn new(dir: &Path, image_name: &str) -> Self {
        let (source, name, args): (&str, String, &[&str]) = if cfg!(windows) {
            (r"C:\Windows\System32\PING.EXE", format!("{image_name}.exe"), &["-n", "60", "127.0.0.1"])
        } else {
            ("/bin/sleep", image_name.to_owned(), &["60"])
        };
        let image = dir.join(name);
        std::fs::copy(source, &image).expect("copy an image");
        Self(std::process::Command::new(image).args(args).stdout(std::process::Stdio::null()).spawn().expect("spawn"))
    }

    pub fn id(&self) -> u32 {
        self.0.id()
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A process id that was alive a moment ago and is not any more.
pub fn dead_pid(dir: &Path) -> u32 {
    let gone = Fake::new(dir, "postgres");
    gone.id()
}

pub fn pid_file(dir: &Path, pid: u32, port: u16) {
    std::fs::write(dir.join("postmaster.pid"), format!("{pid}\n{}\n1\n{port}\n", dir.display())).unwrap();
}
