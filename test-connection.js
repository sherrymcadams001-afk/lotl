const puppeteer = require('puppeteer-core');

async function test() {
    console.log('1. Fetching Chrome version...');
    const res = await fetch('http://127.0.0.1:9222/json/version');
    const data = await res.json();
    console.log('2. Got WebSocket URL:', data.webSocketDebuggerUrl);
    
    console.log('3. Connecting to Chrome...');
    const browser = await puppeteer.connect({
        browserWSEndpoint: data.webSocketDebuggerUrl,
        defaultViewport: null
    });
    console.log('4. Connected!');
    
    console.log('5. Getting pages...');
    const pages = await browser.pages();
    console.log('6. Found', pages.length, 'pages');
    
    for (const p of pages) {
        console.log('   -', await p.title(), '|', p.url());
    }
    
    // Find AI Studio
    const aiPage = pages.find(p => p.url().includes('aistudio.google.com'));
    if (!aiPage) {
        console.log('AI Studio tab not found!');
        return;
    }
    
    console.log('7. Found AI Studio tab, bringing to front...');
    await aiPage.bringToFront();
    
    console.log('8. Counting ms-chat-turn elements...');
    const turnCount = await aiPage.evaluate(() => {
        return document.querySelectorAll('ms-chat-turn').length;
    });
    console.log('9. Found', turnCount, 'chat turns');
    
    console.log('10. Looking for input...');
    const hasInput = await aiPage.evaluate(() => {
        const input = document.querySelector('footer textarea');
        return input ? 'Found footer textarea' : 'Not found';
    });
    console.log('11. Input:', hasInput);
    
    console.log('✅ All tests passed!');
    await browser.disconnect();
}

test().catch(err => {
    console.error('❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
});
