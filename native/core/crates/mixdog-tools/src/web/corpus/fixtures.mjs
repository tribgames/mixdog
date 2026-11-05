// Hand-written pages for the extraction corpus. Each case: { name, url, contentType, body }.
// They cover every branch of the Node extractor (semantic containers, the
// article extractor, raw passthrough, empty shells) and the markdown converter
// (code fences, tables, nested lists, links, images, escapes).

const page = (title, body, head = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

export const FIXTURES = [
  {
    name: 'docs-main-basic',
    url: 'https://docs.example.com/guide/start',
    body: page(
      'Getting started | Example Docs',
      `<header><a href="/">Example</a></header><nav><ul><li><a href="/a">A</a></li></ul></nav>
<main><h1>Getting started</h1><p>Install the <code>example</code> CLI with <strong>npm</strong> or <em>yarn</em>.</p>
<h2 id="install">Install</h2><pre><code class="language-bash">npm install -g example
example --version</code></pre>
<p>See the <a href="/reference">reference</a> and <a href="https://github.com/example/example">GitHub</a>.</p>
<ul><li>First item</li><li>Second <a href="mailto:a@b.co">mail</a></li><li>Third<ul><li>Nested one</li><li>Nested two</li></ul></li></ul>
<ol start="3"><li>Three</li><li>Four</li></ol></main><footer>© Example</footer>`
    ),
  },
  {
    name: 'docs-table',
    url: 'https://docs.example.com/api/options',
    body: page(
      'Options',
      `<main><h1>Options</h1><table><thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead>
<tbody><tr><td><code>a|b</code></td><td>string</td><td>Pipe | char<br>second line</td></tr>
<tr><td>flag</td><td>boolean</td></tr><tr><td colspan="3"><p>wide</p><p>cell</p></td></tr></tbody></table>
<table><tr><td>solo</td></tr></table><table></table></main>`
    ),
  },
  {
    name: 'code-fences',
    url: 'https://blog.example.com/code',
    body: page(
      'Code',
      `<article><h1>Code samples</h1><p>Inline <code>a \`tick\` b</code> and <code>x
y</code>.</p>
<pre>plain preformatted
  indented line

after blank</pre>
<pre><code class="lang-js hljs">const s = \`\`\`;
console.log(s)
</code></pre><pre><code>no language
</code></pre><p>Escapes: * _ [ ] \\ \` here.</p></article>`
    ),
  },
  {
    name: 'links-images',
    url: 'https://example.org/dir/page.html',
    body: page(
      'Links',
      `<main><p><a href="../up">Up</a> <a href="javascript:alert(1)">bad</a> <a href="#frag">frag</a> <a href="">empty</a> <a href="/x"></a>
<a href="ftp://x/y">ftp</a> <a href="tel:123">tel</a></p>
<p><img src="/img/a.png" alt="Alt [one]"><img src="data:image/png;base64,AAAA" alt="data"><img src="/b.png"></p>
<blockquote><p>Quote line one</p><p>Quote two</p></blockquote><hr><p>after rule</p></main>`
    ),
  },
  {
    name: 'og-image',
    url: 'https://news.example.com/story',
    body: page(
      'Story',
      `<main><h1>Story</h1><p>Body text of the story.</p></main>`,
      `<meta property="og:image" content="/media/hero.jpg"><meta name="twitter:image" content="/media/hero.jpg"><meta name="twitter:image" content="/second.jpg">`
    ),
  },
  {
    name: 'og-image-distinct',
    url: 'https://news.example.com/two',
    body: page(
      'Two images',
      `<article><p>Some article text.</p></article>`,
      `<meta property="og:image" content="https://cdn.example.com/a.png"><meta name="twitter:image" content="https://cdn.example.com/b.png">`
    ),
  },
  {
    name: 'hidden-removed',
    url: 'https://example.com/hidden',
    body: page(
      'Hidden',
      `<main><p>Visible paragraph.</p><div hidden>Hidden div</div><p aria-hidden="true">Aria hidden</p>
<div inert>Inert</div><aside>Sidebar aside</aside><script>var x = 1;</script><style>p{color:red}</style>
<noscript>No script</noscript><template><p>template</p></template><nav>Menu</nav><footer>Foot</footer>
<p>Second visible.</p></main>`
    ),
  },
  {
    name: 'largest-container',
    url: 'https://example.com/containers',
    body: page(
      'Containers',
      `<div role="main"><p>Short main role.</p></div><article><p>${'Long article text. '.repeat(30)}</p></article><main><p>Medium main.</p></main>`
    ),
  },
  {
    name: 'markdown-body',
    url: 'https://github.com/example/repo',
    body: page(
      'repo',
      `<div class="header">Repo header with some text</div><div class="markdown-body"><h1>Repo</h1><p>Readme text with <a href="docs/a.md">link</a>.</p></div>`
    ),
  },
  {
    name: 'item-prop-body',
    url: 'https://news.example.com/microdata',
    body: page('Micro', `<div><div itemprop="articleBody"><p>Micro-data body paragraph.</p></div><p>Outside text</p></div>`),
  },
  {
    name: 'readability-blog',
    url: 'https://blog.example.net/2024/post',
    body: page(
      'A long blog post - Example Blog',
      `<div id="wrap"><div class="topbar"><a href="/">Home</a> <a href="/about">About</a> <a href="/contact">Contact</a></div>
<div class="post"><h1>A long blog post</h1><p class="meta">By Someone, March 3</p>
${Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat, <a href="/ref/${i}">reference ${i}</a>.</p>`).join('\n')}
</div><div class="sidebar"><ul><li><a href="/p1">Popular one</a></li><li><a href="/p2">Popular two</a></li></ul></div>
<div class="comments"><p>Comment 1</p><p>Comment 2</p></div></div>`
    ),
  },
  {
    name: 'readability-no-semantic-short',
    url: 'https://example.com/short',
    body: page('Short', `<div><p>Just a short page without any semantic container.</p></div>`),
  },
  {
    name: 'readability-headings-lists',
    url: 'https://wiki.example.org/topic',
    body: page(
      'Topic - Wiki',
      `<div id="content"><h1>Topic</h1>
<p>${'The topic is described in detail across several sentences, each adding information. '.repeat(6)}</p>
<h2>Section one</h2><p>${'Section one has its own long explanatory text with commas, clauses, and details. '.repeat(5)}</p>
<ul><li>Point A</li><li>Point B</li><li>Point C</li></ul>
<h2>Section two</h2><p>${'Another paragraph of reasonable length that belongs to the second section. '.repeat(5)}</p>
<table><tr><th>K</th><th>V</th></tr><tr><td>one</td><td>1</td></tr></table></div>
<div id="footer-links"><a href="/a">A</a> | <a href="/b">B</a></div>`
    ),
  },
  {
    name: 'empty-js-shell',
    url: 'https://app.example.com/',
    body: page('App', `<div id="root"></div><script src="/bundle.js"></script><noscript>Enable JS</noscript>`, `<meta property="og:image" content="/og.png">`),
  },
  {
    name: 'only-nav',
    url: 'https://example.com/nav',
    body: page('Nav', `<nav><a href="/a">A</a></nav><footer>footer text</footer>`),
  },
  {
    name: 'entities-unicode',
    url: 'https://example.com/entities',
    body: page(
      'Caf&eacute; &amp; Cr&egrave;me',
      `<main><p>Tom &amp; Jerry &lt;tag&gt; &copy; 2024 &nbsp;&nbsp; non&#8209;breaking, 한국어 텍스트, emoji 😀 and \u00a0nbsp\u00a0 chars.</p><p>   spaced     out
text   </p></main>`
    ),
  },
  {
    name: 'inline-mix',
    url: 'https://example.com/inline',
    body: page(
      'Inline',
      `<main><p>Text <b>bold <i>both</i></b> <strong></strong> <em> padded </em> tail<br>next line<span> span </span>end</p>
<h3> Heading <a href="/h">linked</a> </h3><dl><dt>Term</dt><dd>Definition</dd></dl><figure><img src="/f.png" alt="fig"><figcaption>Caption</figcaption></figure></main>`
    ),
  },
  {
    name: 'nested-lists-multiline',
    url: 'https://example.com/lists',
    body: page(
      'Lists',
      `<main><ul><li><p>Para one</p><p>Para two</p></li><li><pre>pre in li
second</pre></li><li>plain</li></ul>
<ol><li>one</li><li>two<ol><li>sub</li></ol></li></ol><ul><div>not li</div><li>after</li></ul></main>`
    ),
  },
  {
    name: 'table-nested',
    url: 'https://example.com/tables',
    body: page(
      'Nested tables',
      `<main><table><tr><td>outer<table><tr><td>inner</td></tr></table></td><td>x</td></tr></table></main>`
    ),
  },
  {
    name: 'title-spacing',
    url: 'https://example.com/title',
    body: page('  Spaced\n   Title \t here ', `<main><p>Body.</p></main>`),
  },
  {
    name: 'no-doctype-fragment',
    url: 'https://example.com/frag',
    contentType: 'text/html',
    body: `<p>Fragment without html element</p><p>Second</p><main>Main <b>text</b></main>`,
  },
  {
    name: 'sniffed-html-no-mime',
    url: 'https://example.com/sniff',
    contentType: '',
    body: `<!DOCTYPE html><html><head><title>Sniffed</title></head><body><main><p>Sniffed content.</p></main></body></html>`,
  },
  {
    name: 'xhtml-mime',
    url: 'https://example.com/x.xhtml',
    contentType: 'application/xhtml+xml; charset=utf-8',
    body: `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>X</title></head><body><main><p>Xhtml text.</p></main></body></html>`,
  },
  { name: 'raw-json', url: 'https://api.example.com/data', contentType: 'application/json', body: '{"a":1,"b":[1,2,3]}' },
  { name: 'raw-markdown-mime', url: 'https://example.com/readme', contentType: 'text/markdown', body: '# Title\n\nSome *markdown*.\n' },
  { name: 'raw-markdown-ext', url: 'https://example.com/docs/README.md', contentType: 'text/plain', body: '# Readme\n\ntext\n' },
  { name: 'raw-text', url: 'https://example.com/robots.txt', contentType: 'text/plain; charset=utf-8', body: 'User-agent: *\nDisallow: /private\n' },
  { name: 'raw-empty', url: 'https://example.com/empty.txt', contentType: 'text/plain', body: '   \n  ' },
  {
    name: 'blockquote-nested',
    url: 'https://example.com/quote',
    body: page('Quotes', `<main><blockquote>Outer<blockquote>Inner quote</blockquote><p>para</p></blockquote></main>`),
  },
  {
    name: 'svg-iframe-form',
    url: 'https://example.com/misc',
    body: page(
      'Misc',
      `<main><p>Before</p><svg width="10" height="10"><title>icon</title><a href="/s"><text>svg link</text></a></svg>
<iframe src="/frame">fallback</iframe><form action="/go"><label>Name <input value="v"></label><select><option>One</option><option>Two</option></select><button>Go</button></form>
<video controls><source src="/v.mp4"></video><p>After</p></main>`
    ),
  },
  {
    name: 'comment-and-cdata',
    url: 'https://example.com/comments',
    body: page('Comments', `<main><!-- a comment --><p>Text<!-- inline --> more</p><![CDATA[ not cdata ]]></main>`),
  },
  {
    name: 'empty-main-with-body-text',
    url: 'https://example.com/emptymain',
    body: page('EM', `<main>   </main><div><p>${'Real content outside the empty main element, long enough to matter. '.repeat(6)}</p></div>`),
  },
];
