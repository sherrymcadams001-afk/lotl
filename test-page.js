const puppeteer = require('puppeteer-core');

(async () => {
    try {
        console.log('Fetching Chrome version...');
        const versionRes = await fetch('http://127.0.0.1:9222/json/version');
        const versionData = await versionRes.json();
        console.log('WebSocket URL:', versionData.webSocketDebuggerUrl);
        
        console.log('Fetching tabs...');
        const tabsRes = await fetch('http://127.0.0.1:9222/json');
        const tabs = await tabsRes.json();
        console.log(`Found ${tabs.length} tab(s):`);
        for (const tab of tabs) {
            console.log(`  - ${tab.title}: ${tab.url.substring(0, 50)}...`);
        }
        
        const aiTab = tabs.find(t => t.url.includes('aistudio'));
        if (!aiTab) {
            console.log('ERROR: No AI Studio tab found!');
            process.exit(1);
        }
        console.log('AI Studio tab found:', aiTab.title);
        
        console.log('Connecting to browser...');
        const browser = await puppeteer.connect({
            browserWSEndpoint: versionData.webSocketDebuggerUrl,
            defaultViewport: null
        });
        console.log('Connected to browser');
        
        console.log('Getting pages...');
        const pages = await browser.pages();
        console.log(`Found ${pages.length} pages`);
        
        for (let i = 0; i < pages.length; i++) {
            try {
                const url = await pages[i].url();
                console.log(`  Page ${i}: ${url.substring(0, 60)}...`);
            } catch (e) {
                console.log(`  Page ${i}: Error - ${e.message}`);
            }
        }
        
        console.log('Getting targets...');
        const targets = await browser.targets();
        console.log(`Found ${targets.length} targets`);
        
        for (const t of targets) {
            console.log(`  ${t.type()}: ${t.url().substring(0, 50)}...`);
        }
        
        // Try to get the AI Studio page
        const aiTarget = targets.find(t => t.url().includes('aistudio') && t.type() === 'page');
        if (aiTarget) {
            console.log('Found AI Studio target, attempting to get page...');
            const page = await aiTarget.page();
            if (page) {
                console.log('Got page! Testing title...');
                const title = await page.title();
                console.log('Title:', title);
                
                console.log('Testing evaluate...');
                const turns = await page.evaluate(() => document.querySelectorAll('ms-chat-turn').length);
                console.log('Turns:', turns);
                
                console.log('SUCCESS!');
            } else {
                console.log('Could not get page from target');
            }
        } else {
            console.log('No AI Studio target found');
        }
        
        await browser.disconnect();
        process.exit(0);
    } catch (e) {
        console.error('Error:', e.message);
        console.error(e.stack);
        process.exit(1);
    }
})();
