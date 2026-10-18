/**
 * Minimal static file server for the E2E suite: serves the repo root so the
 * harness page can `import` the library's real ES modules from `/src/...`
 * (dynamic import over http needs a correct JS MIME type, which `file://`
 * can't reliably give every engine) and load fixture images from
 * `/e2e/fixtures/...`. Dev-only, never shipped — see playwright.config.mjs.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT ? Number(process.env.PORT) : 4319;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.heic': 'image/heic',
    '.png': 'image/png',
};

const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const relativePath = urlPath === '/' ? '/e2e/pages/harness.html' : urlPath;
    const filePath = path.join(ROOT, relativePath);

    if (!filePath.startsWith(ROOT + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found: ' + urlPath);
            return;
        }
        res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`e2e static server listening on http://localhost:${PORT}`);
});
