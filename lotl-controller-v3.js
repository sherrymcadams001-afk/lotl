/**
 * 🤖 LOTL CONTROLLER v3 - SOLIDIFIED
 * 
 * Separate endpoints for AI Studio and ChatGPT
 * DOM-first interaction for maximum stability
 * Proper turn counting and streaming detection
 */

const puppeteer = require('puppeteer-core');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ========== FAIL-FAST ENV CHECKS ==========
function parseNodeMajor() {
    const m = /^v?(\d+)\./.exec(process.version || '');
    return m ? Number(m[1]) : null;
}

function assertRuntimeRequirements() {
    const major = parseNodeMajor();
    if (!major || major < 18) {
        console.error(
            `❌ Node.js ${process.version} detected. LotL Controller requires Node 18+ (global fetch).\n` +
            `   Fix: install Node 18+ and retry.\n`
        );
        process.exit(1);
    }

    if (typeof fetch !== 'function') {
        console.error(
            `❌ Global fetch is not available in this Node runtime.\n` +
            `   Fix: use Node 18+ (or add a fetch polyfill).\n`
        );
        process.exit(1);
    }
}

assertRuntimeRequirements();

// ========== CONFIGURATION ==========
const PORT = Number(process.env.PORT || 3000);
// Safer default: local-only. Opt into LAN via HOST=0.0.0.0
const HOST = process.env.HOST || '127.0.0.1';
const CHROME_DEBUG_PORT = Number(process.env.CHROME_PORT || 9222);
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS || 5000);
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 8000);
const PUPPETEER_PROTOCOL_TIMEOUT_MS = Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS || 120000);
// NOTE: The request path can take > 180s (generation + streaming + fallbacks).
// Defaults are set conservatively to avoid "Lock timeout" errors under slow UI/network conditions.
const LOCK_TIMEOUT_MS_TEXT = Number(process.env.LOCK_TIMEOUT_MS_TEXT || 420000);
const LOCK_TIMEOUT_MS_IMAGES = Number(process.env.LOCK_TIMEOUT_MS_IMAGES || 900000);

function nowIso() {
    return new Date().toISOString();
}

