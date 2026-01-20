#!/usr/bin/env node

const puppeteer = require('puppeteer-core');

function take(arr, n) {
  return Array.isArray(arr) ? arr.slice(0, n) : [];
}

function preview(s, n = 160) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

function decodeString(strings, maybeIndex) {
  if (!strings) return '';
  if (typeof maybeIndex === 'number') return strings[maybeIndex] || '';
  if (typeof maybeIndex === 'string') return maybeIndex;
  return '';
}

function buildAncestorChain(parentIndex, nodeNames, strings, nodeIdx, max = 10) {
  const chain = [];
  let cur = nodeIdx;
  let guard = 0;
  while (cur >= 0 && guard++ < max) {
    const name = decodeString(strings, nodeNames[cur]).toUpperCase();
    chain.push(name || '?');
    cur = parentIndex[cur];
  }
  return chain;
}

async function main() {
  const chromePort = Number(process.env.CHROME_PORT || 9222);
  const needle = String(process.env.NEEDLE || 'OK-');

  const versionRes = await fetch(`http://127.0.0.1:${chromePort}/json/version`);
  if (!versionRes.ok) throw new Error(`Failed to fetch /json/version: ${versionRes.status}`);
  const version = await versionRes.json();

  const browser = await puppeteer.connect({
    browserWSEndpoint: version.webSocketDebuggerUrl,
    defaultViewport: null,
    protocolTimeout: 180000,
  });

  try {
    const target = (await browser.targets()).find(
      (t) => t.type() === 'page' && String(t.url()).includes('aistudio.google.com')
    );
    if (!target) throw new Error('AI Studio tab not found');

    const page = await target.page();
    await page.bringToFront();
    await page.waitForTimeout(500);

    const client = await page.target().createCDPSession();
    const snap = await client.send('DOMSnapshot.captureSnapshot', {
      computedStyles: [],
      includePaintOrder: false,
      includeDOMRects: false,
      includeBlendedBackgroundColors: false,
      includeTextColorOpacity: false,
    });

    const strings = Array.isArray(snap.strings) ? snap.strings : [];
    const doc = snap && Array.isArray(snap.documents) ? snap.documents[0] : null;
    if (!doc || !doc.nodes) {
      console.log(JSON.stringify({ ok: false, reason: 'No nodes in snapshot' }, null, 2));
      return;
    }

    const nodeKeys = Object.keys(doc.nodes);

    const nodeValue = Array.isArray(doc.nodes.nodeValue) ? doc.nodes.nodeValue : [];
    const textValue = Array.isArray(doc.nodes.textValue) ? doc.nodes.textValue : [];

    const hay = [];
    for (const v of nodeValue) {
      const s = decodeString(strings, v);
      if (s && s.trim()) hay.push(s);
    }
    for (const v of textValue) {
      const s = decodeString(strings, v);
      if (s && s.trim()) hay.push(s);
    }

    const hits = [];
    for (const v of hay) {
      if (v.includes(needle)) {
        hits.push(preview(v, 220));
        if (hits.length >= 12) break;
      }
    }

    const hitNodes = [];
    if (Array.isArray(doc.nodes.parentIndex) && Array.isArray(doc.nodes.nodeName)) {
      const parentIndex = doc.nodes.parentIndex;
      const nodeNames = doc.nodes.nodeName;
      for (let i = 0; i < nodeValue.length; i++) {
        const s = decodeString(strings, nodeValue[i]);
        if (!s || !s.includes(needle)) continue;
        const nodeName = decodeString(strings, nodeNames[i]).toUpperCase();
        const chain = buildAncestorChain(parentIndex, nodeNames, strings, i, 12);
        hitNodes.push({ nodeIndex: i, nodeName, chain });
        if (hitNodes.length >= 6) break;
      }
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          url: page.url(),
          needle,
          nodeKeys,
          nodesCount: doc.nodes.nodeName ? doc.nodes.nodeName.length : null,
          nodeValueCount: nodeValue.length,
          textValueCount: textValue.length,
          nonEmptyStrings: hay.length,
          hitsCount: hits.length,
          hits,
          hitNodes,
          sample: take(hay.map((s) => preview(s, 120)), 8),
        },
        null,
        2
      )
    );
  } finally {
    await browser.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
