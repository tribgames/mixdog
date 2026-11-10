import http from 'node:http';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const host = args[args.indexOf('--host') + 1];
const server = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (request.url !== '/inference' || !body.includes('first audio')) {
    response.writeHead(400).end();
    return;
  }
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ text: 'first words' }));
});
server.listen(port, host, () => {
  console.log(`listening at http://${host}:${port}`);
});
