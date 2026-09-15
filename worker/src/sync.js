/* ================================================================
   Use-case sync — pulls every source, merges, dedupes, caches.

   Sources
     1. field guide  – bundled (185 cases, each with its exact prompt)
     2. crowd feed   – musecases.netlify.app/usecases.json (grows over
                       time; titles + descriptions, no prompts)
     3. Exa          – optional, activates when EXA_API_KEY is set

   The merged library is what /api/use-cases serves, so the site picks
   up new cases on its next page load — no redeploy needed.
   ================================================================ */

import { FIELD_GUIDE_CASES, FIELD_GUIDE_META } from './data/field-guide.js';
import { approvedCases } from './submissions.js';

// Bump the version when the payload shape changes so a cached library from an
// older worker version can't be served against newer code.
export const LIBRARY_KEY = 'library:v2';
export const STATUS_KEY = 'status:v2';

const CROWD_FEED = 'https://musecases.netlify.app/usecases.json';
const CROWD_SOURCE_NAME = 'musecases.netlify.app';

// The field guide keeps growing (185 → 257 cases within weeks of launch), so
// it is fetched live; the bundled copy in data/field-guide.js is the fallback.
// The host only serves the app to framed requests, hence the Sec-Fetch headers.
const FIELD_GUIDE_URL = 'https://muse-use-cases-xuxf6fkdeq4oxw.cf.metaaiusercontent.com/index.html';
const FIELD_GUIDE_REFERER = 'https://muse.ai/s/muse-use-cases-xuxf6fkdeq4oxw';
const FIELD_GUIDE_SOURCE_NAME = 'Muse use cases field guide';

// ── Helpers ───────────────────────────────────────────────────────
function normalizeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    return `${host}${path}`.toLowerCase();
  } catch (err) {
    return String(value).trim().toLowerCase();
  }
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Titles are the only thing tying two listings of the same case together:
// one source post can describe several different use cases, so a shared
// URL alone must never collapse two cases into one.
const STOPWORDS = new Set(`
  a an the and or for from to with of in on my me i it its at by per via one end first own
  their into out up down over again that this all no not do does did be is are was were been
  has have had will would can could should your you we our us them they he she his her then
  than so if when while as but more most some any each every both few other such only just
  also very too build built make made get got give gave take took
`.split(/\s+/).filter(Boolean));

function titleTokens(title) {
  const out = new Set();

  String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .forEach(word => {
      if (word.length < 4 || STOPWORDS.has(word)) return;
      let stem = word;
      for (const suffix of ['ings', 'ing', 'ers', 'er', 'es', 's']) {
        if (stem.length > suffix.length + 3 && stem.endsWith(suffix)) {
          stem = stem.slice(0, -suffix.length);
          break;
        }
      }
      out.add(stem);
    });

  return out;
}

function sameCase(titleA, titleB) {
  const a = titleTokens(titleA);
  const b = titleTokens(titleB);
  if (!a.size || !b.size) return false;

  for (const token of a) {
    if (b.has(token)) return true;
  }
  return false;
}

// ── Source 1: field guide (live, bundled as fallback) ─────────────
function extractArray(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`${marker} not found`);

  let i = start + marker.length;
  while (source[i] !== '[') i++;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let j = i; j < source.length; j++) {
    const ch = source[j];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return JSON.parse(source.slice(i, j + 1));
    }
  }

  throw new Error('unterminated case array');
}

function shapeGuideCases(raw) {
  return raw
    .filter(item => item && item.id && item.title)
    .map(item => ({
      id: `guide:${item.id}`,
      title: item.title,
      category: item.cat || 'Other',
      prompt: item.prompt || null,
      description: null,
      story: item.story || null,
      sourceHandle: item.source_handle || null,
      sourceUrl: item.source_url || null,
      sourceName: FIELD_GUIDE_SOURCE_NAME,
      hasPrompt: Boolean(item.prompt),
      addedAt: null,
      origins: ['field-guide']
    }));
}

