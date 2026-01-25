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
const { spawnSync } = require('child_process');
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
// Default to 0.0.0.0 to allow remote API access (agents on other machines).
// Set HOST=127.0.0.1 to restrict to local-only if needed.
const HOST = process.env.HOST || '0.0.0.0';
const CHROME_DEBUG_PORT = Number(process.env.CHROME_PORT || 9222);
const READY_TIMEOUT_MS = Number(process.env.READY_TIMEOUT_MS || 5000);
const CONNECT_TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS || 8000);
const PUPPETEER_PROTOCOL_TIMEOUT_MS = Number(process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS || 120000);
// NOTE: The request path can take > 180s (generation + streaming + fallbacks).
// Defaults are set conservatively to avoid "Lock timeout" errors under slow UI/network conditions.
const LOCK_TIMEOUT_MS_TEXT = Number(process.env.LOCK_TIMEOUT_MS_TEXT || 420000);
const LOCK_TIMEOUT_MS_IMAGES = Number(process.env.LOCK_TIMEOUT_MS_IMAGES || 900000);

// Optional pacing to avoid rapid, machine-like sequences (opt-in).
const ACTION_DELAY_MS = Number(process.env.ACTION_DELAY_MS || 0);
const ACTION_DELAY_JITTER_MS = Number(process.env.ACTION_DELAY_JITTER_MS || 0);

// Controller operation mode:
// - normal: reuse one existing tab per platform (legacy default)
// - api: like normal, but aims to behave like an API by starting a new chat each request
//        using native keyboard shortcuts (where available)
// - single: each request uses a fresh tab (open -> run -> close)
// - multi: sessionId-aware tabs (concurrent sessions)
const LOTL_MODE = String(process.env.LOTL_MODE || 'api').toLowerCase();
const MULTI_MAX_SESSIONS = Number(process.env.MULTI_MAX_SESSIONS || 8);

// Single-mode safety: hard-cap ephemeral tabs so a crash/timeout doesn't accumulate hundreds of tabs.
// Defaults are conservative; tune via env if desired.
const SINGLE_MAX_EPHEMERAL_PER_PLATFORM = Number(process.env.SINGLE_MAX_EPHEMERAL_PER_PLATFORM || 1);
const SINGLE_MAX_EPHEMERAL_TOTAL = Number(process.env.SINGLE_MAX_EPHEMERAL_TOTAL || 4);

const VALID_MODES = new Set(['normal', 'api', 'single', 'multi']);
if (!VALID_MODES.has(LOTL_MODE)) {
    console.error(`❌ Invalid LOTL_MODE="${LOTL_MODE}". Expected one of: normal | api | single | multi`);
    process.exit(1);
}

function nowIso() {
    return new Date().toISOString();
}

