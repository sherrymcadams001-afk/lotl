/**
 * 🤖 LOTL CONTROLLER v2 - Clean Version
 * Connects to Chrome (Port 9222) and drives AI Studio
 */

const puppeteer = require('puppeteer-core');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const os = require('os');
const path = require('path');

class LotlController {
    constructor(port = 9222) {
        this.port = port;
        this.browser = null;
        this.page = null;
        this._queue = Promise.resolve();
    }

    async connect() {
        try {
            const res = await fetch(`http://127.0.0.1:${this.port}/json/version`);
            const data = await res.json();
            
            this.browser = await puppeteer.connect({
                browserWSEndpoint: data.webSocketDebuggerUrl,
                defaultViewport: null
            });
            
            const pages = await this.browser.pages();
            this.page = pages.find(p => p.url().includes('aistudio.google.com'));
            
            if (!this.page) throw new Error('AI Studio tab not found. Open aistudio.google.com in Chrome first.');
            
            console.log('✅ Connected to AI Studio');
            return true;
        } catch (e) {
            console.error('❌ Connection failed:', e.message);
            throw e;
        }
    }

    async ensureConnected() {
        if (this.browser && this.page) {
            try {
                await this.page.title();
                return;
            } catch {
                // Fall through to reconnect
            }
        }
        await this.connect();
    }

    async _withLock(fn) {
        const run = this._queue.then(fn, fn);
        this._queue = run.catch(() => undefined);
        return run;
    }

    async send(prompt, images = []) {
        return await this._withLock(async () => {
            await this.ensureConnected();
            await this.page.bringToFront();

            // Upload images first if provided
            if (images && images.length > 0) {
                await this.uploadImages(images);
            }

            // Scroll to bottom
            await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

            // Count turns before
            const turnsBefore = await this.page.evaluate(() => {
                return document.querySelectorAll('ms-chat-turn').length;
            });
            console.log(`📊 Turns before: ${turnsBefore}`);

            // Find and focus input
            const inputSel = 'footer textarea';
            await this.page.waitForSelector(inputSel, { timeout: 5000 });
            await this.page.click(inputSel, { clickCount: 3 });
            await new Promise(r => setTimeout(r, 100));

            // PASTE the prompt (fast + handles large/base64)
            console.log(`📋 Pasting prompt (${prompt.length} chars)...`);
            await this.page.evaluate((sel, text) => {
                const el = document.querySelector(sel);
                if (!el) return;
                if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                    el.value = text;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                    el.innerText = text;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }, inputSel, prompt);
            await new Promise(r => setTimeout(r, 200));

            // Click the Run button
            console.log('🚀 Clicking Run...');
            const runBtn = await this.page.$('button[aria-label*="Run"]');
            if (!runBtn) throw new Error('Run button not found');
            await runBtn.click();

            // Wait for response (up to 3 minutes for large prompts with images)
            console.log('⏳ Waiting for response...');
            let gotResponse = false;
            for (let i = 0; i < 180; i++) {
                await new Promise(r => setTimeout(r, 1000));

                const state = await this.page.evaluate(() => {
                    const turns = document.querySelectorAll('ms-chat-turn').length;
                    const hasLoader = document.querySelectorAll('mat-progress-spinner, [class*="loading"]').length > 0;
                    return { turns, hasLoader };
                });

                // Need 2 new turns (user + model) and no loading spinner
                if (state.turns >= turnsBefore + 2 && !state.hasLoader) {
                    gotResponse = true;
                    break;
                }
            }

            if (!gotResponse) throw new Error('Timeout waiting for model response');

            // Wait for streaming to complete - check if text stops changing
            console.log('⏳ Waiting for streaming to complete...');
            let lastText = '';
            let stableCount = 0;
            for (let i = 0; i < 30; i++) {  // Up to 30 seconds for streaming
                await new Promise(r => setTimeout(r, 1000));
                const currentText = await this.extractResponse();
                if (currentText === lastText) {
                    stableCount++;
                    if (stableCount >= 3) {  // Text stable for 3 seconds
                        console.log('✅ Response streaming complete');
                        break;
                    }
                } else {
                    stableCount = 0;
                    lastText = currentText;
                }
            }

            const response = await this.extractResponse();
            console.log(`✅ Got response (${response ? response.length : 0} chars)`);
            return response;
        });
    }

