const puppeteer = require('puppeteer-core');

async function startNewChat() {
    const res = await fetch('http://127.0.0.1:9222/json/version');
    const data = await res.json();
    const browser = await puppeteer.connect({ browserWSEndpoint: data.webSocketDebuggerUrl });
    const pages = await browser.pages();
    const page = pages.find(p => p.url().includes('aistudio'));
    await page.bringToFront();
    
    console.log('Current URL:', page.url());
    console.log('Navigating to new chat URL...');
    
    // Navigate directly to a fresh new_chat page
    await page.goto('https://aistudio.google.com/prompts/new_chat?model=gemini-2.0-flash');
    await new Promise(r => setTimeout(r, 3000));
    
    const turnCount = await page.evaluate(() => {
        return document.querySelectorAll('ms-chat-turn').length;
    });
    console.log('Turn count after navigation:', turnCount);
    console.log('New URL:', page.url());
    
    await browser.disconnect();
    console.log('Done!');
}

startNewChat().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
