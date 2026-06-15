/**
 * LIQUID Dashboard 本地服务器
 * 用法: node server.js
 *      或指定 GitHub Token: GITHUB_TOKEN=ghp_xxx node server.js
 * 访问: http://localhost:3456
 *
 * 功能:
 *   GET  /              → 看板页面
 *   POST /api/data      → 接收数据 → 保存 JSON → 自动截图 → GitHub 自动推送
 *   GET  /api/screenshot → 手动触发截图
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 3456;
const __dir = __dirname;
const DASHBOARD_FILE = path.join(__dir, 'live_dashboard_v2.html');
const DATA_FILE = path.join(__dir, 'liquid_dashboard_data.json');
const LOGO_FILE = path.join(__dir, 'liquid_logo.jpg');
const SCREENSHOT_SCRIPT = path.join(__dir, 'screenshot.js');
const PENDING_FILE = path.join(__dir, 'pending_screenshot.txt');
const TOKEN_FILE = path.join(__dir, '.gh-token');
const NODE_BIN = '/Users/fl/.workbuddy/binaries/node/versions/22.22.2/bin/node';
const NODE_MODULES = '/Users/fl/.workbuddy/binaries/node/workspace/node_modules';

const GITHUB_OWNER = 'fengli930911-afk';
const GITHUB_REPO = 'LIQUID-';
const GITHUB_FILE = 'liquid_dashboard_data.json';
const GITHUB_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`;

function getGitHubToken() {
  // 1. 环境变量
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  // 2. .gh-token 文件
  try { return fs.readFileSync(TOKEN_FILE, 'utf-8').trim(); } catch(e) {}
  return null;
}

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
    const proc = spawn(NODE_BIN, [SCREENSHOT_SCRIPT], { env, cwd: __dir });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', (code) => {
      const today = new Date().toISOString().slice(0, 10);
      const file = path.join(__dir, 'daily_dashboard_' + today + '.png');
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

/**
 * 使用 GitHub REST API 直接上传文件
 * 这是最可靠的方式——不依赖 git 命令、凭据助手或代理设置
 */
async function githubUpload() {
  const token = getGitHubToken();
  if (!token) {
    console.error('❌ GitHub Token 未配置！');
    console.error('   方式1: GITHUB_TOKEN=ghp_xxx node server.js');
    console.error('   方式2: 将 token 写入 ' + TOKEN_FILE);
    return false;
  }

  const content = fs.readFileSync(DATA_FILE);
  const base64 = content.toString('base64');
  const authHeaders = {
    'Authorization': 'token ' + token,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'LiquidDashboard/1.0'
  };

  try {
    // 第一步：获取当前文件的 SHA（GitHub API 更新文件需要 sha）
    let sha = null;
    try {
      const getResp = await fetch(GITHUB_API, { headers: authHeaders });
      if (getResp.ok) {
        const data = await getResp.json();
        sha = data.sha;
        console.log('📎 当前文件 SHA: ' + sha.slice(0, 7));
      } else if (getResp.status === 404) {
        console.log('📄 文件不存在，将创建新文件');
      } else {
        const errText = await getResp.text();
        console.error('❌ 获取文件信息失败 (' + getResp.status + '): ' + errText.slice(0, 200));
        return false;
      }
    } catch (e) {
      console.error('❌ 网络错误 (获取SHA): ' + e.message);
      return false;
    }

    // 第二步：上传文件
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const body = JSON.stringify({
      message: 'data: auto-update ' + ts,
      content: base64,
      branch: 'main',
      ...(sha ? { sha } : {})
    });

    const putResp = await fetch(GITHUB_API, {
      method: 'PUT',
      headers: Object.assign({}, authHeaders, { 'Content-Type': 'application/json' }),
      body
    });

    if (putResp.ok) {
      const result = await putResp.json();
      console.log('✅ 数据已推送到 GitHub');
      console.log('   commit: ' + result.commit.sha.slice(0, 7));
      console.log('   url: ' + result.content.html_url);
      return true;
    } else {
      const errText = await putResp.text();
      console.error('❌ GitHub API 上传失败 (' + putResp.status + '): ' + errText.slice(0, 300));
      if (putResp.status === 401) {
        console.error('   → Token 无效或已过期，请更新 GITHUB_TOKEN');
      } else if (putResp.status === 409) {
        console.error('   → SHA 冲突，可能是并发更新导致，下次上传会自动修复');
      }
      return false;
    }
  } catch (e) {
    console.error('❌ 网络错误 (上传): ' + e.message);
    return false;
  }
}

function writePendingScreenshot(filePath) {
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

  // POST /api/data — 接收数据 → 保存 JSON → 截图 → 推送到 GitHub
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

        const result = await runScreenshot();
        if (result.ok) {
          writePendingScreenshot(result.path);
          // 推送到 GitHub（用 API，不依赖 git 命令）
          const pushed = await githubUpload();
          const msg = pushed
            ? '数据已同步到 GitHub，其他人可立即查看'
            : '数据已保存本地，但 GitHub 推送未配置（设置 GITHUB_TOKEN 后自动推送）';
          jsonResp(res, 200, { ok: true, message: msg, screenshot: path.basename(result.file) });
        } else {
          jsonResp(res, 500, { ok: false, message: '截图失败', log: result.log });
        }
      } catch (e) {
        jsonResp(res, 400, { ok: false, message: '解析失败: ' + e.message });
      }
    });
    return;
  }

  // GET /api/screenshot
  if (req.method === 'GET' && url.pathname === '/api/screenshot') {
    const result = await runScreenshot();
    if (result.ok) {
      writePendingScreenshot(result.path);
      return jsonResp(res, 200, { ok: true, screenshot: path.basename(result.file) });
    }
    return jsonResp(res, 500, { ok: false, message: '截图失败' });
  }

  // GET /screenshots/:file
  if (req.method === 'GET' && url.pathname.startsWith('/screenshots/')) {
    const fileName = path.basename(url.pathname);
    const filePath = path.join(__dir, fileName);
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
  const token = getGitHubToken();
  console.log('\n🚀 LIQUID 直播看板服务器已启动');
  console.log('   本地: http://localhost:' + PORT);
  if (token) {
    console.log('   GitHub 自动推送: ✅ 已配置');
  } else {
    console.log('   GitHub 自动推送: ⚠️  未配置（设置 GITHUB_TOKEN 后生效）');
  }
  console.log('   上传数据后将自动: 保存 JSON → 生成截图 → 推送 GitHub\n');
});
