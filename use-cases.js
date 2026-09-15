/* ================================================================
   Muse field guide — page logic

     • library    merged Muse cases, served by the everyai-use-cases worker
                  (bundled muse-use-cases.js is the offline fallback)
     • bots       queried live from the botdirectory.ai public API
     • handoff    setup prompt + capability pack, straight from the worker
     • submissions posted to the worker's review queue
   ================================================================ */

'use strict';

import {
  MUSE_CASES,
  MUSE_GUARDRAILS,
  MUSE_MASTER_PROMPT,
  MUSE_META,
  MUSE_PATTERNS
} from './muse-use-cases.js';

// ── Config ────────────────────────────────────────────────────────
const LIBRARY_API =
  (typeof localStorage !== 'undefined' && localStorage.getItem('everyai_uc_api')) ||
  'https://everyai-use-cases.everyai-com.workers.dev';

const BOTS_API = 'https://api.botdirectory.ai/api/bots';
const BOTS_PAGE_SIZE = 100;         // API maximum
const BOTS_CACHE_KEY = 'everyai_uc_bots_cache';
const BOTS_CACHE_LIMIT = 700;
const PAGE_SIZE = 24;
const INTEGRATION_CHIPS = 12;
const FETCH_TIMEOUT_MS = 7000;

const $ = id => document.getElementById(id);

// ── Tiny helpers ──────────────────────────────────────────────────
const esc = value => String(value ?? '').replace(/[&<>'"]/g, ch => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]
));

const norm = value => String(value ?? '').toLowerCase();
const pad = value => String(value).padStart(2, '0');

