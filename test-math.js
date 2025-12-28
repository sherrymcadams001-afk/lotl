// Test the LotL Controller with a unique prompt
const http = require('http');

const data = JSON.stringify({
    target: 'gemini',
    prompt: 'What is 2 plus 2? Answer with just the number.'
});

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/chat',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
    },
    timeout: 60000
};

console.log('Testing LotL Controller...');
console.log('Prompt:', JSON.parse(data).prompt);
console.log('---');

const req = http.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        try {
            const json = JSON.parse(body);
            if (json.success) {
                console.log('✅ SUCCESS!');
                console.log('AI Reply:', json.reply);
            } else {
                console.log('❌ Error:', json.error);
            }
        } catch (e) {
            console.log('Raw response:', body);
        }
    });
});

req.on('error', (e) => console.error('Request failed:', e.message));
req.on('timeout', () => { req.destroy(); console.error('Request timed out'); });

req.write(data);
req.end();
