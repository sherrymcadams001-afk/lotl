#!/usr/bin/env node

const puppeteer = require('puppeteer-core');

function preview(s, n = 160) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.slice(0, n);
}

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
    const target = (await browser.targets()).find(t => t.type() === 'page' && String(t.url()).includes('aistudio.google.com'));
    if (!target) throw new Error('AI Studio tab not found');

    const page = await target.page();
    await page.bringToFront();
    await page.waitForTimeout(500);

    const data = await page.evaluate(() => {
      function snap(selector, max = 6) {
        const els = Array.from(document.querySelectorAll(selector));
        const tail = els.slice(Math.max(0, els.length - max)).map((el, idx) => {
          const it = (el.innerText || '').trim();
          const tc = (el.textContent || '').trim();
          return {
            i: els.length - max + idx + 1,
            innerTextLen: it.length,
            textContentLen: tc.length,
            innerTextHead: it.replace(/\s+/g, ' ').slice(0, 140),
            textContentHead: tc.replace(/\s+/g, ' ').slice(0, 140),
          };
        });
        return { count: els.length, tail };
      }

      const body = (document.body && document.body.innerText) ? document.body.innerText : '';
      return {
        url: window.location.href,
        bodyHasNoApiKey: /No API Key/i.test(body),
        bodyHasResponseReady: /Response ready/i.test(body),
        selectors: {
          chatTurn: snap('ms-chat-turn'),
          chatBubble: snap('ms-chat-bubble'),
          textChunk: snap('ms-text-chunk'),
          promptChunk: snap('ms-prompt-chunk'),
          cmarkNode: snap('ms-cmark-node'),
          thoughtChunk: snap('ms-thought-chunk'),
          codeBlock: snap('ms-code-block'),
        }
      };
    });

    console.log(JSON.stringify(data, null, 2));
  } finally {
    await browser.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
