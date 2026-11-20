const express = require('express');
const { webkit } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 7860;
const API_SECRET = process.env.API_SECRET || "MY_SECRET_BOT_KEY_123";

let globalBrowser = null;

// TeraBox bot එකේ web app එකෙන් එන postMessage events (open_link වගේ) console එකට යවනවා
const TG_HOOK_JS = `
const _pm = window.postMessage.bind(window);
window.postMessage = function (msg, ...rest) {
    try {
        const d = typeof msg === 'string' ? JSON.parse(msg) : msg;
        if (d && d.eventType) console.log('TGEVENT ' + JSON.stringify(d));
    } catch (e) {}
    return _pm(msg, ...rest);
};
`;

// Thumbnail / stream links අයින් කරන්න
const SKIP_WORDS = ['.jpg', '.jpeg', '.gif', '.png', '.webp', 'thumb', 'avatar', 'favicon'];

// ---------- DEBUG helpers ----------
function makeDbg(debug) {
  return (msg) => {
    const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
    debug.push(line);
    console.log(`🔎 ${line}`);
  };
}

function short(u) {
  try {
    const x = new URL(u);
    return x.host + x.pathname.slice(0, 50);
  } catch (e) {
    return String(u).slice(0, 70);
  }
}

function firstLine(msg) {
  return String(msg || '').split('\n')[0].slice(0, 160);
}

async function getBrowser() {
  if (!globalBrowser || !globalBrowser.isConnected()) {
    console.log('🌐 Launching WebKit Browser Engine...');
    globalBrowser = await webkit.launch({
      headless: true
    });
  }
  return globalBrowser;
}

// API response එකේ තියෙන http links ඔක්කොම (path එකත් එක්ක) හොයනවා
function findLinks(obj, path = '') {
  let found = [];
  if (Array.isArray(obj)) {
    obj.forEach((value, index) => {
      found = found.concat(findLinks(value, `${path}[${index}]`));
    });
  } else if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      found = found.concat(findLinks(value, `${path}.${key}`));
    }
  } else if (typeof obj === 'string' && obj.startsWith('http')) {
    found.push({ path, url: obj });
  }
  return found;
}

// download link විතරයි (thumbnail සහ .m3u8 stream අයින්)
function directLinks(apiData) {
  const result = [];
  for (const { path, url } of findLinks(apiData)) {
    const low = (path + url).toLowerCase();
    if (SKIP_WORDS.some(word => low.includes(word)) || low.includes('stream') || low.includes('.m3u8')) {
      continue;
    }
    if (path.toLowerCase().includes('download') || path.toLowerCase().includes('dlink')) {
      result.push({ path, url });
    }
  }
  return result;
}

// Button එක උඩින් තියෙන overlay elements අයින් කරනවා
async function clearOverlay(page, btn) {
  const handle = await btn.elementHandle();
  await page.evaluate(el => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    for (let i = 0; i < 10; i++) {
      const top = document.elementFromPoint(x, y);
      if (!top || top === el || el.contains(top) || top.contains(el)) break;
      top.remove();
    }
  }, handle);
}

async function press(page, btn) {
  await clearOverlay(page, btn);
  try {
    await btn.click({ timeout: 5000 });
  } catch (e) {
    await btn.evaluate(el => el.click());
  }
}

