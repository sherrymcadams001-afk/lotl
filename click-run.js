const puppeteer = require('puppeteer-core');

async function clickRunAndWatch() {
    const res = await fetch('http://127.0.0.1:9222/json/version');
    const data = await res.json();
    const browser = await puppeteer.connect({ browserWSEndpoint: data.webSocketDebuggerUrl });
    const pages = await browser.pages();
    const page = pages.find(p => p.url().includes('aistudio'));
    await page.bringToFront();
    
    console.log('Starting...');
    
    // Listen for console messages
    page.on('console', msg => console.log('PAGE LOG:', msg.text()));
    
    // Count turns before
    const turnsBefore = await page.evaluate(() => {
        return document.querySelectorAll('ms-chat-turn').length;
    });
    console.log('Turns before:', turnsBefore);
    
    // Setup network listener for API calls
    page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('batchexecute') || url.includes('generate')) {
            console.log('API Response:', response.status(), url.substring(0, 100));
            try {
                const text = await response.text();
                console.log('Response snippet:', text.substring(0, 200));
            } catch(e) {}
        }
    });
    
    // Just click the Run button (assuming text is already in input)
    console.log('Looking for Run button...');
    const runBtn = await page.$('button[aria-label*="Run"]');
    if (runBtn) {
        console.log('Found Run button, clicking...');
        await runBtn.click();
    } else {
        console.log('Run button not found');
    }
    
    // Wait and watch
    console.log('Watching for 15 seconds...');
    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const turnsNow = await page.evaluate(() => {
            return document.querySelectorAll('ms-chat-turn').length;
        });
        
        // Check for loading/spinner
        const hasLoader = await page.evaluate(() => {
            const loaders = document.querySelectorAll('mat-progress-spinner, .loading-indicator, [class*="loading"]');
            return loaders.length > 0;
        });
        
        console.log(`Second ${i+1}: turns=${turnsNow}, loading=${hasLoader}`);
    }
    
    // Final state
    const turnsAfter = await page.evaluate(() => {
        return document.querySelectorAll('ms-chat-turn').length;
    });
    console.log('Turns after:', turnsAfter);
    
    await browser.disconnect();
    console.log('Done');
}

clickRunAndWatch().catch(err => {
    console.error('Error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
