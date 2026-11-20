//! The formatters run one file at a time through stdin (see `stdin`): google-java-format, ktfmt
//! and `zig fmt`. Each reads the text, prints it formatted, and exits non-zero for text it cannot
//! parse.

use async_trait::async_trait;

use super::shared::*;
use super::stdin::format_each;

/// A formatter whose call needs nothing read from the project.
pub struct StdinFormatter {
    pub id: &'static str,
    /// The arguments for the file at an index of the request's files.
    pub call: fn(&RunRequest, usize) -> Vec<String>,
}

#[async_trait]
impl Runner for StdinFormatter {
    fn id(&self) -> &'static str {
        self.id
    }
    async fn check(&self, req: &RunRequest) -> RunnerResult {
        format_each(req, self.id, false, &|index| Ok((self.call)(req, index))).await
    }
    async fn fix(&self, req: &RunRequest) -> RunnerResult {
        format_each(req, self.id, true, &|index| Ok((self.call)(req, index))).await
    }
}

/// The style tidy asks an engine for where the engine has no configuration file to say it:
/// `flags`, unless the project's own command for the engine gives arguments.
fn style(req: &RunRequest, flags: &[&str]) -> Vec<String> {
    if req.args.is_empty() { flags.iter().map(|flag| (*flag).to_owned()).collect() } else { Vec::new() }
}

/// google-java-format: `-` formats stdin. It reads no configuration; left to itself it indents
/// by two (Google style), so tidy asks for AOSP style, the four spaces most Java is written in.
pub fn google_java_format(req: &RunRequest, _: usize) -> Vec<String> {
    [style(req, &["--aosp"]), vec!["-".to_owned()]].concat()
}

/// ktfmt: `-` formats stdin, named by the file's path from where ktfmt runs: its errors carry
/// that name, and it reads the `.editorconfig` files from that path upward. Left to itself it
/// indents by two and reads no `.editorconfig`; tidy asks for the Kotlin coding conventions and
/// for the project's `.editorconfig` to be honoured.
pub fn ktfmt(req: &RunRequest, index: usize) -> Vec<String> {
    [style(req, &["--kotlinlang-style", "--enable-editorconfig"]), vec![format!("--stdin-name={}", req.files[index]), "-".to_owned()]].concat()
}

/// `zig fmt --stdin`. It has no configuration.
pub fn zig(_: &RunRequest, _: usize) -> Vec<String> {
    vec!["--stdin".to_owned()]
}

#[cfg(test)]
mod tests {
    use super::super::stdin::tests::{clean, project};
    use super::*;

    /// The arguments an engine got for the one file it was asked about.
    async fn call(runner: &dyn Runner, file: &str, configured: &[&str]) -> String {
        let (dir, spawn, mut req) = project(&[(file, "text")], &[file], clean);
        req.args = configured.iter().map(|a| (*a).to_owned()).collect();
        assert_eq!(runner.check(&req).await.files_checked, Some(1));
        let calls = spawn.0.lock().unwrap();
        assert_eq!(calls[0].1, dir.path(), "the engine runs in the request's directory, where the project's arguments are meant");
        calls[0].0.join(" ")
    }

    #[tokio::test]
    async fn an_engine_without_a_configuration_file_gets_tidys_style_unless_the_project_gives_its_own_arguments() {
        let java = StdinFormatter { id: "google-java-format", call: google_java_format };
        assert_eq!(call(&java, "src/A.java", &[]).await, "--aosp -");
        assert_eq!(call(&java, "A.java", &["--skip-javadoc-formatting"]).await, "--skip-javadoc-formatting -");
        let kotlin = StdinFormatter { id: "ktfmt", call: ktfmt };
        assert_eq!(call(&kotlin, "app/Main.kt", &[]).await, "--kotlinlang-style --enable-editorconfig --stdin-name=app/Main.kt -");
        assert_eq!(call(&kotlin, "b.gradle.kts", &["-jar", "tools/ktfmt.jar", "--google-style"]).await, "-jar tools/ktfmt.jar --google-style --stdin-name=b.gradle.kts -");
        let zig_fmt = StdinFormatter { id: "zig", call: zig };
        assert_eq!(call(&zig_fmt, "src/main.zig", &["fmt"]).await, "fmt --stdin");
    }
}
