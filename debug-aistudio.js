const puppeteer = require('puppeteer-core');

async function debugAIStudio() {
    const res = await fetch('http://127.0.0.1:9222/json/version');
    const data = await res.json();
    const browser = await puppeteer.connect({ browserWSEndpoint: data.webSocketDebuggerUrl });
    const pages = await browser.pages();
    const page = pages.find(p => p.url().includes('aistudio'));
    await page.bringToFront();
    
    console.log('=== DEBUGGING AI STUDIO ===\n');
    
    // 1. Check for error banners/alerts
    console.log('1. Checking for errors/alerts...');
    const errors = await page.evaluate(() => {
        const results = [];
        
        // Snackbars/Toasts
        document.querySelectorAll('.mat-snack-bar-container, .snackbar, [role="alert"]').forEach(el => {
            if (el.innerText) results.push('Alert: ' + el.innerText);
        });
        
        // Dialogs
        document.querySelectorAll('mat-dialog-container, [role="dialog"]').forEach(el => {
            if (el.innerText) results.push('Dialog: ' + el.innerText.substring(0, 300));
        });
        
        // Any error classes
        document.querySelectorAll('[class*="error"], [class*="warning"]').forEach(el => {
            const text = el.innerText?.trim();
            if (text && text.length > 5 && text.length < 200) {
                results.push('Error element: ' + text);
            }
        });
        
        // Rate limit specific
        const bodyText = document.body.innerText;
        if (bodyText.includes('rate limit')) results.push('Rate limit mentioned in page');
        if (bodyText.includes('quota')) results.push('Quota mentioned in page');
        if (bodyText.includes('too many')) results.push('Too many requests mentioned');
        
        return results;
    });
    
    if (errors.length > 0) {
        errors.forEach(e => console.log('   - ' + e));
    } else {
        console.log('   No visible errors');
    }
    
    // 2. Check the actual page HTML structure around chat
    console.log('\n2. Checking chat container structure...');
    const chatStructure = await page.evaluate(() => {
        const chatContainer = document.querySelector('ms-prompt-run-container, .chat-container, [class*="chat"]');
        if (!chatContainer) return 'No chat container found';
        
        const children = Array.from(chatContainer.children).map(c => ({
            tag: c.tagName,
            class: c.className,
            childCount: c.children.length
        }));
        return children;
    });
    console.log('   Chat structure:', JSON.stringify(chatStructure, null, 2));
    
    // 3. Check if there's a "loading" or "generating" indicator
    console.log('\n3. Checking for loading indicators...');
    const loading = await page.evaluate(() => {
        const indicators = [];
        document.querySelectorAll('.loading, .spinner, [class*="loading"], [class*="spinner"], mat-progress-spinner').forEach(el => {
            const visible = el.offsetParent !== null;
            indicators.push(el.className + ' (visible: ' + visible + ')');
        });
        return indicators;
    });
    if (loading.length > 0) {
        loading.forEach(l => console.log('   - ' + l));
    } else {
        console.log('   No loading indicators');
    }
    
    // 4. Check the current turn contents
    console.log('\n4. Current turns...');
    const turns = await page.evaluate(() => {
        const all = document.querySelectorAll('ms-chat-turn');
        return Array.from(all).map((t, i) => {
            const html = t.innerHTML.substring(0, 500);
            const text = t.innerText?.replace(/\n/g, ' ').substring(0, 100);
            return `Turn ${i}: ${text}`;
        });
    });
    turns.forEach(t => console.log('   ' + t));
    
    // 5. Check if Run button is disabled
    console.log('\n5. Checking Run button state...');
    const buttonState = await page.evaluate(() => {
        const btn = document.querySelector('button[aria-label*="Run"]');
        if (!btn) return 'Button not found';
        return {
            disabled: btn.disabled,
            ariaDisabled: btn.getAttribute('aria-disabled'),
            innerText: btn.innerText,
            visible: btn.offsetParent !== null
        };
    });
    console.log('   Run button:', JSON.stringify(buttonState));
    
    // 6. Take a screenshot
    console.log('\n6. Taking screenshot...');
    await page.screenshot({ path: 'debug-screenshot.png', fullPage: true });
    console.log('   Saved to debug-screenshot.png');
    
    await browser.disconnect();
    console.log('\n=== DEBUG COMPLETE ===');
}

debugAIStudio().catch(err => {
    console.error('Error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