function newRequestId() {
    return `req_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function _primaryModifierKey() {
    return process.platform === 'darwin' ? 'Meta' : 'Control';
}

async function _pressWithPrimary(page, primaryKey, { shift, key }) {
    try {
        await page.bringToFront().catch(() => undefined);
        await page.keyboard.down(primaryKey);
        if (shift) await page.keyboard.down('Shift');
        await page.keyboard.press(key);
        return true;
    } catch {
        return false;
    } finally {
        if (shift) await page.keyboard.up('Shift').catch(() => undefined);
        await page.keyboard.up(primaryKey).catch(() => undefined);
    }
}

async function pressComboRdpSafe(page, combo) {
    // In RDP scenarios (macOS client -> Windows host), the user's Cmd key may map unexpectedly.
    // To be resilient, try both Control and Meta as the "primary" modifier.
    if (!combo || !combo.primary) {
        return await pressCombo(page, combo);
    }
    const attempts = ['Control', 'Meta'];
    for (const primaryKey of attempts) {
        const ok = await _pressWithPrimary(page, primaryKey, { shift: Boolean(combo.shift), key: combo.key });
        if (ok) return true;
        await sleep(40);
    }
    return false;
}

async function pressCombo(page, combo) {
    // combo example: { primary: true, shift: true, key: 'KeyO' }
    const primary = _primaryModifierKey();
    try {
        await page.bringToFront().catch(() => undefined);
        if (combo.primary) await page.keyboard.down(primary);
        if (combo.shift) await page.keyboard.down('Shift');
        await page.keyboard.press(combo.key);
    } finally {
        if (combo.shift) await page.keyboard.up('Shift').catch(() => undefined);
        if (combo.primary) await page.keyboard.up(primary).catch(() => undefined);
    }
}

function getClipboardText() {
    try {
        if (process.platform === 'win32') {
            const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' });
            return (r.stdout || '').toString();
        }
        if (process.platform === 'darwin') {
            const r = spawnSync('pbpaste', [], { encoding: 'utf8' });
            return (r.stdout || '').toString();
        }
    } catch {
        // ignore
    }
    return '';
}

function setClipboardText(text) {
    const s = String(text ?? '');
    try {
        if (process.platform === 'win32') {
            spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Set-Clipboard -Value ([Console]::In.ReadToEnd())'], {
                input: s,
                encoding: 'utf8'
            });
            return;
        }
        if (process.platform === 'darwin') {
            spawnSync('pbcopy', [], { input: s, encoding: 'utf8' });
            return;
        }
    } catch {
        // ignore
    }
}

async function setClipboardTextVerified(text, opts = {}) {
    const retries = Number.isFinite(opts.retries) ? opts.retries : 4;
    const delayMs = Number.isFinite(opts.delayMs) ? opts.delayMs : 60;
    const want = String(text ?? '');
    for (let i = 0; i < retries; i++) {
        setClipboardText(want);
        await sleep(delayMs);
        const got = getClipboardText();
        if (String(got ?? '') === want) return true;
    }
    return false;
}

async function withClipboardRestored(fn) {
    const prior = getClipboardText();
    try {
        return await fn();
    } finally {
        // Best-effort restore so we don't trash the user's clipboard.
        setClipboardText(prior);
    }
}

async function humanPause() {
    const base = Number.isFinite(ACTION_DELAY_MS) ? ACTION_DELAY_MS : 0;
    const jitter = Number.isFinite(ACTION_DELAY_JITTER_MS) ? ACTION_DELAY_JITTER_MS : 0;
    if (base <= 0 && jitter <= 0) return;
    const extra = jitter > 0 ? Math.floor(Math.random() * jitter) : 0;
    const delay = Math.max(0, base + extra);
    if (delay > 0) await sleep(delay);
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
        // Use a direct chat URL; the homepage often doesn't render a prompt box.
        launchUrl: 'https://aistudio.google.com/app/prompts/new_chat',
        clickNewChat: async (page) => {
            // AI Studio: navigating directly to the new_chat route is the most reliable "new chat" action.
            try {
                await page.goto('https://aistudio.google.com/app/prompts/new_chat', { waitUntil: 'domcontentloaded' });
                return true;
            } catch {
                return false;
            }
        },
        selectors: {
            input: 'footer textarea, textarea, div[contenteditable="true"]',
            runButton: 'button[aria-label*="Run"], button[aria-label*="Send"], button[aria-label*="Submit"]',
            stopButton: 'button[aria-label*="Stop"]',
            turn: 'ms-chat-turn',
            bubble: 'ms-chat-bubble',
            spinner: 'mat-progress-spinner, [class*="loading"], [class*="spinner"]'
        },
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
        clickRun: async (page) => {
            // Prefer Ctrl+Enter (AI Studio shortcut)
            try {
                const primary = process.platform === 'darwin' ? 'Meta' : 'Control';
                await page.keyboard.down(primary);
                await page.keyboard.press('Enter');
                await page.keyboard.up(primary);
                return true;
            } catch {
                // ignore
            }

            return await page.evaluate(() => {
                const selectors = [
                    'button[aria-label*="Run"]',
                    'button[aria-label*="Send"]',
                    'button[aria-label*="Submit"]'
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
                const turns = document.querySelectorAll('ms-chat-turn');
                if (turns.length === 0) return null;

                const clean = (s) => String(s || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();

                // Prefer most recent turn text.
                for (let i = turns.length - 1; i >= 0; i--) {
                    const t = clean(turns[i].innerText || turns[i].textContent || '');
                    if (t && t.length > 0) return t;
                }
                return null;
            });
        },
        getTurnCount: async (page) => {
            return await page.evaluate(() => document.querySelectorAll('ms-chat-turn').length);
        },
        isGenerating: async (page) => {
            return await page.evaluate(() => {
                const runBtn = document.querySelector('button[aria-label*="Run"]');
                if (runBtn && runBtn.offsetParent !== null && !runBtn.disabled) return false;
                const stopBtn = document.querySelector('button[aria-label*="Stop"]');
                if (stopBtn && stopBtn.offsetParent !== null) return true;
                const spinners = document.querySelectorAll('mat-progress-spinner, [class*="loading"], [class*="spinner"]');
                for (const s of spinners) {
                    if (s.offsetParent !== null) return true;
                }
                return false;
            });
        }
    },

    chatgpt: {
        name: 'ChatGPT',
        urlPattern: 'chatgpt.com',
        launchUrl: 'https://chatgpt.com',
        clickNewChat: async (page) => {
            try {
                await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded' });
                return true;
            } catch {
                return false;
            }
        },
        selectors: {
            input: '#prompt-textarea, textarea[data-id="root"], div[contenteditable="true"][data-placeholder]',
            sendButton: 'button[data-testid="send-button"], button[aria-label*="Send"]',
            stopButton: 'button[data-testid="stop-button"], button[aria-label*="Stop"]',
            turn: '[data-message-author-role="assistant"]',
            spinner: '[class*="streaming"], [class*="loading"]'
        },
        setInput: async (page, text) => {
            return await page.evaluate((txt) => {
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
                    }
                    if (el.contentEditable === 'true') {
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
                const els = document.querySelectorAll('[data-message-author-role="assistant"]');
                if (!els || els.length === 0) return null;
                const last = els[els.length - 1];
                return (last.innerText || last.textContent || '').trim();
            });
        },
        getTurnCount: async (page) => {
            return await page.evaluate(() => document.querySelectorAll('[data-message-author-role="assistant"]').length);
        },
        isGenerating: async (page) => {
            return await page.evaluate(() => {
                const stopBtn = document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]');
                if (stopBtn && stopBtn.offsetParent !== null) return true;
                const streaming = document.querySelector('[class*="streaming"]');
                return Boolean(streaming);
            });
        }
    },

    gemini: {
        name: 'Gemini',
        urlPattern: 'gemini.google.com',
        launchUrl: 'https://gemini.google.com/app',
        shortcutOnly: true,
        clickNewChat: async (page) => {
            try {
                if (!String(page.url() || '').includes('gemini.google.com/app')) {
                    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded' });
                }
            } catch {
                // ignore
            }

            try {
                // Native Gemini new chat: Ctrl/Cmd + Shift + O (or 0)
                for (const key of ['KeyO', 'Digit0']) {
                    await pressComboRdpSafe(page, { primary: true, shift: true, key });
                    await sleep(150);
                }
                return true;
            } catch {
                return false;
            }
        },
        setInput: async (page, text) => {
            // After new chat, the input box moves to CENTER of page (different element).
            // Click/focus the actual visible input box instead of relying on Shift+Esc.
            return await withClipboardRestored(async () => {
                const promptText = String(text || '');
                const clipboardOk = await setClipboardTextVerified(promptText, { retries: 5, delayMs: 80 });

                // Click/focus the visible input box (wherever it is - bottom or center)
                const focused = await page.evaluate(() => {
                    const isVisible = (el) => {
                        if (!el) return false;
                        const style = window.getComputedStyle(el);
                        if (!style) return false;
                        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                        const r = el.getBoundingClientRect();
                        return r && r.width > 10 && r.height > 10;
                    };

                    // Gemini uses rich-textarea with Quill editor or contenteditable
                    const selectors = [
                        'rich-textarea .ql-editor',
                        'div.ql-editor[contenteditable="true"]',
                        'div[contenteditable="true"][aria-label*="prompt" i]',
                        'div[contenteditable="true"][aria-label*="Enter" i]',
                        'div[contenteditable="true"]',
                        'textarea'
                    ];

                    for (const sel of selectors) {
                        const candidates = Array.from(document.querySelectorAll(sel)).filter(isVisible);
                        if (candidates.length === 0) continue;
                        // Pick largest visible one
                        candidates.sort((a, b) => {
                            const ra = a.getBoundingClientRect();
                            const rb = b.getBoundingClientRect();
                            return (rb.width * rb.height) - (ra.width * ra.height);
                        });
                        const el = candidates[0];
                        el.focus();
                        el.click();
                        return true;
                    }
                    return false;
                });

                if (!focused) {
                    // Fallback: try Shift+Esc
                    try {
                        await pressCombo(page, { primary: false, shift: true, key: 'Escape' });
                        await sleep(80);
                    } catch {
                        // ignore
                    }
                }

                await sleep(100);

                // Always use paste - never type (bot detection, large prompts).
                // Retry paste multiple times if clipboard didn't verify on first try.
                for (let attempt = 0; attempt < 3; attempt++) {
                    if (!clipboardOk) {
                        // Retry setting clipboard
                        await setClipboardTextVerified(promptText, { retries: 5, delayMs: 100 });
                    }
                    // Paste: try Ctrl+V and Cmd+V to handle RDP remapping.
                    await pressComboRdpSafe(page, { primary: true, shift: false, key: 'KeyV' });
                    await sleep(200);
                    
                    // Verify paste worked by checking input content
                    const hasContent = await page.evaluate(() => {
                        const selectors = [
                            'rich-textarea .ql-editor',
                            'div.ql-editor[contenteditable="true"]',
                            'div[contenteditable="true"]',
                            'textarea'
                        ];
                        for (const sel of selectors) {
                            const el = document.querySelector(sel);
                            if (el) {
                                const text = (el.innerText || el.value || '').trim();
                                if (text.length > 5) return true;
                            }
                        }
                        return false;
                    });
                    
                    if (hasContent) return true;
                    await sleep(150);
                }
                
                // If paste still failed, throw error rather than typing (bot detection risk)
                throw new Error('Clipboard paste failed after retries - check RDP clipboard settings');
            });
        },
        clickRun: async (page) => {
            // Gemini Web UI: Enter usually sends.
            try {
                await page.keyboard.press('Enter');
                return true;
            } catch {
                return false;
            }
        },
        extractResponse: async (page) => {
            // DOM-based extraction (clipboard shortcuts unreliable under RDP)
            return await page.evaluate(() => {
                // Gemini model responses - try multiple selectors
                const selectors = [
                    '.model-response-text',
                    '.response-container message-content',
                    '[data-message-author-role="model"]',
                    '.markdown-main-panel',
                    '.response-content',
                    '[class*="model-response"]'
                ];

                let messages = [];
                for (const sel of selectors) {
                    const els = document.querySelectorAll(sel);
                    if (els.length > 0) {
                        messages = Array.from(els);
                        break;
                    }
                }

                if (messages.length === 0) {
                    // Broader fallback: look for any message-like containers
                    const fallback = document.querySelectorAll('[class*="response"], [class*="message"]');
                    if (fallback.length > 0) {
                        messages = Array.from(fallback).filter(el => {
                            const text = (el.innerText || '').trim();
                            return text.length > 5;
                        });
                    }
                }

                if (messages.length === 0) return null;

                const lastMsg = messages[messages.length - 1];
                const text = (lastMsg.innerText || lastMsg.textContent || '').trim();
                return text || null;
            });
        },
        getTurnCount: async (page) => {
            return await page.evaluate(() => {
                const selectors = ['.model-response-text', '[data-message-author-role="model"]', '[class*="model-response"]'];
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
                const stopBtn = document.querySelector('button[aria-label*="Stop" i]');
                if (stopBtn && stopBtn.offsetParent !== null) return true;
                // Check for loading/progress indicators
                const loading = document.querySelector('[class*="loading"], [class*="progress"], mat-progress-spinner, [class*="streaming"]');
                if (loading && loading.offsetParent !== null) return true;
                return false;
            });
        }
    }
};

// ========== CONTROLLER CLASS ==========
class LotlController {
    constructor(opts = {}) {
        this.mode = String(opts.mode || LOTL_MODE).toLowerCase();
        this.browser = null;
        // `${platform}:${sessionId}` -> { page, createdAt, lastUsedAt }
        this._pageCache = new Map();
        // lockKey -> Promise chain
        this._locks = new Map();
        // In single mode, we should never accumulate tabs even if a prior request died mid-flight.
        // Track *all* ephemeral tabs we've created so we can sweep leaks.
        this._singleEphemeralPagesByPlatform = new Map(); // platform -> Set<Page>
        this._singleEphemeralMeta = new WeakMap(); // Page -> { platform, createdAt }
        this._connectLock = Promise.resolve();
    }

    _getSingleEphemeralSet(platform) {
        const key = String(platform || '').toLowerCase();
        let set = this._singleEphemeralPagesByPlatform.get(key);
        if (!set) {
            set = new Set();
            this._singleEphemeralPagesByPlatform.set(key, set);
        }
        return set;
    }

    _trackSingleEphemeral(platform, page) {
        if (!page) return;
        const set = this._getSingleEphemeralSet(platform);
        set.add(page);
        if (!this._singleEphemeralMeta.has(page)) {
            this._singleEphemeralMeta.set(page, { platform: String(platform || ''), createdAt: Date.now() });
        }
        // Auto-untrack when it closes.
        try {
            page.once('close', () => {
                try {
                    const s = this._getSingleEphemeralSet(platform);
                    s.delete(page);
                } catch {
                    // ignore
                }
            });
        } catch {
            // ignore
        }
    }

    async _closePageQuiet(page) {
        if (!page) return;
        await page.close({ runBeforeUnload: false }).catch(() => undefined);
    }

    async _cleanupSingleEphemeral(platform, keepPage = null) {
        if (this.mode !== 'single') return;

        const set = this._getSingleEphemeralSet(platform);
        const victims = Array.from(set).filter(p => p && p !== keepPage);

        // Close all tracked ephemerals for this platform except the current one.
        for (const p of victims) {
            // Only close if still healthy; otherwise just drop it from tracking.
            if (await this._ensurePageHealthy(p)) {
                await this._closePageQuiet(p);
            }
            set.delete(p);
        }

        // Enforce per-platform cap (defaults to 1)
        while (set.size > Math.max(1, SINGLE_MAX_EPHEMERAL_PER_PLATFORM)) {
            const arr = Array.from(set);
            const oldest = arr
                .map(p => ({ p, t: (this._singleEphemeralMeta.get(p) || {}).createdAt || 0 }))
                .sort((a, b) => a.t - b.t)[0];
            if (!oldest || !oldest.p) break;
            await this._closePageQuiet(oldest.p);
            set.delete(oldest.p);
        }

        // Enforce global cap across platforms
        const all = [];
        for (const s of this._singleEphemeralPagesByPlatform.values()) {
            for (const p of s.values()) {
                all.push({ p, t: (this._singleEphemeralMeta.get(p) || {}).createdAt || 0 });
            }
        }
        const maxTotal = Math.max(1, SINGLE_MAX_EPHEMERAL_TOTAL);
        if (all.length > maxTotal) {
            all.sort((a, b) => a.t - b.t);
            const over = all.length - maxTotal;
            for (let i = 0; i < over; i++) {
                const victim = all[i] && all[i].p;
                if (victim && victim !== keepPage) {
                    await this._closePageQuiet(victim);
                    try {
                        const meta = this._singleEphemeralMeta.get(victim);
                        const plat = meta && meta.platform ? String(meta.platform).toLowerCase() : null;
                        if (plat) this._getSingleEphemeralSet(plat).delete(victim);
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }

    _isRetryableUiOrCdpError(err) {
        const msg = String((err && err.message) ? err.message : err || '').toLowerCase();
        if (!msg) return false;

        const patterns = [
            'target closed',
            'session closed',
            'connection closed',
            'protocol error',
            'execution context was destroyed',
            'most likely the page has been closed',
            'detached',
            'browser has disconnected',
            'disconnected',
            'net::err',
        ];

        return patterns.some(p => msg.includes(p));
    }

    async _resetPlatformCache(platform, sessionId) {
        const sid = this._normalizeSessionId(sessionId);
        const key = this._cacheKey(platform, sid);
        const cached = this._pageCache.get(key);
        this._pageCache.delete(key);
        if (cached && cached.page) {
            await cached.page.close({ runBeforeUnload: false }).catch(() => undefined);
        }
    }

    async _forceReconnectChrome() {
        // Clear local state and force a reconnect on next ensureConnection().
        if (this.browser) {
            try {
                await this.browser.disconnect();
            } catch {
                // ignore
            }
        }
        this.browser = null;
        this._pageCache.clear();
        this._locks.clear();
        this._singleEphemeralPagesByPlatform.clear();
    }

    async dismissInterruptions(platform, page) {
        if (!page) return { actions: 0 };

        // Quick no-op if page is already dead.
        if (!await this._ensurePageHealthy(page)) return { actions: 0, dead: true };

        let actions = 0;
        try {
            // ESC often closes tooltips/modals; safe across sites.
            await page.keyboard.press('Escape').catch(() => undefined);
        } catch {
            // ignore
        }

        // DOM-based dismissal: close buttons, "not now", backdrop clicks.
        try {
            const r = await page.evaluate((platformName) => {
                const isVisible = (el) => {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    if (!style) return false;
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                    const rect = el.getBoundingClientRect();
                    return rect && rect.width > 5 && rect.height > 5;
                };

                const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
                const click = (el) => {
                    try { el.click(); return true; } catch { return false; }
                };

                let actions = 0;

                // 1) Click common close buttons
                const closeSelectors = [
                    'button[aria-label="Close"]',
                    'button[aria-label*="close" i]',
                    '[role="dialog"] button[aria-label*="close" i]',
                    'button[data-testid*="close" i]',
                    'button[class*="close" i]',
                    'button[title*="close" i]'
                ];
                for (const sel of closeSelectors) {
                    const candidates = Array.from(document.querySelectorAll(sel)).filter(isVisible);
                    for (const c of candidates.slice(0, 3)) {
                        if (click(c)) actions++;
                    }
                }

                // 2) Click "Not now" / "Dismiss" / "Got it" / "OK" / "Close" by text
                const allowText = [
                    'not now',
                    'dismiss',
                    'got it',
                    'ok',
                    'close',
                    'no thanks'
                ];
                const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible);
                for (const b of buttons.slice(0, 80)) {
                    const t = norm(b.innerText || b.textContent || b.getAttribute('aria-label') || '');
                    if (!t) continue;
                    if (allowText.includes(t) || allowText.some(x => t === x)) {
                        if (click(b)) actions++;
                    }
                }

                // 3) Click common backdrops (Angular Material / general)
                const backdrops = [
                    '.cdk-overlay-backdrop',
                    '.cdk-global-overlay-wrapper',
                    '[data-testid="modal-backdrop"]',
                    '[class*="backdrop" i]'
                ];
                for (const sel of backdrops) {
                    const els = Array.from(document.querySelectorAll(sel)).filter(isVisible);
                    for (const e of els.slice(0, 2)) {
                        // Avoid clicking inside dialogs; backdrops are usually behind.
                        if (click(e)) actions++;
                    }
                }

                // 4) Platform-specific nudges
                if (platformName === 'chatgpt') {
                    // Occasionally there's a small "Close" X in top-right areas.
                    const svgClose = Array.from(document.querySelectorAll('button svg')).slice(0, 50)
                        .map(svg => svg.closest('button'))
                        .filter(Boolean)
                        .filter(isVisible);
                    for (const btn of svgClose.slice(0, 2)) {
                        const t = norm(btn.getAttribute('aria-label') || btn.title || btn.textContent || '');
                        if (t.includes('close')) {
                            if (click(btn)) actions++;
                        }
                    }
                }

                return { actions };
            }, platform);

            actions += Number(r && r.actions ? r.actions : 0);
        } catch {
            // ignore
        }

        return { actions };
    }

    _normalizeSessionId(sessionId) {
        const s = String(sessionId || '').trim();
        return s.length > 0 ? s.slice(0, 200) : 'default';
    }

    _cacheKey(platform, sessionId) {
        return `${platform}:${this._normalizeSessionId(sessionId)}`;
    }

    _lockKey(platform, sessionId) {
        if (this.mode === 'multi') return this._cacheKey(platform, sessionId);
        return platform;
    }

    async _ensureBrowserConnected() {
        if (this.browser) return;

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
                this._pageCache.clear();
                this._locks.clear();
                this._singleEphemeralPagesByPlatform.clear();
            });

            console.log('✅ Connected to Chrome');
        });

        await this._connectLock;
    }

    async _ensurePageHealthy(page) {
        if (!page) return false;
        try {
            await page.title();
            return true;
        } catch {
            return false;
        }
    }

    async _waitForUsableInput(platform, page) {
        const adapter = ADAPTERS[platform];
        if (!adapter) return;
        if (adapter.shortcutOnly) return;
        if (!adapter.selectors || !adapter.selectors.input) return;
        await page.waitForSelector(adapter.selectors.input, { timeout: 20000 });
    }

    async _ensureNewChat(platform, page, adapter) {
        if (!adapter || typeof adapter.clickNewChat !== 'function') return;

        // Requirement: in single mode, always start from a clean chat.
        // Also applied on first tab creation in multi mode to avoid inheriting "last chat" state.
        try {
            const ok = await adapter.clickNewChat(page);
            if (ok) {
                await humanPause();
                await this.dismissInterruptions(platform, page).catch(() => undefined);
            }
        } catch {
            // Best-effort; do not fail the request solely because "new chat" wasn't clickable.
        }
    }

    async _createFreshPage(platform) {
        const adapter = ADAPTERS[platform];
        if (!adapter) throw new Error(`Unknown platform: ${platform}`);
        await this._ensureBrowserConnected();

        // Single-mode hygiene: close any leaked ephemerals before opening yet another tab.
        await this._cleanupSingleEphemeral(platform).catch(() => undefined);

        const page = await this.browser.newPage();
        this._trackSingleEphemeral(platform, page);
        const url = adapter.launchUrl || `https://${adapter.urlPattern}`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await this._ensureNewChat(platform, page, adapter);
        await this._waitForUsableInput(platform, page);
        return { page, adapter, ephemeral: true };
    }

    async _connectExistingTab(platform) {
        const adapter = ADAPTERS[platform];
        if (!adapter) throw new Error(`Unknown platform: ${platform}`);

        console.log(`🔌 Connecting to ${adapter.name}...`);

        await this._ensureBrowserConnected();

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

        console.log(`✅ Connected to ${adapter.name}`);
        return { page, adapter, ephemeral: false };
    }

    async ensureConnection(platform, sessionId, opts = {}) {
        const sid = this._normalizeSessionId(sessionId);
        const adapter = ADAPTERS[platform];
        if (!adapter) throw new Error(`Unknown platform: ${platform}`);

        const forceFresh = Boolean(opts.fresh);

        if (this.mode === 'single' || forceFresh) {
            return await this._createFreshPage(platform);
        }

        if (this.mode === 'multi') {
            const key = this._cacheKey(platform, sid);
            const cached = this._pageCache.get(key);
            if (cached && cached.page && await this._ensurePageHealthy(cached.page)) {
                // If the tab drifted off-domain (e.g. logged out redirect / blank tab), recover by reloading.
                try {
                    const u = String(cached.page.url ? cached.page.url() : '');
                    if (!u.includes(adapter.urlPattern)) {
                        const url = adapter.launchUrl || `https://${adapter.urlPattern}`;
                        await cached.page.goto(url, { waitUntil: 'domcontentloaded' });
                        await this._waitForUsableInput(platform, cached.page);
                    }
                } catch {
                    // If recovery fails, fall through to creating a new page.
                    try { await cached.page.close({ runBeforeUnload: false }); } catch {}
                    this._pageCache.delete(key);
                }
                cached.lastUsedAt = Date.now();
                return { page: cached.page, adapter, ephemeral: false };
            }

            await this._ensureBrowserConnected();
            const page = await this.browser.newPage();
            const url = adapter.launchUrl || `https://${adapter.urlPattern}`;
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await this._ensureNewChat(platform, page, adapter);
            await this._waitForUsableInput(platform, page);

            // Enforce a simple per-platform cap.
            const platformKeys = Array.from(this._pageCache.keys()).filter(k => k.startsWith(`${platform}:`));
            if (platformKeys.length >= MULTI_MAX_SESSIONS) {
                let oldestKey = null;
                let oldestAt = Infinity;
                for (const k of platformKeys) {
                    const v = this._pageCache.get(k);
                    const t = (v && v.lastUsedAt) ? v.lastUsedAt : 0;
                    if (t < oldestAt) { oldestAt = t; oldestKey = k; }
                }
                if (oldestKey) {
                    const victim = this._pageCache.get(oldestKey);
                    this._pageCache.delete(oldestKey);
                    if (victim && victim.page) {
                        await victim.page.close({ runBeforeUnload: false }).catch(() => undefined);
                    }
                }
            }

            this._pageCache.set(key, { page, createdAt: Date.now(), lastUsedAt: Date.now() });
            return { page, adapter, ephemeral: false };
        }

        // normal mode
        const key = this._cacheKey(platform, 'default');
        const cached = this._pageCache.get(key);
        if (cached && cached.page && await this._ensurePageHealthy(cached.page)) {
            cached.lastUsedAt = Date.now();
            return { page: cached.page, adapter, ephemeral: false };
        }

        const connected = await this._connectExistingTab(platform);
        this._pageCache.set(key, { page: connected.page, createdAt: Date.now(), lastUsedAt: Date.now() });
        return connected;
    }

    async withLock(lockKey, fn, timeoutMs) {
        const ms = Number(timeoutMs || LOCK_TIMEOUT_MS_TEXT);
        const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Lock timeout (${Math.round(ms / 1000)}s)`)), ms)
        );

        const prior = this._locks.get(lockKey) || Promise.resolve();
        const run = prior.then(fn, fn);
        this._locks.set(lockKey, run.catch(() => undefined));
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
    
    async send(platform, prompt, images, opts = {}) {
        const hasImages = Boolean(images && Array.isArray(images) && images.length > 0);
        const lockTimeoutMs = platform === 'aistudio' && hasImages ? LOCK_TIMEOUT_MS_IMAGES : LOCK_TIMEOUT_MS_TEXT;

        const sessionId = this._normalizeSessionId(opts.sessionId);
        const lockKey = this._lockKey(platform, sessionId);

        return await this.withLock(lockKey, async () => {
            console.log(`\n📩 [${platform.toUpperCase()}] Processing prompt (${prompt.length} chars)...`);

            const runAttempt = async (attempt) => {
                let conn;
                try {
                    if (this.mode === 'single') {
                        await this._cleanupSingleEphemeral(platform).catch(() => undefined);
                    }

                    conn = await this.ensureConnection(platform, sessionId);
                    const { page, adapter } = conn;

                    if (this.mode === 'single' && conn.ephemeral) {
                        this._trackSingleEphemeral(platform, page);
                    }
                    await page.bringToFront();
                    await humanPause();

                    const swept = await this.dismissInterruptions(platform, page);
                    if (swept && swept.actions && swept.actions > 0) {
                        console.log(`🧹 Dismissed interruptions: ${swept.actions}`);
                        await humanPause();
                    }

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
            
                    const expectedExact = platform === 'aistudio' ? parseExpectedExactToken(prompt) : null;

                    // API mode: behave like an API by starting a fresh chat every request.
                    if (this.mode === 'api') {
                        await this._ensureNewChat(platform, page, adapter);
                        await humanPause();
                    }

                    // Upload images if supported by this adapter
                    if (images && Array.isArray(images) && images.length > 0) {
                        if (typeof adapter.uploadImages === 'function') {
                            await adapter.uploadImages(page, images);
                        } else {
                            console.log(`📷 Images provided (${images.length}) but adapter does not support uploads; ignoring`);
                        }
                    }
                    await humanPause();
            
                    // SET INPUT
                    console.log(`⌨️ Setting input...`);
                    const inputSet = await adapter.setInput(page, prompt);
                    if (!inputSet) {
                        // Sometimes an overlay blocks focus; sweep and retry input once.
                        await this.dismissInterruptions(platform, page).catch(() => undefined);
                        await humanPause();
                        const inputSet2 = await adapter.setInput(page, prompt);
                        if (!inputSet2) {
                            throw new Error('Failed to set input - selector not found');
                        }
                    }
                    await sleep(300);
                    await humanPause();
            
                    // CLICK RUN via DOM
                    console.log(`🚀 Clicking run/send...`);
                    const clicked = await adapter.clickRun(page);
                    if (!clicked) {
                        await this.dismissInterruptions(platform, page).catch(() => undefined);
                        await humanPause();
                        const clicked2 = await adapter.clickRun(page);
                        if (!clicked2) {
                            throw new Error('Failed to click run/send button');
                        }
                    }
            
                    // WAIT FOR RESPONSE
                    console.log(`⏳ Waiting for response...`);
                    let response = null;
                    if (adapter && adapter.shortcutOnly) {
                        // Shortcut-only platforms: poll clipboard-based extraction until stable.
                        let lastText = '';
                        let stableCount = 0;
                        const maxSeconds = 180;
                        for (let i = 0; i < maxSeconds; i++) {
                            await sleep(1000);
                            if (i > 0 && i % 10 === 0) {
                                await this.dismissInterruptions(platform, page).catch(() => undefined);
                            }

                            const cur = String(await adapter.extractResponse(page) || '').trim();
                            if (!cur) continue;

                            if (cur === lastText) {
                                stableCount++;
                                if (stableCount >= 3) {
                                    response = cur;
                                    break;
                                }
                            } else {
                                lastText = cur;
                                stableCount = 0;
                            }
                        }
                        if (!response) {
                            // fall back to last seen non-empty text
                            response = lastText || null;
                        }
                    } else {
                        // DOM-based platforms
                        response = await adapter.extractResponse(page);
                    }

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
                } finally {
                    if (conn && conn.ephemeral && conn.page) {
                        await conn.page.close({ runBeforeUnload: false }).catch(() => undefined);
                    }

                    if (this.mode === 'single') {
                        // Best-effort sweep: if the close above failed, ensure we don't keep stacking tabs.
                        await this._cleanupSingleEphemeral(platform).catch(() => undefined);
                    }
                }
            };

            try {
                return await runAttempt(0);
            } catch (err) {
                if (!opts || opts._noRetry) throw err;
                if (!this._isRetryableUiOrCdpError(err)) throw err;

                console.log(`♻️ Recoverable error detected; retrying once: ${err.message || String(err)}`);

                // Reset cached state for this platform/session and force reconnect if necessary.
                await this._resetPlatformCache(platform, sessionId).catch(() => undefined);
                await this._forceReconnectChrome().catch(() => undefined);
                // Small backoff to let Chrome settle.
                await sleep(750);

                return await this.send(platform, prompt, images, { ...opts, _noRetry: true });
            }
        }, lockTimeoutMs);
    }

    async probePlatform(platform) {
        const adapter = ADAPTERS[platform];
        if (!adapter) {
            return { ok: false, reason: `Unknown platform: ${platform}` };
        }

        const attemptProbe = async () => {
            // Check Chrome debug port first
            const version = await fetchJsonWithTimeout(
                `http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version`,
                READY_TIMEOUT_MS
            );

            const forceFresh = this.mode === 'single' || this.mode === 'multi';
            const conn = await this.ensureConnection(platform, '__probe__', { fresh: forceFresh });
            const { page } = conn;
            await page.bringToFront();
            await this.dismissInterruptions(platform, page).catch(() => undefined);

            // Minimal probe + common blocker detection (helps production readiness)
            const probe = await page.evaluate((selInput, urlPattern, platformName, shortcutOnly) => {
                const urlOk = window.location.href.includes(urlPattern);
                const hay = (document.body && document.body.innerText) ? document.body.innerText : '';

                const blockers = [];
                if (platformName === 'aistudio') {
                    if (/Sign in/i.test(hay)) blockers.push('Sign in');
                    if (/Verify it's you/i.test(hay)) blockers.push("Verify it's you");
                    if (/captcha/i.test(hay) || /unusual traffic/i.test(hay)) blockers.push('Captcha/unusual traffic');
                }

                if (shortcutOnly) {
                    return {
                        urlOk,
                        hasInput: true,
                        blockers,
                        activeUrl: window.location.href
                    };
                }

                const isVisible = (el) => {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    if (!style) return false;
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                    const r = el.getBoundingClientRect();
                    return r && r.width > 10 && r.height > 10;
                };

                const nodes = Array.from(document.querySelectorAll(selInput || '')); 
                const input = nodes.find(isVisible) || null;

                return {
                    urlOk,
                    hasInput: Boolean(input),
                    blockers,
                    activeUrl: window.location.href
                };
            }, adapter.selectors ? adapter.selectors.input : '', adapter.urlPattern, platform, Boolean(adapter.shortcutOnly));

            const result = {
                ok: Boolean(probe.urlOk && probe.hasInput && (!probe.blockers || probe.blockers.length === 0)),
                chrome: { webSocketDebuggerUrl: version.webSocketDebuggerUrl ? 'present' : 'missing' },
                page: probe,
            };

            if (conn && conn.ephemeral && conn.page) {
                await conn.page.close({ runBeforeUnload: false }).catch(() => undefined);
            }

            return result;
        };

        try {
            return await attemptProbe();
        } catch (err) {
            if (!this._isRetryableUiOrCdpError(err)) {
                throw err;
            }
            console.log(`♻️ Ready probe recoverable error; retrying once: ${err.message || String(err)}`);
            await this._forceReconnectChrome().catch(() => undefined);
            await sleep(500);
            return await attemptProbe();
        }
    }
}

// ========== EXPRESS SERVER ==========
const app = express();
app.use(bodyParser.json({ limit: '50mb' }));

const controller = new LotlController();

// ---------- API DOCUMENTATION ----------
app.get('/docs', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json({
        name: 'LotL Controller API',
        version: 'v3-solidified',
        description: 'REST API for sending prompts to AI platforms via browser automation. Requests are serialized per platform - only one prompt processes at a time, ensuring clean isolation.',
        baseUrl: `http://<host>:${PORT}`,
        mode: controller.mode,
        
        endpoints: {
            '/gemini': {
                method: 'POST',
                description: 'Send prompt to Gemini Web (gemini.google.com)',
                contentType: 'application/json',
                body: {
                    prompt: { type: 'string', required: true, description: 'The prompt text to send' },
                    sessionId: { type: 'string', required: false, description: 'Session ID (only used in multi mode)' }
                },
                response: {
                    success: { type: 'boolean', description: 'Whether the request succeeded' },
                    reply: { type: 'string', description: 'The model response text' },
                    platform: { type: 'string', value: 'gemini' },
                    requestId: { type: 'string', description: 'Unique request identifier' },
                    timestamp: { type: 'string', description: 'ISO timestamp' }
                },
                example: {
                    request: { prompt: 'Explain quantum computing in simple terms' },
                    curl: `curl -X POST http://<host>:${PORT}/gemini -H "Content-Type: application/json" -d '{"prompt":"Hello"}'`
                }
            },
            '/aistudio': {
                method: 'POST',
                description: 'Send prompt to AI Studio (aistudio.google.com). Supports images.',
                contentType: 'application/json',
                body: {
                    prompt: { type: 'string', required: true, description: 'The prompt text' },
                    images: { type: 'array', required: false, description: 'Array of base64-encoded images' },
                    sessionId: { type: 'string', required: false, description: 'Session ID (only used in multi mode)' }
                },
                response: {
                    success: { type: 'boolean' },
                    reply: { type: 'string' },
                    platform: { type: 'string', value: 'aistudio' },
                    requestId: { type: 'string' },
                    warnings: { type: 'array' },
                    timestamp: { type: 'string' }
                },
                example: {
                    curl: `curl -X POST http://<host>:${PORT}/aistudio -H "Content-Type: application/json" -d '{"prompt":"Hello"}'`
                }
            },
            '/chatgpt': {
                method: 'POST',
                description: 'Send prompt to ChatGPT (chatgpt.com)',
                contentType: 'application/json',
                body: {
                    prompt: { type: 'string', required: true },
                    sessionId: { type: 'string', required: false }
                },
                response: {
                    success: { type: 'boolean' },
                    reply: { type: 'string' },
                    platform: { type: 'string', value: 'chatgpt' },
                    requestId: { type: 'string' },
                    timestamp: { type: 'string' }
                },
                example: {
                    curl: `curl -X POST http://<host>:${PORT}/chatgpt -H "Content-Type: application/json" -d '{"prompt":"Hello"}'`
                }
            },
            '/chat': {
                method: 'POST',
                description: 'Legacy unified endpoint. Use target param to select platform.',
                body: {
                    prompt: { type: 'string', required: true },
                    target: { type: 'string', required: false, default: 'gemini', enum: ['aistudio', 'chatgpt', 'gemini'] },
                    images: { type: 'array', required: false },
                    sessionId: { type: 'string', required: false }
                }
            },
            '/health': {
                method: 'GET',
                description: 'Basic health check'
            },
            '/ready': {
                method: 'GET',
                description: 'Deep readiness check (verifies browser connection)'
            },
            '/docs': {
                method: 'GET',
                description: 'This documentation'
            }
        },
        
        behavior: {
            serialization: 'Requests are queued per platform. Only one prompt processes at a time. Concurrent requests wait in FIFO order.',
            newChat: 'In api mode (default), each request starts a fresh chat via Ctrl+Shift+O before sending the prompt.',
            clipboard: 'Prompts are pasted via clipboard (never typed) to avoid bot detection and support large prompts.',
            timeout: `Lock timeout is ${Math.round(LOCK_TIMEOUT_MS_TEXT/1000)}s for text, ${Math.round(LOCK_TIMEOUT_MS_IMAGES/1000)}s for images.`
        },
        
        modes: {
            api: 'Default. Reuses one tab per platform, starts new chat each request. Best for stateless API usage.',
            normal: 'Reuses one tab, does NOT start new chat. Continues conversation.',
            single: 'Opens fresh tab for each request, closes after. Clean but slower.',
            multi: 'Session-aware. Different sessionIds get separate tabs (up to MULTI_MAX_SESSIONS).'
        },
        
        errors: {
            400: 'Bad request (missing prompt)',
            500: 'Server error (browser issue, timeout, etc.)',
            503: 'Service unavailable (readiness check failed)'
        },
        
        remoteAccess: {
            note: 'By default, the API binds to 0.0.0.0 (all interfaces).',
            firewall: 'Open port with: netsh advfirewall firewall add rule name="LotL API" dir=in action=allow protocol=TCP localport=' + PORT,
            restrictLocal: 'Set HOST=127.0.0.1 to restrict to localhost only.'
        }
    });
});