let toastTimer = null;
function toast(message) {
  const el = $('uc-toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2400);
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast(message);
}

async function getJSON(url, timeout = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── State ─────────────────────────────────────────────────────────
const state = {
  source: 'muse',        // muse | bot | all
  cat: 'all',
  integration: 'all',
  q: '',
  sort: 'curated',       // curated | newest | az
  page: 1
};

let BOTS = [];
let botsTotal = 0;
let MUSE = [];
let libraryMeta = null;      // { refreshedAt, counts }
let setupPrompt = '';
let setupFromServer = false;
let chiefPrompt = '';

function museRows(cases) {
  return cases.map(item => ({
    source: 'muse',
    id: `muse-${item.id}`,
    title: item.title,
    category: item.category,
    prompt: item.prompt || '',
    story: item.story || item.description || '',
    descriptionOnly: !item.hasPrompt,
    integrations: [],
    handle: item.sourceHandle || '',
    url: item.sourceUrl || MUSE_META.sourceUrl,
    urlLabel: item.sourceHandle ? `${item.sourceHandle}` : 'source post',
    addedAt: item.addedAt || null
  }));
}

MUSE = museRows(MUSE_CASES.map(c => ({
  id: c.id,
  title: c.title,
  category: c.cat,
  prompt: c.prompt,
  story: c.story,
  sourceHandle: c.source_handle,
  sourceUrl: c.source_url,
  hasPrompt: Boolean(c.prompt)
})));

// ── Data: Muse library ────────────────────────────────────────────
async function loadLibrary() {
  try {
    const payload = await getJSON(`${LIBRARY_API}/api/use-cases`);
    if (!Array.isArray(payload.cases) || !payload.cases.length) throw new Error('empty payload');

    MUSE = museRows(payload.cases);
    libraryMeta = { refreshedAt: payload.refreshedAt, counts: payload.counts };
    render();
    renderStatus();
    if (!setupFromServer) showSetupPrompt(fallbackSetupPrompt());
  } catch (err) {
    console.warn('[guide] live library unavailable, using the bundled copy:', err.message);
    showSourceNote('Live library unreachable — showing the bundled copy of the guide.');
  }
}

// ── Data: bots ────────────────────────────────────────────────────
function readBotCache() {
  try {
    const raw = localStorage.getItem(BOTS_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function normalizeBot(bot) {
  return {
    source: 'bot',
    id: `bot-${bot.slug}`,
    title: bot.name,
    category: bot.category || 'Bots',
    prompt: bot.prompt || bot.description || '',
    story: bot.description || '',
    descriptionOnly: !bot.prompt,
    integrations: bot.integrations || [],
    handle: bot.contributor || '',
    url: bot.detailUrl || 'https://botdirectory.ai',
    urlLabel: 'botdirectory.ai',
    addedAt: bot.addedAt || null
  };
}

async function fetchBotPage(page) {
  const payload = await getJSON(`${BOTS_API}?limit=${BOTS_PAGE_SIZE}&page=${page}&sort=newest`);
  return {
    bots: payload.bots || [],
    total: payload.pagination?.total ?? (payload.bots || []).length,
    totalPages: payload.pagination?.totalPages ?? 1
  };
}

async function loadBots() {
  const cached = readBotCache();
  if (cached.length) {
    BOTS = cached;
    botsTotal = cached.length;
    render();
  }

  let first;
  try {
    first = await fetchBotPage(1);
  } catch (err) {
    console.warn('[guide] botdirectory unavailable:', err.message);
    if (!cached.length) showSourceNote('Bot prompts are unavailable right now.');
    return;
  }

  BOTS = first.bots.map(normalizeBot);
  botsTotal = first.total;
  render();

  try {
    const pages = [];
    for (let page = 2; page <= first.totalPages; page++) pages.push(page);
    const rest = await Promise.all(pages.map(fetchBotPage));
    rest.forEach(result => BOTS.push(...result.bots.map(normalizeBot)));
    localStorage.setItem(BOTS_CACHE_KEY, JSON.stringify(BOTS.slice(0, BOTS_CACHE_LIMIT)));
    render();
  } catch (err) {
    console.warn('[guide] partial bot load:', err.message);
  }
}

// ── Filtering ─────────────────────────────────────────────────────
function baseRows() {
  if (state.source === 'bot') return BOTS;
  if (state.source === 'muse') return MUSE;
  return MUSE.concat(BOTS);
}

function filteredRows() {
  const q = norm(state.q).trim();

  return baseRows().filter(row => {
    if (state.cat !== 'all' && row.category !== state.cat) return false;
    if (state.integration !== 'all' && !row.integrations.includes(state.integration)) return false;
    if (!q) return true;

    return norm([
      row.title,
      row.prompt,
      row.story,
      row.category,
      row.handle,
      row.integrations.join(' ')
    ].join(' ')).includes(q);
  });
}

function sortedRows(rows) {
  const list = [...rows];

  if (state.sort === 'az') return list.sort((a, b) => a.title.localeCompare(b.title));

  if (state.sort === 'newest') {
    return list.sort((a, b) => {
      if (!a.addedAt) return 1;
      if (!b.addedAt) return -1;
      return b.addedAt.localeCompare(a.addedAt);
    });
  }

  // curated: guide order first, then anything added later
  return list.sort((a, b) => {
    if (a.source !== b.source) return a.source === 'muse' ? -1 : 1;
    if (!a.addedAt || !b.addedAt) return 0;
    return b.addedAt.localeCompare(a.addedAt);
  });
}

// ── Rendering: controls ───────────────────────────────────────────
function renderTabs() {
  const totals = {
    muse: MUSE.length,
    bot: botsTotal || BOTS.length,
    all: MUSE.length + (botsTotal || BOTS.length)
  };

  document.querySelectorAll('.uc-tab-count').forEach(el => {
    el.textContent = (totals[el.dataset.count] || 0).toLocaleString();
  });

  document.querySelectorAll('.uc-tab').forEach(tab => {
    const active = tab.dataset.source === state.source;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  });

  const cases = MUSE.length;
  const prompts = MUSE.filter(row => row.prompt && !row.descriptionOnly).length;
  document.querySelectorAll('[data-count="cases"]').forEach(el => { el.textContent = cases.toLocaleString(); });
  document.querySelectorAll('[data-count="prompts"]').forEach(el => { el.textContent = prompts.toLocaleString(); });
}

function renderCategoryChips() {
  const wrap = $('uc-category-chips');
  if (!wrap) return;

  const rows = baseRows();
  const counts = new Map();
  rows.forEach(row => counts.set(row.category, (counts.get(row.category) || 0) + 1));

  let categories = [...counts.keys()];
  if (state.source === 'muse') {
    categories = [...new Set(MUSE.map(row => row.category))];
  } else {
    categories.sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
  }

  const chips = [`<button type="button" class="uc-chip ${state.cat === 'all' ? 'is-active' : ''}"
      data-cat="all">All <span class="uc-chip-count">${rows.length}</span></button>`];

  categories.forEach(category => {
    chips.push(`<button type="button" class="uc-chip ${state.cat === category ? 'is-active' : ''}"
      data-cat="${esc(category)}">${esc(category)} <span class="uc-chip-count">${counts.get(category) || 0}</span></button>`);
  });

  wrap.innerHTML = chips.join('');
}

function renderIntegrationChips() {
  const group = $('uc-integration-group');
  const wrap = $('uc-integration-chips');
  if (!group || !wrap) return;

  if (state.source === 'muse' || !BOTS.length) {
    group.hidden = true;
    return;
  }

  const counts = new Map();
  BOTS.forEach(bot => bot.integrations.forEach(name => counts.set(name, (counts.get(name) || 0) + 1)));

  const top = [...counts.entries()]
    .filter(([name]) => name !== 'Grok')
    .sort((a, b) => b[1] - a[1])
    .slice(0, INTEGRATION_CHIPS);

  if (!top.length) {
    group.hidden = true;
    return;
  }

  group.hidden = false;
  wrap.innerHTML = [
    `<button type="button" class="uc-chip ${state.integration === 'all' ? 'is-active' : ''}"
      data-integration="all">Any</button>`,
    ...top.map(([name, count]) => `<button type="button" class="uc-chip ${state.integration === name ? 'is-active' : ''}"
      data-integration="${esc(name)}">${esc(name)} <span class="uc-chip-count">${count}</span></button>`)
  ].join('');
}

function renderToolbar(total, start, end) {
  const count = $('uc-result-count');
  if (count) {
    count.innerHTML = total
      ? `Showing <strong>${start + 1}–${end}</strong> of <strong>${total.toLocaleString()}</strong> cases`
      : 'Nothing matched';
  }

  const reset = $('uc-reset');
  if (reset) {
    reset.hidden = !(state.q || state.cat !== 'all' || state.integration !== 'all');
  }
}

// ── Rendering: cards ──────────────────────────────────────────────
function cardHTML(row, index) {
  const isMuse = row.source === 'muse';
  const canCopy = Boolean(row.prompt) && !row.descriptionOnly;
  const label = isMuse ? `${MUSE_META.agentName} case` : 'Bot prompt';

  const extra = isMuse
    ? (row.story ? `<p class="uc-story">${esc(row.story)}</p>` : '')
    : (row.integrations.length
      ? `<div class="uc-integrations">${row.integrations.slice(0, 5).map(name =>
        `<button type="button" class="uc-int-chip" data-integration="${esc(name)}">${esc(name)}</button>`).join('')}</div>`
      : '');

  const promptBlock = canCopy
    ? `<div class="uc-prompt-wrap">
        <div class="uc-prompt">${esc(row.prompt)}</div>
        ${row.prompt.length > 220 ? '<button type="button" class="uc-prompt-toggle" data-toggle>Show the full prompt</button>' : ''}
      </div>`
    : '<p class="uc-noprompt">No prompt was published for this one — the linked post describes what it did.</p>';

  const action = canCopy
    ? `<button type="button" class="uc-btn uc-btn-primary" data-copy="${esc(row.id)}">Copy prompt</button>`
    : '<span class="uc-tag-noprompt">Description only</span>';

  return `
    <article class="uc-card ${isMuse ? 'is-muse' : 'is-bot'}" style="--i:${index % 8}">
      <div class="uc-card-top">
        <span class="uc-badge"><span class="uc-badge-dot"></span>${esc(label)}</span>
        <span class="uc-cat">${esc(row.category)} · #${pad(index + 1)}</span>
      </div>
      <h3 class="uc-card-title">${esc(row.title)}</h3>
      ${extra}
      ${promptBlock}
      <div class="uc-card-footer">
        ${action}
        <a class="uc-card-link" href="${esc(row.url)}" target="_blank" rel="noopener">${esc(row.urlLabel)} →</a>
      </div>
    </article>`;
}

function renderPager(totalPages) {
  const wrap = $('uc-pagination');
  if (!wrap) return;

  if (totalPages <= 1) {
    wrap.innerHTML = '';
    return;
  }

  wrap.innerHTML = `
    <div class="uc-pager">
      <button type="button" class="uc-pager-btn" data-page="prev" ${state.page === 1 ? 'disabled' : ''}>← Prev</button>
      <span class="uc-pager-info">Page <strong>${state.page}</strong> of ${totalPages}</span>
      <button type="button" class="uc-pager-btn" data-page="next" ${state.page === totalPages ? 'disabled' : ''}>Next →</button>
    </div>`;
}

function render() {
  const rows = sortedRows(filteredRows());
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (state.page > totalPages) state.page = totalPages;

  const start = (state.page - 1) * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);

  renderTabs();
  renderCategoryChips();
  renderIntegrationChips();
  renderToolbar(rows.length, start, start + pageRows.length);

  const grid = $('uc-grid');
  if (grid) {
    grid.innerHTML = pageRows.length
      ? pageRows.map((row, i) => cardHTML(row, start + i)).join('')
      : `<div class="uc-empty"><strong>Nothing matched that</strong>
          Try another category, clear the search, or browse everything.</div>`;
  }

  renderPager(totalPages);
}

function renderSkeletons() {
  const grid = $('uc-grid');
  if (grid) {
    grid.innerHTML = Array.from({ length: 6 }, () => '<div class="uc-skeleton"></div>').join('');
  }
}

function renderStatus() {
  const when = $('uc-status-when');
  if (when && libraryMeta?.refreshedAt) {
    const minutes = Math.max(0, Math.round((Date.now() - new Date(libraryMeta.refreshedAt).getTime()) / 60000));
    const ago = minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)}h ago`;
    when.textContent = `synced ${ago}`;

    const line = $('uc-updated');
    if (line) {
      line.hidden = false;
      line.textContent = `${MUSE.length.toLocaleString()} Muse cases in the library · synced ${ago}`;
    }
  }

  const sources = libraryMeta?.counts?.sources || {};
  const map = {
    'uc-source-guide': sources.fieldGuide,
    'uc-source-crowd': sources.crowd,
    'uc-source-community': sources.community,
    'uc-source-exa': sources.exa
  };

  Object.entries(map).forEach(([id, value]) => {
    const el = $(id);
    if (el) el.textContent = value || '—';
  });
}

function showSourceNote(message) {
  const note = $('uc-source-note');
  if (!note) return;
  note.hidden = false;
  note.innerHTML = `${esc(message)} <a href="https://botdirectory.ai" target="_blank" rel="noopener">Browse botdirectory.ai</a>`;
}

// ── Search ────────────────────────────────────────────────────────
function setSearch(value, { scroll = true } = {}) {
  state.q = value;
  state.page = 1;

  const input = $('uc-search');
  if (input && input.value !== value) input.value = value;

  const clear = $('uc-search-clear');
  if (clear) clear.hidden = !value;

  render();

  if (scroll) {
    const library = $('library');
    if (library) library.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// ── Handoff: setup prompt + capability pack ───────────────────────
function fallbackSetupPrompt() {
  const withPrompt = MUSE.filter(row => row.prompt && !row.descriptionOnly).length;

  return [
    'You are Muse. Before we start, load your capability pack and make it your playbook:',
    '',
    `${LIBRARY_API}/muse/capabilities.md`,
    '',
    `It covers ${MUSE.length} real use cases you can run end to end — ${withPrompt} with the exact prompt, plus your operating rules and the guardrails to apply. Read it, then tell me the handful of things from it you can do for me today, one line each.`,
    '',
    'When I ask for something that matches a case, run it end to end: ask for anything you are missing in one round, then execute without stopping. Pause only for payments, signatures, sends, identity checks, or approvals, verify the outcome, and show me the receipts.'
  ].join('\n');
}

function showSetupPrompt(value, fromServer = false) {
  setupPrompt = value;
  setupFromServer = fromServer;
  const pre = $('uc-setup-prompt');
  if (pre) pre.textContent = value;
}

async function initHandoff() {
  const packUrl = `${LIBRARY_API}/muse/capabilities.md`;
  const download = $('uc-download-pack-md');
  const view = $('uc-view-pack');
  if (download) download.href = `${packUrl}?download=1`;
  if (view) view.href = packUrl;

  showSetupPrompt(fallbackSetupPrompt());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${LIBRARY_API}/muse/setup.txt`, { signal: controller.signal });
    if (!res.ok) throw new Error(`setup prompt responded ${res.status}`);
    const text = (await res.text()).trim();
    if (text) showSetupPrompt(text, true);
  } catch (err) {
    console.warn('[guide] using the locally built setup prompt:', err.message);
  } finally {
    clearTimeout(timer);
  }
}

async function initChiefOfStaff() {
  const pre = $('uc-chief-text');
  const download = $('uc-download-chief');
  const url = `${LIBRARY_API}/muse/chief-of-staff.txt`;
  if (download) download.href = url;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`chief of staff prompt responded ${res.status}`);
    chiefPrompt = (await res.text()).trim();
  } catch (err) {
    chiefPrompt = '';
    console.warn('[guide] chief of staff prompt unavailable:', err.message);
  }

  if (pre) {
    pre.textContent = chiefPrompt
      || 'The prompt could not be loaded right now — open the .txt link to read it directly.';
  }
}

