// lib/powercost.js
import fetch from 'node-fetch';
import fetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { load as cheerioLoad } from 'cheerio';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ENV loading
function ensureEnvLoaded(verbose = false) {
  const names = ['MEAGPOWER_USER', 'MEAGPOWER_PASS'];
  const hadAny = names.some(n => Object.prototype.hasOwnProperty.call(process.env, n));
  if (!hadAny) {
    const root = path.join(__dirname, '..');
    dotenv.config({ path: path.join(root, '.env') });
    dotenv.config({ path: path.join(root, '.env.local'), override: true });
  }
  if (verbose) {
    const seen = Object.fromEntries(
      names
        .filter(n => Object.prototype.hasOwnProperty.call(process.env, n))
        .map(n => [n, process.env[n] ? '(set)' : '(empty)'])
    );
    console.log('[powercost env probe]', seen);
  }
}

function readCreds() {
  const username = process.env.MEAGPOWER_USER;
  const password = process.env.MEAGPOWER_PASS;
  return { username, password };
}

// Constants
const BASE = 'https://b2b.meagpower.org';
const LOGIN_URL = `${BASE}/login.aspx?ReturnUrl=%2fpricing.aspx`;
const PRICING_URL = `${BASE}/pricing.aspx`;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// HELPERS 
function pickSubmit($, root) {
  let submitName = null;
  $(root).find('input,button,a').each((_, el) => {
    const $el = $(el);
    const tag = ($el.prop('tagName') || '').toLowerCase();
    const type = ($el.attr('type') || '').toLowerCase();
    const name = $el.attr('name') || '';
    const val  = ($el.attr('value') || $el.text() || '').toLowerCase();

    // Strict match first
    if (!submitName && /cmdlogin|btnlogin|loginbutton/.test(name.toLowerCase())) {
      submitName = name;
    }
    // Otherwise accept obvious "login" submit buttons
    if (!submitName && (type === 'submit' || tag === 'button') && /login/.test(val + name.toLowerCase())) {
      submitName = name || 'login';
    }
  });
  return submitName;
}

function pickEventTarget($, root) {
  // If it's a linkbutton that uses __doPostBack('...',''), capture the target
  let target = null;
  $(root).find('a,button').each((_, el) => {
    const onclk = ($(el).attr('onclick') || '').toString();
    const m = onclk.match(/__doPostBack\('([^']+)'/);
    if (m && !target) target = m[1];
  });
  return target;
}

function isLoggedIn(html) {
  const lower = html.toLowerCase();
  // Pricing page should contain cents/kwh or $/mwh headings or a “forecast” keyword
  return (
    lower.includes('¢ / kwh') ||
    lower.includes('c / kwh') ||
    lower.includes('/mwh') ||
    lower.includes('forecast')
  );
}

// Login flow
async function loginAndGetFetcher({ username, password, debug = false }) {
  const jar = new CookieJar();
  const f = fetchCookie(fetch, jar);

  // 1) GET login page
  const resp = await f(LOGIN_URL, { redirect: 'follow', headers: { 'user-agent': UA } });
  const html = await resp.text();
  const $ = cheerioLoad(html);

  // Locate the *form* that has username/password inputs
  let $form = null;
  $('form').each((_, form) => {
    const hasUser = $(form).find('input[name*="user"], input[name*="User"], input[name*="Username"]').length > 0;
    const hasPass = $(form).find('input[type="password"]').length > 0;
    if (hasUser && hasPass && !$form) $form = $(form);
  });
  if (!$form) $form = $('form').first();

  const formAction = $form?.attr('action') ? new URL($form.attr('action'), LOGIN_URL).toString() : LOGIN_URL;
  const payload = {};

  // Include all hidden fields (VIEWSTATE, EVENTVALIDATION, etc.)
  $form.find('input[type="hidden"]').each((_, el) => {
    const name = $(el).attr('name');
    if (name) payload[name] = $(el).attr('value') ?? '';
  });

  // Username & password field names
  const userField = $form.find('input[name*="user"], input[name*="User"], input[name*="Username"]').attr('name');
  const passField = $form.find('input[type="password"]').attr('name');
  if (debug) console.log('[powercost] fields:', { userField, passField, formAction });

  payload[userField || 'username'] = username;
  payload[passField || 'password'] = password;

  // Submit mechanism
  const submitName = pickSubmit($, $form);
  const eventTarget = pickEventTarget($, $form);
  if (submitName) {
    payload[submitName] = 'Log In';
  } else if (eventTarget) {
    payload['__EVENTTARGET'] = eventTarget;
    payload['__EVENTARGUMENT'] = '';
  } else {
    // last resort — a common DNN login button id
    payload['dnn$ctr$Login$Login_DNN$cmdLogin'] = 'Log In';
  }

  // 2) POST login (follow redirects)
  const postResp = await f(formAction, {
    method: 'POST',
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded',
      'referer': LOGIN_URL
    },
    body: new URLSearchParams(payload).toString()
  });

  // If we’re already at pricing page, great; otherwise fetch it
  const pricingResp = await f(PRICING_URL, { redirect: 'follow', headers: { 'user-agent': UA } });
  const pricingHtml = await pricingResp.text();

  if (debug) {
    console.log('[powercost] after login URL:', pricingResp.url || PRICING_URL);
    console.log('[powercost] pricing status:', pricingResp.status);
  }

  if (!isLoggedIn(pricingHtml)) {
    if (debug) {
      const dumpPath = path.join(__dirname, 'pricing.debug.html');
      fs.writeFileSync(dumpPath, pricingHtml, 'utf8');
      console.warn('[powercost] Not logged in or table not found; wrote snapshot to', dumpPath);
    }
    throw new Error('Not authenticated (pricing page did not look like pricing)');
  }

  return { f, pricingHtml };
}