function newRequestId() {
    return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function withTimeout(promise, ms, timeoutMessage) {
    let t;
    const timeout = new Promise((_, reject) => {
        t = setTimeout(() => reject(new Error(timeoutMessage || `Timeout after ${ms}ms`)), ms);
    });
    return Promise.race([
        promise.finally(() => clearTimeout(t)),
        timeout
    ]);
}

function decodeDataUrlToBuffer(dataUrl) {
    const s = String(dataUrl || '');
    const m = /^data:(image\/(png|jpeg|jpg|gif|webp));base64,(.+)$/i.exec(s);
    if (!m) {
        throw new Error('Invalid image data URL. Expected data:image/<type>;base64,...');
    }
    const mime = m[1].toLowerCase();
    const b64 = m[3];
    const buf = Buffer.from(b64, 'base64');
    return { mime, buf };
}

function extFromMime(mime) {
    if (mime.includes('png')) return 'png';
    if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
    if (mime.includes('gif')) return 'gif';
    if (mime.includes('webp')) return 'webp';
    return 'bin';
}

async function fetchJsonWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} from ${url}${text ? `: ${text.slice(0, 200)}` : ''}`);
        }
        return await res.json();
    } finally {
        clearTimeout(timeout);
    }
}

function cleanExtractedLines(text) {
    const raw = (text || '').replace(/\r\n/g, '\n');
    const artifactPatterns = [
        /^\s*edit\s*$/i, /^\s*more_vert\s*$/i,
        /^\s*thumb_up\s*$/i, /^\s*thumb_down\s*$/i,
        /^\s*content_copy\s*$/i, /^\s*model\s*$/i,
        /^\s*user\s*$/i, /^\s*\d+\.?\d*s\s*$/,
        /^\s*help\s*$/i, /^\s*sources?\s*$/i,
        /^\s*more options\s*$/i,
        /^\s*thoughts\s*$/i,
        /Expand to view model thoughts/i,
        /^\s*chevron_right\s*$/i,
        /Google Search Suggestions?.*/i,
        /Grounding with Google Search.*/i,
        /Learn more.*/i
    ];

    const lines = raw
        .split('\n')
        .map(l => (l || '').trim())
        .filter(Boolean)
        .filter(line => !artifactPatterns.some(p => p.test(line)));

    // De-dupe adjacent identical lines
    const deduped = [];
    for (const line of lines) {
        if (deduped.length === 0 || deduped[deduped.length - 1] !== line) {
            deduped.push(line);
        }
    }

    let result = deduped.join('\n').trim();
    if (result.startsWith('Model')) result = result.substring(5).trim();
    result = result.replace(/\[\d+\]/g, '');
    return result.trim();
}

function parseExpectedExactToken(prompt) {
    const s = String(prompt || '');
    const m = /Reply\s+with\s+exactly:\s*([^\r\n]+)\s*/i.exec(s);
    return m ? String(m[1] || '').trim() : null;
}

// ========== PLATFORM ADAPTERS ==========
const ADAPTERS = {
    aistudio: {
        name: 'AI Studio (Gemini)',
        urlPattern: 'aistudio.google.com',
        selectors: {
            input: 'footer textarea, textarea, div[contenteditable="true"]',
            runButton: 'button[aria-label*="Run"], button[aria-label*="Send"], button[aria-label*="Submit"]',
            stopButton: 'button[aria-label*="Stop"]',
            turn: 'ms-chat-turn',
            bubble: 'ms-chat-bubble',
            spinner: 'mat-progress-spinner, [class*="loading"], [class*="spinner"]'
        },
        // DOM-based input method
        setInput: async (page, text) => {
            return await page.evaluate((txt) => {
                const isVisible = (el) => {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    if (!style) return false;
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                    const r = el.getBoundingClientRect();
                    return r && r.width > 10 && r.height > 10;
                };

                const pickBest = (els) => {
                    const visible = Array.from(els || []).filter(isVisible);
                    if (visible.length === 0) return null;
                    // Prefer the largest visible element (usually the actual prompt box)
                    visible.sort((a, b) => {
                        const ra = a.getBoundingClientRect();
                        const rb = b.getBoundingClientRect();
                        return (rb.width * rb.height) - (ra.width * ra.height);
                    });
                    return visible[0];
                };

                const textarea = pickBest(document.querySelectorAll('footer textarea, textarea'));
                if (textarea) {
                    textarea.focus();
                    textarea.value = '';
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    textarea.dispatchEvent(new Event('change', { bubbles: true }));

                    textarea.value = txt;
                    textarea.dispatchEvent(new Event('input', { bubbles: true }));
                    textarea.dispatchEvent(new Event('change', { bubbles: true }));

                    // Angular-specific: trigger ngModelChange if present
                    const ngModel = textarea.getAttribute('ng-model') || textarea.getAttribute('[(ngModel)]');
                    if (ngModel) {
                        textarea.dispatchEvent(new CustomEvent('ngModelChange', { detail: txt, bubbles: true }));
                    }

                    return textarea.value === txt;
                }

                const editable = pickBest(document.querySelectorAll('div[contenteditable="true"]'));
                if (editable) {
                    editable.focus();
                    editable.textContent = '';
                    editable.dispatchEvent(new Event('input', { bubbles: true }));
                    editable.textContent = txt;
                    editable.dispatchEvent(new Event('input', { bubbles: true }));
                    return (editable.textContent || '').trim() === txt.trim();
                }

                return false;
            }, text);
        },
        // DOM-based run trigger
        clickRun: async (page) => {
            // Prefer Ctrl+Enter because it targets the focused prompt field,
            // avoiding ambiguity when there are multiple visible Run buttons.
            try {
                await page.keyboard.down('Control');
                await page.keyboard.press('Enter');
                await page.keyboard.up('Control');
                return true;
            } catch {}

            // Fallback to clicking a visible Run/Send button.
            return await page.evaluate(() => {
                const isVisible = (el) => {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    if (!style) return false;
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                    const r = el.getBoundingClientRect();
                    return r && r.width > 6 && r.height > 6;
                };

                const candidates = Array.from(document.querySelectorAll(
                    'button[aria-label*="Run"], button[aria-label*="Send"], button[aria-label*="Submit"]'
                ))
                    .filter(isVisible)
                    .filter((b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true');

                candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
                const btn = candidates[0];
                if (!btn) return false;
                btn.click();
                return true;
            });
        },

        uploadImages: async (page, images) => {
            if (!images || !Array.isArray(images) || images.length === 0) return;

            console.log(`📷 Uploading ${images.length} image(s) to AI Studio...`);

            for (let i = 0; i < images.length; i++) {
                const { mime, buf } = decodeDataUrlToBuffer(images[i]);
                const ext = extFromMime(mime);
                const tempPath = path.join(os.tmpdir(), `lotl_upload_${Date.now()}_${i}.${ext}`);
                fs.writeFileSync(tempPath, buf);
                console.log(`📁 Temp image ${i + 1}/${images.length}: ${tempPath} (${Math.round(buf.length / 1024)}KB)`);

                let uploaded = false;

                // Strategy 1: Insert menu -> Upload from computer
                try {
                    const insertBtn = await page.$('button[aria-label*="Insert"]');
                    if (insertBtn) {
                        await insertBtn.click();
                        await sleep(400);

                        const menuItemSelectors = [
                            'button[aria-label*="Upload from computer"]',
                            '[role="menuitem"][aria-label*="Upload"]',
                            '[role="menu"] button',
                            '.mat-mdc-menu-content button',
                            'mat-menu-content button'
                        ];

                        let menuItem = null;
                        for (const sel of menuItemSelectors) {
                            try {
                                const el = await page.$(sel);
                                if (el) {
                                    const text = await el.evaluate(e => (e.textContent || '').toLowerCase());
                                    const aria = await el.evaluate(e => (e.getAttribute('aria-label') || '').toLowerCase());
                                    if (aria.includes('upload') || text.includes('upload')) {
                                        menuItem = el;
                                        break;
                                    }
                                }
                            } catch {}
                        }

                        if (menuItem) {
                            const chooserPromise = page.waitForFileChooser({ timeout: 6000 });
                            await menuItem.click();
                            const chooser = await chooserPromise;
                            await chooser.accept([tempPath]);
                            uploaded = true;
                            console.log(`✅ Image ${i + 1} selected via Insert menu`);
                        }

                        // Close menu if still open
                        try { await page.keyboard.press('Escape'); } catch {}
                    }
                } catch (e) {
                    console.log(`⚠️ Upload strategy 1 failed: ${e.message}`);
                    try { await page.keyboard.press('Escape'); } catch {}
                }

                // Strategy 2: Direct file input
                if (!uploaded) {
                    try {
                        const fileInput = await page.$('input[type="file"]');
                        if (fileInput) {
                            await fileInput.uploadFile(tempPath);
                            uploaded = true;
                            console.log(`✅ Image ${i + 1} uploaded via direct file input`);
                        }
                    } catch (e) {
                        console.log(`⚠️ Upload strategy 2 failed: ${e.message}`);
                    }
                }

                // Strategy 3: Drag-and-drop to prompt box
                if (!uploaded) {
                    try {
                        const b64Only = String(images[i]).replace(/^data:image\/\w+;base64,/, '');
                        uploaded = await page.evaluate(async (b64Data, extLocal) => {
                            const byteString = atob(b64Data);
                            const ab = new ArrayBuffer(byteString.length);
                            const ia = new Uint8Array(ab);
                            for (let j = 0; j < byteString.length; j++) {
                                ia[j] = byteString.charCodeAt(j);
                            }

                            const blob = new Blob([ab], { type: `image/${extLocal === 'jpg' ? 'jpeg' : extLocal}` });
                            const file = new File([blob], `upload_${Date.now()}.${extLocal}`, { type: blob.type });
                            const dataTransfer = new DataTransfer();
                            dataTransfer.items.add(file);

                            const target = document.querySelector('ms-prompt-box') ||
                                           document.querySelector('.prompt-box-container') ||
                                           document.querySelector('footer');
                            if (!target) return false;

                            target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }));
                            target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer }));
                            target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
                            return true;
                        }, b64Only, ext);

                        if (uploaded) {
                            console.log(`✅ Image ${i + 1} drag-drop dispatched`);
                        }
                    } catch (e) {
                        console.log(`⚠️ Upload strategy 3 failed: ${e.message}`);
                    }
                }

                // Wait for UI to show an attachment chip/preview
                if (uploaded) {
                    try {
                        await sleep(1200);
                        await withTimeout(
                            page.waitForFunction(() => {
                                const indicators = [
                                    'ms-img-media',
                                    '[class*="media-chip"]',
                                    '[class*="file-chip"]',
                                    '.prompt-box-container img',
                                    'img[src*="blob:"]',
                                    '[aria-label*="Remove"]'
                                ];
                                return indicators.some(sel => document.querySelector(sel));
                            }, { timeout: 8000 }),
                            9000,
                            'Image preview did not appear in time'
                        );
                        console.log(`✅ Image ${i + 1} verified in UI`);
                    } catch (e) {
                        console.log(`⚠️ Image ${i + 1} uploaded but preview not detected: ${e.message}`);
                    }
                } else {
                    console.log(`❌ Image ${i + 1} upload failed (all strategies exhausted)`);
                }

                // Cleanup temp file
                try { fs.unlinkSync(tempPath); } catch {}

                // Small delay between images
                if (i < images.length - 1) {
                    await sleep(400);
                }
            }

            console.log('📷 Image upload step complete');
        },
        // DOM-based response extraction
        // NOTE: Do NOT clone custom elements here. cloneNode() does not preserve shadow DOM
        // and often results in empty innerText.
        extractResponse: async (page) => {
            return await page.evaluate(() => {
                function deepText(node) {
                    if (!node) return '';
                    // Text node
                    if (node.nodeType === Node.TEXT_NODE) {
                        return node.nodeValue || '';
                    }
                    // Element node
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const el = /** @type {HTMLElement} */ (node);
                        const tag = (el.tagName || '').toLowerCase();

                        // Skip obvious UI noise
                        if (tag === 'button' || tag === 'mat-icon') return '';
                        const cls = (el.className && String(el.className)) ? String(el.className).toLowerCase() : '';
                        if (cls.includes('icon') || cls.includes('action') || cls.includes('menu') || cls.includes('feedback')) return '';
                        const aria = (el.getAttribute && el.getAttribute('aria-label')) ? String(el.getAttribute('aria-label')).toLowerCase() : '';
                        if (aria.includes('copy') || aria.includes('thumb') || aria.includes('rate') || aria.includes('feedback')) return '';

                        let out = '';
                        // Light separators for block-ish elements
                        if (tag === 'br') return '\n';

                        // Walk light DOM
                        if (el.childNodes && el.childNodes.length) {
                            for (const child of el.childNodes) {
                                out += deepText(child);
                            }
                        }
                        // Walk shadow DOM
                        const sr = /** @type {any} */ (el).shadowRoot;
                        if (sr && sr.childNodes && sr.childNodes.length) {
                            for (const child of sr.childNodes) {
                                out += deepText(child);
                            }
                        }

                        // Add newlines after common block containers
                        if (tag === 'p' || tag === 'div' || tag === 'li' || tag === 'pre' || tag === 'section' || tag === 'article') {
                            out += '\n';
                        }

                        return out;
                    }
                    return '';
                }

                function cleanTurnText(raw) {
                    let t = String(raw || '');
                    t = t.replace(/\r\n/g, '\n');

                    // Remove common UI tokens that appear inline.
                    t = t.replace(/\b(edit|more_vert|thumb_up|thumb_down|content_copy|download)\b/gi, ' ');
                    t = t.replace(/\b\d+(?:\.\d+)?s\b/g, ' ');
                    t = t.replace(/\s+/g, ' ').trim();

                    // Strip leading role labels.
                    t = t.replace(/^\s*(User|Model)\s+/i, '');

                    // Remove citation brackets.
                    t = t.replace(/\[\d+\]/g, '');

                    return t.trim();
                }

                const turns = document.querySelectorAll('ms-chat-turn');
                if (turns.length === 0) return null;

                // Prefer the most recent Model turn (avoid returning the user prompt).
                let best = null;
                for (let i = turns.length - 1; i >= 0; i--) {
                    const t = turns[i];
                    let raw = (t.innerText || '').trim();
                    if (!raw) raw = deepText(t);
                    if (!raw || raw.trim().length === 0) continue;

                    const cleaned = cleanTurnText(raw);
                    if (!cleaned) continue;

                    const looksLikeModel = /\bModel\b/i.test(raw);
                    const looksLikeUser = /\bUser\b/i.test(raw);

                    if (looksLikeModel && !looksLikeUser) {
                        return cleaned;
                    }

                    // Keep as fallback in case we can't find a Model-labelled turn.
                    if (!best) best = cleaned;
                }

                return best;
            });
        },
        // Get current turn count
        getTurnCount: async (page) => {
            return await page.evaluate(() => {
                return document.querySelectorAll('ms-chat-turn').length;
            });
        },
        // Check if still generating
        isGenerating: async (page) => {
            return await page.evaluate(() => {
                // Primary signal: when "Run" is visible + enabled, generation is complete.
                const runBtn = document.querySelector('button[aria-label*="Run"]');
                if (runBtn && runBtn.offsetParent !== null && !runBtn.disabled) return false;

                // Secondary signals: Stop visible OR loading spinners visible -> generating.
                const stopBtn = document.querySelector('button[aria-label*="Stop"]');
                if (stopBtn && stopBtn.offsetParent !== null) return true;

                const spinners = document.querySelectorAll(
                    'mat-progress-spinner, [class*="loading"], [class*="spinner"]'
                );
                for (const s of spinners) {
                    if (s.offsetParent !== null) return true;
                }

                // Fallback: if we can't prove it's generating, assume not generating.
                return false;
            });
        }
    },
    
    chatgpt: {
        name: 'ChatGPT',
        urlPattern: 'chatgpt.com',
        selectors: {
            input: '#prompt-textarea, textarea[data-id="root"], div[contenteditable="true"][data-placeholder]',
            sendButton: 'button[data-testid="send-button"], button[aria-label*="Send"]',
            stopButton: 'button[data-testid="stop-button"], button[aria-label*="Stop"]',
            turn: '[data-message-author-role="assistant"]',
            spinner: '[class*="streaming"], [class*="loading"]'
        },
        setInput: async (page, text) => {
            return await page.evaluate((txt) => {
                // ChatGPT uses contenteditable div or textarea
                const selectors = [
                    '#prompt-textarea',
                    'textarea[data-id="root"]', 
                    'div[contenteditable="true"][data-placeholder]',
                    'div[contenteditable="true"]'
                ];
                
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (!el) continue;
                    
                    el.focus();
                    
                    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                        el.value = txt;
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        el.dispatchEvent(new Event('change', { bubbles: true }));
                        return true;
                    } else if (el.contentEditable === 'true') {
                        // ContentEditable div
                        el.innerHTML = '';
                        el.innerText = txt;
                        el.dispatchEvent(new Event('input', { bubbles: true }));
                        return true;
                    }
                }
                return false;
            }, text);
        },
        clickRun: async (page) => {
            return await page.evaluate(() => {
                const selectors = [
                    'button[data-testid="send-button"]',
                    'button[aria-label*="Send"]',
                    'button[aria-label*="send"]'
                ];
                
                for (const sel of selectors) {
                    const btn = document.querySelector(sel);
                    if (btn && !btn.disabled) {
                        btn.click();
                        return true;
                    }
                }
                return false;
            });
        },
        extractResponse: async (page) => {
            return await page.evaluate(() => {
                // ChatGPT response messages
                const selectors = [
                    '[data-message-author-role="assistant"]',
                    '.agent-turn .markdown',
                    '[class*="assistant-message"]'
                ];
                
                let messages = [];
                for (const sel of selectors) {
                    const els = document.querySelectorAll(sel);
                    if (els.length > 0) {
                        messages = Array.from(els);
                        break;
                    }
                }
                
                if (messages.length === 0) return null;
                
                const lastMsg = messages[messages.length - 1];
                const clone = lastMsg.cloneNode(true);
                
                // Remove UI elements
                clone.querySelectorAll('button, [class*="copy"], [class*="action"]')
                    .forEach(el => el.remove());
                
                return (clone.innerText || clone.textContent || '').trim();
            });
        },
        getTurnCount: async (page) => {
            return await page.evaluate(() => {
                const selectors = [
                    '[data-message-author-role="assistant"]',
                    '.agent-turn'
                ];
                for (const sel of selectors) {
                    const count = document.querySelectorAll(sel).length;
                    if (count > 0) return count;
                }
                return 0;
            });
        },
        isGenerating: async (page) => {
            return await page.evaluate(() => {
                // Check for stop button
                const stopBtn = document.querySelector(
                    'button[data-testid="stop-button"], button[aria-label*="Stop"]'
                );
                if (stopBtn && stopBtn.offsetParent !== null) return true;
                
                // Check for streaming indicator
                const streaming = document.querySelector('[class*="streaming"]');
                if (streaming) return true;
                
                // Check if send button is disabled (generating)
                const sendBtn = document.querySelector('button[data-testid="send-button"]');
                if (sendBtn && sendBtn.disabled) return true;
                
                return false;
            });
        }
    }
};

// ========== CONTROLLER CLASS ==========
class LotlController {
    constructor() {
        this.browser = null;
        this.pages = {};  // Separate page references per platform
        this._locks = {
            aistudio: Promise.resolve(),
            chatgpt: Promise.resolve(),
        };
        this._connectLock = Promise.resolve();
    }
    
    async connect(platform) {
        const adapter = ADAPTERS[platform];
        if (!adapter) throw new Error(`Unknown platform: ${platform}`);
        
        console.log(`🔌 Connecting to ${adapter.name}...`);
        
        // Get browser connection (serialized)
        if (!this.browser) {
            this._connectLock = this._connectLock.then(async () => {
                if (this.browser) return;
                const versionData = await fetchJsonWithTimeout(
                    `http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version`,
                    CONNECT_TIMEOUT_MS
                );

                this.browser = await puppeteer.connect({
                    browserWSEndpoint: versionData.webSocketDebuggerUrl,
                    defaultViewport: null,
                    protocolTimeout: PUPPETEER_PROTOCOL_TIMEOUT_MS
                });
                this.browser.on('disconnected', () => {
                    console.error('⚠️ Chrome disconnected; clearing cached pages/browser');
                    this.browser = null;
                    this.pages = {};
                });

                console.log('✅ Connected to Chrome');
            });

            await this._connectLock;
        }
        
        // Find the right tab
        const targets = await this.browser.targets();
        const target = targets.find(t => 
            t.url().includes(adapter.urlPattern) && t.type() === 'page'
        );
        
        if (!target) {
            throw new Error(
                `${adapter.name} tab not found. Open ${adapter.urlPattern} in Chrome first.`
            );
        }
        
        const page = await target.page();
        if (!page) throw new Error(`Could not get page for ${adapter.name}`);
        
        this.pages[platform] = page;
        console.log(`✅ Connected to ${adapter.name}`);
        return { page, adapter };
    }
    
    async ensureConnection(platform) {
        if (this.pages[platform]) {
            try {
                await this.pages[platform].title();  // Quick health check
                return { page: this.pages[platform], adapter: ADAPTERS[platform] };
            } catch (e) {
                console.log(`⚠️ Connection stale, reconnecting...`);
                delete this.pages[platform];
            }
        }
        return await this.connect(platform);
    }
    
    async withLock(platform, fn, timeoutMs) {
        const ms = Number(timeoutMs || LOCK_TIMEOUT_MS_TEXT);
        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Lock timeout (${Math.round(ms / 1000)}s)`)), ms)
        );

        const prior = this._locks[platform] || Promise.resolve();
        const run = prior.then(fn, fn);
        this._locks[platform] = run.catch(() => undefined);
        return Promise.race([run, timeout]);
    }

    async extractFallback(platform, page, anchorText) {
        if (platform !== 'aistudio') return null;

        // Fallback: (1) try the accessibility tree, then (2) try a CDP DOMSnapshot.
        // Both help when the UI moves content into closed/shadow DOM where innerText/textContent appear empty.
        try {
            const turns = await page.$$('ms-chat-turn');
            if (!turns || turns.length === 0) return null;

            const expected = parseExpectedExactToken(anchorText);

            const pieces = [];
            const visit = (node) => {
                if (!node) return;
                if (typeof node.name === 'string' && node.name.trim()) pieces.push(node.name.trim());
                if (typeof node.value === 'string' && node.value.trim()) pieces.push(node.value.trim());
                if (Array.isArray(node.children)) {
                    for (const c of node.children) visit(c);
                }
            };

            // Scan a handful of recent turns; UI changes sometimes make innerText useless.
            const start = Math.max(0, turns.length - 6);
            for (let i = turns.length - 1; i >= start; i--) {
                pieces.length = 0;
                const snapshot = await page.accessibility.snapshot({ root: turns[i] });
                if (!snapshot) continue;
                visit(snapshot);
                const raw = pieces.join('\n');
                const cleaned = cleanExtractedLines(raw);
                if (!cleaned) continue;
                if (/Expand to view model thoughts/i.test(cleaned)) continue;

                // If we're expecting a specific token, prefer returning just that token.
                if (expected && raw.includes(expected) && !/Reply\s+with\s+exactly:/i.test(raw)) {
                    return expected;
                }
                return cleaned;
            }

            // Accessibility didn't expose the model text; fall back to a DOMSnapshot.
            try {
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
                if (!doc || !doc.nodes || !Array.isArray(doc.nodes.nodeValue)) return null;

                const decode = (idx) => (typeof idx === 'number' ? (strings[idx] || '') : '');

                const nodeCount = Array.isArray(doc.nodes.nodeName) ? doc.nodes.nodeName.length : 0;
                const parentIndex = Array.isArray(doc.nodes.parentIndex) ? doc.nodes.parentIndex : [];

                // Prefer extracting within the most recent chat turn subtree that actually contains content.
                const turnIndices = [];
                if (Array.isArray(doc.nodes.nodeName)) {
                    for (let i = 0; i < nodeCount; i++) {
                        const name = decode(doc.nodes.nodeName[i]).toUpperCase();
                        if (name === 'MS-CHAT-TURN') turnIndices.push(i);
                    }
                }

                const isDescendantOf = (nodeIdx, ancestorIdx) => {
                    if (ancestorIdx < 0) return false;
                    let cur = nodeIdx;
                    let guard = 0;
                    while (cur >= 0 && guard++ < 8000) {
                        if (cur === ancestorIdx) return true;
                        cur = parentIndex[cur];
                    }
                    return false;
                };

                const extractTurnTexts = (turnIdx) => {
                    const out = [];
                    for (let i = 0; i < nodeCount; i++) {
                        if (!isDescendantOf(i, turnIdx)) continue;
                        const s = decode(doc.nodes.nodeValue[i]);
                        if (!s) continue;
                        const t = s.replace(/\s+/g, ' ').trim();
                        if (!t) continue;
                        if (t.length > 2000) continue;
                        if (t.startsWith('{') && t.includes('"') && t.includes(':')) continue;
                        if (t.includes('function ') || t.includes('var _F_')) continue;
                        out.push(t);
                    }
                    return out;
                };

                // Anchor to the current prompt (when possible), then extract from the following turn(s).
                const anchor = String(anchorText || '').trim();
                const expected = parseExpectedExactToken(anchor);
                const anchorForSearch = expected || anchor;

                if (expected) {
                    for (let i = 0; i < nodeCount; i++) {
                        const s = decode(doc.nodes.nodeValue[i]);
                        if (!s) continue;
                        if (String(s).trim() === expected) {
                            return expected;
                        }
                    }
                }

                const turnNoise = [
                    /^More options$/i,
                    /^Send prompt \(Ctrl \+ Enter\)$/i,
                    /^Enter a prompt$/i,
                    /^Run$/i,
                    /^Stop$/i,
                ];

                const maxTurnsToInspect = 14;
                const turnScanStart = Math.max(0, turnIndices.length - maxTurnsToInspect);
                let anchorTurnPos = -1;

                if (anchorForSearch) {
                    for (let ti = turnScanStart; ti < turnIndices.length; ti++) {
                        const raw = extractTurnTexts(turnIndices[ti]).join('\n');
                        if (raw && raw.includes(anchorForSearch)) {
                            anchorTurnPos = ti;
                        }
                    }
                }

                const scanEnd = turnIndices.length - 1;
                const scanStart = anchorTurnPos >= 0 ? Math.min(scanEnd, anchorTurnPos + 6) : scanEnd;
                const scanFloor = anchorTurnPos >= 0 ? anchorTurnPos + 1 : turnScanStart;

                let best = null;
                for (let ti = scanStart; ti >= scanFloor; ti--) {
                    const turnTexts = extractTurnTexts(turnIndices[ti]);
                    const raw = turnTexts.join('\n');
                    if (!raw) continue;

                    if (expected && raw.includes(expected) && !/Reply\s+with\s+exactly:/i.test(raw)) {
                        return expected;
                    }

                    const cleaned = cleanExtractedLines(raw);
                    if (!cleaned) continue;
                    if (/Expand to view model thoughts/i.test(cleaned)) continue;
                    if (turnNoise.some((p) => p.test(cleaned))) continue;

                    if (!best) best = cleaned;
                }

                if (best) return best;

                const ordered = (() => {
                    const all = [];
                    for (const idx of doc.nodes.nodeValue) {
                        const s = decode(idx);
                        if (!s) continue;
                        const t = s.replace(/\s+/g, ' ').trim();
                        if (!t) continue;
                        if (t.length > 2000) continue;
                        if (t.startsWith('{') && t.includes('"') && t.includes(':')) continue;
                        if (t.includes('function ') || t.includes('var _F_')) continue;
                        all.push(t);
                    }
                    return all;
                })();

                let anchorIdx = -1;
                if (anchorForSearch) {
                    for (let i = ordered.length - 1; i >= 0; i--) {
                        if (ordered[i].includes(anchorForSearch)) {
                            anchorIdx = i;
                            break;
                        }
                    }
                }

                const after = anchorIdx >= 0 ? ordered.slice(anchorIdx + 1) : ordered;
                const noise = [
                    /Google AI Studio/i,
                    /Cookie Consent/i,
                    /Response ready\.?/i,
                    /Send prompt \(Ctrl \+ Enter\)/i,
                    /Enter a prompt/i,
                    /\b(edit|more_vert|thumb_up|thumb_down|content_copy|download)\b/i,
                    /Expand to view model thoughts/i,
                    /'s Confirmation/i,
                ];

                const candidates = [];
                for (const t of after) {
                    if (anchorForSearch && t.includes(anchorForSearch)) continue;
                    if (noise.some((p) => p.test(t))) continue;
                    const cleaned = cleanExtractedLines(t);
                    if (!cleaned) continue;
                    candidates.push(cleaned);
                }

                if (candidates.length === 0) return null;

                if (expected) {
                    for (let i = candidates.length - 1; i >= 0; i--) {
                        if (candidates[i] && candidates[i].includes(expected)) {
                            return expected;
                        }
                    }
                }

                return candidates[candidates.length - 1];
            } catch (e2) {
                console.log(`⚠️ DOMSnapshot extraction failed: ${e2.message}`);
                return null;
            }
        } catch (e) {
            console.log(`⚠️ Fallback extraction failed: ${e.message}`);
            return null;
        }
    }
    
    async send(platform, prompt, images) {
        const hasImages = Boolean(images && Array.isArray(images) && images.length > 0);
        const lockTimeoutMs = platform === 'aistudio' && hasImages ? LOCK_TIMEOUT_MS_IMAGES : LOCK_TIMEOUT_MS_TEXT;

        return await this.withLock(platform, async () => {
            console.log(`\n📩 [${platform.toUpperCase()}] Processing prompt (${prompt.length} chars)...`);
            
            const { page, adapter } = await this.ensureConnection(platform);
            await page.bringToFront();

            // Production guard: detect common AI Studio blockers early.
            if (platform === 'aistudio') {
                const blockers = await page.evaluate(() => {
                    const hay = (document.body && document.body.innerText) ? document.body.innerText : '';
                    const patterns = [
                        /Sign in/i,
                        /Verify it's you/i,
                        /unusual traffic/i,
                        /captcha/i,
                        /Something went wrong/i
                    ];
                    return patterns.filter(p => p.test(hay)).map(p => p.toString());
                });
                if (Array.isArray(blockers) && blockers.length > 0) {
                    throw new Error(`AI Studio is blocked (${blockers.join(', ')}). Fix the tab state (login / API key prompt) and retry.`);
                }
            }
            
            // Scroll to bottom
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await sleep(300);
            
            // Get turn count BEFORE
            const turnsBefore = await adapter.getTurnCount(page);
            console.log(`📊 Turns before: ${turnsBefore}`);

            // Capture the current extracted response so we can detect stale/non-updating extraction.
            const preSendExtract = platform === 'aistudio'
                ? String(await adapter.extractResponse(page) || '').trim()
                : '';

            const expectedExact = platform === 'aistudio' ? parseExpectedExactToken(prompt) : null;

            // Upload images if supported by this adapter
            if (images && Array.isArray(images) && images.length > 0) {
                if (typeof adapter.uploadImages === 'function') {
                    await adapter.uploadImages(page, images);
                } else {
                    console.log(`📷 Images provided (${images.length}) but adapter does not support uploads; ignoring`);
                }
            }
            
            // SET INPUT via DOM
            console.log(`⌨️ Setting input via DOM...`);
            const inputSet = await adapter.setInput(page, prompt);
            if (!inputSet) {
                throw new Error('Failed to set input - selector not found');
            }
            await sleep(300);
            
            // CLICK RUN via DOM
            console.log(`🚀 Clicking run/send...`);
            const clicked = await adapter.clickRun(page);
            if (!clicked) {
                throw new Error('Failed to click run/send button');
            }
            
            // WAIT FOR RESPONSE
            console.log(`⏳ Waiting for response...`);
            let gotResponse = false;

            // AI Studio reliably produces 2 turns (user + model). ChatGPT patterns differ.
            const requiredTurnDelta = platform === 'aistudio' ? 2 : 1;
            
            for (let i = 0; i < 180; i++) {  // Up to 3 minutes
                await sleep(1000);
                
                const turnsNow = await adapter.getTurnCount(page);
                const generating = await adapter.isGenerating(page);
                
                // We need sufficient new turns and not generating
                if (turnsNow >= turnsBefore + requiredTurnDelta && !generating) {
                    gotResponse = true;
                    console.log(`📊 Turns after: ${turnsNow}`);
                    break;
                }
                
                // Log progress every 10 seconds
                if (i > 0 && i % 10 === 0) {
                    console.log(`   ... still waiting (${i}s, turns: ${turnsNow}, generating: ${generating})`);
                }
            }
            
            if (!gotResponse) {
                throw new Error('Timeout waiting for response (3 min)');
            }
            
            // WAIT FOR STREAMING TO COMPLETE
            console.log(`⏳ Waiting for streaming to complete...`);
            let lastText = '';
            let stableCount = 0;
            
            for (let i = 0; i < 60; i++) {  // Up to 60 seconds for streaming
                await sleep(1000);
                
                const currentText = await adapter.extractResponse(page);
                
                if (currentText === lastText && currentText && currentText.length > 0) {
                    stableCount++;
                    if (stableCount >= 3) {  // Stable for 3 seconds
                        console.log(`✅ Response complete (stable for 3s)`);
                        break;
                    }
                } else {
                    stableCount = 0;
                    lastText = currentText;
                }
            }
            
            // EXTRACT FINAL RESPONSE
            let response = await adapter.extractResponse(page);
            const responseStr = String(response || '').trim();
            const looksLikeThoughtsOnly = /Expand to view model thoughts/i.test(responseStr) || /^Thoughts\b/i.test(responseStr);

            // If the prompt asks for an exact token, validate we got that token.
            // This catches cases where the generic "latest model turn" extractor returns a stale/previous reply.

            if (!response || responseStr.length === 0 || (platform === 'aistudio' && looksLikeThoughtsOnly)) {
                const fallback = await this.extractFallback(platform, page, prompt);
                if (fallback && fallback.trim().length > 0) {
                    console.log(`✅ Got response via fallback (${fallback.length} chars)`);
                    response = fallback;
                }
            }

            // If extraction returned a non-empty string that is identical to what we saw before sending,
            // treat it as likely stale and force fallback.
            if (platform === 'aistudio') {
                const gotNow = String(response || '').trim();
                if (gotNow && preSendExtract && gotNow === preSendExtract) {
                    console.log('⚠️ Response equals pre-send extraction; forcing fallback extraction');
                    const fallbackStale = await this.extractFallback(platform, page, prompt);
                    const fb = String(fallbackStale || '').trim();
                    if (fb && fb !== gotNow) {
                        console.log('✅ Stale extraction corrected via fallback');
                        response = fallbackStale;
                    }
                }
            }

            // Exact-token mode: if we didn't get the expected token, try anchored fallbacks even if response is non-empty.
            if (platform === 'aistudio' && expectedExact) {
                const got = String(response || '').trim();
                if (got !== expectedExact) {
                    const fallback2 = await this.extractFallback(platform, page, prompt);
                    const fb = String(fallback2 || '').trim();
                    if (fb === expectedExact || fb.includes(expectedExact)) {
                        console.log('✅ Exact-token mode: corrected reply via fallback');
                        response = expectedExact;
                    } else {
                        throw new Error(`Exact-token mode failed. expected="${expectedExact}" got="${got}"`);
                    }
                }
            }

            // If still empty, surface likely blockers rather than returning an empty string.
            if (platform === 'aistudio' && (!response || String(response).trim().length === 0)) {
                const hint = await page.evaluate(() => {
                    const hay = (document.body && document.body.innerText) ? document.body.innerText : '';
                    const known = [
                        "Verify it's you",
                        'Sign in',
                        'unusual traffic',
                        'captcha'
                    ];
                    for (const k of known) {
                        if (hay.includes(k)) return k;
                    }
                    return null;
                });
                if (hint) {
                    throw new Error(`AI Studio returned an empty reply; likely blocked by: ${hint}. Check the AI Studio tab UI.`);
                }
            }

            console.log(`✅ Got response (${response ? response.length : 0} chars)`);
            return response;
        }, lockTimeoutMs);
    }

    async probePlatform(platform) {
        const adapter = ADAPTERS[platform];
        if (!adapter) {
            return { ok: false, reason: `Unknown platform: ${platform}` };
        }

        // Check Chrome debug port first
        const version = await fetchJsonWithTimeout(
            `http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version`,
            READY_TIMEOUT_MS
        );

        const { page } = await this.ensureConnection(platform);
        await page.bringToFront();

        // Minimal selector probe + common blocker detection (helps production readiness)
        const probe = await page.evaluate((selInput, urlPattern, platformName) => {
            const urlOk = window.location.href.includes(urlPattern);
            const isVisible = (el) => {
                if (!el) return false;
                const style = window.getComputedStyle(el);
                if (!style) return false;
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                const r = el.getBoundingClientRect();
                return r && r.width > 10 && r.height > 10;
            };

            const nodes = Array.from(document.querySelectorAll(selInput));
            const input = nodes.find(isVisible) || null;
            const hay = (document.body && document.body.innerText) ? document.body.innerText : '';

            const blockers = [];
            if (platformName === 'aistudio') {
                if (/Sign in/i.test(hay)) blockers.push('Sign in');
                if (/Verify it's you/i.test(hay)) blockers.push("Verify it's you");
                if (/captcha/i.test(hay) || /unusual traffic/i.test(hay)) blockers.push('Captcha/unusual traffic');
            }

            return {
                urlOk,
                hasInput: Boolean(input),
                blockers,
                activeUrl: window.location.href
            };
        }, adapter.selectors.input, adapter.urlPattern, platform);

        return {
            ok: Boolean(probe.urlOk && probe.hasInput && (!probe.blockers || probe.blockers.length === 0)),
            chrome: { webSocketDebuggerUrl: version.webSocketDebuggerUrl ? 'present' : 'missing' },
            page: probe,
        };
    }
}

