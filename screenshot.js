/**
 * LIQUID 每日看板自动截图脚本 (精准裁剪版)
 * 用法: node screenshot.js
 * 前提: 项目目录下存在 liquid_dashboard_data.json（从看板页面导出）
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const PROJECT_DIR = __dirname;
const DATA_FILE = path.join(PROJECT_DIR, 'liquid_dashboard_data.json');
const DASHBOARD_FILE = path.join(PROJECT_DIR, 'live_dashboard_v2.html');
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TEMP_FILE = '/tmp/.liquid_screenshot.html';

(async () => {
  // 1. 检查数据文件
  if (!fs.existsSync(DATA_FILE)) {
    console.error('❌ 未找到 liquid_dashboard_data.json，请先从看板页面点击"💾 导出JSON"并保存到此目录。');
    process.exit(1);
  }

  // 2. 读取数据
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('❌ JSON 数据文件解析失败:', e.message);
    process.exit(1);
  }

  if (!data.datasets || !Array.isArray(data.datasets)) {
    console.error('❌ 数据格式无效：缺少 datasets 数组');
    process.exit(1);
  }
  const allNames = new Set();
  data.datasets.forEach(d => (d.records || []).forEach(r => { if (r.name) allNames.add(r.name); }));
  console.log(`📊 已加载 ${allNames.size} 位达人`);

  // 3. 注入数据到 HTML
  let html = fs.readFileSync(DASHBOARD_FILE, 'utf8');
  const INJECTION_MARKER = '<script>\nvar STORAGE_KEY';
  html = html.replace(
    INJECTION_MARKER,
    '<script>window.__INJECTED_DATA__=' + JSON.stringify(data) + ';\nvar STORAGE_KEY'
  );
  fs.writeFileSync(TEMP_FILE, html);

  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);
  const outputFile = path.join(PROJECT_DIR, 'daily_dashboard_' + dateStr + '.png');

  console.log('📸 正在启动 Chrome 截图...');

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2000 });

    page.on('console', msg => {
      if (msg.type() === 'error') console.log('  [浏览器] ' + msg.text());
    });
    page.on('pageerror', err => console.log('  [页面异常] ' + err.message));

    await page.goto('file://' + TEMP_FILE, { waitUntil: 'networkidle0', timeout: 15000 });

    // 等待表格渲染完成
    await page.waitForFunction(() => {
      const body = document.querySelector('#dailyTableBody') || document.querySelector('#tableBody');
      return body && body.children.length > 0;
    }, { timeout: 10000 });

    // 精准测量实际内容区域（#tabDaily 容器的底部位置 + 一点内边距）
    const clipRect = await page.evaluate(() => {
      const tabContent = document.getElementById('tabDaily');
      if (tabContent) {
        const rect = tabContent.getBoundingClientRect();
        return {
          x: 0,
          y: 0,
          width: Math.max(document.documentElement.clientWidth || 1400, 1400),
          height: rect.bottom + window.scrollY + 16
        };
      }
      // fallback: 取 body 的实际内容高度
      return {
        x: 0,
        y: 0,
        width: document.documentElement.clientWidth,
        height: document.body.scrollHeight
      };
    });
    console.log('📏 内容区域高度: ' + clipRect.height.toFixed(0) + 'px');

    // 精准裁剪截图 —— 只截有内容的区域
    await page.screenshot({
      path: outputFile,
      type: 'png',
      clip: clipRect
    });

    console.log('✅ 截图已保存: ' + outputFile);

  } catch (e) {
    console.error('❌ 截图失败:', e.message);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
    if (fs.existsSync(TEMP_FILE)) fs.unlinkSync(TEMP_FILE);
  }

  if (fs.existsSync(outputFile)) {
    const stats = fs.statSync(outputFile);
    console.log('📏 文件大小: ' + (stats.size / 1024).toFixed(1) + ' KB');
  } else {
    console.error('❌ 截图文件未生成');
    process.exit(1);
  }
})();
