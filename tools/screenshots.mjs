// Captures the README screenshots into docs/ from the running viewer.
// Requires the viewer and agent-browser to be running. Run: node --import <platform-linux.mjs> tools/screenshots.mjs
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
const require = createRequire('/home/key/.local/share/playwright-mcp/node_modules/');
const { chromium } = require('playwright-core');
const ab = (...a) => new Promise(r => execFile('/home/key/.local/bin/agent-browser', a, { timeout: 20000 }, (e, o) => r(e ? '' : o.trim())));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const original = await ab('get', 'url');
await ab('open', 'http://127.0.0.1:4860/');
await sleep(1500);
// load a striking WebGPU piece so the viewer showcases GPU graphics + the stats bar
await ab('eval', "(function(){var n=document.getElementById('navToggle');if(n)n.click();var t=[...document.querySelectorAll('#list li')].find(l=>/Raymarch/i.test(l.textContent));if(t)t.click();return 1;})()");
const browser = await chromium.launch({ executablePath: '/data/data/com.termux/files/usr/bin/chromium-browser', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 832, height: 468 }, deviceScaleFactor: 2 });
await page.goto('http://127.0.0.1:4850/');
await page.waitForFunction(() => frame !== null); await sleep(1500);
await page.screenshot({ path: 'docs/viewer.png' });
await page.evaluate(() => document.getElementById('tabsBtn').click()); await sleep(600);
await page.screenshot({ path: 'docs/tabs.png' });
await page.evaluate(() => { document.getElementById('scrim').click(); document.getElementById('urlBtn').click(); }); await sleep(500);
await page.screenshot({ path: 'docs/address.png' });
await page.evaluate(() => { document.getElementById('urlClose').click(); document.getElementById('tabsBtn').click(); document.getElementById('con').click(); });
await ab('eval', `console.log('hello from the page'); console.warn('low battery'); setTimeout(() => { throw new Error('something broke') }, 0); 1`); await sleep(2500);
await page.evaluate(() => { const l = document.getElementById('log'); l.scrollTop = l.scrollHeight; });
await page.screenshot({ path: 'docs/console.png' });
await browser.close();
if (original && !original.startsWith('about:')) await ab('open', original);
console.log('wrote docs/viewer.png docs/tabs.png docs/address.png docs/console.png');
