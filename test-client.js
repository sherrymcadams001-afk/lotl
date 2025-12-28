// Test the LotL Controller
const http = require('http');

const data = JSON.stringify({
    target: 'gemini',
    prompt: 'Say hello in exactly 3 words'
});

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/chat',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length
    }
};

console.log('Sending request to LotL Controller...');

const req = http.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        console.log('Response:', body);
        try {
            const json = JSON.parse(body);
            if (json.success) {
                console.log('\n✅ AI Reply:', json.reply);
            } else {
                console.log('\n❌ Error:', json.error);
            }
        } catch (e) {
            console.log('Raw response:', body);
        }
    });
});

req.on('error', (e) => {
    console.error('Request failed:', e.message);
});

req.write(data);
req.end();
