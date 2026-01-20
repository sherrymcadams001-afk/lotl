#!/usr/bin/env node

const puppeteer = require('puppeteer-core');

function findInA11yTree(root, needle) {
  const stack = [{ node: root, path: [] }];
  const hits = [];

  while (stack.length) {
    const { node, path } = stack.pop();
    if (!node) continue;

    const name = typeof node.name === 'string' ? node.name : '';
    const value = typeof node.value === 'string' ? node.value : '';
    const hay = `${name}\n${value}`;

    if (hay.includes(needle)) {
      hits.push({
        path: path.slice(-12),
        role: node.role || null,
        name: name.slice(0, 200),
        value: value.slice(0, 200),
      });
      if (hits.length >= 10) break;
    }

    const children = Array.isArray(node.children) ? node.children : [];
    for (let i = children.length - 1; i >= 0; i--) {
      const c = children[i];
      const label = `${c.role || 'node'}:${(c.name || '').toString().slice(0, 40)}`;
      stack.push({ node: c, path: path.concat([label]) });
    }
  }

  return hits;
}

async function main() {
  const chromePort = Number(process.env.CHROME_PORT || 9222);
  const waitMs = Number(process.env.WAIT_MS || 90000);
  const pollMs = Number(process.env.POLL_MS || 3000);

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
    await page.waitForTimeout(500);

    const marker = `LOTL_A11Y_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const prompt = `Reply with exactly: ${marker}`;

    await page.evaluate((txt) => {
      const textarea = document.querySelector('footer textarea');
      if (!textarea) throw new Error('footer textarea not found');
      textarea.focus();
      textarea.value = '';
      textarea.value = txt;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }, prompt);

    await page.waitForTimeout(200);

    const clicked = await page.evaluate(() => {
      const btn = document.querySelector('button[aria-label*="Run"]');
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!clicked) throw new Error('Run button not found/clickable');

    const deadline = Date.now() + waitMs;
    let hits = [];
    while (Date.now() < deadline) {
      const snap = await page.accessibility.snapshot();
      hits = snap ? findInA11yTree(snap, marker) : [];
      if (hits.length > 0) break;
      await page.waitForTimeout(pollMs);
    }

    console.log(JSON.stringify({ marker, url: page.url(), waitMs, pollMs, hitsCount: hits.length, hits }, null, 2));
  } finally {
    await browser.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
