//! Declared names of the scopes a classic script is made of, for the redeclaration rules of the early-error
//! pass: a lexical name (`let`, `const`, `class`, a function in a block) may not meet another declaration of the
//! same name in its scope, and a `var` (which hoists to the function or script scope) may not pass through a scope
//! that holds the name lexically.

use std::collections::HashMap;
use std::collections::HashSet;

use crate::message::Reason;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ScopeKind {
    /// The script itself: functions declared here are var-scoped.
    Script,
    /// A function body together with its parameters.
    Function,
    /// A block, a `for` head, a `switch` body.
    Block,
    /// A `catch` clause: the parameter and the body's own declarations share the scope.
    Catch { simple: bool },
}

impl ScopeKind {
    fn hoist_target(self) -> bool {
        matches!(self, Self::Script | Self::Function)
    }
}

struct Scope {
    kind: ScopeKind,
    lexical: HashSet<String>,
    vars: HashSet<String>,
    /// Functions declared in a block, with whether each is a plain function (sloppy code may repeat those).
    funcs: HashMap<String, bool>,
    params: HashSet<String>,
}

impl Scope {
    fn new(kind: ScopeKind) -> Self {
        Self {
            kind,
            lexical: HashSet::new(),
            vars: HashSet::new(),
            funcs: HashMap::new(),
            params: HashSet::new(),
        }
    }
}

pub struct Scopes {
    stack: Vec<Scope>,
}

fn redeclared(name: &str) -> Reason {
    Reason::Redeclared(name.to_owned())
}

impl Scopes {
    pub fn new() -> Self {
        Self { stack: vec![Scope::new(ScopeKind::Script)] }
    }

    pub fn push(&mut self, kind: ScopeKind) {
        self.stack.push(Scope::new(kind));
    }

    pub fn pop(&mut self) {
        self.stack.pop();
    }

    /// Parameter (or catch parameter) names of the innermost scope.
    pub fn add_params(&mut self, names: &[String]) {
        if let Some(scope) = self.stack.last_mut() {
            scope.params.extend(names.iter().cloned());
        }
    }

    /// `let`, `const`, `class`.
    pub fn declare_lexical(&mut self, name: &str) -> Result<(), Reason> {
        let Some(scope) = self.stack.last_mut() else { return Ok(()) };
        if scope.lexical.contains(name)
            || scope.vars.contains(name)
            || scope.params.contains(name)
            || scope.funcs.contains_key(name)
        {
            return Err(redeclared(name));
        }
        scope.lexical.insert(name.to_owned());
        Ok(())
    }

    /// `var`: the name is recorded on every scope up to the function or script scope it hoists to.
    pub fn declare_var(&mut self, name: &str) -> Result<(), Reason> {
        for scope in self.stack.iter_mut().rev() {
            if scope.lexical.contains(name) || scope.funcs.contains_key(name) {
                return Err(redeclared(name));
            }
            if matches!(scope.kind, ScopeKind::Catch { simple: false }) && scope.params.contains(name) {
                return Err(redeclared(name));
            }
            scope.vars.insert(name.to_owned());
            if scope.kind.hoist_target() {
                break;
            }
        }
        Ok(())
    }

    /// A function declaration: var-scoped at the top of a function or the script, lexical in a block.
    pub fn declare_function(&mut self, name: &str, plain: bool, strict: bool) -> Result<(), Reason> {
        let Some(scope) = self.stack.last_mut() else { return Ok(()) };
        if scope.kind.hoist_target() {
            if scope.lexical.contains(name) {
                return Err(redeclared(name));
            }
            scope.vars.insert(name.to_owned());
            return Ok(());
        }
        if scope.lexical.contains(name) || scope.vars.contains(name) || scope.params.contains(name) {
            return Err(redeclared(name));
        }
        if let Some(&earlier_plain) = scope.funcs.get(name)
            && (strict || !(earlier_plain && plain))
        {
            return Err(redeclared(name));
        }
        scope.funcs.insert(name.to_owned(), plain);
        Ok(())
    }
}