    async uploadImages(images) {
        console.log(`📷 Uploading ${images.length} image(s)...`);
        
        for (let i = 0; i < images.length; i++) {
            const base64Data = images[i];
            const imageNum = i + 1;
            
            // Write base64 to temp file
            const tempPath = path.join(os.tmpdir(), `lotl_upload_${Date.now()}_${i}.png`);
            const imageBuffer = Buffer.from(
                base64Data.replace(/^data:image\/\w+;base64,/, ''),
                'base64'
            );
            fs.writeFileSync(tempPath, imageBuffer);
            console.log(`📁 Temp file created: ${tempPath} (${Math.round(imageBuffer.length / 1024)}KB)`);
            
            let uploaded = false;
            
            // === STRATEGY 1: AI Studio Insert Menu -> Upload from computer ===
            try {
                console.log(`🔍 Strategy 1: AI Studio Insert menu...`);
                
                // Click the "Insert images, videos, audio, or files" button
                const insertBtn = await this.page.$('button[aria-label*="Insert"]');
                if (insertBtn) {
                    console.log(`✅ Found Insert button`);
                    await insertBtn.click();
                    await new Promise(r => setTimeout(r, 500));  // Wait for menu
                    
                    // Look for "Upload from computer" menu item
                    const menuItemSelectors = [
                        'button[aria-label*="Upload from computer"]',
                        'button:has-text("Upload from computer")',
                        '[role="menuitem"]:has-text("Upload")',
                        'mat-menu-content button:first-child',
                        '.mat-mdc-menu-content button:first-child',
                        '[role="menu"] button:first-child'
                    ];
                    
                    let menuItem = null;
                    for (const sel of menuItemSelectors) {
                        try {
                            menuItem = await this.page.$(sel);
                            if (menuItem) {
                                console.log(`✅ Found menu item: ${sel}`);
                                break;
                            }
                        } catch (e) {}
                    }
                    
                    // If no menu item found, try text-based search
                    if (!menuItem) {
                        menuItem = await this.page.evaluateHandle(() => {
                            const buttons = document.querySelectorAll('button');
                            for (const btn of buttons) {
                                if (btn.textContent.toLowerCase().includes('upload')) {
                                    return btn;
                                }
                            }
                            return null;
                        });
                        if (menuItem && await menuItem.evaluate(el => el !== null)) {
                            console.log(`✅ Found upload menu item via text search`);
                        } else {
                            menuItem = null;
                        }
                    }
                    
                    if (menuItem) {
                        // Click menu item and wait for file chooser
                        console.log(`📤 Clicking upload menu item...`);
                        const [fileChooser] = await Promise.all([
                            this.page.waitForFileChooser({ timeout: 5000 }),
                            menuItem.click()
                        ]);
                        await fileChooser.accept([tempPath]);
                        uploaded = true;
                        console.log(`✅ File selected via menu`);
                    } else {
                        // Menu opened but no item found - try FileChooser anyway
                        // (some menus trigger file input directly)
                        console.log(`⚠️ No menu item found, checking for file input...`);
                        const fileInput = await this.page.$('input[type="file"]');
                        if (fileInput) {
                            await fileInput.uploadFile(tempPath);
                            uploaded = true;
                            console.log(`✅ Used direct file input`);
                        }
                    }
                    
                    // Close menu if still open
                    await this.page.keyboard.press('Escape');
                }
            } catch (e) {
                console.log(`⚠️ Strategy 1 failed: ${e.message}`);
                // Close any open menu
                try { await this.page.keyboard.press('Escape'); } catch {}
            }
            
            // === STRATEGY 2: Direct file input (may be hidden) ===
            if (!uploaded) {
                try {
                    console.log(`🔍 Strategy 2: Direct file input...`);
                    const fileInput = await this.page.$('input[type="file"]');
                    if (fileInput) {
                        await fileInput.uploadFile(tempPath);
                        uploaded = true;
                        console.log(`✅ Direct file input upload`);
                    }
                } catch (e) {
                    console.log(`⚠️ Strategy 2 failed: ${e.message}`);
                }
            }
            
            // === STRATEGY 3: Drag and Drop on prompt area ===
            if (!uploaded) {
                try {
                    console.log(`🔍 Strategy 3: Drag-and-drop...`);
                    
                    const b64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
                    
                    uploaded = await this.page.evaluate(async (b64Data) => {
                        const byteString = atob(b64Data);
                        const ab = new ArrayBuffer(byteString.length);
                        const ia = new Uint8Array(ab);
                        for (let i = 0; i < byteString.length; i++) {
                            ia[i] = byteString.charCodeAt(i);
                        }
                        const blob = new Blob([ab], { type: 'image/png' });
                        const file = new File([blob], `screenshot_${Date.now()}.png`, { type: 'image/png' });
                        
                        const dataTransfer = new DataTransfer();
                        dataTransfer.items.add(file);
                        
                        // Target the prompt box area (has drag overlay)
                        const target = document.querySelector('ms-prompt-box') || 
                                       document.querySelector('.prompt-box-container') ||
                                       document.querySelector('footer');
                        
                        if (!target) return false;
                        
                        target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }));
                        target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer }));
                        target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }));
                        
                        return true;
                    }, b64);
                    
                    if (uploaded) console.log(`✅ Drag-drop dispatched`);
                } catch (e) {
                    console.log(`⚠️ Strategy 3 failed: ${e.message}`);
                }
            }
            
            // Clean up temp file
            try {
                fs.unlinkSync(tempPath);
                console.log(`🗑️ Temp file deleted`);
            } catch (e) {
                console.log(`⚠️ Could not delete temp file: ${e.message}`);
            }
            
            // Wait for upload processing
            if (uploaded) {
                console.log(`⏳ Waiting for image ${imageNum} to process...`);
                await new Promise(r => setTimeout(r, 2000));
                
                // Verify - look for image in the prompt area
                const hasImage = await this.page.evaluate(() => {
                    const indicators = [
                        'ms-img-media',
                        'ms-video-media', 
                        '[class*="media-chip"]',
                        '[class*="file-chip"]',
                        '.prompt-box-container img',
                        'img[src*="blob:"]',
                        '[aria-label*="Remove"]'
                    ];
                    
                    for (const sel of indicators) {
                        if (document.querySelector(sel)) return true;
                    }
                    return false;
                });
                
                if (hasImage) {
                    console.log(`✅ Image ${imageNum}/${images.length} verified in UI`);
                } else {
                    console.log(`⚠️ Image ${imageNum} - no preview detected (may still work)`);
                }
            } else {
                console.log(`❌ Image ${imageNum} upload FAILED - all strategies exhausted`);
            }
            
            // Small delay between images
            if (i < images.length - 1) {
                await new Promise(r => setTimeout(r, 500));
            }
        }
        
        console.log(`📷 Image upload complete`);
    }

    async extractResponse() {
        return await this.page.evaluate(() => {
            const turns = document.querySelectorAll('ms-chat-turn');
            const lastTurn = turns[turns.length - 1];
            if (!lastTurn) return null;

            const clone = lastTurn.cloneNode(true);

            // Remove UI elements
            clone.querySelectorAll('button, mat-icon, [class*="icon"], [class*="search-suggestion"], [class*="grounding"], [class*="source"], .sources, .citation').forEach(el => el.remove());

            // Get text from bubble or whole turn
            const bubble = clone.querySelector('ms-chat-bubble');
            let text = (bubble ? bubble.innerText : clone.innerText) || '';
            text = text.trim();

            // Clean up grounding/sources noise
            text = text
                .replace(/\[\d+\]/g, '')
                .replace(/Google Search Suggestions?.*/gi, '')
                .replace(/Display of Search Suggestions?.*/gi, '')
                .replace(/Grounding with Google Search.*/gi, '')
                .replace(/Learn more.*/gi, '');

            const lines = text.split('\n').filter(l => {
                const t = l.trim();
                const tLower = t.toLowerCase();
                if (!t) return false;
                if (['edit', 'more_vert', 'thumb_up', 'thumb_down', 'content_copy', 'model', 'user', 'sources', 'help'].includes(tLower)) return false;
                if (t.match(/^\d+\.?\d*s$/)) return false;
                return true;
            });

            let result = lines.join('\n').trim();
            if (result.startsWith('Model')) result = result.substring(5).trim();
            result = result.replace(/\s*\d+\.?\d*s\s*$/, '').trim();
            return result;
        });
    }
}

// --- EXPRESS SERVER ---
const app = express();
app.use(bodyParser.json({ limit: '50mb' }));
const controller = new LotlController(9222);

app.post('/chat', async (req, res) => {
    const { prompt, images } = req.body;
    if (!prompt) {
        return res.status(400).json({ success: false, error: 'Missing prompt' });
    }
    
    const imageCount = images ? images.length : 0;
    console.log(`\n📩 Request: "${prompt.substring(0, 80)}..." (${prompt.length} chars, ${imageCount} images)`);
    
    try {
        const reply = await controller.send(prompt, images);
        console.log(`✅ Success!`);
        res.json({ success: true, reply });
    } catch (err) {
        console.error('❌ Error:', err.message);
        console.error(err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'LotL Controller is running' });
});

// Error handlers - keep process alive
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err.message);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection:', reason);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 LotL Controller running on port ${PORT}`);
    console.log(`📋 Endpoints:`);
    console.log(`   POST /chat   - Send a prompt and get response`);
    console.log(`   GET  /health - Health check`);
    console.log(`\n⚠️  Make sure Chrome is running with --remote-debugging-port=9222`);
    console.log(`⚠️  And have aistudio.google.com open in a tab\n`);
});
