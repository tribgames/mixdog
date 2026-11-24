//! Private folders for files ssh reads or runs on behalf of this app (the askpass helper, the generated ssh config,
//! the jump-host scan config). They belong to this user alone: a random subfolder per use, locked with icacls on
//! Windows before anything is written into it, and the shared parent locked too.
//!
//! Paths handed to ssh must be plain ASCII without spaces on Windows: ssh starts a jump host's own ssh with
//! `-F <config>` as one unquoted word, and cmd.exe reads wrapper paths in the console code page.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use mixdog_fsio::{DirBuilder, Unlaned};

use crate::context::{Platform, SshEnv, ToolOutput};

const TOOL_TIMEOUT: Duration = Duration::from_millis(8_000);
const NAME_ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SUFFIX_LENGTH: usize = 6;
const NAME_ATTEMPTS: usize = 100;

/// Whether a path is plain: printable ASCII without spaces (`/^[\x21-\x7e]+$/`).
pub fn is_plain_path(path: &str) -> bool {
    !path.is_empty() && path.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

/// The account that gets a folder: the signed-in one.
fn current_user(env: &SshEnv) -> String {
    ["USERNAME", "USER", "LOGNAME"].iter().find_map(|name| env.var(name).filter(|value| !value.is_empty())).unwrap_or("user").to_owned()
}

/// `path.join(base, name)` of the platform for a base that is already normal.
pub(crate) fn join_name(platform: Platform, base: &str, name: &str) -> String {
    let separator = if platform.is_windows() { '\\' } else { '/' };
    let trimmed = base.trim_end_matches(|c| c == separator || (platform.is_windows() && c == '/'));
    format!("{trimmed}{separator}{name}")
}

/// Restricts the folder to the account of the current token (named by its SID, so it resolves on any kind of PC) and its
/// children by inheritance. `/L`: a link met on the way is changed itself, never its target.
async fn lock_to_user(env: &SshEnv, dir: &Path, sid: &str) -> io::Result<()> {
    let args = vec![dir.to_string_lossy().into_owned(), "/L".to_owned(), "/inheritance:r".to_owned(), "/grant:r".to_owned(), format!("*{sid}:(OI)(CI)F")];
    let locked = env.tools.run(Path::new("icacls"), &args, TOOL_TIMEOUT).await?;
    if locked.exit_code == Some(0) {
        return Ok(());
    }
    Err(io::Error::other(format!("{} could not be restricted to this user: {}", dir.display(), reason_of(&locked))))
}

/// What a tool said about why it failed: its error text, else its output, else its exit code.
fn reason_of(output: &ToolOutput) -> String {
    [output.stderr.trim(), output.stdout.trim()]
        .into_iter()
        .find(|text| !text.is_empty())
        .map_or_else(|| format!("exit code {:?}", output.exit_code), str::to_owned)
}

/// Prints <state> <SID of the running account>`: `link` (a junction or link, or no folder), `owner` (owned by an account other
/// than this one, SYSTEM or Administrators), `broad` (a real folder of this account that an allowing access entry of someone
/// else reaches) or `private` (every allowing entry names this account, SYSTEM or Administrators).
const PRIVATE_CHECK: &str = "$ErrorActionPreference='Stop'; $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; \
$item=Get-Item -LiteralPath '{dir}' -Force; \
if(-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){Write-Output \"link $me\"; exit 0}; \
$acl=Get-Acl -LiteralPath '{dir}'; $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; \
$ok=@($me,'S-1-5-18','S-1-5-32-544'); if($ok -notcontains $owner){Write-Output \"owner $me\"; exit 0}; \
foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){ \
if($rule.AccessControlType -eq 'Allow' -and $ok -notcontains $rule.IdentityReference.Value){Write-Output \"broad $me\"; exit 0} }; \
Write-Output \"private $me\"";

/// The state of a folder and the SID of the running account, in one PowerShell run.
async fn standing(env: &SshEnv, dir: &Path) -> io::Result<(String, String)> {
    let literal = dir.to_string_lossy().replace('\'', "''");
    let args = vec!["-NoProfile".to_owned(), "-NonInteractive".to_owned(), "-Command".to_owned(), PRIVATE_CHECK.replace("{dir}", &literal)];
    let result = env.tools.run(Path::new("powershell.exe"), &args, TOOL_TIMEOUT).await?;
    let mut words = result.stdout.split_whitespace();
    match (result.exit_code, words.next(), words.next()) {
        (Some(0), Some(state), Some(sid)) => Ok((state.to_owned(), sid.to_owned())),
        _ => Err(io::Error::other(format!("The owner and access list of {} could not be read: {}", dir.display(), reason_of(&result)))),
    }
}

fn inside_profile(env: &SshEnv, dir: &Path) -> bool {
    let plain = |path: &Path| path.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase();
    let (home, dir) = (plain(&env.home), plain(dir));
    !home.is_empty() && dir.strip_prefix(&home).is_some_and(|rest| rest.starts_with('\\'))
}

/// Proves a Windows folder outside the user's profile (a shared fallback location another account may have prepared first) is
/// one only this account and the system can have written, by its owner and access list now. A real folder of this account whose
/// access list is merely too broad is tightened and checked again; a link, or a folder of someone else, is refused untouched.
pub(crate) async fn ensure_private_dir(env: &SshEnv, dir: &Path) -> io::Result<()> {
    if inside_profile(env, dir) {
        return Ok(());
    }
    let refused = |why: &str| io::Error::new(io::ErrorKind::PermissionDenied, format!("{} {why}, so it is not used.", dir.display()));
    let (state, sid) = standing(env, dir).await?;
    match state.as_str() {
        "private" => Ok(()),
        "link" => Err(refused("is a link or not a folder")),
        "owner" => Err(refused("belongs to another account")),
        _ => {
            lock_to_user(env, dir, &sid).await?;
            match standing(env, dir).await?.0.as_str() {
                "private" => Ok(()),
                _ => Err(refused("is not private to this user")),
            }
        }
    }
}
fn random_suffix() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    hasher.write_u32(std::process::id());
    let mut bits = hasher.finish();
    let base = NAME_ALPHABET.len() as u64;
    (0..SUFFIX_LENGTH)
        .map(|_| {
            let letter = NAME_ALPHABET[(bits % base) as usize];
            bits /= base;
            char::from(letter)
        })
        .collect()
}

