const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

const AUTH = { username: 'bwa', password: 'bwazax' };

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'vaxerban-zaax-secret-' + Math.random().toString(36).slice(2),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 4 } // 4 jam
}));

// Static files (login.html aja yang public)
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// AUTH MIDDLEWARE
// ============================================
function requireAuth(req, res, next) {
  if (req.session && req.session.loggedIn) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login.html');
}

// ============================================
// ROUTES
// ============================================
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === AUTH.username && password === AUTH.password) {
    req.session.loggedIn = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Username atau password salah' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.loggedIn) });
});

// ============================================
// SSE LOG STREAM
// ============================================
let activeClients = [];

function broadcast(type, msg) {
  const payload = JSON.stringify({ type, msg, ts: Date.now() });
  activeClients.forEach(res => {
    try { res.write(`data: ${payload}\n\n`); } catch (e) {}
  });
}

app.get('/api/logs', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  activeClients.push(res);
  res.write(`data: ${JSON.stringify({ type: 'info', msg: 'Connected to log stream', ts: Date.now() })}\n\n`);

  req.on('close', () => {
    activeClients = activeClients.filter(c => c !== res);
  });
});

// ============================================
// REPORT LOGIC (dari script lo)
// ============================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function formatPhone(phone) {
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('0')) p = '62' + p.slice(1);
  if (!p.startsWith('62')) p = '62' + p;
  return p;
}

async function reportViaWhatsAppWeb(browser, phone) {
  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  try {
    broadcast('info', `[WA-WEB] Buka chat ke ${phone}...`);
    await page.goto(`https://web.whatsapp.com/send?phone=${phone}`, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    await sleep(5000);

    const needsQR = await page.evaluate(() => {
      return document.querySelector('canvas[aria-label*="Scan"]') !== null ||
             document.body.innerText.includes('Scan the QR code');
    });

    if (needsQR) {
      broadcast('warn', '[WA-WEB] Perlu scan QR. Buka browser, scan dalam 60 detik...');
      await sleep(60000);
    }

    await sleep(2000);
    const menuBtn = await page.$('div[title="Menu"]') || await page.$('span[data-icon="menu"]');
    if (menuBtn) {
      await menuBtn.click();
      await sleep(1500);
    }

    const reportBtn = await page.$('div[aria-label*="Report"]') ||
                      await page.$('li[data-testid="mi-report"]') ||
                      await page.evaluateHandle(() => {
                        const els = [...document.querySelectorAll('div, li, span')];
                        return els.find(e => e.textContent.trim() === 'Report');
                      });

    if (reportBtn) {
      await reportBtn.click();
      await sleep(2000);

      const reasons = ['Spam', 'Abusive', "I don't know this person", 'Other'];
      const reasonBtn = await page.evaluateHandle((reasons) => {
        const els = [...document.querySelectorAll('div, li, span, label')];
        for (const r of reasons) {
          const found = els.find(e => e.textContent.trim().toLowerCase() === r.toLowerCase());
          if (found) return found;
        }
        return null;
      }, reasons);

      if (reasonBtn) {
        await reasonBtn.click();
        await sleep(1500);
      }

      const submitBtn = await page.evaluateHandle(() => {
        const els = [...document.querySelectorAll('button, div[role="button"]')];
        return els.find(e => /report|submit|send/i.test(e.textContent));
      });

      if (submitBtn) {
        await submitBtn.click();
        await sleep(2000);
      }
    }

    await page.close();
    broadcast('success', '[WA-WEB] Report submitted');
    return true;
  } catch (err) {
    broadcast('error', `[WA-WEB] ${err.message}`);
    try { await page.close(); } catch (e) {}
    return false;
  }
}

async function reportViaSupportForm(browser, phone) {
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

  try {
    broadcast('info', '[SUPPORT] Buka form report abuse...');
    await page.goto('https://www.whatsapp.com/contact/?subject=report_abuse', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });
    await sleep(3000);

    const phoneField = await page.$('input[name="phone"]') ||
                       await page.$('input[type="tel"]');
    if (phoneField) await phoneField.type(phone);

    const descField = await page.$('textarea[name="description"]') ||
                      await page.$('textarea');
    if (descField) {
      await descField.type('This number is sending spam and abusive messages. Please review and take action.');
    }

    const submitBtn = await page.$('button[type="submit"]') ||
                      await page.$('input[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
      await sleep(3000);
    }

    await page.close();
    broadcast('success', '[SUPPORT] Form submitted');
    return true;
  } catch (err) {
    broadcast('error', `[SUPPORT] ${err.message}`);
    try { await page.close(); } catch (e) {}
    return false;
  }
}

