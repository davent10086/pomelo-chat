// Present captures of both real renderers together for layout review.
const { chromium } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async function preview(directory, width, height) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: width + 360, height }, deviceScaleFactor: 1 });
    const data = name => fs.readFileSync(path.join(directory, name)).toString('base64');
    await page.setContent(`<style>body{margin:0;display:flex;gap:0;background:#e6e5e8}img{display:block;height:${height}px}img:first-child{width:${width}px}img:last-child{width:360px}</style><img src="data:image/png;base64,${data('main-wechat-layout.png')}"><img src="data:image/png;base64,${data('assistant-welcome.png')}">`);
    await page.screenshot({ path: path.join(directory, 'desktop-attached-layout.png') });
  } finally { await browser.close(); }
};
