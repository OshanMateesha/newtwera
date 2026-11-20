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
async function extractTeraboxFiles(context, shareLink, webappUrl) {
  const files = [];        // { name, url, cookie, referer, userAgent }
  const openedLinks = [];
  let downloadEvents = 0;
  let userAgent = '';

  await context.addInitScript(TG_HOOK_JS);
  const page = await context.newPage();

  // Network / Web App Event Sniffing
  page.on('console', msg => {
    const text = msg.text();
    if (!text.startsWith('TGEVENT ')) return;
    try {
      const event = JSON.parse(text.slice(8));
      if (['web_app_open_link', 'web_app_open_tg_link'].includes(event.eventType)) {
        const url = (event.eventData || {}).url;
        if (url) openedLinks.push(url);
      }
    } catch (e) {}
  });
  page.on('dialog', dlg => dlg.dismiss().catch(() => {}));

  // Browser එක download එකක් පටන් ගත්තම name + url අල්ලගෙන, එකම ගමන් cancel කරනවා
  const onDownload = async (download) => {
    const name = download.suggestedFilename();
    const url = download.url();

    if (!files.some(f => f.name === name)) {
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

  await page.goto(webappUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  userAgent = await page.evaluate(() => navigator.userAgent);

  const linkInput = page.locator('input[placeholder="Enter TeraBox link"]');
  await linkInput.waitFor({ timeout: 30000 });
  await linkInput.fill(shareLink);

  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/terabox/new'), { timeout: 180000 }),
    page.locator('form button[type="submit"]').click()
  ]);

  let apiData = null;
  try {
    apiData = await response.json();
  } catch (e) {
    console.log(`⚠️ [API] response read කරන්න බැරි: ${e.message}`);
  }

  let expected = 1;
  const data = apiData && typeof apiData === 'object' ? apiData.data : null;
  if (Array.isArray(data) && data.length) expected = data.length; // API එකේ files කීයක්ද
  console.log(`📁 [FILES] ${expected} expected`);

  const greenBtn = page.locator('button.bg-green-600', { hasText: 'Download' });
  try {
    await greenBtn.first().waitFor({ timeout: 180000 });
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
  if (apiData) {
    for (const { url } of directLinks(apiData)) {
      if (files.length >= expected) break;
      const beforeFiles = files.length;
      const beforeEvents = downloadEvents;
      try {
        await helper.goto(url, { timeout: 30000 });
      } catch (e) {}
      await waitForNew(beforeEvents, 25000);
      if (files.length === beforeFiles) await resetHelper();
    }
  }

  // ---- Plan B: green buttons ----
  if (files.length < expected) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const count = await greenBtn.count();
      for (let i = 0; i < Math.max(count, 1); i++) {
        if (files.length >= expected) break;

        const beforeFiles = files.length;
        const beforeEvents = downloadEvents;
        await press(page, greenBtn.nth(Math.min(i, count - 1)));
        await waitForNew(beforeEvents, 60000);

        if (files.length === beforeFiles && openedLinks.length) {
          const retryFiles = files.length;
          const retryEvents = downloadEvents;
          try {
            await helper.goto(openedLinks.shift(), { timeout: 30000 });
          } catch (e) {}
          await waitForNew(retryEvents, 60000);
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

    try {
      const browser = await getBrowser();

      context = await browser.newContext({
        acceptDownloads: true,
        viewport: { width: 480, height: 900 }
      });

      const { files, expected } = await extractTeraboxFiles(context, shareLink, webappUrl);

      await context.close();
      console.log(`🧹 [CLEANUP] Context closed successfully.`);

      if (files.length) {
        return res.json({ success: true, data: { files, expected } });
      } else {
        return res.json({ success: false, error: 'Download links not found' });
      }

    } catch (error) {
      if (context) await context.close().catch(() => {});
      console.log(`💥 [ERROR] ${error.message}`);
      return res.status(500).json({ success: false, error: error.message });
    }
  }

  return res.status(400).json({ success: false, error: 'Invalid action' });
});

app.listen(PORT, () => {
  console.log(`🚀 TeraBox Playwright WebKit API Running on Port ${PORT}`);
});
