#!/usr/bin/env node

const path = require('path');
const puppeteer = require('puppeteer-core');

async function main() {
  const chromePort = Number(process.env.CHROME_PORT || 9222);
  const outPath = path.resolve(process.cwd(), 'aistudio_capture.png');

  const versionRes = await fetch(`http://127.0.0.1:${chromePort}/json/version`);
  if (!versionRes.ok) throw new Error(`Failed to fetch /json/version: ${versionRes.status}`);
  const version = await versionRes.json();

  const browser = await puppeteer.connect({
    browserWSEndpoint: version.webSocketDebuggerUrl,
    defaultViewport: null,
    protocolTimeout: 120000,
  });

  try {
    const targets = await browser.targets();
    const target = targets.find(t => t.type() === 'page' && String(t.url()).includes('aistudio.google.com'));
    if (!target) throw new Error('AI Studio tab not found');

    const page = await target.page();
    if (!page) throw new Error('Could not get page for AI Studio');

    await page.bringToFront();
    await page.waitForTimeout(800);

    await page.screenshot({ path: outPath, fullPage: true });
    console.log(`Saved ${outPath}`);
  } finally {
    await browser.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
