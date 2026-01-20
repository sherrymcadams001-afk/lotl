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

    // Use a very distinctive marker so we can locate it in the DOM.
    const marker = `LOTL_MARK_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const prompt = `Reply with exactly: ${marker}`;

    // Try sending via the same selectors the controller uses.
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

    // Give it some time to render.
    await page.waitForTimeout(6000);

    const scan = await page.evaluate((needle) => {
      const all = Array.from(document.querySelectorAll('*'));
      const msTags = all
        .map(el => (el.tagName || '').toLowerCase())
        .filter(t => t.startsWith('ms-'));

      const tagCounts = {};
      for (const t of msTags) tagCounts[t] = (tagCounts[t] || 0) + 1;

      const topMsTags = Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 40)
        .map(([tag, count]) => ({ tag, count }));

      // Try to find any light-DOM element whose textContent contains the marker.
      const hits = [];
      for (const el of all) {
        if (hits.length >= 25) break;
        const tc = (el.textContent || '').trim();
        if (!tc) continue;
        if (tc.includes(needle)) {
          hits.push({
            tag: (el.tagName || '').toLowerCase(),
            id: el.id || null,
            className: (typeof el.className === 'string' ? el.className : null),
            textHead: tc.replace(/\s+/g, ' ').slice(0, 160)
          });
        }
      }

      const bodyHasNeedle = (document.body?.innerText || '').includes(needle);

      // If textContent doesn't contain it, search for the marker in attributes/outerHTML
      // (useful when the UI stores prompt text in attributes or serialized JSON).
      const outerHits = [];
      const msEls = all.filter(el => (el.tagName || '').toLowerCase().startsWith('ms-'));
      for (const el of msEls) {
        if (outerHits.length >= 25) break;
        try {
          const html = el.outerHTML || '';
          if (html.includes(needle)) {
            outerHits.push({
              tag: (el.tagName || '').toLowerCase(),
              id: el.id || null,
              className: (typeof el.className === 'string' ? el.className : null),
              outerHead: html.replace(/\s+/g, ' ').slice(0, 220)
            });
          }
        } catch {}
      }

      return { needle, bodyHasNeedle, topMsTags, hits, outerHits };
    }, marker);

    console.log(JSON.stringify(scan, null, 2));
  } finally {
    await browser.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