// ---------- HEALTH CHECK ----------
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        version: 'v3-solidified',
        mode: controller.mode,
        multiMaxSessions: MULTI_MAX_SESSIONS,
        endpoints: ['/aistudio', '/chatgpt', '/gemini', '/chat', '/docs'],
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
    const { prompt, images, sessionId } = req.body;
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
        const reply = await controller.send('aistudio', prompt, images, { sessionId });
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
    const { prompt, images, sessionId } = req.body;
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
        const reply = await controller.send('chatgpt', prompt, undefined, { sessionId });
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

// ---------- GEMINI ENDPOINT ----------
app.post('/gemini', async (req, res) => {
    const { prompt, sessionId } = req.body;
    const requestId = newRequestId();

    if (!prompt) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing prompt',
            endpoint: '/gemini',
            requestId
        });
    }

    console.log(`\n🟣 [GEMINI] Request: "${prompt.substring(0, 60)}..."`);

    try {
        const reply = await controller.send('gemini', prompt, undefined, { sessionId });
        res.json({ 
            success: true, 
            reply,
            platform: 'gemini',
            requestId,
            timestamp: nowIso()
        });
    } catch (err) {
        console.error(`❌ [GEMINI] Error: ${err.message}`);
        res.status(500).json({ 
            success: false, 
            error: err.message,
            platform: 'gemini',
            requestId
        });
    }
});

