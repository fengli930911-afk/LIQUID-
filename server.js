/**
 * LIQUID Dashboard 本地服务器
 * 用法: node server.js
 * 访问: http://localhost:3456
 *
 * 功能:
 *   GET  /           → 看板页面
 *   POST /api/data   → 接收数据 → 保存 JSON → 自动截图 → 写入待发送标记
 *   GET  /api/screenshot → 手动触发截图
 *   GET  /screenshots/:file → 静态截图文件
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3456;
const DASHBOARD_FILE = path.join(__dirname, 'live_dashboard_v2.html');
const DATA_FILE = path.join(__dirname, 'liquid_dashboard_data.json');
const LOGO_FILE = path.join(__dirname, 'liquid_logo.jpg');
const SCREENSHOT_SCRIPT = path.join(__dirname, 'screenshot.js');
const PENDING_FILE = path.join(__dirname, 'pending_screenshot.txt');
const NODE_BIN = '/Users/fl/.workbuddy/binaries/node/versions/22.22.2/bin/node';
const NODE_MODULES = '/Users/fl/.workbuddy/binaries/node/workspace/node_modules';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.jpg':  'image/jpeg',
  '.png':  'image/png',
};

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*' });
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end('Not Found');
  }
}

function jsonResp(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function runScreenshot() {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, { NODE_PATH: NODE_MODULES });
    const proc = spawn(NODE_BIN, [SCREENSHOT_SCRIPT], { env, cwd: __dirname });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', (code) => {
      const today = new Date().toISOString().slice(0, 10);
      const file = path.join(__dirname, 'daily_dashboard_' + today + '.png');
      if (code === 0 && fs.existsSync(file)) {
        console.log('✅ 截图成功: ' + file);
        resolve({ ok: true, file, path: file });
      } else {
        console.error('❌ 截图失败 (exit ' + code + ')\n' + out + '\n' + err);
        resolve({ ok: false, log: out + err });
      }
    });
  });
}

function gitPush() {
  return new Promise((resolve) => {
    const git = spawn('git', ['add', 'liquid_dashboard_data.json'], { cwd: __dirname });
    git.on('close', (code) => {
      if (code !== 0) { console.error('git add 失败 (exit ' + code + ')'); return resolve(false); }
      const ts = new Date().toISOString().replace('T',' ').slice(0,19);
      const commit = spawn('git', ['commit', '-m', 'data: auto-update ' + ts], { cwd: __dirname });
      commit.on('close', (cCode) => {
        if (cCode !== 0 && cCode !== 1) { /* 1 = nothing to commit */ console.log('git commit 跳过 (exit ' + cCode + ')'); return resolve(false); }
        const push = spawn('git', ['push', 'origin', 'main'], { cwd: __dirname });
        let pushOut = '', pushErr = '';
        push.stdout.on('data', d => pushOut += d.toString());
        push.stderr.on('data', d => pushErr += d.toString());
        push.on('close', (pCode) => {
          if (pCode === 0) {
            console.log('✅ 数据已推送到 GitHub');
            resolve(true);
          } else {
            console.error('❌ git push 失败: ' + pushErr.slice(-200));
            resolve(false);
          }
        });
      });
    });
  });
}

function writePendingScreenshot(filePath) {
  // 写入待发送标记，WorkBuddy 自动化会轮询此文件并发送
  try {
    fs.writeFileSync(PENDING_FILE, filePath);
    console.log('📨 已写入待发送标记: ' + PENDING_FILE);
  } catch (e) {
    console.error('⚠️ 写入待发送标记失败:', e.message);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // POST /api/data — 接收数据，保存，截图，写待发送标记
  if (req.method === 'POST' && url.pathname === '/api/data') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        if (!data.datasets || !Array.isArray(data.datasets)) {
          return jsonResp(res, 400, { ok: false, message: '数据格式无效' });
        }
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        const total = data.datasets.reduce((s, d) => s + (d.records || []).length, 0);
        console.log('📥 收到数据: ' + data.datasets.length + ' 数据集, ' + total + ' 条记录');

        // 等待截图完成后再响应客户端
        const result = await runScreenshot();
        if (result.ok) {
          writePendingScreenshot(result.path);
          // 后台自动推送到 GitHub（不阻塞响应）
          gitPush().then(pushed => {
            if (pushed) console.log('🚀 数据已自动部署到 GitHub Pages');
          });
          jsonResp(res, 200, { ok: true, message: '数据已保存，截图已生成', screenshot: path.basename(result.file) });
        } else {
          jsonResp(res, 500, { ok: false, message: '截图失败', log: result.log });
        }
      } catch (e) {
        jsonResp(res, 400, { ok: false, message: '解析失败: ' + e.message });
      }
    });
    return;
  }

  // GET /api/screenshot — 手动触发截图
  if (req.method === 'GET' && url.pathname === '/api/screenshot') {
    const result = await runScreenshot();
    if (result.ok) {
      writePendingScreenshot(result.path);
      return jsonResp(res, 200, { ok: true, screenshot: path.basename(result.file) });
    }
    return jsonResp(res, 500, { ok: false, message: '截图失败' });
  }

  // GET /screenshots/:file — 静态截图
  if (req.method === 'GET' && url.pathname.startsWith('/screenshots/')) {
    const fileName = path.basename(url.pathname); // 防止路径遍历
    const filePath = path.join(__dirname, fileName);
    return serveFile(res, filePath);
  }

  // 静态文件
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveFile(res, DASHBOARD_FILE);
  }
  if (url.pathname === '/liquid_logo.jpg') {
    return serveFile(res, LOGO_FILE);
  }

  res.writeHead(404);
  res.end('404 Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n🚀 LIQUID 直播看板服务器已启动');
  console.log('   打开: http://localhost:' + PORT);
  console.log('   上传数据后将自动保存 JSON → 生成截图 → 通知 WorkBuddy 发送\n');
});
