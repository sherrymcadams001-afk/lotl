/**
 * 🤖 FINAL HYBRID LOTL CONTROLLER (v2025)
 * Connects to your existing Chrome window (Port 9222).
 * Features: Stealth Input, Network-based Timing, Self-Healing Selectors.
 */

const puppeteer = require('puppeteer-core');
const express = require('express');
const bodyParser = require('body-parser');

// --- CONFIGURATION: UI ADAPTERS ---
// Updated to target current (late 2024/2025) UI structures.
const ADAPTERS = {
    'gemini': {
        urlKeyword: 'aistudio.google.com',
        // Network: Wait for the main RPC call to finish
        backendTrigger: 'batchexecute',
        // UI Strategies (Self-healing: tries top to bottom)
        inputSelectors: [
            'footer textarea',
            'div[contenteditable="true"]',
            'textarea[aria-label*="prompt"]',
            'textarea[placeholder*="prompt"]',
            'textarea'
        ],
        sendSelectors: [
            'button[aria-label*="Run"]',
            'button[aria-label*="Send"]',
            'button[aria-label*="Submit"]',
            '.run-button',
            'button[mattooltip*="Run"]'
        ],
        // Output: Multiple possible selectors for AI Studio response containers
        responseSelectors: [
            'ms-chat-bubble',
            '.model-response',
            '.response-content',
            '[data-message-author="model"]',
            '.chat-turn-container:last-child .markdown-content',
            '.chat-message:last-child',
            '.message-content:last-child',
            'div[class*="response"]',
            'div[class*="output"]',
            'div[class*="model"]'
        ]
    },
    'chatgpt': {
        urlKeyword: 'chatgpt.com',
        // Network: Wait for the conversation API
        backendTrigger: '/conversation',
        inputSelectors: [
            '#prompt-textarea',
            'div[contenteditable="true"]'
        ],
        sendSelectors: [
            'button[data-testid="send-button"]',
            'button[aria-label="Send prompt"]',
            'form button[type="submit"]'
        ],
        responseSelectors: [
            '.markdown',
            '.message-content',
            '[data-message-author-role="assistant"]'
        ]
    }
};

class LotlController {
    constructor(port = 9222) {
        this.port = port;
        this.browser = null;
        this.page = null;
    }

    // --- CONNECTION LOGIC ---
    async connect(targetKey) {
        const adapter = ADAPTERS[targetKey];
        if (!adapter) throw new Error(`Unknown adapter: ${targetKey}`);

        try {
            // 1. Get WebSocket URL from Chrome
            const vRes = await fetch(`http://127.0.0.1:${this.port}/json/version`);
            const vData = await vRes.json();
            
            // 2. Connect Puppeteer
            this.browser = await puppeteer.connect({
                browserWSEndpoint: vData.webSocketDebuggerUrl,
                defaultViewport: null // Preserve manual window size
            });

            // 3. Find the correct tab
            const pages = await this.browser.pages();
            this.page = pages.find(p => p.url().includes(adapter.urlKeyword));

            if (!this.page) throw new Error(`Tab for ${targetKey} not found.`);
            console.log(`✅ Attached to ${targetKey}`);
            
            return adapter;
        } catch (e) {
            console.error("❌ Connection failed. Is Chrome running on port 9222?");
            throw e;
        }
    }

    // --- ROBUST UI INTERACTIONS ---
    async robustClick(selectors) {
        for (const sel of selectors) {
            try {
                // Wait briefly for this specific selector strategy
                await this.page.waitForSelector(sel, { timeout: 1000, visible: true });
                await this.page.click(sel);
                return; // Success
            } catch (e) { continue; } // Try next strategy
        }
        throw new Error("UI Helper: Could not find element with any known selector.");
    }

