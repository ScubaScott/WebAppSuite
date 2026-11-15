// Static dev server for the engine test. Logs every GET, and can serve sw.js with a bumped SW_VERSION
// (when the flag file exists) so the version-bump scenario never touches the real file.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = process.argv[2];
const outDir = process.argv[3];
const port = Number(process.argv[4] || 8766);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.traineddata': 'application/octet-stream', '.wasm': 'application/wasm' };

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  fs.appendFileSync(path.join(outDir, 'requests.log'), `${req.method} ${url}\n`);
  const file = path.normalize(path.join(root, url));
  if (!file.startsWith(path.normalize(root))) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('not found'); }
    if (url === '/htdocs/sw.js' && fs.existsSync(path.join(outDir, 'bump.flag'))) {
      data = Buffer.from(data.toString().replace(/SW_VERSION = '([0-9.]+)'/, "SW_VERSION = '99.9'"));
    }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(data);
  });
}).listen(port, 'localhost', () => console.log('listening ' + port));
