//! Which files expose a declared name, and under which names: the declaring files plus every module that
//! re-exports it through an `export * from` or `export { name as alias } from` binding, followed to a fixed
//! point (a cycle of barrels ends when no new (file, name) pair appears).

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use mixdog_graph::resolve::{ImportRecord, resolve_and_link};
use regex::Regex;

use super::graph::{Graph, Node};

/// What a re-export statement passes on.
enum Passes {
    /// `export * from`: every name.
    All,
    /// `export { imported as exported } from`.
    Named(Vec<(String, String)>),
}

struct ReExport {
    spec: String,
    passes: Passes,
}

static STAR: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\bexport\s+\*\s*(as\s+[A-Za-z_$][\w$]*\s+)?from\s*['"]([^'"\n]+)['"]"#).expect("a fixed pattern")
});
static NAMED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"\n]+)['"]"#).expect("a fixed pattern")
});

fn re_exports(node: &Node) -> Vec<ReExport> {
    if !matches!(node.lang, "javascript" | "typescript") {
        return Vec::new();
    }
    let source = node.read();
    let text = source.text();
    let mut out = Vec::new();
    for found in STAR.captures_iter(text) {
        // `export * as ns` binds one namespace object, not the names inside it.
        if found.get(1).is_none() {
            out.push(ReExport { spec: found[2].to_owned(), passes: Passes::All });
        }
    }
    for found in NAMED.captures_iter(text) {
        let pairs = found[1]
            .split(',')
            .filter_map(|item| {
                let item = item.trim().trim_start_matches("type ").trim();
                let (imported, exported) = item.split_once(" as ").map_or((item, item), |(a, b)| (a.trim(), b.trim()));
                (!imported.is_empty()).then(|| (imported.to_owned(), exported.to_owned()))
            })
            .collect();
        out.push(ReExport { spec: found[2].to_owned(), passes: Passes::Named(pairs) });
    }
    out
}

/// One specifier of a file, resolved on its own by the graph's import resolver.
struct Spec {
    rel: String,
    lang: String,
    raw: Vec<String>,
    package: String,
    namespace: String,
    types: Vec<String>,
    resolved: Vec<String>,
}

impl ImportRecord for Spec {
    fn rel(&self) -> &str {
        &self.rel
    }
    fn lang(&self) -> &str {
        &self.lang
    }
    fn raw_imports(&self) -> &[String] {
        &self.raw
    }
    fn package_name(&self) -> &str {
        &self.package
    }
    fn namespace_name(&self) -> &str {
        &self.namespace
    }
    fn top_level_types(&self) -> &[String] {
        &self.types
    }
    fn set_edges(&mut self, resolved_imports: Vec<String>, _imported_by: Vec<String>) {
        self.resolved = resolved_imports;
    }
}

/// The files each specifier of `node`'s re-exports names, in the order given.
fn resolve_specs(graph: &Graph, files: &HashSet<String>, node: &Node, specs: &[&str]) -> Vec<Vec<String>> {
    let mut records: Vec<Spec> = specs
        .iter()
        .map(|spec| Spec {
            rel: node.rel.clone(),
            lang: node.lang.to_owned(),
            raw: vec![(*spec).to_owned()],
            package: node.package_name().to_owned(),
            namespace: node.namespace_name().to_owned(),
            types: node.top_level_types().to_vec(),
            resolved: Vec::new(),
        })
        .collect();
    resolve_and_link(&mut records, graph.root(), files);
    records.into_iter().map(|r| r.resolved).collect()
}

/// Every file that exposes `name` (declared in `roots`), with the names it exposes it under.
pub(super) fn exposing_files(graph: &Graph, roots: &[String], name: &str) -> HashMap<String, HashSet<String>> {
    let files: HashSet<String> = graph.nodes.iter().map(|n| n.rel.clone()).collect();
    let mut exposed: HashMap<String, HashSet<String>> = HashMap::new();
    let mut queue: Vec<(String, String)> = Vec::new();
    for root in roots {
        if exposed.entry(root.clone()).or_default().insert(name.to_owned()) {
            queue.push((root.clone(), name.to_owned()));
        }
    }
    // An importer's re-exports and what they resolve to, computed once.
    let mut forwarding: HashMap<String, Vec<(Vec<String>, Passes)>> = HashMap::new();
    while let Some((rel, exposed_as)) = queue.pop() {
        for importer_rel in graph.dependents(&rel) {
            let Some(importer) = graph.node(&importer_rel) else { continue };
            if !forwarding.contains_key(&importer_rel) {
                let statements = re_exports(importer);
                let specs: Vec<&str> = statements.iter().map(|s| s.spec.as_str()).collect();
                let targets = resolve_specs(graph, &files, importer, &specs);
                forwarding.insert(importer_rel.clone(), targets.into_iter().zip(statements.into_iter().map(|s| s.passes)).collect());
            }
            for (targets, passes) in &forwarding[&importer_rel] {
                if !targets.contains(&rel) {
                    continue;
                }
                let names: Vec<String> = match passes {
                    Passes::All => vec![exposed_as.clone()],
                    Passes::Named(pairs) => pairs.iter().filter(|(imported, _)| *imported == exposed_as).map(|(_, exported)| exported.clone()).collect(),
                };
                for forwarded in names {
                    if exposed.entry(importer_rel.clone()).or_default().insert(forwarded.clone()) {
                        queue.push((importer_rel.clone(), forwarded));
                    }
                }
            }
        }
    }
    exposed
}
