#!/usr/bin/env node

const path = require('path');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];

        if (key === 'help' || key === 'h') {
            out.help = true;
            continue;
        }

        if (next && !next.startsWith('--')) {
            out[key] = next;
            i++;
        } else {
            out[key] = true;
        }
    }
    return out;
}

function printHelp() {
    // Keep output compact; users can read README for full examples.
    console.log(`LotL Controller starter\n\nUsage:\n  node scripts/start-controller.js [--host 127.0.0.1] [--port 3000] [--chrome-port 9222] [--mode normal]\n\nOptions:\n  --host         Bind address (default: controller default)\n  --port         HTTP port (default: controller default)\n  --chrome-port  Chrome remote debugging port (default: controller default)\n  --mode         Controller mode: normal | single | multi (default: normal)\n`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
    printHelp();
    process.exit(0);
}

if (args.host) process.env.HOST = String(args.host);
if (args.port) process.env.PORT = String(args.port);
if (args['chrome-port']) process.env.CHROME_PORT = String(args['chrome-port']);
if (args.mode) process.env.LOTL_MODE = String(args.mode);

// Load the controller in-process so we don't rely on shell-specific scripts.
require(path.join(__dirname, '..', 'lotl-controller-v3.js'));
