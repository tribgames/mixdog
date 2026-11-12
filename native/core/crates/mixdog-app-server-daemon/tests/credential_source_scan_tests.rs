//! A new bypass of the credential-read counter fails here. The counter sits at the places that perform a read (the secret
//! stores, the credential files, `Environment::key_var` / `process_key_var_os`); a direct read of an environment variable or
//! a call of a secret store in the non-test code of the credential-handling modules must be one of the listed ones, each
//! with the reason it needs no count. A hit that is not listed fails; so does a listed entry nothing matches any more.

use std::path::Path;
use std::path::PathBuf;

/// What a direct read looks like in source.
const READS: [&str; 15] = [
    "std::env::var",
    "use std::env::{",
    "env::var(",
    "env::vars",
    "env::var_os",
    "store.has(",
    "vault.has(",
    ".var(",
    ".var_os(",
    "store.get(",
    "vault.get(",
    "probe.get(",
    "keychain.get(",
    "tracked.get(",
    "self.inner.get(account",
];

/// The credential-handling code, relative to `native/core/crates`: whole directories and single files.
const SCANNED: [&str; 8] = [
    "mixdog-ai/src",
    "mixdog-secrets/src",
    "mixdog-core-domains/src/domains/ai_account",
    "mixdog-core/src/run_host/vault.rs",
    "mixdog-core/src/run_host/model_proxy_pc.rs",
    "mixdog-core/src/run_host/builder_env.rs",
    "mixdog-core/src/run_host/process.rs",
    "mixdog-core-config/src/config/secret_changes.rs",
];