    async robustType(selectors, text) {
        for (const sel of selectors) {
            try {
                await this.page.waitForSelector(sel, { timeout: 1000 });
                // Focus the element
                await this.page.click(sel);
                
                // Select all existing content first
                await this.page.keyboard.down('Control');
                await this.page.keyboard.press('a');
                await this.page.keyboard.up('Control');
                await new Promise(r => setTimeout(r, 50));
                
                // Clear existing content and PASTE the new text (much faster than typing)
                await this.page.evaluate((s, newText) => {
                    const el = document.querySelector(s);
                    if (el) {
                        // Clear the element first
                        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                            el.value = '';
                            el.value = newText;
                            // Trigger input event so frameworks detect the change
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                        } else {
                            // For contenteditable divs
                            el.innerHTML = '';
                            el.innerText = newText;
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                    }
                }, sel, text);
                
                // Small delay to let the UI update
                await new Promise(r => setTimeout(r, 100));
                return;
            } catch (e) { continue; }
        }
        throw new Error("UI Helper: Could not find input box.");
    }

    // --- NEW CHAT HELPER ---
    async startNewChat() {
        console.log('🆕 Starting new chat...');
        try {
            // Look for "New chat" button in AI Studio sidebar or header
            const newChatSelectors = [
                'button[aria-label*="New chat"]',
                'button[aria-label*="new chat"]',
                'a[aria-label*="New chat"]',
                '.new-chat-button',
                'button:has-text("New chat")',
                '[data-testid="new-chat"]'
            ];
            
            // Try clicking the new chat button
            for (const sel of newChatSelectors) {
                try {
                    await this.page.waitForSelector(sel, { timeout: 500, visible: true });
                    await this.page.click(sel);
                    console.log('✅ Clicked new chat button');
                    await new Promise(r => setTimeout(r, 1000));
                    return true;
                } catch (e) { continue; }
            }
            
            // Fallback: Use keyboard shortcut if available (Ctrl+Shift+O for AI Studio)
            // or just scroll to bottom
            console.log('⚠️ No new chat button found, scrolling to bottom instead');
            await this.page.evaluate(() => {
                const chatContainer = document.querySelector('.chat-container') || 
                                     document.querySelector('[role="main"]') ||
                                     document.body;
                chatContainer.scrollTo(0, chatContainer.scrollHeight);
            });
            return false;
        } catch (e) {
            console.log('⚠️ Could not start new chat:', e.message);
            return false;
        }
    }