// ========== EXPRESS SERVER ==========
const app = express();
app.use(bodyParser.json({ limit: '50mb' }));

const controller = new LotlController();

// ---------- HEALTH CHECK ----------
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: 'v3-solidified',
        endpoints: ['/aistudio', '/chatgpt', '/chat'],
        timestamp: nowIso()
    });
});

// ---------- READINESS CHECK ----------
app.get('/ready', async (req, res) => {
    const requestId = newRequestId();
    try {
        const aistudio = await controller.probePlatform('aistudio');
        const chatgptRequested = String(req.query.chatgpt || '').toLowerCase() === 'true';
        const chatgpt = chatgptRequested ? await controller.probePlatform('chatgpt') : { ok: true, skipped: true };

        const ok = Boolean(aistudio.ok && chatgpt.ok);
        res.status(ok ? 200 : 503).json({
            ok,
            requestId,
            timestamp: nowIso(),
            node: process.version,
            chromePort: CHROME_DEBUG_PORT,
            checks: { aistudio, chatgpt }
        });
    } catch (err) {
        res.status(503).json({
            ok: false,
            requestId,
            timestamp: nowIso(),
            error: err.message || String(err)
        });
    }
});

// ---------- AI STUDIO ENDPOINT ----------
app.post('/aistudio', async (req, res) => {
    const { prompt, images } = req.body;
    const requestId = newRequestId();
    
    if (!prompt) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing prompt',
            endpoint: '/aistudio',
            requestId
        });
    }

    const warnings = [];
    
    console.log(`\n🔵 [AISTUDIO] Request: "${prompt.substring(0, 60)}..."`);
    
    try {
        const reply = await controller.send('aistudio', prompt, images);
        res.json({ 
            success: true, 
            reply,
            platform: 'aistudio',
            requestId,
            warnings,
            timestamp: nowIso()
        });
    } catch (err) {
        console.error(`❌ [AISTUDIO] Error: ${err.message}`);
        res.status(500).json({ 
            success: false, 
            error: err.message,
            platform: 'aistudio',
            requestId
        });
    }
});

