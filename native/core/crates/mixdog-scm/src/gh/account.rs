//! Settings → Git: the CLI probes, guided install through the platform's package manager, the
//! signed-in account, logout, and the project star.

use std::time::Duration;

use std::sync::Arc;

use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::desktop::home_dir;
use crate::engine::Scm;
use crate::error::ScmFailure;
use crate::exec::ExecSpec;

const INSTALL_LIMIT: Duration = Duration::from_secs(10 * 60);
const HOSTNAME: &str = "github.com";
const STAR_REPOSITORY: &str = "tribgames/mixdog";

/// The login `gh auth status` names: gh >= 2.40 prints "Logged in to github.com account <login>",
/// older builds "Logged in to github.com as <login>".
pub(crate) fn login_from_auth_output(output: &str) -> String {
    let word = |rest: &str| rest.split_whitespace().next().unwrap_or("").to_owned();
    if let Some(at) = output.find("account ") {
        let login = word(&output[at + "account ".len()..]);
        if !login.is_empty() {
            return login;
        }
    }
    match output.find("Logged in to ") {
        Some(at) => {
            let rest = &output[at + "Logged in to ".len()..];
            rest.split_once(" as ").map(|(_, login)| word(login)).unwrap_or_default()
        }
        None => String::new(),
    }
}

fn first_version(output: &str, prefix: &str) -> String {
    output
        .lines()
        .find_map(|line| line.trim().strip_prefix(prefix))
        .and_then(|rest| rest.split_whitespace().next())
        .unwrap_or("")
        .to_owned()
}

impl Scm {
    /// `github/status`: whether `gh` is installed and signed in.
    pub async fn gh_status(&self, cancel: &CancellationToken, refresh: bool) -> Result<Value, ScmFailure> {
        if refresh {
            self.github.runner.forget_program();
        }
        let home = home_dir();
        let probe = match self.github.output(&home, cancel, &["--version"]).await {
            Ok(output) if output.success() => output,
            Ok(_) | Err(ScmFailure::Unavailable { .. }) => {
                return Ok(json!({ "installed": false, "authenticated": false }));
            }
            Err(other) => return Err(other),
        };
        let version = first_version(&probe.stdout, "gh version ");
        let auth = self
            .github
            .output(&home, cancel, &["auth", "status", "--hostname", HOSTNAME, "--active"])
            .await?;
        let authenticated = auth.success();
        let login = if authenticated { login_from_auth_output(&auth.combined()) } else { String::new() };
        let mut status = json!({ "installed": true, "authenticated": authenticated });
        if !version.is_empty() {
            status["version"] = json!(version);
        }
        if !login.is_empty() {
            status["login"] = json!(login);
        }
        Ok(status)
    }

