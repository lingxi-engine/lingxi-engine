const http = require('http');
const fs = require('fs');
const path = require('path');

// 灵犀引擎官网服务器（deploy/site-server.js）
// 2026-09-12 安全加固版：官网定位 = 产品介绍 + 文档 + 下载。
//   - 引擎 API /api/* 不再对外（仅 /api/admin/* 供管理后台，x-admin-token 鉴权）
//   - /chat /app /platform → 302 下载页（网页版引擎下线）
//   - /ws WebSocket 升级一律拒绝
//   - 管理后台页面走不可猜测路径（ADMIN_CONSOLE_PATH 环境变量，服务器上配置）
// 部署位置：/var/www/lingxi/server.js（PM2: lingxi-site, 端口 8080）

const ROOT = '/var/www/lingxi';
const PORT = 8080;
const PLATFORM_PORT = 3001;
// 管理后台路径（不可猜测）。服务器上设置，如 ADMIN_CONSOLE_PATH=admin-console-<random>.html
const ADMIN_CONSOLE_PATH = process.env.ADMIN_CONSOLE_PATH || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.sh': 'text/plain; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8',
  '.tar.gz': 'application/gzip',
  '.gz': 'application/gzip',
  '.woff2': 'font/woff2',
};

function proxyAdminToPlatform(req, res) {
  const options = {
    hostname: '127.0.0.1',
    port: PLATFORM_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: '127.0.0.1:' + PLATFORM_PORT, 'x-forwarded-for': req.socket.remoteAddress || '' },
  };
  const proxy = http.request(options, (apiRes) => {
    res.writeHead(apiRes.statusCode, apiRes.headers);
    apiRes.pipe(res);
  });
  proxy.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'API 服务不可用' }));
  });
  req.pipe(proxy);
}

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (urlPath.includes('..')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  // ===== 引擎不对外开放：API 只留管理后台 =====
  if (urlPath.startsWith('/api/')) {
    if (urlPath.startsWith('/api/admin/')) {
      return proxyAdminToPlatform(req, res);
    }
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: '引擎 API 已不对外开放。请下载灵犀引擎本地部署：/download.html' }));
    return;
  }

  // ===== 网页版引擎入口下线 =====
  if (urlPath === '/chat' || urlPath.startsWith('/chat/') || urlPath === '/app' || urlPath === '/app/' || urlPath === '/platform' || urlPath.startsWith('/platform/')) {
    res.writeHead(302, { Location: '/download.html' });
    res.end();
    return;
  }

  // docs/* → /var/www/lingxi/docs/*
  if (urlPath === '/docs' || urlPath === '/docs/' || urlPath.startsWith('/docs/')) {
    let rel = urlPath.replace(/^\/docs\/?/, '') || 'index.html';
    const file = path.join('/var/www/lingxi/docs', rel);
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      const idx = path.join(file, 'index.html');
      if (fs.existsSync(idx)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(idx).pipe(res);
        return;
      }
    }
    if (fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
      const ext = path.extname(file);
      const mime = MIME[ext] || 'text/plain; charset=utf-8';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  // /uploads/* → public/uploads/*
  if (urlPath.startsWith('/uploads/')) {
    const file = path.join(ROOT, 'public', urlPath);
    if (fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
      const ext = path.extname(file);
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(file).pipe(res);
      return;
    }
  }

  // install.sh / install.ps1 — 从 public/ 目录读取
  if (urlPath === '/install.sh' || urlPath === '/install.ps1') {
    const file = path.join(ROOT, 'public', path.basename(urlPath));
    if (fs.existsSync(file)) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      fs.createReadStream(file).pipe(res);
      return;
    }
  }

  // public/ 目录下的公开文件（下载包、文档等）
  if (urlPath.startsWith('/public/')) {
    const file = path.join(ROOT, urlPath);
    if (fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
      const ext = file.endsWith('.tar.gz') ? '.tar.gz' : path.extname(file);
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      fs.createReadStream(file).pipe(res);
      return;
    }
  }

  // / → 官网首页
  if (urlPath === '/') {
    const official = path.join(ROOT, 'public', 'official.html');
    if (fs.existsSync(official)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      fs.createReadStream(official).pipe(res);
      return;
    }
    urlPath = '/index.html';
  }

  // /admin → 管理后台（不可猜测路径，ADMIN_CONSOLE_PATH 配置）
  if (urlPath === '/admin' || urlPath === '/admin/') {
    if (ADMIN_CONSOLE_PATH) {
      res.writeHead(302, { Location: '/' + ADMIN_CONSOLE_PATH });
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    }
    res.end();
    return;
  }

  // 兜底静态文件只允许来自 public/ 目录
  const filePath = path.join(ROOT, 'public', urlPath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    const idx = path.join(filePath, 'index.html');
    if (fs.existsSync(idx)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(idx).pipe(res);
      return;
    }
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  const ext = path.extname(filePath);
  const mimeKey = filePath.endsWith('.tar.gz') ? '.tar.gz' : ext;
  const mime = MIME[mimeKey] || 'application/octet-stream';

  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
});

// ===== WebSocket 代理已关闭 — 引擎不对外开放 =====
server.on('upgrade', (req, socket, head) => {
  socket.destroy();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[lingxi-site] running on port ' + PORT + ' (site-only; admin-api→' + PLATFORM_PORT + '; engine closed to public)');
});