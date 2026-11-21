//! `compileLanguage` and `compileMode` of core.js: a dumped (uncompiled) language becomes the typed modes the
//! highlighter runs on.
//!
//! The compiler works on the dumped objects the way core.js works on JavaScript objects: it mutates them in
//! place, shares what the definition shares and clones what `expandOrCloneMode` clones, because the result
//! depends on that (a keyword table shared by two modes loses its `$pattern` to the first one compiled).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use super::keywords::{DEFAULT_KEYWORD_CLASSNAME, KeywordTable, compile_keywords};
use super::matcher::{LazyRegex, Matcher, RuleKind};
use super::{Hook, ModeData};
use crate::languages::callbacks;
use crate::languages::{Raw, RawLanguage, RawObject};

/// A compiler extension of a language (`compilerExtensions`): `(compiler, mode, parent)`.
pub(crate) type Extension = fn(&mut Compiler, usize, Option<usize>) -> Result<(), String>;

/// `mode.subLanguage`.
#[derive(Debug, Clone)]
pub(crate) enum SubLanguage {
    Name(String),
    List(Vec<String>),
}

/// A compiled mode.
#[derive(Debug)]
pub(crate) struct CMode {
    pub(crate) class_name: Option<String>,
    pub(crate) keywords: Option<KeywordTable>,
    pub(crate) keyword_pattern: Rc<LazyRegex>,
    pub(crate) sub_language: Option<SubLanguage>,
    pub(crate) relevance: f64,
    pub(crate) skip: bool,
    pub(crate) return_begin: bool,
    pub(crate) return_end: bool,
    pub(crate) exclude_begin: bool,
    pub(crate) exclude_end: bool,
    pub(crate) ends_parent: bool,
    pub(crate) ends_with_parent: bool,
    pub(crate) end_same_as_begin: bool,
    pub(crate) starts: Option<usize>,
    pub(crate) before_begin: Option<Hook>,
    pub(crate) on_begin: Option<Hook>,
    pub(crate) on_end: Option<Hook>,
    pub(crate) end_re: RefCell<Option<Rc<LazyRegex>>>,
    pub(crate) terminator_end: String,
    pub(crate) matcher: Matcher,
    pub(crate) data: RefCell<ModeData>,
}

impl CMode {
    fn blank(case_insensitive: bool) -> Self {
        Self {
            class_name: None,
            keywords: None,
            keyword_pattern: Rc::new(LazyRegex::new("\\w+".to_string(), case_insensitive)),
            sub_language: None,
            relevance: 1.0,
            skip: false,
            return_begin: false,
            return_end: false,
            exclude_begin: false,
            exclude_end: false,
            ends_parent: false,
            ends_with_parent: false,
            end_same_as_begin: false,
            starts: None,
            before_begin: None,
            on_begin: None,
            on_end: None,
            end_re: RefCell::new(None),
            terminator_end: String::new(),
            matcher: Matcher::new(Vec::new(), case_insensitive),
            data: RefCell::new(ModeData::default()),
        }
    }
}

/// A compiled language.
#[derive(Debug)]
pub(crate) struct CompiledLanguage {
    pub(crate) case_insensitive: bool,
    pub(crate) root: usize,
    pub(crate) modes: Vec<CMode>,
    pub(crate) class_aliases: HashMap<String, String>,
}

impl CompiledLanguage {
    /// `language.classNameAliases[name] || name`.
    pub(crate) fn class_alias<'a>(&'a self, name: &'a str) -> &'a str {
        self.class_aliases.get(name).map_or(name, String::as_str)
    }
}

pub(crate) struct Compiler {
    pub(crate) nodes: Vec<RawObject>,
    modes: Vec<CMode>,
    case_insensitive: bool,
    extensions: Vec<Extension>,
}

/// `either(...)` of core.js: `(a|b|c)`.
fn either(parts: &[Option<&str>]) -> String {
    let joined: Vec<&str> = parts.iter().map(|p| p.unwrap_or("")).collect();
    format!("({})", joined.join("|"))
}

struct TypedFields {
    class_name: Option<String>,
    sub_language: Option<SubLanguage>,
    relevance: f64,
    skip: bool,
    return_begin: bool,
    return_end: bool,
    exclude_begin: bool,
    exclude_end: bool,
    ends_parent: bool,
    ends_with_parent: bool,
    end_same_as_begin: bool,
    starts: Option<usize>,
}

fn object_ids(items: &[Raw]) -> Vec<usize> {
    items
        .iter()
        .filter_map(|item| match item {
            Raw::Obj(v) => Some(*v),
            _ => None,
        })
        .collect()
}