async function fieldGuideCases() {
  const res = await fetch(FIELD_GUIDE_URL, {
    headers: {
      accept: 'text/html',
      referer: FIELD_GUIDE_REFERER,
      'sec-fetch-dest': 'iframe',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'cross-site',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    },
    cf: { cacheTtl: 900, cacheEverything: true }
  });

  if (!res.ok) throw new Error(`field guide responded ${res.status}`);

  const html = await res.text();
  const cases = shapeGuideCases(extractArray(html, 'const cases='));
  if (!cases.length) throw new Error('field guide returned no cases');

  return cases;
}

function bundledGuideCases() {
  return FIELD_GUIDE_CASES.map(item => ({ ...item, origins: [...item.origins] }));
}

// ── Source 2: crowd feed ──────────────────────────────────────────
async function crowdCases() {
  const res = await fetch(CROWD_FEED, {
    headers: { accept: 'application/json', 'user-agent': 'everyai-use-cases-sync' },
    cf: { cacheTtl: 300, cacheEverything: true }
  });
  if (!res.ok) throw new Error(`crowd feed responded ${res.status}`);

  const payload = await res.json();
  const rows = Array.isArray(payload) ? payload : payload.usecases || [];

  return rows.map(row => ({
    id: `crowd:${row.id}`,
    title: row.title,
    category: row.category || 'Other',
    prompt: null,
    description: row.description || null,
    story: null,
    sourceHandle: row.sourceHandle || null,
    sourceUrl: row.sourceUrl || null,
    sourceName: CROWD_SOURCE_NAME,
    hasPrompt: false,
    addedAt: null,
    origins: [CROWD_SOURCE_NAME]
  }));
}

// ── Source 3: Exa discovery (optional) ────────────────────────────
// Wired but dormant until EXA_API_KEY exists as a worker secret:
//   wrangler secret put EXA_API_KEY
async function exaCases(env) {
  if (!env.EXA_API_KEY) return { cases: [], note: 'EXA_API_KEY not set' };

  const res = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.EXA_API_KEY
    },
    body: JSON.stringify({
      query: 'things people did with Meta Muse personal AI agent — use cases and results',
      numResults: 25,
      type: 'auto',
      contents: { text: { maxCharacters: 500 } },
      includeDomains: ['x.com', 'twitter.com']
    })
  });

  if (!res.ok) throw new Error(`exa responded ${res.status}`);

  const payload = await res.json();
  const results = payload.results || [];

  return {
    cases: results.map((result, index) => ({
      id: `exa:${result.id || index}`,
      title: result.title || 'Muse use case',
      category: 'Other',
      prompt: null,
      description: (result.text || '').slice(0, 400) || null,
      story: null,
      sourceHandle: null,
      sourceUrl: result.url || null,
      sourceName: 'exa.ai',
      hasPrompt: false,
      addedAt: result.publishedDate || null,
      origins: ['exa.ai']
    })),
    note: `exa returned ${results.length} results`
  };
}

// ── Merge ─────────────────────────────────────────────────────────
function mergeInto(target, item) {
  const origins = [...new Set([...target.origins, ...item.origins])];

  // Prefer the copy that actually carries a runnable prompt.
  if (!target.hasPrompt && item.hasPrompt) {
    Object.assign(target, item, { origins });
    return;
  }

  target.origins = origins;
  if (!target.description && item.description) target.description = item.description;
  if (!target.story && item.story) target.story = item.story;
  if (!target.sourceHandle && item.sourceHandle) target.sourceHandle = item.sourceHandle;
  if (!target.sourceUrl && item.sourceUrl) target.sourceUrl = item.sourceUrl;
}

