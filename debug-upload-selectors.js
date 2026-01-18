/**
 * 🔍 AI Studio Upload Selector Discovery Tool
 * 
 * Run this script to inspect AI Studio's current DOM and find
 * the correct selectors for image upload functionality.
 * 
 * Prerequisites:
 *   1. Chrome running with --remote-debugging-port=9222
 *   2. aistudio.google.com open in a tab
 * 
 * Usage:
 *   node debug-upload-selectors.js
 */

const puppeteer = require('puppeteer-core');

async function discoverSelectors() {
    console.log('🔍 AI Studio Upload Selector Discovery Tool\n');
    console.log('=' .repeat(60));
    
    try {
        // Connect to Chrome
        const res = await fetch('http://127.0.0.1:9222/json/version');
        const data = await res.json();
        
        const browser = await puppeteer.connect({
            browserWSEndpoint: data.webSocketDebuggerUrl,
            defaultViewport: null
        });
        
        const pages = await browser.pages();
        const page = pages.find(p => p.url().includes('aistudio.google.com'));
        
        if (!page) {
            console.error('❌ AI Studio tab not found. Open aistudio.google.com first.');
            process.exit(1);
        }
        
        console.log('✅ Connected to AI Studio\n');
        
        // ============================================
        // 1. Find all buttons in footer area
        // ============================================
        console.log('📌 FOOTER BUTTONS:\n');
        
        const footerButtons = await page.evaluate(() => {
            const buttons = document.querySelectorAll('footer button');
            return Array.from(buttons).map(btn => ({
                ariaLabel: btn.getAttribute('aria-label'),
                matTooltip: btn.getAttribute('mattooltip'),
                dataTooltip: btn.getAttribute('data-tooltip'),
                className: btn.className,
                innerHTML: btn.innerHTML.substring(0, 200),
                hasMatIcon: btn.querySelector('mat-icon') ? true : false,
                matIconFont: btn.querySelector('mat-icon')?.getAttribute('fonticon'),
                outerHTML: btn.outerHTML.substring(0, 300)
            }));
        });
        
        footerButtons.forEach((btn, i) => {
            console.log(`Button ${i + 1}:`);
            console.log(`  aria-label: ${btn.ariaLabel || '(none)'}`);
            console.log(`  mattooltip: ${btn.matTooltip || '(none)'}`);
            console.log(`  data-tooltip: ${btn.dataTooltip || '(none)'}`);
            console.log(`  class: ${btn.className || '(none)'}`);
            console.log(`  mat-icon fonticon: ${btn.matIconFont || '(none)'}`);
            console.log(`  snippet: ${btn.outerHTML.substring(0, 150)}...`);
            console.log('');
        });
        
        // ============================================
        // 2. Find all file inputs
        // ============================================
        console.log('\n📌 FILE INPUTS:\n');
        
        const fileInputs = await page.evaluate(() => {
            const inputs = document.querySelectorAll('input[type="file"]');
            return Array.from(inputs).map(inp => ({
                id: inp.id,
                name: inp.name,
                accept: inp.accept,
                className: inp.className,
                hidden: inp.hidden || inp.style.display === 'none' || inp.offsetParent === null,
                multiple: inp.multiple,
                outerHTML: inp.outerHTML
            }));
        });
        
        if (fileInputs.length === 0) {
            console.log('  (no file inputs found - may be dynamically created)');
        } else {
            fileInputs.forEach((inp, i) => {
                console.log(`File Input ${i + 1}:`);
                console.log(`  id: ${inp.id || '(none)'}`);
                console.log(`  name: ${inp.name || '(none)'}`);
                console.log(`  accept: ${inp.accept || '(any)'}`);
                console.log(`  hidden: ${inp.hidden}`);
                console.log(`  multiple: ${inp.multiple}`);
                console.log(`  HTML: ${inp.outerHTML}`);
                console.log('');
            });
        }
        
        // ============================================
        // 3. Find buttons with attachment-related icons
        // ============================================
        console.log('\n📌 ATTACHMENT-RELATED ELEMENTS:\n');
        
        const attachElements = await page.evaluate(() => {
            const results = [];
            
            // Search for elements with attachment-related attributes
            const searchTerms = ['attach', 'upload', 'file', 'image', 'insert', 'add', 'photo'];
            
            // Check all elements with aria-label
            document.querySelectorAll('[aria-label]').forEach(el => {
                const label = el.getAttribute('aria-label').toLowerCase();
                if (searchTerms.some(term => label.includes(term))) {
                    results.push({
                        tag: el.tagName,
                        ariaLabel: el.getAttribute('aria-label'),
                        selector: el.tagName.toLowerCase() + '[aria-label="' + el.getAttribute('aria-label') + '"]'
                    });
                }
            });
            
            // Check mat-icons with fonticon
            document.querySelectorAll('mat-icon[fonticon]').forEach(el => {
                const icon = el.getAttribute('fonticon');
                if (searchTerms.some(term => icon.includes(term)) || 
                    ['attach_file', 'add_photo_alternate', 'image', 'upload_file', 'cloud_upload'].includes(icon)) {
                    results.push({
                        tag: 'mat-icon',
                        fonticon: icon,
                        parentTag: el.parentElement?.tagName,
                        selector: `mat-icon[fonticon="${icon}"]`
                    });
                }
            });
            
            return results;
        });
        
        if (attachElements.length === 0) {
            console.log('  (no attachment-related elements found)');
        } else {
            attachElements.forEach((el, i) => {
                console.log(`Element ${i + 1}:`);
                Object.entries(el).forEach(([k, v]) => {
                    console.log(`  ${k}: ${v}`);
                });
                console.log('');
            });
        }
        
        // ============================================
        // 4. Find the prompt input area structure
        // ============================================
        console.log('\n📌 INPUT AREA STRUCTURE:\n');
        
        const inputStructure = await page.evaluate(() => {
            const footer = document.querySelector('footer');
            if (!footer) return 'Footer not found';
            
            function describe(el, depth = 0) {
                if (depth > 3) return '';
                const indent = '  '.repeat(depth);
                const tag = el.tagName.toLowerCase();
                const id = el.id ? `#${el.id}` : '';
                const cls = el.className && typeof el.className === 'string' 
                    ? '.' + el.className.split(' ').slice(0, 2).join('.') 
                    : '';
                const aria = el.getAttribute('aria-label') ? ` [aria-label="${el.getAttribute('aria-label')}"]` : '';
                
                let result = `${indent}<${tag}${id}${cls}${aria}>\n`;
                
                Array.from(el.children).forEach(child => {
                    result += describe(child, depth + 1);
                });
                
                return result;
            }
            
            return describe(footer);
        });
        
        console.log(inputStructure);
        
        // ============================================
        // 5. Recommended selectors
        // ============================================
        console.log('\n📌 RECOMMENDED SELECTORS TO TRY:\n');
        
        const recommendedSelectors = await page.evaluate(() => {
            const selectors = [];
            
            // Test various selectors and report which work
            const toTest = [
                'input[type="file"]',
                'input[type="file"][accept*="image"]',
                'button[aria-label*="Insert"]',
                'button[aria-label*="Upload"]',
                'button[aria-label*="Attach"]',
                'button[aria-label*="Add"]',
                'button mat-icon[fonticon="attach_file"]',
                'button mat-icon[fonticon="add_photo_alternate"]',
                'button:has(mat-icon[fonticon="attach_file"])',
                '[mattooltip*="Insert"]',
                '[mattooltip*="Upload"]',
                '[data-tooltip*="upload"]',
                'footer button:first-child',
                'footer button:last-child'
            ];
            
            toTest.forEach(sel => {
                try {
                    const found = document.querySelector(sel);
                    if (found) {
                        selectors.push({
                            selector: sel,
                            tag: found.tagName,
                            ariaLabel: found.getAttribute('aria-label') || '(none)'
                        });
                    }
                } catch (e) {
                    // Invalid selector
                }
            });
            
            return selectors;
        });
        
        if (recommendedSelectors.length === 0) {
            console.log('  ⚠️ No common selectors matched - UI may have changed');
        } else {
            recommendedSelectors.forEach(sel => {
                console.log(`  ✅ ${sel.selector}`);
                console.log(`     → ${sel.tag} [aria-label: ${sel.ariaLabel}]`);
            });
        }
        
        // ============================================
        // 6. Take screenshot for reference
        // ============================================
        const screenshotPath = 'ai-studio-footer-debug.png';
        
        // Scroll to bottom and screenshot footer
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await new Promise(r => setTimeout(r, 500));
        
        const footer = await page.$('footer');
        if (footer) {
            await footer.screenshot({ path: screenshotPath });
            console.log(`\n📸 Footer screenshot saved: ${screenshotPath}`);
        }
        
        console.log('\n' + '=' .repeat(60));
        console.log('🏁 Discovery complete!');
        console.log('\nUpdate the selectors in lotl-controller-v3.js based on these findings.');
        
        // Don't disconnect - leave Chrome session intact
        
    } catch (e) {
        console.error('❌ Error:', e.message);
        console.error(e.stack);
    }
}

discoverSelectors();