impl Compiler {
    /// Adds an object to the graph and returns its index.
    pub(crate) fn new_node(&mut self, object: RawObject) -> usize {
        self.nodes.push(object);
        self.modes.push(CMode::blank(self.case_insensitive));
        self.nodes.len() - 1
    }

    /// `inherit(original, ...objects)`: a new unfrozen object with the fields of `original`, each overridden by
    /// the later objects' fields.
    fn inherit(&mut self, original: usize, overlays: &[&[(String, Raw)]]) -> usize {
        let mut result = RawObject { frozen: false, fields: self.nodes[original].fields.clone() };
        for overlay in overlays {
            for (key, value) in *overlay {
                result.set(key, value.clone());
            }
        }
        self.new_node(result)
    }

    /// `dependencyOnParent(mode)`.
    fn dependency_on_parent(&self, id: usize) -> bool {
        let node = &self.nodes[id];
        if node.flag("endsWithParent") {
            return true;
        }
        match node.get("starts") {
            Some(Raw::Obj(starts)) => self.dependency_on_parent(*starts),
            _ => false,
        }
    }

    /// `expandOrCloneMode(mode)`.
    fn expand_or_clone(&mut self, id: usize) -> Vec<usize> {
        let variants: Option<Vec<usize>> = match self.nodes[id].truthy("variants") {
            Some(Raw::Arr(items)) => Some(object_ids(items)),
            _ => None,
        };
        // On a frozen object the assignment of `cachedVariants` is silently dropped (the library is sloppy-mode
        // code), so its variants are never expanded; no shared mode of core.js has any.
        if let Some(variants) = variants
            && self.nodes[id].truthy("cachedVariants").is_none()
            && !self.nodes[id].frozen
        {
            let clones: Vec<Raw> = variants
                .into_iter()
                .map(|variant| {
                    let overlay = self.nodes[variant].fields.clone();
                    let none = [("variants".to_string(), Raw::Null)];
                    Raw::Obj(self.inherit(id, &[&none, &overlay]))
                })
                .collect();
            self.nodes[id].set("cachedVariants", Raw::Arr(clones));
        }
        if let Some(Raw::Arr(cached)) = self.nodes[id].truthy("cachedVariants") {
            return object_ids(cached);
        }
        if self.dependency_on_parent(id) {
            let starts = match self.nodes[id].get("starts") {
                Some(Raw::Obj(starts)) => {
                    let starts = *starts;
                    Raw::Obj(self.inherit(starts, &[]))
                }
                _ => Raw::Null,
            };
            let overlay = [("starts".to_string(), starts)];
            return vec![self.inherit(id, &[&overlay])];
        }
        if self.nodes[id].frozen {
            return vec![self.inherit(id, &[])];
        }
        vec![id]
    }

    fn hook_of(&self, id: usize, key: &str) -> Result<Option<Hook>, String> {
        match self.nodes[id].get(key) {
            Some(Raw::Cb(name)) => callbacks::hook(name).map(Some).ok_or_else(|| format!("unknown callback {name}")),
            _ => Ok(None),
        }
    }

    /// core.js `compileMatch`: `match` becomes the mode's `begin`.
    fn compile_match(&mut self, id: usize) -> Result<(), String> {
        if self.nodes[id].truthy("match").is_some() {
            if self.nodes[id].flag("begin") || self.nodes[id].flag("end") {
                return Err("begin & end are not supported with match".to_string());
            }
            if let Some(m) = self.nodes[id].remove("match") {
                self.nodes[id].set("begin", m);
            }
        }
        Ok(())
    }

    /// `beginKeywords` becomes a `begin` regex that skips a keyword after a dot.
    fn compile_begin_keywords(&mut self, id: usize) {
        let Some(Raw::Str(words)) = self.nodes[id].truthy("beginKeywords").cloned() else { return };
        let begin = format!("\\b({})(?!\\.)(?=\\b|\\s)", words.split(' ').collect::<Vec<_>>().join("|"));
        let node = &mut self.nodes[id];
        node.set("begin", Raw::Str(begin));
        node.set("__beforeBegin", Raw::Cb("skipIfHasPrecedingDot".to_string()));
        if !node.flag("keywords") {
            node.set("keywords", Raw::Str(words));
        }
        node.remove("beginKeywords");
        if node.get("relevance").is_none() {
            node.set("relevance", Raw::Num(0.0));
        }
    }

