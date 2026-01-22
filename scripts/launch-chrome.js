#!/usr/bin/env node

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
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
    console.log(`Launch Chrome with CDP enabled\n\nUsage:\n  node scripts/launch-chrome.js [--chrome-port 9222] [--user-data-dir <dir>] [--chrome-path <path>]\n\nNotes:\n  - If Chrome isn't on PATH (common on Windows), pass --chrome-path or set CHROME_PATH.\n\nExamples:\n  node scripts/launch-chrome.js --chrome-port 9222\n  node scripts/launch-chrome.js --chrome-port 9223 --user-data-dir /tmp/chrome-lotl-9223\n  node scripts/launch-chrome.js --chrome-port 9222 --chrome-path "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"\n`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
    printHelp();
    process.exit(0);
}

const chromePort = Number(args['chrome-port'] || 9222);
if (!Number.isFinite(chromePort) || chromePort <= 0) {
    console.error('Invalid --chrome-port');
    process.exit(1);
}

const defaultUserDataDir = (() => {
    if (process.platform === 'win32') {
        // Prefer a persistent dir so users stay logged in between runs.
        // Fallback to TEMP if LOCALAPPDATA is unavailable.
        const base = process.env.LOCALAPPDATA || process.env.TEMP || 'C:\\temp';
        return path.join(base, 'LotL', `chrome-lotl-${chromePort}`);
    }
    // Prefer a persistent dir so users stay logged in between runs.
    const home = process.env.HOME || os.homedir() || os.tmpdir();
    return path.join(home, '.lotl', `chrome-lotl-${chromePort}`);
})();

const userDataDir = String(args['user-data-dir'] || defaultUserDataDir);
const chromeArgs = [`--remote-debugging-port=${chromePort}`, `--user-data-dir=${userDataDir}`];

try {
    fs.mkdirSync(userDataDir, { recursive: true });
} catch {
    // If mkdir fails (permissions), Chrome will surface the error; we keep going.
}

function resolveChromePath() {
    const argPath = args['chrome-path'] ? String(args['chrome-path']) : null;
    const envPath = process.env.CHROME_PATH ? String(process.env.CHROME_PATH) : null;
    const explicit = argPath || envPath;
    if (explicit) {
        if (fs.existsSync(explicit)) return explicit;
        throw new Error(`Chrome not found at: ${explicit}`);
    }

    if (process.platform === 'darwin') {
        // We'll use `open -na "Google Chrome"`.
        return null;
    }

    if (process.platform === 'win32') {
        const candidates = [
            process.env.PROGRAMFILES
                ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
                : null,
            process.env['PROGRAMFILES(X86)']
                ? path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
                : null,
            process.env.LOCALAPPDATA
                ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
                : null
        ].filter(Boolean);
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }

        // Last resort: look up via where.exe
        const where = spawnSync('where', ['chrome.exe'], { encoding: 'utf8' });
        if (where.status === 0 && where.stdout) {
            const line = where.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
            if (line && fs.existsSync(line)) return line;
        }

        throw new Error(
            'Could not find chrome.exe. Install Google Chrome or provide --chrome-path / CHROME_PATH.'
        );
    }

    // Linux best-effort
    const bins = ['google-chrome', 'chromium', 'chromium-browser'];
    for (const bin of bins) {
        const which = spawnSync('which', [bin], { encoding: 'utf8' });
        if (which.status === 0 && which.stdout) {
            const resolved = which.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
            if (resolved) return resolved;
        }
    }

    throw new Error('Could not find Chrome binary. Provide --chrome-path / CHROME_PATH.');
}

function launch() {
    if (process.platform === 'darwin') {
        // macOS: use open so we don't need the direct binary path.
        return spawn('open', ['-na', 'Google Chrome', '--args', ...chromeArgs], {
            detached: true,
            stdio: 'ignore'
        });
    }

    if (process.platform === 'win32') {
        const chromePath = resolveChromePath();
        return spawn(chromePath, chromeArgs, {
            detached: true,
            stdio: 'ignore'
        });
    }

    const chromePath = resolveChromePath();
    return spawn(chromePath, chromeArgs, {
        detached: true,
        stdio: 'ignore'
    });
}

try {
    // Resolve early so missing Chrome fails fast (and doesn't crash via async ENOENT).
    if (process.platform !== 'darwin') resolveChromePath();
    const child = launch();
    child.once('error', (err) => {
        console.error(`❌ Failed to launch Chrome: ${err.message}`);
        console.error('   Provide --chrome-path or set CHROME_PATH.');
        process.exit(1);
    });
    child.unref();
    console.log(`✅ Launched Chrome (CDP) on port ${chromePort}`);
    console.log(`   user-data-dir: ${userDataDir}`);
} catch (e) {
    console.error(`❌ Failed to launch Chrome: ${e.message}`);
    console.error('   Launch Chrome manually with:');
    console.error(`   --remote-debugging-port=${chromePort} --user-data-dir=${userDataDir}`);
    process.exit(1);
}