    /// The signed-in account, straight from the GitHub API through `gh`.
    pub async fn gh_account(&self, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let output = self.github.output(&home_dir(), cancel, &["api", "user"]).await?;
        if !output.success() {
            let detail = if output.stderr.trim().is_empty() { &output.stdout } else { &output.stderr };
            let detail = detail.trim();
            return Err(ScmFailure::Command {
                domain: crate::error::GITHUB_DOMAIN,
                text: if detail.is_empty() { "gh could not read the signed-in user.".into() } else { detail.to_owned() },
            });
        }
        let data: Value = serde_json::from_str(&output.stdout).map_err(|_| ScmFailure::Command {
            domain: crate::error::GITHUB_DOMAIN,
            text: "gh returned an unreadable user payload.".into(),
        })?;
        let login = data.get("login").and_then(Value::as_str).unwrap_or("");
        if login.is_empty() {
            return Err(ScmFailure::Command {
                domain: crate::error::GITHUB_DOMAIN,
                text: "gh returned no signed-in user.".into(),
            });
        }
        let id = data.get("id").and_then(Value::as_u64).unwrap_or(0);
        let named = |key: &str| data.get(key).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_owned);
        // No public email: the account's noreply address, like GitHub Desktop's suggestion.
        let noreply = format!("{}{login}@users.noreply.github.com", if id > 0 { format!("{id}+") } else { String::new() });
        Ok(json!({
            "login": login,
            "name": named("name").unwrap_or_else(|| login.to_owned()),
            "email": named("email").unwrap_or(noreply),
        }))
    }

    pub async fn gh_logout(&self, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let home = home_dir();
        let status = self.gh_status(cancel, false).await?;
        if status["installed"] != true {
            return Err(ScmFailure::Unavailable { capability: "gh".into() });
        }
        let base = ["auth", "logout", "--hostname", HOSTNAME];
        let mut result = self.github.output(&home, cancel, &base).await?;
        if !result.success() {
            if let Some(login) = status.get("login").and_then(Value::as_str) {
                // Several signed-in accounts make gh demand an explicit --user.
                let mut with_user = base.to_vec();
                with_user.extend(["--user", login]);
                result = self.github.output(&home, cancel, &with_user).await?;
            }
        }
        if !result.success() {
            let detail = if result.stderr.trim().is_empty() { result.stdout.trim() } else { result.stderr.trim() };
            return Err(ScmFailure::Command {
                domain: crate::error::GITHUB_DOMAIN,
                text: if detail.is_empty() { "gh could not sign out.".into() } else { detail.to_owned() },
            });
        }
        self.gh_status(cancel, true).await
    }

    pub async fn gh_install(self: &Arc<Self>, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        self.install_with_package_manager(
            cancel,
            "GitHub CLI",
            "https://cli.github.com",
            "GitHub.cli",
            &["install", "gh"],
        )
        .await?;
        let status = self.gh_status(cancel, true).await?;
        if status["installed"] != true {
            return Err(ScmFailure::refused(
                "INSTALL_NOT_VISIBLE",
                "GitHub CLI installed, but the executable was not found yet. Restart Mixdog Desktop to pick it up.",
            ));
        }
        Ok(status)
    }

    pub async fn git_cli_install(self: &Arc<Self>, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        // A system Git that is already present answers first: winget treats an installed
        // package as an upgrade request.
        let existing = self.git_cli_status(cancel).await?;
        if existing["installed"] == true {
            return Ok(existing);
        }
        self.install_with_package_manager(cancel, "Git", "https://git-scm.com", "Git.Git", &["install", "git"])
            .await?;
        let status = self.git_cli_status(cancel).await?;
        if status["installed"] != true {
            return Err(ScmFailure::refused(
                "INSTALL_NOT_VISIBLE",
                "Git installed, but the executable was not found yet. Restart Mixdog Desktop to pick it up.",
            ));
        }
        Ok(status)
    }

    async fn install_with_package_manager(
        &self,
        cancel: &CancellationToken,
        label: &str,
        homepage: &str,
        winget_id: &str,
        brew_args: &[&str],
    ) -> Result<(), ScmFailure> {
        let (program, manager, args): (&str, &str, Vec<String>) = if cfg!(windows) {
            (
                "winget",
                "winget",
                [
                    "install", "--id", winget_id, "--exact", "--source", "winget",
                    "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity",
                ]
                .iter()
                .map(|arg| (*arg).to_owned())
                .collect(),
            )
        } else if cfg!(target_os = "macos") {
            ("brew", "Homebrew", brew_args.iter().map(|arg| (*arg).to_owned()).collect())
        } else {
            return Err(ScmFailure::refused(
                "INSTALL_UNSUPPORTED",
                format!("Automatic install is not supported on this platform. Install {label} from {homepage}."),
            ));
        };
        let mut spec = ExecSpec::new(program, home_dir());
        spec.args = args;
        spec.time_limit = Some(INSTALL_LIMIT);
        match self.git.exec().run(spec, cancel).await {
            Ok(output) if output.success() => Ok(()),
            Ok(output) => {
                let text = if output.stderr.is_empty() { output.stdout_text() } else { output.stderr_text() };
                let detail = text.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("").trim().to_owned();
                Err(ScmFailure::refused(
                    "INSTALL_FAILED",
                    format!(
                        "{program} could not install {label}: {}",
                        if detail.is_empty() { format!("exit code {}", output.code.unwrap_or(-1)) } else { detail }
                    ),
                ))
            }
            Err(ScmFailure::Unavailable { .. }) => Err(ScmFailure::refused(
                "INSTALL_UNAVAILABLE",
                format!("{manager} is unavailable. Install {label} from {homepage} and try again."),
            )),
            Err(other) => Err(other),
        }
    }

    /// Whether the project is starred: the status line of the response says, not its text.
    pub async fn gh_star_status(&self, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let endpoint = format!("user/starred/{STAR_REPOSITORY}");
        let output = match self.github.output(&home_dir(), cancel, &["api", "--include", &endpoint]).await {
            Ok(output) => output,
            Err(ScmFailure::Unavailable { .. }) => return Ok(json!({ "available": false, "starred": false })),
            Err(other) => return Err(other),
        };
        let status = output
            .stdout
            .lines()
            .next()
            .and_then(|line| line.strip_prefix("HTTP/"))
            .and_then(|rest| rest.split_whitespace().nth(1))
            .and_then(|code| code.parse::<u16>().ok());
        Ok(match status {
            Some(204) => json!({ "available": true, "starred": true }),
            Some(404) => json!({ "available": true, "starred": false }),
            _ => json!({ "available": false, "starred": false }),
        })
    }

    pub async fn gh_star(&self, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        let endpoint = format!("user/starred/{STAR_REPOSITORY}");
        let output = self
            .github
            .output(&home_dir(), cancel, &["api", "-X", "PUT", &endpoint, "--silent"])
            .await?;
        if !output.success() {
            let detail = output.stderr.trim();
            return Err(ScmFailure::Command {
                domain: crate::error::GITHUB_DOMAIN,
                text: if detail.is_empty() { "gh could not star the repository.".into() } else { detail.to_owned() },
            });
        }
        Ok(json!({ "starred": true }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_login_is_read_from_either_gh_wording() {
        assert_eq!(login_from_auth_output("✓ Logged in to github.com account octo (keyring)"), "octo");
        assert_eq!(login_from_auth_output("✓ Logged in to github.com as octo (oauth_token)"), "octo");
        assert_eq!(login_from_auth_output("not signed in"), "");
    }
}