// TeraBox web app එකෙන් download links (name + url + cookie) ගන්නවා. File එක ඩවුන්ලෝඩ් කරන්නේ නැහැ.
async function extractTeraboxFiles(context, shareLink, webappUrl, debug) {
  const dbg = makeDbg(debug);
  const files = [];        // { name, url, cookie, referer, userAgent }
  const openedLinks = [];
  let downloadEvents = 0;
  let userAgent = '';
  const seenNames = new Set(); // දැනටමත් අල්ලගත්ත file names
  let noise = 0;           // debug logs වැඩිවෙන එක පාලනය කරන්න
  const NOISE_LIMIT = 25;

  dbg(`START share=${shareLink} webapp=${short(webappUrl)}`);

  await context.addInitScript(TG_HOOK_JS);
  const page = await context.newPage();

  // ---- Debug: සියලුම page වල failed requests / 4xx 5xx responses / page errors ----
  context.on('requestfailed', r => {
    if (noise++ < NOISE_LIMIT) {
      const f = r.failure();
      dbg(`REQ FAILED ${short(r.url())} ${f ? f.errorText : ''}`);
    }
  });
  context.on('response', r => {
    if (r.status() >= 400 && noise++ < NOISE_LIMIT) {
      dbg(`HTTP ${r.status()} ${short(r.url())}`);
    }
  });
  page.on('pageerror', e => {
    if (noise++ < NOISE_LIMIT) dbg(`PAGEERROR ${firstLine(e.message)}`);
  });

  // Network / Web App Event Sniffing
  page.on('console', msg => {
    const text = msg.text();
    if (!text.startsWith('TGEVENT ')) return;
    try {
      const event = JSON.parse(text.slice(8));
      dbg(`TGEVENT ${event.eventType}`);
      if (['web_app_open_link', 'web_app_open_tg_link'].includes(event.eventType)) {
        const url = (event.eventData || {}).url;
        if (url) {
          openedLinks.push(url);
          dbg(`openedLinks +1 -> ${short(url)}`);
        }
      }
    } catch (e) {}
  });
  page.on('dialog', dlg => dlg.dismiss().catch(() => {}));

  // Browser එක download එකක් පටන් ගත්තම name + url අල්ලගෙන, එකම ගමන් cancel කරනවා
  const onDownload = async (download) => {
    const name = download.suggestedFilename();
    const url = download.url();
    dbg(`DOWNLOAD EVENT ${name} <- ${short(url)}`);

    // await එකට කලින්ම name එක mark කරනවා, නැත්නම් එකම file එකේ events දෙකක් එකවර ආවොත් දෙපාරක් push වෙනවා
    if (!files.some(f => f.name === name) && !seenNames.has(name)) {
      seenNames.add(name);
      let cookie = '';
      try {
        const cookies = await context.cookies(url);
        cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      } catch (e) {}
      files.push({ name, url, cookie, referer: webappUrl, userAgent });
      console.log(`📡 [DOWNLOAD DETECT] ${name}`);
    }

    downloadEvents++;
    try {
      await download.cancel(); // File එක API server එකේ save වෙන්න දෙන්නේ නැහැ
    } catch (e) {}
  };

  page.on('download', onDownload);
  context.on('page', pg => pg.on('download', onDownload));
  const helper = await context.newPage(); // download links open කරන්න එකම page එක
  // (helper එකට download listener එක context.on('page') එකෙන්ම ලැබෙනවා, ආයෙත් දාන්නේ නැහැ)

  await page.goto(webappUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  userAgent = await page.evaluate(() => navigator.userAgent);
  dbg(`web app loaded. UA=${userAgent.slice(0, 80)}`);

  const linkInput = page.locator('input[placeholder="Enter TeraBox link"]');
  await linkInput.waitFor({ timeout: 30000 });
  await linkInput.fill(shareLink);

  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/terabox/new'), { timeout: 180000 }),
    page.locator('form button[type="submit"]').click()
  ]);

  dbg(`API ${response.status()} ${short(response.url())}`);

  let apiData = null;
  try {
    const raw = await response.text();
    dbg(`API body (${raw.length} chars): ${raw.slice(0, 400)}`);
    apiData = JSON.parse(raw);
  } catch (e) {
    console.log(`⚠️ [API] response read කරන්න බැරි: ${e.message}`);
    dbg(`API parse fail: ${firstLine(e.message)}`);
  }

  let expected = 1;
  const data = apiData && typeof apiData === 'object' ? apiData.data : null;
  if (Array.isArray(data) && data.length) expected = data.length; // API එකේ files කීයක්ද
  console.log(`📁 [FILES] ${expected} expected`);

  const greenBtn = page.locator('button.bg-green-600', { hasText: 'Download' });
  try {
    await greenBtn.first().waitFor({ timeout: 180000 });
    dbg(`green button visible, count=${await greenBtn.count()}`);
  } catch (e) {
    throw new Error('Green Download button එක ආවේ නැහැ');
  }

  // අලුත් download event එකක් එනකම් (නැත්නම් time out වෙනකම්) බලාගෙන ඉන්නවා
  const waitForNew = async (startEvents, waitMs) => {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline && downloadEvents <= startEvents) {
      await page.waitForTimeout(500);
    }
  };

  const resetHelper = async () => {
    try {
      await helper.goto('about:blank', { timeout: 10000 });
    } catch (e) {}
  };

  // ---- Plan A: API download links ----
  const links = apiData ? directLinks(apiData) : [];
  dbg(`PLAN A: ${links.length} link(s) [${links.map(l => l.path).join(', ')}]`);

  for (const { path, url } of links) {
    if (files.length >= expected) break;
    const beforeFiles = files.length;
    const beforeEvents = downloadEvents;
    dbg(`A -> goto ${path} ${short(url)}`);
    try {
      const resp = await helper.goto(url, { timeout: 30000 });
      if (resp) {
        const h = resp.headers();
        dbg(`A status=${resp.status()} type=${h['content-type'] || '-'} disp=${(h['content-disposition'] || '-').slice(0, 60)}`);
      }
    } catch (e) {
      dbg(`A goto err: ${firstLine(e.message)}`);
    }
    await waitForNew(beforeEvents, 25000);
    dbg(`A result: files ${beforeFiles} -> ${files.length}`);
    if (files.length === beforeFiles) await resetHelper();
  }

  // ---- Plan A2: browser එකෙන් download event එක ආවේ නැත්නම් (WebKit එක inline media විදිහට handle කරනවා),
  //      API response එකේ තියෙන downloadLink එක කෙලින්ම ගන්නවා ----
  if (files.length < expected && apiData && Array.isArray(apiData.data)) {
    for (const item of apiData.data) {
      if (files.length >= expected) break;
      if (!item || item.isDir || typeof item.downloadLink !== 'string' || !item.downloadLink.startsWith('http')) continue;
      const name = item.fileName || 'file';
      if (files.some(f => f.name === name)) continue;
      let cookie = '';
      try {
        const cookies = await context.cookies(item.downloadLink);
        cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      } catch (e) {}
      files.push({ name, url: item.downloadLink, cookie, referer: webappUrl, userAgent });
      dbg(`A2 direct link used: ${name} <- ${short(item.downloadLink)}`);
      console.log(`📡 [API DIRECT] ${name}`);
    }
  }

  // ---- Plan B: green buttons ----
  if (files.length < expected) {
    dbg(`PLAN B start (files=${files.length}/${expected})`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const count = await greenBtn.count();
      dbg(`B attempt ${attempt}: green buttons=${count}`);
      for (let i = 0; i < Math.max(count, 1); i++) {
        if (files.length >= expected) break;

        const beforeFiles = files.length;
        const beforeEvents = downloadEvents;
        try {
          await press(page, greenBtn.nth(Math.min(i, count - 1)));
          dbg(`B pressed button #${i}`);
        } catch (e) {
          dbg(`B press err: ${firstLine(e.message)}`);
        }
        await waitForNew(beforeEvents, 60000);
        dbg(`B after press: files ${beforeFiles} -> ${files.length}, openedLinks=${openedLinks.length}`);

        if (files.length === beforeFiles && openedLinks.length) {
          const retryFiles = files.length;
          const retryEvents = downloadEvents;
          const target = openedLinks.shift();
          dbg(`B retry via openedLink ${short(target)}`);
          try {
            const resp = await helper.goto(target, { timeout: 30000 });
            if (resp) dbg(`B openedLink status=${resp.status()}`);
          } catch (e) {
            dbg(`B openedLink err: ${firstLine(e.message)}`);
          }
          await waitForNew(retryEvents, 60000);
          dbg(`B openedLink result: files ${retryFiles} -> ${files.length}`);
          if (files.length === retryFiles) await resetHelper();
        }

        for (const pg of context.pages()) {
          if (pg !== page && pg !== helper && !pg.isClosed()) {
            await pg.close().catch(() => {});
          }
        }
      }
      if (files.length >= expected) break;
    }
  }

  dbg(`DONE files=${files.length}/${expected} downloadEvents=${downloadEvents}`);
  return { files, expected };
}

