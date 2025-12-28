/**
 * Debug script to inspect AI Studio's HTML structure
 */
const puppeteer = require('puppeteer-core');

async function debug() {
    try {
        const vRes = await fetch('http://127.0.0.1:9222/json/version');
        const vData = await vRes.json();
        
        const browser = await puppeteer.connect({
            browserWSEndpoint: vData.webSocketDebuggerUrl,
            defaultViewport: null
        });

        const pages = await browser.pages();
        const page = pages.find(p => p.url().includes('aistudio.google.com'));
        
        if (!page) {
            console.log('AI Studio tab not found');
            return;
        }

        console.log('Found AI Studio tab:', page.url());
        console.log('\n--- Inspecting page structure ---\n');

        // Get all potential message containers
        const elements = await page.evaluate(() => {
            const results = [];
            
            // Look for common chat patterns
            const selectors = [
                'ms-chat-turn',
                'ms-chat-bubble', 
                '.chat-turn',
                '.message',
                '.turn',
                '[class*="turn"]',
                '[class*="message"]',
                '[class*="response"]',
                '[class*="model"]',
                '[data-turn-role]',
                '[role="listitem"]',
                'article'
            ];
            
            for (const sel of selectors) {
                const els = document.querySelectorAll(sel);
                if (els.length > 0) {
                    results.push({
                        selector: sel,
                        count: els.length,
                        lastText: els[els.length - 1].innerText?.substring(0, 100),
                        className: els[els.length - 1].className
                    });
                }
            }
            
            return results;
        });

        console.log('Found elements:');
        for (const el of elements) {
            console.log(`\n${el.selector} (${el.count} found)`);
            console.log(`  Class: ${el.className}`);
            console.log(`  Text: ${el.lastText}...`);
        }

        // Also get the full HTML of any chat container
        const chatHtml = await page.evaluate(() => {
            const container = document.querySelector('ms-autoscroll-container, .chat-container, main');
            if (container) {
                return container.outerHTML.substring(0, 2000);
            }
            return 'No chat container found';
        });
        
        console.log('\n--- Chat Container HTML (first 2000 chars) ---\n');
        console.log(chatHtml);

    } catch (e) {
        console.error('Error:', e.message);
    }
}

debug();