    /// The typed fields the highlighter reads from a node.
    fn typed_fields(&self, id: usize) -> TypedFields {
        let node = &self.nodes[id];
        let sub_language = match node.get("subLanguage") {
            Some(Raw::Str(name)) => Some(SubLanguage::Name(name.clone())),
            Some(Raw::Arr(list)) => Some(SubLanguage::List(
                list.iter()
                    .filter_map(|item| match item {
                        Raw::Str(s) => Some(s.clone()),
                        _ => None,
                    })
                    .collect(),
            )),
            _ => None,
        };
        let relevance = match node.get("relevance") {
            Some(Raw::Num(n)) => *n,
            _ => 1.0,
        };
        let class_name = match node.truthy("className") {
            Some(Raw::Str(s)) => Some(s.clone()),
            _ => None,
        };
        let starts = match node.get("starts") {
            Some(Raw::Obj(s)) => Some(*s),
            _ => None,
        };
        TypedFields {
            class_name,
            sub_language,
            relevance,
            skip: node.flag("skip"),
            return_begin: node.flag("returnBegin"),
            return_end: node.flag("returnEnd"),
            exclude_begin: node.flag("excludeBegin"),
            exclude_end: node.flag("excludeEnd"),
            ends_parent: node.flag("endsParent"),
            ends_with_parent: node.flag("endsWithParent"),
            end_same_as_begin: node.flag("endSameAsBegin"),
            starts,
        }
    }

    /// The `end` of a nested mode and the terminator regex source it contributes: its own end, then its parent's when it
    /// ends with the parent.
    fn compile_terminator(&mut self, id: usize, parent: Option<usize>) -> (String, Option<Rc<LazyRegex>>) {
        let Some(parent) = parent else { return (String::new(), None) };
        if !self.nodes[id].flag("begin") {
            self.nodes[id].set("begin", Raw::Re("\\B|\\b".to_string()));
        }
        if self.nodes[id].flag("endSameAsBegin") {
            let begin = self.nodes[id].get("begin").cloned().unwrap_or(Raw::Null);
            self.nodes[id].set("end", begin);
        }
        if !self.nodes[id].flag("end") && !self.nodes[id].flag("endsWithParent") {
            self.nodes[id].set("end", Raw::Re("\\B|\\b".to_string()));
        }
        let end_source = self.nodes[id].truthy("end").and_then(Raw::source).map(str::to_string);
        let end_re = end_source.as_ref().map(|source| Rc::new(LazyRegex::new(source.clone(), self.case_insensitive)));
        let mut terminator_end = end_source.clone().unwrap_or_default();
        let parent_terminator = self.modes[parent].terminator_end.clone();
        if self.nodes[id].flag("endsWithParent") && !parent_terminator.is_empty() {
            if end_source.is_some() {
                terminator_end.push('|');
            }
            terminator_end.push_str(&parent_terminator);
        }
        (terminator_end, end_re)
    }