app.post('/api/automate', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${API_SECRET}`) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { shareLink, webappUrl, action } = req.body;

  if (action === 'get_terabox_files') {
    console.log(`\n📩 [REQ RECEIVED] Processing: ${shareLink}`);

    if (!shareLink || !webappUrl) {
      return res.status(400).json({ success: false, error: 'shareLink and webappUrl are required' });
    }

    let context = null;
    const debug = [];

    try {
      const browser = await getBrowser();

      context = await browser.newContext({
        acceptDownloads: true,
        viewport: { width: 480, height: 900 }
      });

      const { files, expected } = await extractTeraboxFiles(context, shareLink, webappUrl, debug);

      await context.close();
      console.log(`🧹 [CLEANUP] Context closed successfully.`);

      if (files.length) {
        return res.json({ success: true, data: { files, expected } });
      } else {
        return res.json({ success: false, error: 'Download links not found', debug });
      }

    } catch (error) {
      if (context) await context.close().catch(() => {});
      console.log(`💥 [ERROR] ${error.message}`);
      debug.push(`ERROR: ${firstLine(error.message)}`);
      return res.status(500).json({ success: false, error: error.message, debug });
    }
  }

  return res.status(400).json({ success: false, error: 'Invalid action' });
});

app.listen(PORT, () => {
  console.log(`🚀 TeraBox Playwright WebKit API Running on Port ${PORT}`);
});
