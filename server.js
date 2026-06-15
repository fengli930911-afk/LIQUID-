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
const BUILT_HTML = path.join(__dir, 'index.html');
const DATA_FILE = path.join(__dir, 'liquid_dashboard_data.json');
const LOGO_FILE = path.join(__dir, 'liquid_logo.jpg');
const SCREENSHOT_SCRIPT = path.join(__dir, 'screenshot.js');
const PENDING_FILE = path.join(__dir, 'pending_screenshot.txt');
const TOKEN_FILE = path.join(__dir, '.gh-token');
const NODE_BIN = '/Users/fl/.workbuddy/binaries/node/versions/22.22.2/bin/node';
const NODE_MODULES = '/Users/fl/.workbuddy/binaries/node/workspace/node_modules';

const GITHUB_OWNER = 'fengli930911-afk';
const GITHUB_REPO = 'LIQUID-';

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
        console.error('❌ 截图失败 (exit ' + code + ')\n' + out.slice(-200) + '\n' + err.slice(-200));
        resolve({ ok: false, log: out + err });
      }
    });
  });
}

// 防并发锁：同一时间只允许一个截图
let _screenshotBusy = false;

function runScreenshotOnce() {
  if (_screenshotBusy) return Promise.resolve({ ok: true, skipped: true });
  _screenshotBusy = true;
  return runScreenshot().finally(() => { _screenshotBusy = false; });
}

/**
 * 构建内嵌数据的 HTML（数据直接写入 HTML，零缓存、零延迟）
 * 输出: index.html（用于 GitHub Pages 展示）
 */
function buildHTML() {
  try {
    const template = fs.readFileSync(DASHBOARD_FILE, 'utf8');
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    const jsonData = JSON.parse(data);
    
    // 在 <script> 标签后立即注入内嵌数据
    const injectCode = '\n<script>window.__EMBEDDED_DATA__=' + JSON.stringify(jsonData) + ';</script>\n';
    const built = template.replace('</head>', injectCode + '</head>');
    
    fs.writeFileSync(BUILT_HTML, built);
    console.log('🔨 HTML 已构建 (' + Math.round(built.length / 1024) + 'KB, ' + jsonData.datasets.length + ' 数据集)');
    return true;
  } catch (e) {
    console.error('❌ HTML 构建失败: ' + e.message);
    return false;
  }
}

/**
 * 通过 GitHub REST API 上传任意文件
 */
async function githubUploadFile(repoPath, localPath, commitMsg) {
  const token = getGitHubToken();
  if (!token) return false;

  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${repoPath}`;
  const content = fs.readFileSync(localPath);
  const base64 = content.toString('base64');
  const headers = {
    'Authorization': 'token ' + token,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'LiquidDashboard/1.0'
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const getResp = await fetch(apiUrl, { headers });
      let sha = null;
      if (getResp.ok) sha = (await getResp.json()).sha;
      else if (getResp.status !== 404) { console.error('❌ 获取 ' + repoPath + ' 信息失败 (' + getResp.status + ')'); return false; }

      const putResp = await fetch(apiUrl, {
        method: 'PUT',
        headers: Object.assign({}, headers, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message: commitMsg, content: base64, branch: 'main', ...(sha ? { sha } : {}) })
      });

      if (putResp.ok) {
        const r = await putResp.json();
        console.log('✅ 已推送 ' + repoPath + ' (commit ' + r.commit.sha.slice(0, 7) + ')');
        return true;
      }
      if (putResp.status === 409) {
        console.log('⏳ ' + repoPath + ' SHA 冲突，重试 ' + attempt + '/3...');
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      console.error('❌ 上传 ' + repoPath + ' 失败 (' + putResp.status + ')');
      return false;
    } catch (e) { console.error('❌ 网络错误 (' + repoPath + '): ' + e.message); return false; }
  }
  return false;
}

async function pushAllToGitHub() {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const jsonOk = await githubUploadFile('liquid_dashboard_data.json', DATA_FILE, 'data: auto-update ' + ts);
  
  // 构建内嵌数据的 HTML
  const built = buildHTML();
  const htmlOk = built ? await githubUploadFile('index.html', BUILT_HTML, 'build: ' + ts) : false;
  
  return jsonOk || htmlOk;
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

        const result = await runScreenshotOnce();
        if (result.ok || result.skipped) {
          if (!result.skipped) writePendingScreenshot(result.path);
          const pushed = await pushAllToGitHub();
          jsonResp(res, 200, { ok: true, message: pushed ? '✅ 数据已同步到 GitHub' : '数据已保存' });
        } else {
          const pushed = await pushAllToGitHub();
          jsonResp(res, 200, { ok: true, message: pushed ? '数据已同步（截图未生成）' : '数据已保存（截图未生成）' });
        }
      } catch (e) {
        jsonResp(res, 400, { ok: false, message: '解析失败: ' + e.message });
      }
    });
    return;
  }

  // GET /api/screenshot
  if (req.method === 'GET' && url.pathname === '/api/screenshot') {
    const result = await runScreenshotOnce();
    if (result.ok || result.skipped) {
      if (!result.skipped) writePendingScreenshot(result.path);
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

server.listen(PORT, '127.0.0.1', async () => {
  const token = getGitHubToken();
  console.log('\n🚀 LIQUID 直播看板服务器已启动');
  console.log('   上传数据: http://localhost:' + PORT);
  console.log('   展示链接: https://fengli930911-afk.github.io/LIQUID-/');
  if (token) {
    console.log('   GitHub 同步: ✅ 已配置');
  } else {
    console.log('   GitHub 同步: ⚠️  未配置');
  }
  console.log('   上传后自动: 保存JSON → 截图 → 内嵌数据到HTML → 推送GitHub\n');

  // 启动时构建一次 HTML（如果数据文件存在）
  if (fs.existsSync(DATA_FILE)) buildHTML();
});