// ── Submissions ───────────────────────────────────────────────────
async function submitCase(event) {
  event.preventDefault();

  const form = event.currentTarget;
  const button = $('uc-submit-btn');
  const status = $('uc-submit-status');

  const payload = {
    title: form.title.value,
    category: form.category.value,
    handle: form.handle.value,
    description: form.description.value,
    prompt: form.prompt.value,
    sourceUrl: form.sourceUrl.value,
    website: form.website.value
  };

  if (status) {
    status.textContent = '';
    status.className = 'uc-form-status';
  }
  if (button) {
    button.disabled = true;
    button.textContent = 'Sending…';
  }

  try {
    const res = await fetch(`${LIBRARY_API}/api/submissions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const body = await res.json().catch(() => ({}));

    if (!res.ok) throw new Error(body.error || `Submission failed (${res.status})`);

    if (status) {
      status.textContent = body.message || 'Thanks — it is in the review queue.';
      status.className = 'uc-form-status is-ok';
    }
    form.reset();
    toast('Case sent — thank you');
  } catch (err) {
    if (status) {
      status.textContent = err.message;
      status.className = 'uc-form-status is-error';
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = 'Send it in';
    }
  }
}

// ── Copy + download ───────────────────────────────────────────────
function findRow(id) {
  return MUSE.find(row => row.id === id) || BOTS.find(row => row.id === id);
}

function copyRow(id, button) {
  const row = findRow(id);
  if (!row || !row.prompt) return;

  const text = row.source === 'muse'
    ? MUSE_MASTER_PROMPT.replace('[PASTE ONE CASE PROMPT FROM BELOW]', row.prompt)
    : row.prompt;

  copyText(text, row.source === 'muse' ? 'Muse prompt copied' : 'Bot prompt copied');

  if (button) {
    const original = button.textContent;
    button.dataset.copied = 'true';
    button.textContent = 'Copied';
    setTimeout(() => {
      button.dataset.copied = 'false';
      button.textContent = original;
    }, 1600);
  }
}

function downloadPromptPack() {
  const pack = {
    snapshot: MUSE_META.snapshot,
    source: MUSE_META.sourceUrl,
    master_prompt: MUSE_MASTER_PROMPT,
    patterns: MUSE_PATTERNS,
    guardrails: MUSE_GUARDRAILS,
    use_cases: MUSE_CASES
  };

  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'muse-use-cases-prompt-pack.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast('Prompt pack downloaded');
}

// ── Static content ────────────────────────────────────────────────
function renderGuideContent() {
  const master = $('uc-master-text');
  if (master) master.textContent = MUSE_MASTER_PROMPT;

  const loops = $('uc-patterns');
  if (loops) {
    loops.innerHTML = MUSE_PATTERNS.map((pattern, i) => `
      <article class="uc-loop">
        <span class="uc-loop-index">${pad(i + 1)}</span>
        <strong>${esc(pattern.title)}</strong>
        <p>${esc(pattern.body)}</p>
      </article>`).join('');
  }

  const guards = $('uc-guardrails');
  if (guards) {
    guards.innerHTML = MUSE_GUARDRAILS.map(guard => `
      <article class="uc-guard">
        <strong>${esc(guard.title)}</strong>
        <p>${esc(guard.body)}</p>
      </article>`).join('');
  }
}

// ── Counters ──────────────────────────────────────────────────────
let countersRan = false;
function animateCounters() {
  if (countersRan) return;
  countersRan = true;

  document.querySelectorAll('.stat-num').forEach(el => {
    const start = performance.now();
    const duration = 1100;

    function step(now) {
      // Read the target each frame: the live library can land mid-animation and
      // raise it (351 rather than the bundled 257), and the count should follow.
      const target = parseInt(el.dataset.target, 10) || 0;
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 4);
      el.textContent = Math.floor(eased * target).toLocaleString();
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  });
}

function updateStatTargets() {
  const withPrompt = MUSE.filter(row => row.prompt && !row.descriptionOnly).length;
  const categories = new Set(MUSE.map(row => row.category)).size;

  const set = (id, value) => {
    const el = $(id);
    if (!el) return;
    el.dataset.target = value;
    // Counters run once on load; a later refresh (live library lands) should
    // just correct the number rather than replay the animation.
    if (countersRan) el.textContent = value.toLocaleString();
  };

  set('uc-stat-muse', MUSE.length);
  set('uc-stat-prompts', withPrompt);
  set('uc-stat-cats', categories);
  set('uc-stat-loops', MUSE_PATTERNS.length);
}

// ── Page chrome ───────────────────────────────────────────────────
function initTheme() {
  const toggle = $('theme-toggle');
  if (!toggle) return;

  const isDark = () => document.documentElement.classList.contains('dark');
  const sync = () => toggle.setAttribute('aria-pressed', String(isDark()));
  sync();

  toggle.addEventListener('click', () => {
    // Suppress transitions for one frame so the swap snaps instead of smearing.
    document.documentElement.classList.add('uc-theme-switching');

    const dark = !isDark();
    document.documentElement.classList.toggle('dark', dark);
    document.body.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
    sync();

    void document.body.offsetHeight;
    requestAnimationFrame(() => document.documentElement.classList.remove('uc-theme-switching'));
  });
}

function initNav() {
  const burger = $('uc-burger');
  const menu = $('uc-mobile-nav');
  if (!burger || !menu) return;

  burger.addEventListener('click', () => {
    const open = burger.getAttribute('aria-expanded') === 'true';
    burger.setAttribute('aria-expanded', String(!open));
    menu.hidden = open;
  });

  menu.addEventListener('click', event => {
    if (event.target.tagName === 'A') {
      burger.setAttribute('aria-expanded', 'false');
      menu.hidden = true;
    }
  });
}

// ── Events ────────────────────────────────────────────────────────
function initEvents() {
  $('uc-source-switch')?.addEventListener('click', event => {
    const tab = event.target.closest('.uc-tab');
    if (!tab) return;

    state.source = tab.dataset.source;
    state.page = 1;
    if (state.source === 'muse') state.integration = 'all';

    const available = new Set(baseRows().map(row => row.category));
    if (state.cat !== 'all' && !available.has(state.cat)) state.cat = 'all';

    render();
  });

  $('uc-category-chips')?.addEventListener('click', event => {
    const chip = event.target.closest('.uc-chip');
    if (!chip) return;
    state.cat = chip.dataset.cat;
    state.page = 1;
    render();
  });

  $('uc-integration-chips')?.addEventListener('click', event => {
    const chip = event.target.closest('.uc-chip');
    if (!chip) return;
    state.integration = chip.dataset.integration;
    state.page = 1;
    render();
  });

  $('uc-grid')?.addEventListener('click', event => {
    const copy = event.target.closest('[data-copy]');
    if (copy) {
      copyRow(copy.dataset.copy, copy);
      return;
    }

    const toggle = event.target.closest('[data-toggle]');
    if (toggle) {
      const card = toggle.closest('.uc-card');
      const open = card.classList.toggle('is-open');
      toggle.textContent = open ? 'Show less' : 'Show the full prompt';
      return;
    }

    const integration = event.target.closest('.uc-int-chip');
    if (integration) {
      state.integration = integration.dataset.integration;
      state.page = 1;
      render();
      $('library')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  $('uc-pagination')?.addEventListener('click', event => {
    const button = event.target.closest('[data-page]');
    if (!button) return;

    const totalPages = Math.ceil(filteredRows().length / PAGE_SIZE);
    if (button.dataset.page === 'prev' && state.page > 1) state.page--;
    if (button.dataset.page === 'next' && state.page < totalPages) state.page++;

    render();
    $('library')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  $('uc-sort')?.addEventListener('change', event => {
    state.sort = event.target.value;
    state.page = 1;
    render();
  });

  $('uc-search')?.addEventListener('input', event => setSearch(event.target.value, { scroll: false }));
  $('uc-search-clear')?.addEventListener('click', () => setSearch('', { scroll: false }));

  $('uc-reset')?.addEventListener('click', () => {
    state.cat = 'all';
    state.integration = 'all';
    state.q = '';
    state.sort = 'curated';
    state.page = 1;

    const search = $('uc-search');
    if (search) search.value = '';
    const clear = $('uc-search-clear');
    if (clear) clear.hidden = true;
    const sort = $('uc-sort');
    if (sort) sort.value = 'curated';

    render();
  });

  $('uc-hero-search-btn')?.addEventListener('click', () => setSearch($('uc-hero-search')?.value || ''));
  $('uc-hero-search')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') setSearch(event.target.value);
  });

  $('uc-hero-tags')?.addEventListener('click', event => {
    const chip = event.target.closest('[data-query]');
    if (chip) setSearch(chip.dataset.query || '');
  });

  $('uc-copy-setup')?.addEventListener('click', () => {
    copyText(setupPrompt || fallbackSetupPrompt(), 'Setup prompt copied — paste it into Muse');
  });

  $('uc-copy-chief')?.addEventListener('click', () => {
    if (!chiefPrompt) {
      toast('Still loading — try again in a second');
      return;
    }
    copyText(chiefPrompt, 'Chief of Staff prompt copied');
  });

  $('uc-copy-master')?.addEventListener('click', () => copyText(MUSE_MASTER_PROMPT, 'Wrapper copied'));
  $('uc-download-pack')?.addEventListener('click', downloadPromptPack);
  $('uc-download-pack-md')?.addEventListener('click', () => toast('Downloading the capability pack'));
  $('uc-download-chief')?.addEventListener('click', () => toast('Downloading the prompt'));

  $('uc-submit-form')?.addEventListener('submit', submitCase);
}

// ── Init ──────────────────────────────────────────────────────────
function init() {
  initTheme();
  initNav();
  renderGuideContent();
  renderSkeletons();
  updateStatTargets();
  render();
  initEvents();

  // Counters sit at the top, so they run as soon as the hero paints.
  animateCounters();

  initHandoff();
  initChiefOfStaff();
  loadLibrary().then(updateStatTargets);
  loadBots().then(updateStatTargets);
}

init();