export function mergeCases(groups) {
  const byKey = new Map();   // url + title → the case we keep
  const byUrl = new Map();   // url → every case already seen from that post
  const out = [];

  groups.flat().filter(Boolean).forEach(item => {
    const url = normalizeUrl(item.sourceUrl);
    const key = url ? `${url}|${slugify(item.title)}` : `title:${slugify(item.title)}`;

    if (byKey.has(key)) {
      mergeInto(byKey.get(key), item);
      return;
    }

    // Same post, possibly the same case listed by another source. Only
    // cross-source matches get this treatment — inside one source the
    // key above is enough, and fuzzy-matching there would fold genuinely
    // different cases from a single article together.
    const twin = url
      ? (byUrl.get(url) || []).find(sibling =>
        sameCase(sibling.title, item.title) &&
        sibling.origins.some(origin => !item.origins.includes(origin)))
      : null;

    if (twin) {
      mergeInto(twin, item);
      return;
    }

    byKey.set(key, item);
    if (url) byUrl.set(url, [...(byUrl.get(url) || []), item]);
    out.push(item);
  });

  return out;
}

function summarize(cases, sources) {
  const byCategory = {};
  const byOrigin = {};

  cases.forEach(item => {
    byCategory[item.category] = (byCategory[item.category] || 0) + 1;
    item.origins.forEach(origin => {
      byOrigin[origin] = (byOrigin[origin] || 0) + 1;
    });
  });

  return {
    total: cases.length,
    withPrompt: cases.filter(item => item.hasPrompt).length,
    descriptionOnly: cases.filter(item => !item.hasPrompt).length,
    byCategory,
    byOrigin,
    sources
  };
}

// ── Build the library payload ─────────────────────────────────────
export async function buildLibrary(env) {
  const sources = {};

  let community = [];
  try {
    community = await approvedCases(env);
    sources.community = `approved (${community.length})`;
  } catch (err) {
    sources.community = `failed: ${err.message}`;
  }

  let crowd = [];
  try {
    crowd = await crowdCases();
    sources.crowd = `ok (${crowd.length})`;
  } catch (err) {
    sources.crowd = `failed: ${err.message}`;
  }

  let exa = [];
  try {
    const result = await exaCases(env);
    exa = result.cases;
    sources.exa = result.note;
  } catch (err) {
    sources.exa = `failed: ${err.message}`;
  }

  let guide;
  try {
    guide = await fieldGuideCases();
    sources.fieldGuide = `live (${guide.length})`;
  } catch (err) {
    guide = bundledGuideCases();
    sources.fieldGuide = `bundled (${guide.length}) — live fetch failed: ${err.message}`;
  }

  const cases = mergeCases([guide, community, crowd, exa]);

  return {
    version: 1,
    refreshedAt: new Date().toISOString(),
    agent: {
      name: FIELD_GUIDE_META.agentName,
      guideUrl: FIELD_GUIDE_META.sourceUrl,
      snapshot: FIELD_GUIDE_META.snapshot,
      collectedFrom: FIELD_GUIDE_META.collectedFrom
    },
    counts: summarize(cases, sources),
    cases
  };
}

// ── KV access ─────────────────────────────────────────────────────
export async function readLibrary(env) {
  if (!env.USE_CASES) return null;
  return env.USE_CASES.get(LIBRARY_KEY, 'json');
}

export async function readStatus(env) {
  if (!env.USE_CASES) return null;
  return env.USE_CASES.get(STATUS_KEY, 'json');
}

export async function runSync(env) {
  const startedAt = new Date().toISOString();

  try {
    const library = await buildLibrary(env);

    if (env.USE_CASES) {
      await env.USE_CASES.put(LIBRARY_KEY, JSON.stringify(library));
      await env.USE_CASES.put(STATUS_KEY, JSON.stringify({
        ok: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        counts: library.counts
      }));
    }

    console.log(`[sync] ${library.counts.total} cases (${library.counts.withPrompt} with prompts)`);
    return library;
  } catch (err) {
    console.error('[sync] failed:', err);

    if (env.USE_CASES) {
      await env.USE_CASES.put(STATUS_KEY, JSON.stringify({
        ok: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: err.message
      }));
    }
    throw err;
  }
}