    // --- MAIN EXECUTION FLOW ---
    async send(targetKey, prompt, startFresh = false) {
        const adapter = await this.connect(targetKey);
        await this.page.bringToFront();
        
        // Optionally start a new chat
        if (startFresh) {
            await this.startNewChat();
        }
        
        // ALWAYS scroll to bottom first
        await this.page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
            const container = document.querySelector('.chat-turns-container') || 
                              document.querySelector('[class*="chat"]') ||
                              document.querySelector('main');
            if (container) container.scrollTo(0, container.scrollHeight);
        });

        // 0. Count existing turns BEFORE sending
        const turnCountBefore = await this.page.evaluate(() => {
            return document.querySelectorAll('ms-chat-turn').length;
        });
        console.log(`📊 Turns before: ${turnCountBefore}`);

        // 1. Setup Network Listener (The "Hitchhiker" Trick)
        // We capture the response promise BEFORE clicking send.
        const responsePromise = this.page.waitForResponse(res => 
            res.url().includes(adapter.backendTrigger) && res.status() === 200,
            { timeout: 45000 } // 45s timeout for long thoughts
        ).catch(e => null);

        // 2. Drive Input (Human-like)
        await this.robustType(adapter.inputSelectors, prompt);
        
        // 3. Click Send
        // Try clicking, if fails, fallback to 'Enter' key
        try {
            await this.robustClick(adapter.sendSelectors);
        } catch(e) {
            console.log("⚠️ Click failed, trying Enter key...");
            await this.page.keyboard.press('Enter');
        }

        console.log("⏳ Waiting for network response...");
        
        // 4. Wait for Network to Finish
        await responsePromise;
        
        // 5. Wait for NEW turn to appear (poll for new turn count)
        let newTurnCount = turnCountBefore;
        for (let i = 0; i < 30; i++) { // Max 30 seconds
            await new Promise(r => setTimeout(r, 1000));
            newTurnCount = await this.page.evaluate(() => {
                return document.querySelectorAll('ms-chat-turn').length;
            });
            // We need at least 2 new turns (user + model)
            if (newTurnCount >= turnCountBefore + 2) {
                console.log(`📊 New turns detected: ${newTurnCount} (was ${turnCountBefore})`);
                break;
            }
        }
        
        // Extra buffer for streaming to complete
        await new Promise(r => setTimeout(r, 1000));

        // 6. Scrape Result - Get the specific NEW turn content (model's response)
        let reply = null;
        
        // The new model response should be at index turnCountBefore + 1 (0-indexed)
        // (turnCountBefore is user turn, turnCountBefore+1 is model response)
        const modelTurnIndex = turnCountBefore + 1;
        console.log(`🎯 Looking for model response at turn index ${modelTurnIndex}...`);
        
        reply = await this.page.evaluate((targetIndex) => {
            // AI Studio uses ms-chat-turn components
            const allTurns = document.querySelectorAll('ms-chat-turn');
            if (allTurns.length === 0 || targetIndex >= allTurns.length) {
                return null;
            }
            
            // Get the specific turn at our calculated index
            const modelTurn = allTurns[targetIndex];
            
            // First, try to find specific response content containers within the turn
            const responseContainers = [
                'ms-chat-bubble',
                '.markdown-content',
                '.response-text',
                '.model-response',
                '[class*="bubble"]',
                'p', 'div'
            ];
            
            // Try to find the actual content element
            for (const sel of responseContainers) {
                const content = modelTurn.querySelector(sel);
                if (content && content.innerText && content.innerText.trim().length > 0) {
                    const text = content.innerText.trim();
                    // Filter out UI artifacts
                    if (!text.match(/^(edit|more_vert|thumb_up|thumb_down|content_copy)$/i)) {
                        return text;
                    }
                }
            }
            
            // Fallback: Clone and clean the whole turn
            const clone = modelTurn.cloneNode(true);
            
            // Remove buttons, icons, and action elements
            clone.querySelectorAll('button, mat-icon, .actions, .toolbar, [role="button"], .icon-button, .turn-actions, [class*="icon"]').forEach(el => el.remove());
            
            // Get text content
            let text = clone.innerText || clone.textContent || '';
            
            // Clean up - remove known UI artifacts
            const linesToRemove = ['edit', 'more_vert', 'thumb_up', 'thumb_down', 'content_copy', 'Advanced settings'];
            const lines = text.split('\n').filter(line => {
                const trimmed = line.trim().toLowerCase();
                if (!trimmed) return false;
                for (const artifact of linesToRemove) {
                    if (trimmed === artifact.toLowerCase()) return false;
                }
                if (trimmed.length <= 2 && !trimmed.match(/^\d+$/)) return false;
                return true;
            });
            
            return lines.join(' ').trim();
        }, modelTurnIndex);
        
        // Fallback approach if the above didn't work
        if (!reply || reply.length < 2) {
            console.log('⚠️ First approach returned empty, trying fallback...');
            reply = await this.page.evaluate(() => {
                // Get the last ms-chat-turn
                const allTurns = document.querySelectorAll('ms-chat-turn');
                if (allTurns.length === 0) return null;
                
                const lastTurn = allTurns[allTurns.length - 1];
                const clone = lastTurn.cloneNode(true);
                clone.querySelectorAll('button, mat-icon, .actions, .toolbar, [role="button"]').forEach(el => el.remove());
                
                let text = clone.innerText || clone.textContent || '';
                const lines = text.split('\n').filter(line => {
                    const t = line.trim();
                    if (!t || t.length <= 2) return false;
                    if (['edit', 'more_vert', 'thumb_up', 'thumb_down', 'content_copy'].includes(t.toLowerCase())) return false;
                    return true;
                });
                return lines.join(' ').trim();
            });
        }

        if (!reply) throw new Error("Response scraped as null. UI may have changed.");
        return reply.trim();
    }
}

// --- EXPRESS SERVER ---
const app = express();
app.use(bodyParser.json());
const controller = new LotlController(9222);

app.post('/chat', async (req, res) => {
    const { target = 'gemini', prompt } = req.body;
    console.log(`📩 Received request: target=${target}, prompt="${prompt.substring(0, 50)}..."`);
    try {
        const reply = await controller.send(target, prompt);
        console.log(`✅ Success! Reply length: ${reply.length}`);
        res.json({ success: true, reply });
    } catch (err) {
        console.error('❌ Error:', err.message);
        console.error(err.stack);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err.message);
    console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection:', reason);
});

app.listen(3000, () => console.log('🚀 LotL Controller running on port 3000'));
