//! The entry of a worker process (`mixdogd ext-worker`): READY on the frame pipe, then the calls of the registry this build
//! assembles.

use std::process::ExitCode;
use std::sync::OnceLock;

use crate::methods::register_document_methods;
use crate::registry::Registry;

/// A registration another crate contributes (the office tracks): it adds that crate's methods to the registry.
pub type Extension = fn(&mut Registry);

/// The registry of this build: the document methods, then each extension's.
pub fn assemble(extensions: &[Extension]) -> Registry {
    let mut registry = Registry::new();
    register_document_methods(&mut registry);
    for extension in extensions {
        extension(&mut registry);
    }
    registry
}

/// The method names a worker of this build serves, sorted, read from the registry it assembles.
pub fn native_methods() -> Vec<&'static str> {
    static NAMES: OnceLock<Vec<&'static str>> = OnceLock::new();
    NAMES
        .get_or_init(|| {
            native_methods_with(&[])
                .into_iter()
                .map(|name| &*Box::leak(name.into_boxed_str()))
                .collect()
        })
        .clone()
}

/// [`native_methods`] of a composition with `extensions`.
pub fn native_methods_with(extensions: &[Extension]) -> Vec<String> {
    assemble(extensions).methods().into_iter().map(str::to_owned).collect()
}

/// Runs a worker with the document methods until the pool says bye or closes the pipe.
pub fn ext_worker_main() -> ExitCode {
    ext_worker_main_with(&[])
}

/// [`ext_worker_main`] with the registrations of other crates added.
pub fn ext_worker_main_with(extensions: &[Extension]) -> ExitCode {
    let (input, output) = match crate::run::stdio() {
        Ok(pipes) => pipes,
        Err(error) => {
            eprintln!("ext-host: cannot take the frame pipes: {error}");
            return ExitCode::from(1);
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("ext-host: cannot start the runtime: {error}");
            return ExitCode::from(1);
        }
    };
    let code = runtime.block_on(crate::run::serve(assemble(extensions), input, output));
    // The blocked read of standard input and a handler that never returns must not hold the process.
    runtime.shutdown_background();
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_names_come_from_the_registry_and_an_extension_adds_to_them() {
        assert_eq!(
            native_methods(),
            vec!["image.jpeg", "image.probe", "image.resize", "image.still", "image.validate", "media.officeText", "media.pdfCounts", "media.pdfText", "office.sweepJournals", "ooxml.text", "pdf.inspect"]
        );
        let extra: Extension =
            |registry| registry.register("zzz.extra", |_| async { Ok(crate::Outcome::value(serde_json::Value::Null)) });
        let all = native_methods_with(&[extra]);
        assert_eq!(all.len(), native_methods().len() + 1);
        assert_eq!(all.last().map(String::as_str), Some("zzz.extra"));
    }
}