// ============================================
// JOB RUNNER
// ============================================
let jobState = {
  running: false,
  target: null,
  current: 0,
  total: 0,
  success: 0,
  failed: 0,
  startedAt: null,
};

app.get('/api/job', requireAuth, (req, res) => {
  res.json(jobState);
});

app.post('/api/start', requireAuth, async (req, res) => {
  if (jobState.running) {
    return res.status(409).json({ ok: false, error: 'Job masih jalan boss, sabar.' });
  }

  const { target, reportCount, delayMin, delayMax, headless } = req.body;

  if (!target) return res.status(400).json({ ok: false, error: 'Nomor target kosong' });

  const cfg = {
    target: formatPhone(target),
    reportCount: Math.min(parseInt(reportCount) || 10, 500),
    delayMin: Math.max(parseInt(delayMin) || 3000, 500),
    delayMax: Math.max(parseInt(delayMax) || 8000, 1000),
    headless: headless === true || headless === 'true',
  };

  jobState = {
    running: true,
    target: cfg.target,
    current: 0,
    total: cfg.reportCount,
    success: 0,
    failed: 0,
    startedAt: new Date().toISOString(),
  };

  res.json({ ok: true, job: jobState });

  // Run async, gak block response
  runJob(cfg).catch(err => {
    broadcast('error', `JOB FATAL: ${err.message}`);
    jobState.running = false;
  });
});

async function runJob(cfg) {
  broadcast('info', `═══════════════════════════════════`);
  broadcast('info', `VAXERBAN by zaax — JOB START`);
  broadcast('info', `Target: ${cfg.target}`);
  broadcast('info', `Report count: ${cfg.reportCount}`);
  broadcast('info', `Delay: ${cfg.delayMin}-${cfg.delayMax}ms`);
  broadcast('info', `Headless: ${cfg.headless}`);
  broadcast('info', `═══════════════════════════════════`);

  const browser = await puppeteer.launch({
    headless: cfg.headless ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--window-size=1280,800'
    ],
    defaultViewport: { width: 1280, height: 800 }
  });

  for (let i = 1; i <= cfg.reportCount; i++) {
    jobState.current = i;
    broadcast('info', `[${i}/${cfg.reportCount}] Attempting report...`);

    let ok = false;
    if (i % 2 === 0) {
      ok = await reportViaSupportForm(browser, cfg.target);
    } else {
      ok = await reportViaWhatsAppWeb(browser, cfg.target);
    }

    if (ok) {
      jobState.success++;
      broadcast('success', `Report #${i} submitted (Success: ${jobState.success}, Failed: ${jobState.failed})`);
    } else {
      jobState.failed++;
      broadcast('error', `Report #${i} failed (Success: ${jobState.success}, Failed: ${jobState.failed})`);
    }

    if (i < cfg.reportCount) {
      const delay = cfg.delayMin + Math.random() * (cfg.delayMax - cfg.delayMin);
      broadcast('info', `Sleep ${Math.round(delay)}ms...`);
      await sleep(delay);
    }
  }

  broadcast('success', `═══════════════════════════════════`);
  broadcast('success', `JOB DONE! Success: ${jobState.success}, Failed: ${jobState.failed}`);
  broadcast('success', `═══════════════════════════════════`);

  try { await browser.close(); } catch (e) {}
  jobState.running = false;
}

// ============================================
// BOOT
// ============================================
app.listen(PORT, () => {
  console.log(chalk.bold.cyan('\n╔════════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('║   VAXERBAN by zaax — WEB EDITION       ║'));
  console.log(chalk.bold.cyan('╚════════════════════════════════════════╝'));
  console.log(chalk.green(`\n  ✓ Server jalan di http://localhost:${PORT}`));
  console.log(chalk.gray(`  ✓ Login: bwa / bwazax\n`));
});
