const puppeteer = require('puppeteer-core');

async function sendAndGetResponse(prompt) {
    console.log('1. Connecting to Chrome...');
    const res = await fetch('http://127.0.0.1:9222/json/version');
    const data = await res.json();
    
    const browser = await puppeteer.connect({
        browserWSEndpoint: data.webSocketDebuggerUrl,
        defaultViewport: null
    });
    
    const pages = await browser.pages();
    const page = pages.find(p => p.url().includes('aistudio.google.com'));
    if (!page) throw new Error('AI Studio tab not found');
    
    await page.bringToFront();
    console.log('2. AI Studio tab active');
    
    // Scroll to bottom
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    
    // Count turns before
    const turnsBefore = await page.evaluate(() => {
        return document.querySelectorAll('ms-chat-turn').length;
    });
    console.log(`3. Turns before: ${turnsBefore}`);
    
    // Find and focus input
    console.log('4. Finding input...');
    const inputSel = 'footer textarea';
    await page.waitForSelector(inputSel, { timeout: 5000 });
    await page.click(inputSel, { clickCount: 3 }); // Select all
    await new Promise(r => setTimeout(r, 100));
    
    // Type the prompt
    console.log('5. Typing prompt...');
    await page.keyboard.type(prompt, { delay: 10 });
    await new Promise(r => setTimeout(r, 300)); // Wait for UI to update
    
    // Verify text is in input
    const inputVal = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? el.value : '';
    }, inputSel);
    console.log(`6. Input value: "${inputVal.substring(0, 50)}..."`);
    
    // Click the Run button (NOT just Enter)
    console.log('7. Clicking Run button...');
    const runBtn = await page.$('button[aria-label*="Run"]');
    if (!runBtn) {
        throw new Error('Run button not found');
    }
    await runBtn.click();
    
    // Wait for response with loading detection
    console.log('8. Waiting for response...');
    let gotResponse = false;
    for (let i = 0; i < 60; i++) { // Max 60 seconds
        await new Promise(r => setTimeout(r, 1000));
        
        const state = await page.evaluate((before) => {
            const turns = document.querySelectorAll('ms-chat-turn').length;
            const hasLoader = document.querySelectorAll('mat-progress-spinner, [class*="loading"]').length > 0;
            return { turns, hasLoader };
        }, turnsBefore);
        
        // We need 2 new turns (user + model) AND no loader
        if (state.turns >= turnsBefore + 2 && !state.hasLoader) {
            console.log(`   Got response at second ${i+1}`);
            gotResponse = true;
            break;
        }
        
        // Just show progress every 5 seconds
        if (i % 5 === 4) {
            console.log(`   Second ${i+1}: turns=${state.turns}, loading=${state.hasLoader}`);
        }
    }
    
    if (!gotResponse) {
        throw new Error('Timeout waiting for response');
    }
    
    // Extra wait for streaming to finish
    await new Promise(r => setTimeout(r, 500));
    
    // Extract the model response (last turn)
    console.log('9. Extracting response...');
    const response = await page.evaluate(() => {
        const turns = document.querySelectorAll('ms-chat-turn');
        const lastTurn = turns[turns.length - 1];
        if (!lastTurn) return null;
        
        const clone = lastTurn.cloneNode(true);
        
        // Remove buttons, icons, and UI elements more aggressively
        clone.querySelectorAll('button, mat-icon, [class*="icon"], [class*="search-suggestion"], [class*="grounding"], [class*="source"], .sources, .citation').forEach(el => el.remove());
        
        // Try to find the actual content element first - ms-chat-bubble contains the actual message
        const bubble = clone.querySelector('ms-chat-bubble');
        let sourceText = bubble ? bubble.innerText : clone.innerText;
        
        // Clean up grounding/sources text
        sourceText = sourceText
            .replace(/\[\d+\]/g, '') // Remove [1], [2], etc
            .replace(/Sources\s*help\s*\w+\.com\w*/gi, '') // Remove "Sources help domain.com..."
            .replace(/\w+\.org\s*/gi, '') // Remove domain.org
            .replace(/\w+\.com\s*/gi, '') // Remove domain.com
            .replace(/\w+\.edu\s*/gi, '') // Remove domain.edu
            .replace(/Google Search Suggestions?.*/gi, '') // Remove Google Search notice
            .replace(/Display of Search Suggestions?.*/gi, '') 
            .replace(/Grounding with Google Search.*/gi, '')
            .replace(/Learn more.*/gi, '');
        
        const lines = sourceText.split('\n').filter(l => {
            const t = l.trim();
            const tLower = t.toLowerCase();
            if (!t) return false;
            // Skip known UI artifacts
            if (['edit', 'more_vert', 'thumb_up', 'thumb_down', 'content_copy', 'model', 'user', 'sources', 'help'].includes(tLower)) return false;
            // Skip timing info like "0.8s" or "2.2s" 
            if (t.match(/^\d+\.?\d*s$/)) return false;
            // Skip if it looks like just a URL or domain
            if (t.match(/^[\w\.]+\.(com|org|edu|net)$/i)) return false;
            return true;
        });
        
        let result = lines.join('\n').trim();
        
        // Remove "Model" prefix if present
        if (result.startsWith('Model')) {
            result = result.substring(5).trim();
        }
        
        // Remove trailing timing like " 2.3s"
        result = result.replace(/\s*\d+\.?\d*s\s*$/, '').trim();
        
        // If result is empty but we have "Model180 1.3s" pattern, extract the number
        if (!result && sourceText) {
            const modelMatch = sourceText.match(/Model(.+?)\s*\d+\.?\d*s/);
            if (modelMatch) {
                result = modelMatch[1].trim();
            }
        }
        
        return result;
    });
    
    console.log(`10. Response: "${response}"`);
    
    await browser.disconnect();
    return response;
}

// Test it
const testPrompt = process.argv[2] || 'What is 7 times 8? Reply with ONLY the number.';
console.log(`\n=== Testing with prompt: "${testPrompt}" ===\n`);

sendAndGetResponse(testPrompt)
    .then(response => {
        console.log('\n✅ Success!');
        console.log('Final response:', response);
    })
    .catch(err => {
        console.error('\n❌ Error:', err.message);
        process.exit(1);
    });