/// (file, text of the line, why that read is not a counted credential read).
const ALLOWED: &[(&str, &str, &str)] = &[
    // The counting funnels and the implementations behind them.
    ("mixdog-ai/src/registry/keys.rs", "self.var(name)", "Environment::key_var itself: the one counted read of a credential variable"),
    ("mixdog-ai/src/registry/keys.rs", "std::env::var_os(name)", "process_key_var_os: the counted read for a caller with no injected Environment"),
    ("mixdog-ai/src/registry/keys.rs", "std::env::var(name).ok()", "ProcessEnv::var: the implementation key_var and the non-credential readers call"),
    ("mixdog-ai/src/registry/keys.rs", "self.vault.get(account)", "ApiKeyStore::stored: the store behind the vault performs and counts the read"),
    ("mixdog-ai/src/service/api_usage.rs", "self.vault.get(OPENAI_USAGE_SESSION_KEY_ACCOUNT)", "the store behind the vault performs and counts the read"),
    ("mixdog-core/src/run_host/vault.rs", "self.store.get(account)", "KeychainVault::get delegates to the SecretStore, which counts"),
    ("mixdog-core-domains/src/domains/ai_account/admin.rs", "self.vault.get(&account)", "the store behind the vault performs and counts the read"),
    ("mixdog-core-domains/src/domains/ai_account/custom_admin.rs", "self.vault.get(&account)", "the store behind the vault performs and counts the read"),
    ("mixdog-core-domains/src/domains/ai_account/keychain_live.rs", "self.probe.get(PROBE_ACCOUNT)", "a SecretStore lookup: the store counts it"),
    ("mixdog-core-config/src/config/secret_changes.rs", "self.inner.get(account)", "a wrapper that delegates to the SecretStore, which counts"),
    ("mixdog-ai/src/accounts/rotation.rs", "state.last_probe.get(", "a map of probe times, not a secret store"),
    ("mixdog-ai/src/accounts/mod.rs", "env.var(variable)", "a provider's *_OAUTH_CREDENTIALS_PATH: the path of a credential file, not a secret; the file read is counted"),
    ("mixdog-ai/src/providers/compat/xai_cache.rs", "self.var(", "the cache-routing switches (scope, shards, auto), not a credential"),
    ("mixdog-ai/src/providers/compat/xai_cache.rs", "env.var(name)", "the cache-routing switches (scope, shards, auto), not a credential"),
    ("mixdog-core-domains/src/domains/ai_account/setup_world.rs", "self.vault.get(account)", "the store behind the vault performs and counts the read"),
    ("mixdog-secrets/src/fallback.rs", "self.keychain.get(account)", "FallbackStore delegates to the keychain store, which counts"),
    ("mixdog-secrets/src/status.rs", "self.inner.get(account)", "TrackedStore delegates to the store it wraps, which counts"),
    // Not credentials: a path, a mode, an identifier, a version, a tuning knob.
    ("mixdog-ai/src/registry/builder.rs", "GOOGLE_APPLICATION_CREDENTIALS", "the path of the login file; reading the file is counted (read_credential_text)"),
    ("mixdog-ai/src/registry/builder.rs", "MIXDOG_OAI_TRANSPORT", "a transport mode"),
    ("mixdog-ai/src/registry/builder.rs", "MIXDOG_XAI_API_MODE", "xAI's API mode (Responses or Chat)"),
    ("mixdog-ai/src/registry/builder.rs", "MIXDOG_XAI_RESPONSES", "xAI's API mode under its earlier name"),
    ("mixdog-ai/src/registry/builder.rs", "let var = |name: &str| self.env.env.var(name)", "gcloud directory variables (CLOUDSDK_CONFIG, APPDATA): paths"),
    ("mixdog-ai/src/registry/builder.rs", "CLOUDSDK_ACTIVE_CONFIG_NAME", "the name of a gcloud configuration"),
    ("mixdog-ai/src/registry/builder.rs", "let get = |name: &str| env.var(name)", "the Vertex project and location variables: identifiers"),
    ("mixdog-ai/src/registry/builder.rs", "resolve_project(&credential, &|n| env.var(n))", "the Vertex project variables: identifiers"),
    ("mixdog-ai/src/registry/builder.rs", "env_location(|n| self.env.env.var(n)", "the Vertex location variable: an identifier"),
    ("mixdog-ai/src/registry/builder.rs", ".find_map(|name| env.var(name)", "vertex::PROJECT_ENV: project identifiers"),
    ("mixdog-ai/src/service/api_usage.rs", "XAI_TEAM_ID", "a team identifier, not a secret"),
    ("mixdog-ai/src/catalog/listing.rs", "MIXDOG_MODEL_STALE_MONTHS", "a staleness bound (code after an inline test module, unscanned before this round)"),
    ("mixdog-ai/src/providers/google/mod.rs", "std::env::var(name).ok()", "cache tuning variables (code after an inline test module, unscanned before this round)"),
    // The OpenAI wire's process settings (Node's `process.env` reads of the Codex transport): four switches, read through `WireContext::var`.
    ("mixdog-ai/src/providers/openai/config.rs", "std::env::var(name).ok()", "WireContext::var: the wire's settings reader (keep-alive, request compression, cache-key switches)"),
    ("mixdog-ai/src/providers/openai/adapter.rs", "var: Box::new(|name| std::env::var(name).ok())", "Sources::var: the adapter's WireContext::var over the process environment"),
    ("mixdog-ai/src/providers/openai/adapter.rs", "MIXDOG_LLM_KEEPALIVE_MS", "the keep-alive time the preconnect's TTL comes from"),
    ("mixdog-ai/src/providers/grok/auth.rs", "MIXDOG_LLM_KEEPALIVE_MS", "the keep-alive time the preconnect's TTL comes from"),
    // The refresh-lease replay's own harness (two real processes): where the reference Node and its tree are, and the mark of a child.
    ("mixdog-ai/src/providers/grok/refresh_lease/processes.rs", "MIXDOG_REFERENCE_NODE", "test harness: the reference Node binary, not a credential"),
    ("mixdog-ai/src/providers/grok/refresh_lease/processes.rs", "MIXDOG_REFERENCE_TREE", "test harness: the reference Node tree, not a credential"),
    ("mixdog-ai/src/providers/grok/refresh_lease/processes.rs", "MIXDOG_LEASE_CHILD", "test harness: marks the child process of the replay, not a credential"),
    ("mixdog-ai/src/transport/node_http.rs", "REPLAY_PROVIDER_PIN\")", "the replay's pin of a spawned binary: the stand-in provider's address, not a credential"),
    ("mixdog-ai/src/transport/node_http.rs", "REPLAY_PROVIDER_PIN_CERT", "the replay's pin of a spawned binary: the stand-in's certificate path, not a credential"),
    ("mixdog-ai/src/providers/openai/adapter.rs", "MIXDOG_OPENAI_REQ_ZSTD", "the request-compression switch"),
    ("mixdog-ai/src/providers/openai/body.rs", "|name: &str| config.context.var(name)", "the cache-key switches (MIXDOG_OAI_CACHE_KEY_SHARED, MIXDOG_OAI_CODEX_THREAD_CACHE_KEY)"),
    ("mixdog-ai/src/providers/openai/cache_key.rs", "std::env::var(name).ok()", "process_var: the cache-key switches for a caller with no injected environment"),
    // The Anthropic wire's process settings (Node's `process.env` reads of the Anthropic transport): switches, none a credential.
    ("mixdog-ai/src/providers/anthropic/adapter.rs", "settings: Arc::new(|name| std::env::var(name).ok())", "the adapter's settings reader over the process environment (the request-gzip switch MIXDOG_ANTHROPIC_REQ_GZIP, the keep-alive time)"),
    ("mixdog-ai/src/providers/anthropic/codec.rs", "MIXDOG_ANTHROPIC_MESSAGE_THREADS", "the message-threads switch"),
    ("mixdog-ai/src/providers/anthropic/threads.rs", "MIXDOG_QUIET_PROVIDER_LOG", "the switch that silences the provider's stderr line"),
    ("mixdog-ai/src/registry/builder.rs", "Arc::new(move |name| context.var(name))", "the wire settings reader over the process's request context (WireContext::var), the same switches"),
    ("mixdog-ai/src/admission/settings.rs", "MIXDOG_PROVIDER_ADMISSION_MAX_QUEUE", "a queue bound"),
    ("mixdog-ai/src/providers/openai/adapter.rs", "http_response_ms(|name| links.context.var(name))", "the HTTP initial-response window (MIXDOG_PROVIDER_HTTP_RESPONSE_TIMEOUT_MS, STALL_TIMEOUT_S): a duration"),
    ("mixdog-ai/src/providers/openai/adapter.rs", "hedge::Window::from_settings(|name| self.context.var(name))", "the WebSocket hedge and acquire windows (MIXDOG_PROVIDER_WS_HEDGE_MS, MIXDOG_PROVIDER_WS_ACQUIRE_TIMEOUT_MS): durations"),
    ("mixdog-ai/src/providers/openai/config.rs", "self.var(name).is_some_and(", "WireContext::flag: an on/off switch read through the wire's settings reader"),
    ("mixdog-ai/src/registry/builder.rs", "MIXDOG_ANTIGRAVITY_FC_MODE", "the function-calling mode switch"),
    ("mixdog-ai/src/providers/first_byte.rs", "Self::once(&AT_START, |name| std::env::var(name).ok())", "the first-response budgets (stall, first-byte and Antigravity retry variables): durations and counts"),
    ("mixdog-ai/src/catalog/sources.rs", "let env = |name: &str| std::env::var(name).ok()", "the model floor's variables: model names"),
    ("mixdog-ai/src/client_versions.rs", "MIXDOG_DISABLE_LIVE_CLI_VERSIONS", "a feature flag"),
    ("mixdog-ai/src/client_versions.rs", "MIXDOG_ANTIGRAVITY_VERSION", "a client version"),
    ("mixdog-ai/src/client_versions.rs", "let text = |name: &str| env.var(name)", "client version overrides"),
    ("mixdog-ai/src/netproxy/route.rs", "std::env::var_os(name).map(|value| value.to_string_lossy()", "the proxy route variables (HTTP_PROXY, NO_PROXY): endpoints"),
    ("mixdog-ai/src/netproxy/system.rs", "std::env::var(\"SystemRoot\")", "the Windows directory"),
    ("mixdog-ai/src/providers/compat/login/command_code.rs", "std::env::var_os(\"USERPROFILE\")", "the home directory"),
    ("mixdog-ai/src/providers/compat/login/command_code.rs", "std::env::var_os(\"HOME\")", "the home directory"),
    ("mixdog-ai/src/providers/compat/xai_cache.rs", "self.environment.and_then(|env| env.var(name))", "cache-lane tuning variables (scope, shards, auto)"),
    ("mixdog-ai/src/providers/google/conformance.rs", "MIXDOG_FIXTURES_DIR", "the fixtures directory of the conformance runner"),
    ("mixdog-secrets/src/lib.rs", "MIXDOG_KEYCHAIN_TIMEOUT_MS", "a timeout"),
    ("mixdog-secrets/src/linux.rs", "std::env::var(name).ok()", "the session bus address variables"),
    ("mixdog-secrets/src/linux.rs", "XDG_RUNTIME_DIR", "the session bus directory"),
    ("mixdog-core-domains/src/domains/ai_account/admin.rs", "std::env::var(MODEL_PROXY_ENV)", "the model-proxy mode switch"),
    ("mixdog-core/src/run_host/process.rs", "model_proxy_client_mode(&|name| env.var(name))", "the model-proxy mode switch"),
    ("mixdog-core/src/run_host/process.rs", "MIXDOG_CODEX_INSTALLATION_ID", "an installation identifier"),
    ("mixdog-core/src/run_host/builder_env.rs", "env.var(name).map(|v| mixdog_js::js_trim(&v)", "set(): MIXDOG_CODEX_USER_AGENT, _ORIGINATOR, _VERSION, TERM_PROGRAM: header texts"),
    ("mixdog-core/src/run_host/builder_env.rs", "MIXDOG_CODEX_BETA_FEATURES", "a feature list"),
    ("mixdog-core/src/run_host/builder_env.rs", "MIXDOG_ANTHROPIC_ALWAYS_ENABLE_EFFORT", "a feature flag"),
];

