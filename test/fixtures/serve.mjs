// Serves this folder on $PORT (default 4852): a stand-in for the dev server Key would open live.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = fileURLToPath(new URL('.', import.meta.url)), PORT = Number(process.env.PORT || 4852);
createServer(async (req, res) => {
  const name = new URL(req.url, 'http://x').pathname.replace(/^\/+/, '') || 'live-page.html';
  if (!/^[\w.-]+\.html$/.test(name)) { res.writeHead(404); return res.end(); }
  try { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(await readFile(join(DIR, name))); }
  catch { res.writeHead(404); res.end(); }
}).listen(PORT, '127.0.0.1', () => console.log(`fixture at http://127.0.0.1:${PORT}/`));