// ---------- CHATGPT ENDPOINT ----------
app.post('/chatgpt', async (req, res) => {
    const { prompt, images } = req.body;
    const requestId = newRequestId();
        if (images && Array.isArray(images) && images.length > 0) {
            return res.status(400).json({
                success: false,
                error: 'ChatGPT endpoint does not support images in this controller. Use /aistudio for vision inputs.',
                platform: 'chatgpt',
                requestId
            });
        }
    
    if (!prompt) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing prompt',
            endpoint: '/chatgpt',
            requestId
        });
    }
    
    console.log(`\n🟢 [CHATGPT] Request: "${prompt.substring(0, 60)}..."`);
    
    try {
        const reply = await controller.send('chatgpt', prompt);
        res.json({ 
            success: true, 
            reply,
            platform: 'chatgpt',
            requestId,
            timestamp: nowIso()
        });
    } catch (err) {
        console.error(`❌ [CHATGPT] Error: ${err.message}`);
        res.status(500).json({ 
            success: false, 
            error: err.message,
            platform: 'chatgpt',
            requestId
        });
    }
});

// ---------- LEGACY UNIFIED ENDPOINT ----------
app.post('/chat', async (req, res) => {
    const { prompt, target = 'gemini', images } = req.body;
    const requestId = newRequestId();
    
    if (!prompt) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing prompt',
            requestId
        });
    }
    
    // Map legacy target names
    const platformMap = {
        'gemini': 'aistudio',
        'aistudio': 'aistudio',
        'chatgpt': 'chatgpt',
        'gpt': 'chatgpt'
    };
    
    const platform = platformMap[target.toLowerCase()] || 'aistudio';
    console.log(`\n⚪ [CHAT] Request (target: ${target} -> ${platform})`);
    
    try {
        const reply = await controller.send(platform, prompt, images);
        res.json({ 
            success: true, 
            status: 'success',  // Legacy compat
            reply,
            platform,
            requestId
        });
    } catch (err) {
        console.error(`❌ [CHAT] Error: ${err.message}`);
        res.status(500).json({ 
            success: false, 
            status: 'error',
            error: err.message,
            message: err.message,  // Legacy compat
            requestId
        });
    }
});