fn crates_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("crates dir").to_path_buf()
}

fn rust_files(path: &Path, out: &mut Vec<PathBuf>) {
    if path.is_file() {
        out.push(path.to_path_buf());
        return;
    }
    for entry in std::fs::read_dir(path).expect("read dir").flatten() {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_owned();
        if path.is_dir() {
            if name != "tests" {
                rust_files(&path, out);
            }
        } else if name.ends_with(".rs") && !name.ends_with("tests.rs") && name != "testing.rs" {
            out.push(path);
        }
    }
}

/// The lines of the non-test code: the file without its `#[cfg(test)]` items. An item is skipped through its closing
/// brace (or its `;`), so code after an inline test module is scanned.
fn production_lines(path: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(path).expect("read source");
    let mut out = Vec::new();
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if line.trim() != "#[cfg(test)]" {
            out.push(line.to_owned());
            continue;
        }
        let mut depth = 0i32;
        for item in lines.by_ref() {
            if item.trim_start().starts_with('#') {
                continue;
            }
            depth += item.matches('{').count() as i32 - item.matches('}').count() as i32;
            if depth <= 0 && (item.trim_end().ends_with(';') || item.contains('}')) {
                break;
            }
        }
    }
    out
}

#[test]
fn every_direct_credential_read_in_the_credential_modules_is_listed_with_its_reason() {
    let root = crates_dir();
    let mut files = Vec::new();
    for scanned in SCANNED {
        rust_files(&root.join(scanned), &mut files);
    }
    let mut used = vec![false; ALLOWED.len()];
    let mut unlisted = Vec::new();
    for file in &files {
        let relative = file.strip_prefix(&root).expect("under crates").to_string_lossy().replace('\\', "/");
        for (number, line) in production_lines(file).iter().enumerate() {
            let code = line.trim();
            if code.starts_with("//") || !READS.iter().any(|read| code.contains(read)) {
                continue;
            }
            let mut listed = false;
            for (index, (path, text, _)) in ALLOWED.iter().enumerate() {
                if *path == relative && code.contains(text) {
                    used[index] = true;
                    listed = true;
                }
            }
            if !listed {
                unlisted.push(format!("{relative}:{}: {code}", number + 1));
            }
        }
    }
    assert!(
        unlisted.is_empty(),
        "a direct read of a variable or a secret store bypasses the work counter. Route it through Environment::key_var, \
         process_key_var_os or a counted store, or list it in ALLOWED with the reason it is not a credential:\n{}",
        unlisted.join("\n")
    );
    let stale: Vec<String> = ALLOWED.iter().zip(&used).filter(|(_, used)| !**used).map(|((path, text, _), _)| format!("{path}: {text}")).collect();
    assert!(stale.is_empty(), "allowlist entries no code matches any more:\n{}", stale.join("\n"));
}
