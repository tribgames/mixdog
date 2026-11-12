//! Embeds Mixdog's Google OAuth "Desktop app" client, as Node does at release packaging
//! (`scripts/embed-google-oauth-client.mjs`): the values come from MIXDOG_GOOGLE_OAUTH_CLIENT_ID /
//! MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET (the repository secrets) — both must be set — or, failing
//! that, from the gitignored `src/runtime/shared/google-oauth-client.generated.json` that same
//! script writes. A build with neither has no built-in Google sign-in (the user's own client
//! still works). The values are never printed.

#![allow(clippy::disallowed_methods, reason = "a build script runs before any runtime exists")]

use std::path::PathBuf;

#[path = "../../build-support/dev_only.rs"]
mod dev_only;

const ID_VAR: &str = "MIXDOG_GOOGLE_OAUTH_CLIENT_ID";
const SECRET_VAR: &str = "MIXDOG_GOOGLE_OAUTH_CLIENT_SECRET";
const GENERATED: &str = "src/runtime/shared/google-oauth-client.generated.json";

fn text(value: Option<String>) -> String {
    value.unwrap_or_default().trim().to_owned()
}

fn quote(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() => out.push_str(&format!("\\u{{{:x}}}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn main() {
    dev_only::refuse_in_release(&["test-support"]);
    println!("cargo:rerun-if-env-changed={ID_VAR}");
    println!("cargo:rerun-if-env-changed={SECRET_VAR}");
    let repo = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets it")).join("../../../..");
    let generated = repo.join(GENERATED);
    // Cargo treats a missing rerun-if-changed path as always changed, which reran this script and
    // recompiled every downstream crate on each build. While the file is absent, watch the nearest
    // existing ancestor instead: creating the file still bumps that directory.
    let watched = generated.ancestors().find(|path| path.exists()).unwrap_or(&repo);
    println!("cargo:rerun-if-changed={}", watched.display());

    let (id, secret) = (text(std::env::var(ID_VAR).ok()), text(std::env::var(SECRET_VAR).ok()));
    let client = if !id.is_empty() && !secret.is_empty() {
        Some((id, secret))
    } else {
        std::fs::read_to_string(&generated).ok().and_then(|source| {
            let value: serde_json::Value = serde_json::from_str(&source).ok()?;
            let field = |key: &str| value.get(key).and_then(|v| v.as_str()).unwrap_or_default().trim().to_owned();
            let id = field("clientId");
            (!id.is_empty()).then(|| (id, field("clientSecret")))
        })
    };
    let source = match client {
        Some((id, secret)) => format!("Some(({}, {}))", quote(&id), quote(&secret)),
        None => "None".to_owned(),
    };
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("cargo sets it")).join("google_client.rs");
    // An unchanged rewrite would still bump the mtime that rustc's dep-info compares.
    if std::fs::read_to_string(&out).ok().as_deref() != Some(source.as_str()) {
        std::fs::write(out, source).expect("write the embedded client");
    }
}
