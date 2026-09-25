// The wire contract: request shapes accepted on stdin, the rg-compatible
// argv parser, the post-walk path filter, and the list-metadata reply.
use super::*;

#[derive(Deserialize)]
pub(super) struct ServeRequest {
    pub(super) id: u64,
    pub(super) cwd: String,
    #[serde(default)]
    pub(super) args: Vec<String>,
    #[serde(default)]
    pub(super) offset: usize,
    #[serde(default)]
    pub(super) limit: usize,
    #[serde(default, rename = "deadlineMs")]
    pub(super) deadline_ms: Option<u64>,
    #[serde(default, rename = "keepWarm")]
    pub(super) keep_warm: bool,
    // Keep only the query-independent path inventory alive after a fuzzy
    // deadline. Unlike keepWarm this never pre-reads file contents.
    #[serde(default, rename = "keepInventory")]
    pub(super) keep_inventory: bool,
    #[serde(default, rename = "keepInventoryMs")]
    pub(super) keep_inventory_ms: u64,
    // Client-supplied breadth hint: broad directory content scans (multi-
    // pattern combined and fallback passes) opt into the bulk lane so they
    // cannot saturate the interactive worker pool.
    #[serde(default, rename = "bulkHint")]
    pub(super) bulk_hint: bool,
    #[serde(default, rename = "mtimeTopK")]
    pub(super) mtime_top_k: bool,
    #[serde(default)]
    pub(super) fuzzy: Option<String>,
    #[serde(default)]
    pub(super) hidden: bool,
    #[serde(default, rename = "includeNoise")]
    pub(super) include_noise: bool,
    #[serde(default, rename = "maxDepth")]
    pub(super) max_depth: Option<usize>,
    #[serde(default)]
    pub(super) exclude: Vec<String>,
}

#[cfg(unix)]
pub(super) fn list_metadata_mode(metadata: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    metadata.mode()
}

#[cfg(not(unix))]
pub(super) fn list_metadata_mode(metadata: &std::fs::Metadata) -> u32 {
    if metadata.is_dir() {
        0o777
    } else if metadata.permissions().readonly() {
        0o444
    } else {
        0o666
    }
}

pub(super) fn list_metadata_response(id: u64, cwd: &str, paths: &[String]) -> serde_json::Value {
    if paths.len() > 50_000 {
        return serde_json::json!({
            "id": id,
            "error": "list metadata request exceeds 50000 paths",
        });
    }
    let cwd = Path::new(cwd);
    let entries = paths
        .iter()
        .map(|raw| {
            // Path::join replaces the base when the path is absolute.
            match std::fs::symlink_metadata(cwd.join(raw)) {
                Ok(metadata) => {
                    let file_type = metadata.file_type();
                    let kind = if file_type.is_dir() {
                        "dir"
                    } else if file_type.is_file() {
                        "file"
                    } else if file_type.is_symlink() {
                        "symlink"
                    } else {
                        "other"
                    };
                    let mtime_ms = metadata
                        .modified()
                        .ok()
                        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|value| value.as_millis().min(u64::MAX as u128) as u64)
                        .unwrap_or(0);
                    serde_json::json!({
                        "path": raw,
                        "type": kind,
                        "size": metadata.len(),
                        "mtimeMs": mtime_ms,
                        "mode": list_metadata_mode(&metadata),
                    })
                }
                Err(error) => serde_json::json!({
                    "path": raw,
                    "error": error.to_string(),
                }),
            }
        })
        .collect::<Vec<_>>();
    serde_json::json!({ "id": id, "entries": entries })
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum WireRequest {
    ListMetadata {
        id: u64,
        cwd: String,
        #[serde(rename = "listMetadata")]
        list_metadata: Vec<String>,
    },
    Search(ServeRequest),
    Cancel {
        cancel: u64,
    },
    ProcessSnapshot {
        id: u64,
        #[serde(rename = "processSnapshot")]
        process_snapshot: bool,
    },
}

#[derive(Clone, Default)]
pub(super) struct ParsedArgs {
    pub(super) patterns: Vec<String>,
    pub(super) globs: Vec<String>,
    pub(super) iglobs: Vec<String>,
    pub(super) targets: Vec<String>,
    pub(super) before: usize,
    pub(super) after: usize,
    pub(super) case_insensitive: bool,
    pub(super) fixed_strings: bool,
    pub(super) hidden: bool,
    pub(super) no_ignore: bool,
    pub(super) text: bool,
    pub(super) no_require_git: bool,
    pub(super) max_depth: Option<usize>,
    pub(super) line_numbers: bool,
    pub(super) with_filename: bool,
    pub(super) files_with_matches: bool,
    pub(super) count: bool,
    pub(super) only_matching: bool,
    pub(super) pcre2: bool,
    pub(super) multiline: bool,
    pub(super) multiline_dotall: bool,
    pub(super) file_types: Vec<String>,
    pub(super) files_list: bool,
    pub(super) directories: bool,
    pub(super) max_columns: usize,
    pub(super) literal_trigrams: Option<Vec<Vec<(usize, usize)>>>,
}

