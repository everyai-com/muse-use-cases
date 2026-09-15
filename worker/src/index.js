/* ================================================================
   EveryAI – use-case library worker

   Keeps the /use-cases page supplied without anyone touching it:

     GET  /                        – what this worker is
     GET  /api/use-cases           – the merged Muse use-case library (JSON)
     GET  /api/status              – last sync result
     POST /api/refresh             – force a sync (needs REFRESH_TOKEN)

     GET  /muse/capabilities.md    – capability pack a Muse agent can be handed
     GET  /muse/capabilities.json  – same pack, structured
     GET  /muse/setup.txt          – short prompt that points Muse at the pack

   A cron trigger re-syncs every 6 hours and writes the result to KV,
   so the site picks up new cases on the next page load. The first
   request after a cold deploy also seeds the library on demand.
   ================================================================ */

import { buildCapabilityJson, buildCapabilityMarkdown, buildSetupPrompt } from './capabilities.js';
import { CHIEF_OF_STAFF, STANDALONE_PROMPTS } from './prompts.js';
import { list as listSubmissions, review as reviewSubmission, submit as submitCase } from './submissions.js';
import { buildLibrary, readLibrary, readStatus, runSync } from './sync.js';

const DEFAULT_SITE_URL = 'https://muse.every-ai.com';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization'
};

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS,
      ...(init.headers || {})
    }
  });
}

function text(body, contentType, init = {}) {
  return new Response(body, {
    ...init,
    headers: {
      'content-type': `${contentType}; charset=utf-8`,
      ...CORS,
      ...(init.headers || {})
    }
  });
}

function siteUrl(env) {
  return (env.SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, '');
}

async function currentLibrary(env) {
  const cached = await readLibrary(env);
  if (cached) return cached;

  return runSync(env).catch(async err => {
    console.error('[library] sync failed, serving seed only:', err);
    return buildLibrary(env);
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/' || url.pathname === '') {
      return json({
        name: 'everyai-use-cases',
        repo: 'https://github.com/everyai-com/muse-use-cases',
        endpoints: {
          library: '/api/use-cases',
          status: '/api/status',
          refresh: 'POST /api/refresh',
          capabilityPack: '/muse/capabilities.md',
          capabilityPackJson: '/muse/capabilities.json',
          setupPrompt: '/muse/setup.txt',
          chiefOfStaff: '/muse/chief-of-staff.txt',
          prompts: '/muse/prompts.json',
          submit: 'POST /api/submissions',
          review: 'GET /api/submissions?status=pending (token)'
        }
      });
    }

    if (request.method === 'HEAD') {
      // Run the GET path so probes see real status and headers, then drop the body.
      const head = await this.fetch(new Request(request, { method: 'GET' }), env, ctx);
      return new Response(null, { status: head.status, headers: head.headers });
    }

    if (url.pathname === '/api/use-cases' && request.method === 'GET') {
      return serveLibrary(env);
    }

    if (url.pathname === '/api/status' && request.method === 'GET') {
      const status = await readStatus(env);
      return json(status || { ok: null, note: 'no sync recorded yet' }, {
        headers: { 'cache-control': 'no-store' }
      });
    }

    if (url.pathname === '/muse/capabilities.md' && request.method === 'GET') {
      const library = await currentLibrary(env);
      const packUrl = `${url.origin}/muse/capabilities.md`;
      const body = buildCapabilityMarkdown(library, { packUrl, siteUrl: siteUrl(env) });

      return text(body, 'text/markdown', {
        headers: {
          'cache-control': 'public, max-age=300, s-maxage=1800',
          ...(url.searchParams.has('download')
            ? { 'content-disposition': 'attachment; filename="muse-capability-pack.md"' }
            : {})
        }
      });
    }

    if (url.pathname === '/muse/capabilities.json' && request.method === 'GET') {
      const library = await currentLibrary(env);
      const packUrl = `${url.origin}/muse/capabilities.md`;

      return json(buildCapabilityJson(library, { packUrl, siteUrl: siteUrl(env) }), {
        headers: { 'cache-control': 'public, max-age=300, s-maxage=1800' }
      });
    }

    if (url.pathname === '/muse/setup.txt' && request.method === 'GET') {
      const library = await currentLibrary(env);
      const packUrl = `${url.origin}/muse/capabilities.md`;

      return text(buildSetupPrompt(library, { packUrl, siteUrl: siteUrl(env) }), 'text/plain', {
        headers: { 'cache-control': 'public, max-age=300, s-maxage=1800' }
      });
    }

    if (url.pathname === '/muse/chief-of-staff.txt' && request.method === 'GET') {
      return text(CHIEF_OF_STAFF.prompt, 'text/plain', {
        headers: { 'cache-control': 'public, max-age=3600' }
      });
    }

    if (url.pathname === '/muse/prompts.json' && request.method === 'GET') {
      return json({ ok: true, prompts: STANDALONE_PROMPTS }, {
        headers: { 'cache-control': 'public, max-age=3600' }
      });
    }

    // ── Community submissions ──
    if (url.pathname === '/api/submissions' && request.method === 'POST') {
      const result = await submitCase(request, env);
      return json(result.body, { status: result.status });
    }

    if (url.pathname === '/api/submissions' && request.method === 'GET') {
      const denied = requireToken(request, env, 'review');
      if (denied) return denied;

      const result = await listSubmissions(env, url.searchParams.get('status') || 'pending');
      return json(result.body, { status: result.status, headers: { 'cache-control': 'no-store' } });
    }

    const reviewMatch = url.pathname.match(/^\/api\/submissions\/([A-Za-z0-9_-]+)\/(approve|reject)$/);
    if (reviewMatch && request.method === 'POST') {
      const denied = requireToken(request, env, 'review');
      if (denied) return denied;

      const [, id, action] = reviewMatch;
      let note = '';
      try {
        note = (await request.json())?.note || '';
      } catch (err) { /* body is optional */ }

      const approved = action === 'approve';
      const result = await reviewSubmission(env, id, approved ? 'approved' : 'rejected', note);

      // Publish immediately rather than waiting for the next cron.
      if (approved && result.status === 200) {
        ctx.waitUntil(runSync(env).catch(err => console.error('[submissions] resync failed:', err)));
      }

      return json(result.body, { status: result.status });
    }

    if (url.pathname === '/api/refresh' && request.method === 'POST') {
      return forceRefresh(request, env);
    }

    return json({ error: 'not found' }, { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSync(env).catch(err => {
      console.error('[cron] sync failed:', err);
    }));
  }
};

async function serveLibrary(env) {
  const library = await currentLibrary(env);

  return json(library, {
    headers: { 'cache-control': 'public, max-age=300, s-maxage=3600' }
  });
}

function requireToken(request, env, label) {
  if (!env.REFRESH_TOKEN) {
    return json({ error: `${label} disabled — set the REFRESH_TOKEN secret to enable it` }, { status: 403 });
  }

  const header = request.headers.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();

  if (token !== env.REFRESH_TOKEN) {
    return json({ error: 'unauthorized' }, { status: 401 });
  }

  return null;
}

async function forceRefresh(request, env) {
  const denied = requireToken(request, env, 'refresh');
  if (denied) return denied;

  try {
    const library = await runSync(env);
    return json({ ok: true, counts: library.counts, refreshedAt: library.refreshedAt });
  } catch (err) {
    return json({ ok: false, error: err.message }, { status: 500 });
  }
}
