import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { executeOfficeTool } from '../../src/runtime/office/index.mjs';

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer mixdog-intro-local-7pages') {
    res.writeHead(403).end();
    return;
  }
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const args = JSON.parse(body);
    if (args.action === 'shutdown') {
      res.end('{"ok":true}');
      server.close();
      return;
    }
    if (args.action === 'author') args.script = await readFile('deliverables/mixdog-intro/deck.js', 'utf8');
    const raw = await executeOfficeTool(args, { cwd: process.cwd() });
    const text = raw.content?.find(c => c.type === 'text')?.text || '{}';
    let result;
    try { result = JSON.parse(text); } catch { result = { ok: false, error: text }; }
    await writeFile(`deliverables/mixdog-intro/${args.action}-result.json`, JSON.stringify(result, null, 2));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(500).end(JSON.stringify({ ok: false, error: error.message }));
  }
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