// Parse the table headered with "¢ / KWH"
function parseTableMinMaxCents(pricingHtml) {
  const $ = cheerioLoad(pricingHtml);

  // Find the right table by header text
  let target = null;
  $('table').each((_, tbl) => {
    const head = $(tbl).find('th, thead').text().toLowerCase();
    if (head.includes('¢') && head.includes('kwh')) target = tbl;
  });
  if (!target) {
    $('table').each((_, tbl) => {
      const text = $(tbl).text().toLowerCase();
      if (text.includes('/mwh') && (text.includes('¢') || text.includes('c/kwh') || text.includes('kwh'))) {
        target = tbl;
      }
    });
  }
  if (!target) return null;

  // Locate the cents/kWh column index
  let centsIdx = null;
  $(target).find('tr').each((_, tr) => {
    if (centsIdx != null) return;
    $(tr).find('th').each((j, th) => {
      const t = $(th).text().toLowerCase().replace(/\s+/g, ' ');
      if ((t.includes('¢') && t.includes('kwh')) || t.includes('c / kwh') || t.includes('c/kwh')) {
        centsIdx = j;
      }
    });
  });

  const cents = [];
  $(target).find('tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (!tds.length) return;

    let cell;
    if (centsIdx != null && centsIdx < tds.length) {
      cell = tds.get(centsIdx);
    } else {
      // fallback: last cell in the row
      cell = tds.get(tds.length - 1);
    }

    const txt = $(cell).text().trim();
    // Skip if there are no digits (prevents Number('') => 0)
    if (!/\d/.test(txt)) return;

    const raw = txt.replace(/[^\d.]/g, '');
    if (!raw) return;

    const v = Number(raw);
    // Filter out bogus zeros and out-of-range values
    if (Number.isFinite(v) && v > 0 && v <= 100) {
      cents.push(v);
    }
  });

  if (!cents.length) return null;

  return {
    min: Number(Math.min(...cents).toFixed(3)),
    max: Number(Math.max(...cents).toFixed(3))
  };
}

// Loose fallback: scan the whole HTML for 3-decimal cents/kWh values, ignore 0
function parseLooseMinMaxCents(pricingHtml) {
  const nums = (pricingHtml.match(/\b\d{1,2}\.\d{3}\b/g) || [])
    .map(s => Number(s))
    .filter(v => Number.isFinite(v) && v > 0 && v <= 100);
  if (!nums.length) return null;
  return {
    min: Number(Math.min(...nums).toFixed(3)),
    max: Number(Math.max(...nums).toFixed(3))
  };
}

// Public API
export async function fetchPowerCost({ debug = false } = {}) {
  ensureEnvLoaded(debug);
  const { username, password } = readCreds();
  if (!username || !password) {
    throw new Error('Missing credentials: set MEAGPOWER_USER and MEAGPOWER_PASS');
  }

  const { f, pricingHtml } = await loginAndGetFetcher({ username, password, debug });

  // Parse strictly first, then fall back to loose
  let mm = parseTableMinMaxCents(pricingHtml);
  if (!mm) mm = parseLooseMinMaxCents(pricingHtml);
  if (!mm) {
    if (debug) {
      const dumpPath = path.join(__dirname, 'pricing.debug.html');
      fs.writeFileSync(dumpPath, pricingHtml, 'utf8');
      console.warn('[powercost] Could not parse table; wrote snapshot to', dumpPath);
    }
    throw new Error('Could not locate pricing table');
  }

  return {
    min_cents_kwh: mm.min,
    max_cents_kwh: mm.max,
    fetchedAt: new Date().toISOString(),
    source: 'meagpower'
  };
}

export async function fetchPowerCostMinMaxOrNull({ debug = false } = {}) {
  try {
    return await fetchPowerCost({ debug });
  } catch (err) {
    if (debug || process.env.DEBUG_POWER === '1') {
      console.warn('[powercost] failed:', err?.message || err);
    }
    return null;
  }
}
