import test from 'node:test'
import assert from 'node:assert/strict'
import { extractDocument } from './document-content.mjs'

test('source documents preserve embedded HTML, whitespace, code and JSON verbatim', async () => {
  for (const [type, source] of [
    ['text/plain', '# Guide\n\n<div>Example, not an HTML page</div>\n\n\n    indented code\n'],
    ['text/markdown', '# Guide\n\n```html\n<main>hello</main>\n```\n'],
    ['application/ld+json', '{\n  "name": "<main>literal</main>"\n}\n'],
    ['application/xml', '<feed><item>example</item></feed>'],
  ]) {
    const page = await extractDocument('https://example.com/guide', source, type)
    assert.equal(page.content, source)
    assert.equal(page.extractor, 'raw')
  }
})

test('semantic HTML retains headings, links, fenced code and tables without navigation', async () => {
  const page = await extractDocument('https://example.com/docs/start', `
    <title>Setup</title><nav>Navigation noise</nav>
    <main><h1>Setup guide</h1><p>Use <a href="../api">the API</a>.</p>
    <pre><code class="language-js">const x = 1;


  console.log(x);</code></pre>
    <table><tr><th>Option</th><th>Value</th></tr><tr><td>port</td><td>8080</td></tr></table>
    <ul><li>First</li><li>Second</li></ul><div hidden>Hidden noise</div>
    <script>throw new Error('must not execute')</script></main><aside>Advertisement</aside>`, 'text/html')
  assert.match(page.content, /# Setup guide/)
  assert.match(page.content, /\[the API\]\(<https:\/\/example.com\/api>\)/)
  assert.ok(page.content.includes('```js\nconst x = 1;\n\n\n  console.log(x);\n```'))
  assert.ok(page.content.includes('| Option | Value |\n| --- | --- |\n| port | 8080 |'))
  assert.match(page.content, /- First\n- Second/)
  assert.doesNotMatch(page.content, /Navigation noise|Hidden noise|Advertisement|must not execute/)
})

test('empty JS shells cannot become successes through metadata alone', async () => {
  await assert.rejects(extractDocument('https://example.com', '<meta property="og:image" content="/cover.png"><div id="root"></div><script>render()</script>', 'text/html'),
    { code: 'EMPTY_CONTENT' })
})

test('article fallback returns text even without a semantic container', async () => {
  const page = await extractDocument('https://example.com', '<title>Small page</title><div><p>A small useful page.</p><p>More details here.</p></div>', 'text/html')
  assert.match(page.content, /A small useful page/)
  assert.match(page.content, /More details here/)
})

test('short HTML documentation is not rejected for login or challenge vocabulary', async () => {
  for (const title of ['Just a moment...', 'Access denied', 'Sign in - Example']) {
    const page = await extractDocument('https://example.com/docs', `<title>${title}</title>
      <main><h1>${title}</h1><p>When checking your browser, you may see “Please enable JavaScript”.</p>
      <p>This guide explains how to verify you are human and sign in.</p></main>`, 'text/html')
    assert.equal(page.title, title)
    assert.match(page.content, /This guide explains/)
  }
})
