#!/usr/bin/env node

const puppeteer = require('puppeteer-core');

async function main() {
  const chromePort = Number(process.env.CHROME_PORT || 9222);
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

    const info = await page.evaluate(() => {
      const turns = Array.from(document.querySelectorAll('ms-chat-turn'));
      const last = turns[turns.length - 1] || null;
      const lastInnerText = last ? (last.innerText || '') : '';
      const lastTextContent = last ? (last.textContent || '') : '';
      const bodyInnerText = (document.body && document.body.innerText) ? document.body.innerText : '';

      const tailTurns = turns.slice(Math.max(0, turns.length - 6)).map((t, idx) => {
        const it = (t.innerText || '').replace(/\s+/g, ' ').trim();
        const tc = (t.textContent || '').replace(/\s+/g, ' ').trim();
        return {
          n: turns.length - 6 + idx + 1,
          innerTextLen: it.length,
          textContentLen: tc.length,
          innerTextHead: it.slice(0, 120),
          textContentHead: tc.slice(0, 120),
        };
      });
      return {
        url: window.location.href,
        turns: turns.length,
        lastInnerTextLen: lastInnerText.length,
        lastTextContentLen: lastTextContent.length,
        bodyInnerTextLen: bodyInnerText.length,
        tailTurns,
        bodyTail: bodyInnerText.slice(Math.max(0, bodyInnerText.length - 800)),
      };
    });

    console.log(JSON.stringify(info, null, 2));
  } finally {
    await browser.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