    /// `compileMode(mode, parent)`.
    pub(crate) fn compile_mode(&mut self, id: usize, parent: Option<usize>) -> Result<(), String> {
        if self.nodes[id].flag("isCompiled") {
            return Ok(());
        }

        self.compile_match(id)?;

        for extension in self.extensions.clone() {
            extension(self, id, parent)?;
        }

        // `mode.__beforeBegin = null`
        self.nodes[id].set("__beforeBegin", Raw::Null);

        if parent.is_some() {
            self.compile_begin_keywords(id);
        }

        if let Some(Raw::Arr(items)) = self.nodes[id].get("illegal").cloned() {
            let sources: Vec<Option<&str>> = items.iter().map(Raw::source).collect();
            let joined = either(&sources);
            self.nodes[id].set("illegal", Raw::Str(joined));
        }

        if self.nodes[id].get("relevance").is_none() {
            self.nodes[id].set("relevance", Raw::Num(1.0));
        }

        self.nodes[id].set("isCompiled", Raw::Bool(true));

        let mut keyword_pattern: Option<Raw> = None;
        if let Some(Raw::Obj(table)) = self.nodes[id].get("keywords").cloned() {
            keyword_pattern = self.nodes[table].remove("$pattern");
        }
        let keywords = match self.nodes[id].truthy("keywords").cloned() {
            Some(raw) => {
                let mut table = KeywordTable::new();
                compile_keywords(&raw, &self.nodes, self.case_insensitive, DEFAULT_KEYWORD_CLASSNAME, &mut table);
                Some(table)
            }
            None => None,
        };
        let lexemes = self.nodes[id].truthy("lexemes").cloned();
        let pattern = keyword_pattern.filter(Raw::truthy);
        if lexemes.is_some() && pattern.is_some() {
            return Err("ERR: Prefer `keywords.$pattern` to `mode.lexemes`, BOTH are not allowed. (see mode reference) ".to_string());
        }
        let pattern_source = pattern.as_ref().or(lexemes.as_ref()).and_then(Raw::source).unwrap_or("\\w+").to_string();
        let keyword_pattern = Rc::new(LazyRegex::new(pattern_source, self.case_insensitive));

        let (terminator_end, end_re) = self.compile_terminator(id, parent);
        if !self.nodes[id].flag("contains") {
            self.nodes[id].set("contains", Raw::Arr(Vec::new()));
        }

        let typed = self.typed_fields(id);
        let before_begin = self.hook_of(id, "__beforeBegin")?;
        let on_begin = self.hook_of(id, "on:begin")?;
        let on_end = self.hook_of(id, "on:end")?;
        {
            let mode = &mut self.modes[id];
            mode.class_name = typed.class_name;
            mode.keywords = keywords;
            mode.keyword_pattern = keyword_pattern;
            mode.sub_language = typed.sub_language;
            mode.relevance = typed.relevance;
            mode.skip = typed.skip;
            mode.return_begin = typed.return_begin;
            mode.return_end = typed.return_end;
            mode.exclude_begin = typed.exclude_begin;
            mode.exclude_end = typed.exclude_end;
            mode.ends_parent = typed.ends_parent;
            mode.ends_with_parent = typed.ends_with_parent;
            mode.end_same_as_begin = typed.end_same_as_begin;
            mode.starts = typed.starts;
            mode.before_begin = before_begin;
            mode.on_begin = on_begin;
            mode.on_end = on_end;
            mode.end_re = RefCell::new(end_re);
            mode.terminator_end = terminator_end.clone();
        }

        let entries = match self.nodes[id].get("contains") {
            Some(Raw::Arr(items)) => items.clone(),
            _ => Vec::new(),
        };
        let mut expanded = Vec::new();
        for entry in entries {
            let target = match entry {
                Raw::Str(name) if name == "self" => id,
                Raw::Obj(object) => object,
                other => return Err(format!("unsupported contains entry {other:?}")),
            };
            expanded.extend(self.expand_or_clone(target));
        }
        self.nodes[id].set("contains", Raw::Arr(expanded.iter().map(|c| Raw::Obj(*c)).collect()));
        for child in &expanded {
            self.compile_mode(*child, Some(id))?;
        }

        if let Some(Raw::Obj(starts)) = self.nodes[id].truthy("starts").cloned() {
            self.compile_mode(starts, parent)?;
        }

        let mut rules: Vec<(String, RuleKind)> = Vec::new();
        for child in &expanded {
            let begin = self.nodes[*child].get("begin").and_then(Raw::source).ok_or_else(|| "a contained mode has no begin".to_string())?;
            rules.push((begin.to_string(), RuleKind::Begin(*child)));
        }
        if !terminator_end.is_empty() {
            rules.push((terminator_end, RuleKind::End));
        }
        if let Some(illegal) = self.nodes[id].truthy("illegal").and_then(Raw::source) {
            rules.push((illegal.to_string(), RuleKind::Illegal));
        }
        self.modes[id].matcher = Matcher::new(rules, self.case_insensitive);
        Ok(())
    }
}

/// `compileLanguage(language)`.
pub(crate) fn compile_language(raw: &RawLanguage) -> Result<CompiledLanguage, String> {
    let root = &raw.objects[raw.root];
    let case_insensitive = root.flag("case_insensitive");
    if let Some(Raw::Arr(contains)) = root.get("contains")
        && contains.iter().any(|c| matches!(c, Raw::Str(s) if s == "self"))
    {
        return Err("ERR: contains `self` is not supported at the top-level of a language.  See documentation.".to_string());
    }
    let mut extensions = Vec::new();
    if let Some(Raw::Arr(list)) = root.get("compilerExtensions") {
        for item in list {
            if let Raw::Cb(name) = item {
                extensions.push(callbacks::extension(name).ok_or_else(|| format!("unknown compiler extension {name}"))?);
            }
        }
    }
    let mut class_aliases = HashMap::new();
    if let Some(Raw::Obj(dict)) = root.get("classNameAliases") {
        for (key, value) in &raw.objects[*dict].fields {
            if let Raw::Str(alias) = value {
                class_aliases.insert(key.clone(), alias.clone());
            }
        }
    }
    let mut compiler =
        Compiler { nodes: raw.objects.clone(), modes: raw.objects.iter().map(|_| CMode::blank(case_insensitive)).collect(), case_insensitive, extensions };
    compiler.compile_mode(raw.root, None)?;
    Ok(CompiledLanguage { case_insensitive, root: raw.root, modes: compiler.modes, class_aliases })
}
