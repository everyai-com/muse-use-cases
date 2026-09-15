/* ================================================================
   Community submissions

   Anyone can propose a use case; nothing reaches the library until it
   is reviewed. Approved entries are merged into the library on every
   sync, so they survive cron rebuilds.

     POST /api/submissions                  – public, rate-limited
     GET  /api/submissions?status=pending   – review queue (token)
     POST /api/submissions/:id/approve      – publish it (token)
     POST /api/submissions/:id/reject       – discard it (token)
   ================================================================ */

const PENDING_KEY = 'submissions:pending';
const APPROVED_KEY = 'submissions:approved';
const REJECTED_KEY = 'submissions:rejected';

const RATE_LIMIT = 5;                 // per address per window
const RATE_WINDOW_SECONDS = 24 * 60 * 60;

const LIMITS = {
  title: 120,
  category: 40,
  description: 1200,
  prompt: 6000,
  handle: 60,
  sourceUrl: 400
};

// ── Helpers ───────────────────────────────────────────────────────
async function hash(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function clean(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanMultiline(value, max) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function readList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(item => item && typeof item === 'object');
}

async function load(env, key) {
  const stored = await env.USE_CASES.get(key, 'json');
  return readList(stored);
}

async function save(env, key, list) {
  await env.USE_CASES.put(key, JSON.stringify(list));
}

function validate(body) {
  const title = clean(body.title, LIMITS.title);
  const category = clean(body.category, LIMITS.category);
  const description = cleanMultiline(body.description, LIMITS.description);
  const prompt = cleanMultiline(body.prompt, LIMITS.prompt);
  const handle = clean(body.handle, LIMITS.handle);
  const sourceUrl = clean(body.sourceUrl, LIMITS.sourceUrl);

  if (title.length < 5) return { error: 'Give the case a title of at least 5 characters.' };
  if (category.length < 2) return { error: 'Pick or name a category.' };
  if (description.length < 20) return { error: 'Describe what it did in at least 20 characters.' };

  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('bad protocol');
    } catch (err) {
      return { error: 'The source link must be a full http(s) URL.' };
    }
  }

  return { value: { title, category, description, prompt, handle, sourceUrl } };
}

// ── Public: submit ────────────────────────────────────────────────
export async function submit(request, env) {
  if (!env.USE_CASES) {
    return { status: 503, body: { error: 'Submissions are not available right now.' } };
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return { status: 400, body: { error: 'Send a JSON body.' } };
  }

  // Bots fill every field they find; humans never see this one.
  if (body.website) {
    return { status: 202, body: { ok: true, id: 'ignored' } };
  }

  const address = request.headers.get('cf-connecting-ip') || 'unknown';
  const bucket = `ratelimit:submit:${await hash(address)}`;
  const used = parseInt(await env.USE_CASES.get(bucket), 10) || 0;

  if (used >= RATE_LIMIT) {
    return { status: 429, body: { error: `That's ${RATE_LIMIT} submissions today — try again tomorrow.` } };
  }

  const { error, value } = validate(body);
  if (error) return { status: 400, body: { error } };

  const entry = {
    id: `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    status: 'pending',
    ...value,
    ipHash: await hash(address),
    submittedAt: new Date().toISOString()
  };

  const pending = await load(env, PENDING_KEY);
  pending.unshift(entry);
  await save(env, PENDING_KEY, pending.slice(0, 500));
  await env.USE_CASES.put(bucket, String(used + 1), { expirationTtl: RATE_WINDOW_SECONDS });

  return {
    status: 201,
    body: {
      ok: true,
      id: entry.id,
      message: 'Thanks — it lands in the review queue and appears in the library once it clears.'
    }
  };
}

// ── Review (token) ────────────────────────────────────────────────
export async function list(env, status = 'pending') {
  const key = status === 'approved' ? APPROVED_KEY : status === 'rejected' ? REJECTED_KEY : PENDING_KEY;
  const items = await load(env, key);

  return {
    status: 200,
    body: { ok: true, status, count: items.length, submissions: items }
  };
}

async function findIn(env, key, id) {
  const items = await load(env, key);
  const index = items.findIndex(item => item.id === id);
  return { items, index, item: index >= 0 ? items[index] : null };
}

export async function review(env, id, action, note = '') {
  if (!id) return { status: 400, body: { error: 'Missing submission id.' } };

  const { items, index, item } = await findIn(env, PENDING_KEY, id);
  if (!item) return { status: 404, body: { error: `No pending submission ${id}.` } };

  items.splice(index, 1);
  item.status = action;
  item.reviewedAt = new Date().toISOString();
  if (note) item.note = clean(note, 400);

  if (action === 'approved') {
    const approved = await load(env, APPROVED_KEY);
    approved.unshift(item);
    await save(env, APPROVED_KEY, approved);
  } else {
    const rejected = await load(env, REJECTED_KEY);
    rejected.unshift(item);
    await save(env, REJECTED_KEY, rejected.slice(0, 500));
  }

  await save(env, PENDING_KEY, items);

  return { status: 200, body: { ok: true, id, status: action, remaining: items.length } };
}

// ── Library source ────────────────────────────────────────────────
export async function approvedCases(env) {
  const items = await load(env, APPROVED_KEY);

  return items.map(item => ({
    id: `submission:${item.id}`,
    title: item.title,
    category: item.category || 'Community',
    prompt: item.prompt || null,
    description: item.description || null,
    story: item.description || null,
    sourceHandle: item.handle || null,
    sourceUrl: item.sourceUrl || null,
    sourceName: 'community submission',
    hasPrompt: Boolean(item.prompt),
    addedAt: item.submittedAt || null,
    origins: ['community']
  }));
}
