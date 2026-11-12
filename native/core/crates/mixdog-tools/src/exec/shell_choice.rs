//! The model shell of one spawn, chosen as `shell-runtime.mjs` `resolveShell` does. The "system
//! shell" setting (`getConfiguredShell()`) is read on every spawn, so a change reaches the next
//! command; only the default program is resolved once, at start, by the host.

/// `shellTypeFor(shell) === 'posix'`: a `bash`, `zsh` or `sh` program. Every other name is
/// PowerShell on Windows (`shellTypeFor`'s fallback there).
fn is_posix_shell(program: &str) -> bool {
    let stem = program_name(program).to_lowercase();
    matches!(stem.strip_suffix(".exe").unwrap_or(&stem), "bash" | "zsh" | "sh")
}

/// `resolveShell()`'s program. Off Windows the default (a real bash, else `/bin/sh`) is the only
/// choice. On Windows an explicit program, the setting before the `MIXDOG_SHELL` variable (the
/// variable is not trimmed; an empty one is none), replaces the default PowerShell unless it is a
/// POSIX shell.
pub(crate) fn chosen_shell(windows: bool, configured: &str, env_shell: Option<&str>, default_program: &str) -> String {
    if !windows {
        return default_program.to_owned();
    }
    let explicit = if configured.is_empty() { env_shell.unwrap_or_default() } else { configured };
    if explicit.is_empty() || is_posix_shell(explicit) { default_program.to_owned() } else { explicit.to_owned() }
}

/// `resolveShell()`'s default program: the kept one, else a probe on `lane` kept for the next
/// spawns until the setting changes (the setting is its only source the kept value tracks, as
/// Node's `_resolvedShell`). `Err` is the reason the probe could not run.
pub(crate) async fn default_program(
    source: &std::sync::Arc<dyn super::jobs::ShellSource>,
    lane: mixdog_rt::SpawnIo,
    cancel: &tokio_util::sync::CancellationToken,
    configured: &str,
) -> Result<String, String> {
    if let Some(kept) = source.kept_default() {
        return Ok(kept);
    }
    use mixdog_rt::LaneToken;
    let probe = source.clone();
    let program = lane
        .submit(cancel, move |_lane| probe.resolve_default())
        .map_err(|_| "the lane is full".to_owned())?
        .await
        .map_err(|error| error.to_string())?;
    source.keep_default(configured, program.clone());
    Ok(program)
}

/// `basename(program)`: the file name of a program path, either separator, trailing ones ignored.
fn program_name(program: &str) -> &str {
    let trimmed = program.trim_end_matches(['\\', '/']);
    trimmed.rsplit(['\\', '/']).next().unwrap_or(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden() -> serde_json::Value {
        serde_json::from_str(include_str!("testdata/shell_choice.json")).unwrap()
    }

    /// The recorded `<default>` stands for the host's own default program.
    const DEFAULT: &str = "C:\\Host\\default-shell.exe";

    fn expected(case: &serde_json::Value) -> String {
        match case["shell"].as_str().unwrap() {
            "<default>" => DEFAULT.to_owned(),
            explicit => explicit.to_owned(),
        }
    }

    /// Node's shell for every recorded setting, `MIXDOG_SHELL` value and platform. The setting is
    /// stored trimmed (`setConfiguredShell`), as the daemon's `ConfiguredShell` does.
    #[test]
    fn the_chosen_shell_equals_nodes_for_every_setting_variable_and_platform() {
        let golden = golden();
        let cases = golden["cases"].as_array().unwrap();
        assert!(cases.len() > 100);
        for case in cases {
            let windows = case["platform"] == "win32";
            let configured = mixdog_js::js_trim(case["configured"].as_str().unwrap());
            let env = case["env"].as_str();
            assert_eq!(chosen_shell(windows, configured, env, DEFAULT), expected(case), "{case}");
        }
    }

    /// The type of the shell Node chose is the platform's: the PowerShell-only paths (wmic rewrite,
    /// hygiene, the UTF-8 preamble) follow `windows`, whatever is configured.
    #[test]
    fn the_shell_type_is_the_platforms_for_every_recorded_choice() {
        let golden = golden();
        for case in golden["cases"].as_array().unwrap() {
            let want = if case["platform"] == "win32" { "powershell" } else { "posix" };
            assert_eq!(case["shellType"], want, "{case}");
        }
        for (platform, kind) in golden["defaults"].as_object().unwrap() {
            assert_eq!(kind, if platform == "win32" { "powershell" } else { "posix" });
        }
    }

    /// One process, the setting changing between spawns: each spawn follows the current value.
    #[test]
    fn the_setting_is_followed_from_one_spawn_to_the_next() {
        let golden = golden();
        for step in golden["sequence"].as_array().unwrap() {
            let configured = mixdog_js::js_trim(step["set"].as_str().unwrap());
            assert_eq!(chosen_shell(true, configured, None, DEFAULT), expected(step), "{step}");
        }
    }

    /// A setting whose change drops the kept default, as the daemon's `ConfiguredShell` does
    /// (`setConfiguredShell`); every probe answers a new program.
    #[derive(Default)]
    struct Setting {
        value: std::sync::Mutex<String>,
        kept: std::sync::Mutex<Option<String>>,
        probes: std::sync::atomic::AtomicUsize,
    }

    impl super::super::jobs::ShellSource for Setting {
        fn configured(&self) -> String {
            self.value.lock().unwrap().clone()
        }
        fn kept_default(&self) -> Option<String> {
            self.kept.lock().unwrap().clone()
        }
        fn resolve_default(&self) -> String {
            format!("probe-{}", self.probes.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1)
        }
        fn keep_default(&self, configured: &str, program: String) {
            if *self.value.lock().unwrap() == configured {
                *self.kept.lock().unwrap() = Some(program);
            }
        }
    }

    /// The default program of one spawn.
    async fn spawn_program(source: &std::sync::Arc<dyn super::super::jobs::ShellSource>) -> String {
        let cancel = tokio_util::sync::CancellationToken::new();
        default_program(source, mixdog_rt::testing::tokens().spawn_io, &cancel, &source.configured()).await.unwrap()
    }

    /// The default program is probed once and kept; a setting change makes the next spawn probe again.
    #[tokio::test]
    async fn the_kept_default_program_is_probed_again_after_the_setting_changes() {
        let setting = std::sync::Arc::new(Setting::default());
        let source: std::sync::Arc<dyn super::super::jobs::ShellSource> = setting.clone();
        assert_eq!(spawn_program(&source).await, "probe-1");
        assert_eq!(spawn_program(&source).await, "probe-1");
        *setting.value.lock().unwrap() = "pwsh".into();
        *setting.kept.lock().unwrap() = None;
        assert_eq!(spawn_program(&source).await, "probe-2");
        assert_eq!(spawn_program(&source).await, "probe-2");
        assert_eq!(setting.probes.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn the_program_name_is_the_last_path_component() {
        assert_eq!(program_name("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "pwsh.exe");
        assert_eq!(program_name("/usr/bin/pwsh"), "pwsh");
        assert_eq!(program_name("C:\\Git\\bin\\bash.exe\\"), "bash.exe");
        assert_eq!(program_name("powershell.exe"), "powershell.exe");
    }
}
