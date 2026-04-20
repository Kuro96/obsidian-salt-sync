import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Keep admin bundle resolution ESM-native so the server package never depends on CommonJS globals.
const ADMIN_BUNDLE_URL = new URL('../../dist/admin.js', import.meta.url);

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Salt Sync Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: #fafafa; color: #1a1a2e; }
    button { cursor: pointer; font-size: 14px; }
    input { font-size: 14px; }
    table { width: 100%; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="/admin/app.js"></script>
</body>
</html>`;

/** 处理 /admin 路由：提供管理 SPA 静态文件 */
export class AdminRouter {
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = req.url ?? '';

    if (url === '/admin' || url === '/admin/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ADMIN_HTML);
      return true;
    }

    if (url === '/admin/app.js') {
      if (!fs.existsSync(ADMIN_BUNDLE_URL)) {
        res.writeHead(404);
        res.end('Admin bundle not found — run pnpm build first');
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(ADMIN_BUNDLE_URL).pipe(res);
      return true;
    }

    return false;
  }
}
