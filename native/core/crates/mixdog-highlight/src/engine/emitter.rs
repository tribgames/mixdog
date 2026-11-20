//! `TokenTreeEmitter` and `HTMLRenderer` of core.js: the token tree a highlight builds, and its HTML form.
//!
//! Text is kept as UTF-16 code units: two pieces of text that split a surrogate pair join again in the HTML.

/// A child of a tree node.
#[derive(Debug, Clone)]
enum Child {
    Text(Vec<u16>),
    Node(usize),
}

#[derive(Debug, Clone)]
struct TreeNode {
    /// The class name (or, for a sub-language, the language name); `None` emits no tag.
    kind: Option<String>,
    sublanguage: bool,
    children: Vec<Child>,
}

/// The emitter of one `_highlight` run: a tree of nodes with a stack of the nodes still open.
#[derive(Debug, Clone)]
pub(crate) struct Emitter {
    nodes: Vec<TreeNode>,
    stack: Vec<usize>,
}

impl Emitter {
    pub(crate) fn new() -> Self {
        Self { nodes: vec![TreeNode { kind: None, sublanguage: false, children: Vec::new() }], stack: vec![0] }
    }

    fn top(&self) -> usize {
        *self.stack.last().unwrap_or(&0)
    }

    fn add(&mut self, child: Child) {
        let top = self.top();
        self.nodes[top].children.push(child);
    }

    pub(crate) fn open_node(&mut self, kind: &str) {
        let id = self.nodes.len();
        self.nodes.push(TreeNode { kind: Some(kind.to_string()), sublanguage: false, children: Vec::new() });
        self.add(Child::Node(id));
        self.stack.push(id);
    }

    pub(crate) fn close_node(&mut self) {
        if self.stack.len() > 1 {
            self.stack.pop();
        }
    }

    pub(crate) fn close_all_nodes(&mut self) {
        while self.stack.len() > 1 {
            self.stack.pop();
        }
    }

    pub(crate) fn add_text(&mut self, text: &[u16]) {
        if !text.is_empty() {
            self.add(Child::Text(text.to_vec()));
        }
    }

    pub(crate) fn add_keyword(&mut self, text: &[u16], kind: &str) {
        if text.is_empty() {
            return;
        }
        self.open_node(kind);
        self.add_text(text);
        self.close_node();
    }

    /// `addSublanguage(emitter, name)`: the other emitter's whole tree becomes a child node named `name`
    /// (a node without a name emits no tag).
    pub(crate) fn add_sublanguage(&mut self, other: Emitter, name: Option<&str>) {
        let offset = self.nodes.len();
        for mut node in other.nodes {
            for child in &mut node.children {
                if let Child::Node(id) = child {
                    *id += offset;
                }
            }
            self.nodes.push(node);
        }
        let root = &mut self.nodes[offset];
        root.kind = name.map(str::to_string);
        root.sublanguage = true;
        self.add(Child::Node(offset));
    }

    /// `toHTML()` with the class prefix `hljs-`.
    pub(crate) fn to_html(&self) -> Vec<u16> {
        let mut out = Vec::new();
        self.walk(0, &mut out);
        out
    }

    fn walk(&self, id: usize, out: &mut Vec<u16>) {
        let node = &self.nodes[id];
        if let Some(kind) = &node.kind {
            out.extend("<span class=\"".encode_utf16());
            if !node.sublanguage {
                out.extend("hljs-".encode_utf16());
            }
            out.extend(kind.encode_utf16());
            out.extend("\">".encode_utf16());
        }
        for child in &node.children {
            match child {
                Child::Text(text) => escape_html_into(text, out),
                Child::Node(inner) => self.walk(*inner, out),
            }
        }
        if node.kind.is_some() {
            out.extend("</span>".encode_utf16());
        }
    }
}

fn escape_html_into(text: &[u16], out: &mut Vec<u16>) {
    for &unit in text {
        match unit {
            0x26 => out.extend("&amp;".encode_utf16()),
            0x3C => out.extend("&lt;".encode_utf16()),
            0x3E => out.extend("&gt;".encode_utf16()),
            0x22 => out.extend("&quot;".encode_utf16()),
            0x27 => out.extend("&#x27;".encode_utf16()),
            other => out.push(other),
        }
    }
}

/// `escapeHTML(value)`.
pub(crate) fn escape_html(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    escape_html_into(text, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    fn html(e: &Emitter) -> String {
        String::from_utf16_lossy(&e.to_html())
    }

    #[test]
    fn nodes_nest_and_text_is_escaped() {
        let mut e = Emitter::new();
        e.add_text(&u("a < b "));
        e.open_node("string");
        e.add_text(&u("\"x\" & 'y'"));
        e.add_keyword(&u("if"), "keyword");
        e.close_node();
        e.close_all_nodes();
        assert_eq!(html(&e), "a &lt; b <span class=\"hljs-string\">&quot;x&quot; &amp; &#x27;y&#x27;<span class=\"hljs-keyword\">if</span></span>");
    }

    #[test]
    fn a_sublanguage_is_a_tag_without_the_prefix_unless_it_has_no_name() {
        let mut inner = Emitter::new();
        inner.add_text(&u("<b>"));
        let mut e = Emitter::new();
        e.add_sublanguage(inner.clone(), Some("xml"));
        e.add_sublanguage(inner, None);
        assert_eq!(html(&e), "<span class=\"xml\">&lt;b&gt;</span>&lt;b&gt;");
    }

    #[test]
    fn closing_stops_at_the_root_and_empty_text_is_dropped() {
        let mut e = Emitter::new();
        e.close_node();
        e.add_text(&[]);
        e.add_keyword(&[], "keyword");
        assert_eq!(html(&e), "");
    }

    #[test]
    fn a_split_surrogate_pair_joins_again() {
        let pair: Vec<u16> = "\u{1F600}".encode_utf16().collect();
        let mut e = Emitter::new();
        e.add_text(&pair[..1]);
        e.add_text(&pair[1..]);
        assert_eq!(html(&e), "\u{1F600}");
    }
}
