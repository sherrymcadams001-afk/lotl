const puppeteer = require('puppeteer-core');

async function test() {
    console.log('1. Connecting to Chrome...');
    const res = await fetch('http://127.0.0.1:9222/json/version');
    const data = await res.json();
    
    const browser = await puppeteer.connect({
        browserWSEndpoint: data.webSocketDebuggerUrl,
        defaultViewport: null
    });
    console.log('2. Connected!');
    
    const pages = await browser.pages();
    const page = pages.find(p => p.url().includes('aistudio.google.com'));
    if (!page) throw new Error('AI Studio tab not found');
    
    await page.bringToFront();
    console.log('3. AI Studio tab active');
    
    // Scroll to bottom first
    await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
    });
    console.log('3.5. Scrolled to bottom');
    await new Promise(r => setTimeout(r, 500));
    
    // Count turns before
    const turnsBefore = await page.evaluate(() => {
        return document.querySelectorAll('ms-chat-turn').length;
    });
    console.log(`4. Turns before: ${turnsBefore}`);
    
    // Find and focus the input - try multiple methods
    console.log('5. Looking for input...');
    
    // First check if input is empty or has placeholder text
    const inputInfo = await page.evaluate(() => {
        const inputs = [
            document.querySelector('footer textarea'),
            document.querySelector('div[contenteditable="true"]'),
            document.querySelector('textarea')
        ].filter(Boolean);
        return inputs.map(i => ({
            tag: i.tagName,
            id: i.id,
            className: i.className,
            value: i.value || i.innerText || '',
            placeholder: i.placeholder || ''
        }));
    });
    console.log('   Found inputs:', JSON.stringify(inputInfo, null, 2));
    
    const inputSel = 'footer textarea';
    await page.waitForSelector(inputSel, { timeout: 5000 });
    console.log('6. Found input, triple-clicking to select all...');
    await page.click(inputSel, { clickCount: 3 });
    await new Promise(r => setTimeout(r, 100));
    
    console.log('7. Typing via keyboard...');
    const testPrompt = 'Reply with ONLY the word BANANA';
    await page.keyboard.type(testPrompt, { delay: 20 });
    await new Promise(r => setTimeout(r, 500));
    
    // Verify the text was entered
    const afterType = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? (el.value || el.innerText || 'empty') : 'not found';
    }, inputSel);
    console.log('7.5. Input value after typing:', afterType);
    
    console.log('8. Using Ctrl+Enter to send...');
    // Try Ctrl+Enter first (common shortcut for send)
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    await new Promise(r => setTimeout(r, 500));
    
    // Also try clicking the Run button as backup
    console.log('8.5. Also clicking Run button...');
    const sendSelectors = [
        'button[aria-label*="Run"]',
        'button[aria-label*="Send"]',
        '.run-button',
        'button[mattooltip*="Run"]'
    ];
    
    let clicked = false;
    for (const sel of sendSelectors) {
        try {
            const btn = await page.$(sel);
            if (btn) {
                const isVisible = await btn.isIntersectingViewport();
                console.log(`   - ${sel}: found, visible=${isVisible}`);
                if (isVisible) {
                    await btn.click();
                    clicked = true;
                    break;
                }
            }
        } catch (e) {
            console.log(`   - ${sel} error: ${e.message}`);
        }
    }
    
    if (!clicked) {
        console.log('9. No visible button, trying Enter key...');
        await page.keyboard.press('Enter');
    }
    
    console.log('10. Waiting for response...');
    // Wait for new turns
    let turnsNow = turnsBefore;
    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        turnsNow = await page.evaluate(() => {
            return document.querySelectorAll('ms-chat-turn').length;
        });
        console.log(`    Turns: ${turnsNow} (was ${turnsBefore})`);
        if (turnsNow >= turnsBefore + 2) {
            break;
        }
        
        // Check for error dialogs or rate limit messages after 5 seconds
        if (i === 5) {
            const errors = await page.evaluate(() => {
                const errorTexts = [];
                // Check for snackbar/toast errors
                const snackbars = document.querySelectorAll('.mat-snack-bar-container, .snackbar, [role="alert"], .error-message');
                snackbars.forEach(el => {
                    if (el.innerText) errorTexts.push('Snackbar: ' + el.innerText);
                });
                // Check for dialogs
                const dialogs = document.querySelectorAll('mat-dialog-container, .dialog, [role="dialog"]');
                dialogs.forEach(el => {
                    if (el.innerText) errorTexts.push('Dialog: ' + el.innerText.substring(0, 200));
                });
                // Check for error spans
                const errorSpans = document.querySelectorAll('.error, .error-text, [class*="error"]');
                errorSpans.forEach(el => {
                    if (el.innerText && el.innerText.length > 3) errorTexts.push('Error: ' + el.innerText.substring(0, 100));
                });
                return errorTexts;
            });
            if (errors.length > 0) {
                console.log('⚠️ Found error messages:', errors);
            }
        }
    }
    
    // Extra wait for streaming
    await new Promise(r => setTimeout(r, 2000));
    
    console.log('11. Extracting response...');
    const response = await page.evaluate((idx) => {
        const turns = document.querySelectorAll('ms-chat-turn');
        if (idx < 0 || idx >= turns.length) return 'INDEX OUT OF BOUNDS';
        
        const turn = turns[idx];
        const clone = turn.cloneNode(true);
        clone.querySelectorAll('button, mat-icon').forEach(el => el.remove());
        
        let text = clone.innerText || '';
        // Filter UI cruft
        const lines = text.split('\n').filter(l => {
            const t = l.trim().toLowerCase();
            if (!t) return false;
            if (['edit', 'more_vert', 'thumb_up', 'thumb_down', 'content_copy'].includes(t)) return false;
            return true;
        });
        return lines.join(' ').trim();
    }, turnsBefore + 1);
    
    console.log('12. Response:', response);
    
    await browser.disconnect();
    console.log('✅ Done!');
}

test().catch(err => {
    console.error('❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