/// A new folder `prefix` + random letters under `parent` (Node's `mkdtemp`), readable by this user only on Unix.
pub(crate) fn make_temp_dir(parent: &Path, prefix: &str) -> io::Result<PathBuf> {
    for _ in 0..NAME_ATTEMPTS {
        let dir = parent.join(format!("{prefix}{}", random_suffix()));
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut builder = DirBuilder::new();
        #[cfg(unix)]
        builder.mode(0o700);
        match builder.create(&Unlaned, &dir) {
            Ok(()) => return Ok(dir),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, format!("no free folder name under {}", parent.display())))
}

/// A new random subfolder of `parent`, usable by this user only. On Windows the parent is locked first and the
/// subfolder is locked before the caller writes into it.
pub async fn create_private_dir(env: &SshEnv, parent: &Path, prefix: &str) -> io::Result<PathBuf> {
    let windows = env.platform.is_windows();
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(&Unlaned, parent)?;
    if windows {
        ensure_private_dir(env, parent).await?;
    }
    let dir = make_temp_dir(parent, prefix)?;
    // A folder made inside the proven parent has exactly the parent's access list.
    if let Err(error) = restrict_to_owner(&dir) {
        let _ = mixdog_fsio::remove_dir_all(&Unlaned, &dir);
        return Err(error);
    }
    Ok(dir)
}

#[cfg(unix)]
fn restrict_to_owner(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    mixdog_fsio::set_permissions(&Unlaned, dir, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn restrict_to_owner(_dir: &Path) -> io::Result<()> {
    Ok(())
}

/// The 8.3 short form of an existing Windows folder, or None when the volume has none.
async fn short_windows_path(env: &SshEnv, dir: &str) -> Option<String> {
    let literal = dir.replace('\'', "''");
    let args = vec![
        "-NoProfile".to_owned(),
        "-NonInteractive".to_owned(),
        "-Command".to_owned(),
        format!("(New-Object -ComObject Scripting.FileSystemObject).GetFolder('{literal}').ShortPath"),
    ];
    let result = env.tools.run(Path::new("powershell.exe"), &args, TOOL_TIMEOUT).await.ok()?;
    let short = if result.exit_code == Some(0) { result.stdout.trim().to_owned() } else { String::new() };
    is_plain_path(&short).then_some(short)
}

/// A folder for files ssh must be able to name: `<base>/<name>` when that path is plain, else the same folder under
/// the 8.3 short path of the base folder, else a per-user folder under a shared root (ProgramData, Public, the system
/// drive), which [`create_private_dir`] then locks.
pub async fn resolve_plain_dir(env: &SshEnv, base: &Path, name: &str) -> PathBuf {
    resolve_plain_dir_with(env, base, name, |folder| {
        let mut builder = DirBuilder::new();
        builder.recursive(true);
        let _ = builder.create(&Unlaned, folder);
    })
    .await
}

/// [`resolve_plain_dir`] with the creation of the base folder (Windows names its short form only once it exists)
/// passed in.
pub(crate) async fn resolve_plain_dir_with(env: &SshEnv, base: &Path, name: &str, ensure_base: impl FnOnce(&Path)) -> PathBuf {
    let platform = env.platform;
    let base_text = base.to_string_lossy().into_owned();
    let preferred = join_name(platform, &base_text, name);
    if !platform.is_windows() || is_plain_path(&preferred) {
        return PathBuf::from(preferred);
    }
    ensure_base(base);
    if let Some(short) = short_windows_path(env, &base_text).await {
        let joined = join_name(platform, &short, name);
        if is_plain_path(&joined) {
            return PathBuf::from(joined);
        }
    }
    let account: String = current_user(env).chars().map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' }).collect();
    let drive = env.var("SystemDrive").filter(|drive| !drive.is_empty()).map(|drive| format!("{drive}\\"));
    let roots = [env.var("ProgramData").map(str::to_owned), env.var("PUBLIC").map(str::to_owned), drive];
    for root in roots.into_iter().flatten() {
        if is_plain_path(&root) {
            return PathBuf::from(join_name(platform, &root, &format!("mixdog-{name}-{account}")));
        }
    }
    PathBuf::from(preferred)
}