pub(super) struct PathFilter {
    pub(super) globs: Override,
    pub(super) types: Option<Types>,
}

impl PathFilter {
    pub(super) fn new(root: &Path, parsed: &ParsedArgs) -> Result<Self, String> {
        // `OverrideBuilder` requires a directory root. When rg's positional
        // operand is an exact file, using that file as the root makes its
        // relative path empty, so ordinary filters such as `*.mjs` reject the
        // file. Match ripgrep by evaluating file operands from their parent.
        let filter_root = if root.is_file() {
            root.parent().unwrap_or(root)
        } else {
            root
        };
        let mut globs = OverrideBuilder::new(filter_root);
        for glob in &parsed.globs {
            globs.add(glob).map_err(|error| format!("glob: {error}"))?;
        }
        globs
            .case_insensitive(true)
            .map_err(|error| format!("iglob: {error}"))?;
        for glob in &parsed.iglobs {
            globs.add(glob).map_err(|error| format!("iglob: {error}"))?;
        }
        let globs = globs.build().map_err(|error| format!("glob: {error}"))?;
        let types = if parsed.file_types.is_empty() {
            None
        } else {
            let mut builder = TypesBuilder::new();
            builder.add_defaults();
            for file_type in &parsed.file_types {
                builder.select(file_type);
            }
            Some(builder.build().map_err(|error| format!("type: {error}"))?)
        };
        Ok(Self { globs, types })
    }

    pub(super) fn allows(&self, path: &Path) -> bool {
        !self.globs.matched(path, false).is_ignore()
            && !self
                .types
                .as_ref()
                .is_some_and(|matcher| matcher.matched(path, false).is_ignore())
    }
}

/// One operand of a request: the spelling the argv used, the path it
/// resolves to, and the post-walk filter that decides which files under it
/// are in scope. The three always travel together — a file is reported only
/// once `filter` accepted it, and it is labelled by `display_path(operand,
/// operand_path, file)`.
pub(super) struct OperandScope<'a> {
    pub(super) operand: &'a str,
    pub(super) operand_path: &'a Path,
    pub(super) filter: &'a PathFilter,
}

pub(super) fn parse_args(args: &[String]) -> Result<ParsedArgs, String> {
    let mut p = ParsedArgs::default();
    let mut i = 0usize;
    let mut options = true;
    let take = |i: &mut usize, args: &[String]| -> Result<String, String> {
        *i += 1;
        args.get(*i)
            .cloned()
            .ok_or_else(|| "missing flag value".to_string())
    };
    while i < args.len() {
        let a = args[i].as_str();
        if !options {
            p.targets.push(a.to_string());
            i += 1;
            continue;
        }
        match a {
            "--" => options = false,
            "--color" => {
                take(&mut i, args)?;
            }
            "--threads" | "-j" => {
                take(&mut i, args)?;
            }
            "--hidden" => p.hidden = true,
            "--no-ignore" => p.no_ignore = true,
            "--text" | "-a" => p.text = true,
            "--no-require-git" => p.no_require_git = true,
            "--no-heading" | "--max-columns-preview" => {}
            "-H" => p.with_filename = true,
            "--line-number" | "-n" => p.line_numbers = true,
            "-i" => p.case_insensitive = true,
            "-F" => p.fixed_strings = true,
            "-P" => p.pcre2 = true,
            "-U" => p.multiline = true,
            "--multiline-dotall" => p.multiline_dotall = true,
            "--only-matching" | "-o" => p.only_matching = true,
            "--count" => p.count = true,
            "--files-with-matches" | "-l" => p.files_with_matches = true,
            "--files" => p.files_list = true,
            "--directories" => p.directories = true,
            "--type" => p.file_types.push(take(&mut i, args)?),
            "-e" => p.patterns.push(take(&mut i, args)?),
            "--glob" => {
                p.globs.push(take(&mut i, args)?);
            }
            "--iglob" => {
                p.iglobs.push(take(&mut i, args)?);
            }
            "--max-depth" => {
                p.max_depth = Some(take(&mut i, args)?.parse().map_err(|_| "bad --max-depth")?);
            }
            "-B" => p.before = take(&mut i, args)?.parse().map_err(|_| "bad -B")?,
            "-A" => p.after = take(&mut i, args)?.parse().map_err(|_| "bad -A")?,
            "-C" => {
                let n: usize = take(&mut i, args)?.parse().map_err(|_| "bad -C")?;
                p.before = n;
                p.after = n;
            }
            _ if a.starts_with("--max-columns=") => {
                p.max_columns = a["--max-columns=".len()..]
                    .parse()
                    .map_err(|_| "bad --max-columns")?;
            }
            _ if a.starts_with("--threads=") || a.starts_with("-j") && a.len() > 2 => {}
            _ if !a.starts_with('-') => p.targets.push(a.to_string()),
            other => return Err(format!("unsupported flag {other}")),
        }
        i += 1;
    }
    if p.patterns.is_empty() && !p.files_list {
        return Err("no -e patterns".to_string());
    }
    if p.targets.is_empty() {
        return Err("no target path".to_string());
    }
    p.literal_trigrams = literal_trigram_requirements(&p);
    Ok(p)
}