// ---------- CONNECTION TEST ENDPOINTS ----------
app.get('/test/aistudio', async (req, res) => {
    try {
        await controller.ensureConnection('aistudio');
        res.json({ 
            success: true, 
            message: 'AI Studio connection OK',
            platform: 'aistudio'
        });
    } catch (err) {
        res.status(500).json({ 
            success: false, 
            error: err.message,
            platform: 'aistudio'
        });
    }
});

app.get('/test/chatgpt', async (req, res) => {
    try {
        await controller.ensureConnection('chatgpt');
        res.json({ 
            success: true, 
            message: 'ChatGPT connection OK',
            platform: 'chatgpt'
        });
    } catch (err) {
        res.status(500).json({ 
            success: false, 
            error: err.message,
            platform: 'chatgpt'
        });
    }
});

// ========== ERROR HANDLERS ==========
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err.message);
    console.error(err.stack);
    // Don't exit - keep running
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection:', reason);
    // Don't exit - keep running
});

// ========== START SERVER ==========
const server = app.listen(PORT, HOST, () => {
    console.log('═'.repeat(60));
    console.log('🤖 LOTL CONTROLLER v3 - SOLIDIFIED');
    console.log('═'.repeat(60));
    console.log(`🌐 Listening on http://${HOST}:${PORT}`);
    console.log('');
    console.log('📋 ENDPOINTS:');
    console.log('   POST /aistudio    - AI Studio (Gemini) - DEDICATED');
    console.log('   POST /chatgpt     - ChatGPT - DEDICATED');
    console.log('   POST /chat        - Legacy unified (use target param)');
    console.log('   GET  /health      - Health check');
    console.log('   GET  /ready       - Dependency readiness probe');
    console.log('   GET  /test/aistudio - Test AI Studio connection');
    console.log('   GET  /test/chatgpt  - Test ChatGPT connection');
    console.log('');
    console.log('⚠️  PREREQUISITES:');
    console.log(`   1. Chrome running with --remote-debugging-port=${CHROME_DEBUG_PORT}`);
    console.log('   2. AI Studio tab open: https://aistudio.google.com');
    console.log('   3. ChatGPT tab open: https://chatgpt.com (optional)');
    console.log('');
    console.log(`ℹ️  Default bind is local-only (HOST=${HOST}). Set HOST=0.0.0.0 for LAN.`);
    console.log('═'.repeat(60));
});

server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} is already in use. Stop the other process or set PORT to a free port.`);
        process.exit(1);
    }
    console.error('❌ Server error:', err);
    process.exit(1);
});