// ---------- LEGACY UNIFIED ENDPOINT ----------
app.post('/chat', async (req, res) => {
    const { prompt, target = 'gemini', images, sessionId } = req.body;
    const requestId = newRequestId();
    
    if (!prompt) {
        return res.status(400).json({ 
            success: false, 
            error: 'Missing prompt',
            requestId
        });
    }
    
    // Map legacy target names
    // NOTE:
    // - "gemini" now means Gemini Web (gemini.google.com) to match the dedicated /gemini endpoint.
    // - Use "aistudio" or "gemini-studio" / "gemini-api" for AI Studio.
    const platformMap = {
        'gemini': 'gemini',
        'gemini-web': 'gemini',
        'gemini-studio': 'aistudio',
        'gemini-api': 'aistudio',
        'aistudio': 'aistudio',
        'chatgpt': 'chatgpt',
        'gpt': 'chatgpt'
    };
    
    const platform = platformMap[target.toLowerCase()] || 'gemini';
    console.log(`\n⚪ [CHAT] Request (target: ${target} -> ${platform})`);
    
    try {
        const reply = await controller.send(platform, prompt, images, { sessionId });
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
        const forceFresh = controller.mode === 'single' || controller.mode === 'multi';
        const conn = await controller.ensureConnection('aistudio', '__test__', { fresh: forceFresh });
        if (conn && conn.ephemeral && conn.page) {
            await conn.page.close({ runBeforeUnload: false }).catch(() => undefined);
        }
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
        const forceFresh = controller.mode === 'single' || controller.mode === 'multi';
        const conn = await controller.ensureConnection('chatgpt', '__test__', { fresh: forceFresh });
        if (conn && conn.ephemeral && conn.page) {
            await conn.page.close({ runBeforeUnload: false }).catch(() => undefined);
        }
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

app.get('/test/gemini', async (req, res) => {
    try {
        const forceFresh = controller.mode === 'single' || controller.mode === 'multi';
        const conn = await controller.ensureConnection('gemini', '__test__', { fresh: forceFresh });
        if (conn && conn.ephemeral && conn.page) {
            await conn.page.close({ runBeforeUnload: false }).catch(() => undefined);
        }
        res.json({ 
            success: true, 
            message: 'Gemini connection OK',
            platform: 'gemini'
        });
    } catch (err) {
        res.status(500).json({ 
            success: false, 
            error: err.message,
            platform: 'gemini'
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
    console.log(`⚙️  Mode: ${controller.mode}`);
    console.log('');
    console.log('📋 ENDPOINTS:');
    console.log('   POST /aistudio    - AI Studio (Gemini API)');
    console.log('   POST /gemini      - Gemini Web (gemini.google.com)');
    console.log('   POST /chatgpt     - ChatGPT');
    console.log('   POST /chat        - Legacy unified (use target param)');
    console.log('   GET  /health      - Health check');
    console.log('   GET  /ready       - Dependency readiness probe');
    console.log('   GET  /docs        - API documentation (for remote clients)');
    console.log('');
    console.log('🔒 SERIALIZATION: One prompt at a time per platform (queued)');
    console.log('📋 CLIPBOARD: Prompts pasted, never typed (bot-safe, large prompts OK)');
    console.log('');
    console.log('⚠️  PREREQUISITES:');
    console.log(`   1. Chrome running with --remote-debugging-port=${CHROME_DEBUG_PORT}`);
    console.log('   2. At least one AI tab open (AI Studio, Gemini, or ChatGPT)');
    console.log('');
    if (HOST === '0.0.0.0') {
        console.log('🌍 REMOTE ACCESS ENABLED (bound to 0.0.0.0)');
        console.log(`   Remote agents: curl -X POST http://<this-ip>:${PORT}/gemini -H "Content-Type: application/json" -d '{"prompt":"..."}'`);
        console.log('   Firewall: netsh advfirewall firewall add rule name="LotL" dir=in action=allow protocol=TCP localport=' + PORT);
    } else {
        console.log(`ℹ️  Local-only (HOST=${HOST}). Set HOST=0.0.0.0 for remote access.`);
    }
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
