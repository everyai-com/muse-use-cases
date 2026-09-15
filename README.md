# Muse Use Cases

A working field guide to what people actually run with [Muse](https://ai.meta.com/muse/), Meta's personal
AI agent — **351 real use cases, 257 of them with the exact prompt that ran the job**, plus a
**capability pack** you can hand to an agent in a single paste so it knows what it can do for you.

Live: **[muse.every-ai.com](https://muse.every-ai.com)**

```
field guide (live) ─┐
crowd feed ─────────┼─→ sync worker (cron, 6h) ─→ KV ─→ /api/use-cases ─→ the site
community PRs ──────┤                                   └─→ /muse/capabilities.md ─→ your agent
Exa discovery ──────┘
```

## What's in the box

| Piece | What it does |
| --- | --- |
| `worker/` | Cloudflare Worker: merges every source, de-duplicates, serves the library + capability pack, runs the submission queue |
| `use-cases.html` / `.css` / `.js` | The site. Self-contained — its own tokens, type and components, no framework |
| `muse-use-cases.js` | Bundled fallback copy of the field guide, used when the worker is unreachable |
| `scripts/build-muse-site.mjs` | Assembles `dist/muse/` for Pages |
| `scripts/export-oss.mjs` | Assembles this repository's contents for publishing |

## The capability pack

The interesting part. `/muse/capabilities.md` is generated from the live library and contains:

- what the agent should do when asked for something — match to a case, ask once, execute, verify
- the **Chief of Staff prompt**: the onboarding prompt that sets up connections, memory and a weekly review
- the master prompt wrapper, the twelve reusable loops, the six guardrails
- every case, by category, with its prompt and a link to the post it came from

Hand it over with the setup prompt (`/muse/setup.txt`), and any Muse session starts knowing the whole
library instead of waiting to be told:

> You are Muse. Before we start, load your capability pack and make it your playbook:
> `https://everyai-use-cases.everyai-com.workers.dev/muse/capabilities.md`
> It covers 351 real use cases you can run end to end — 257 with the exact prompt …

## Run it

```bash
# 1. the worker
cd worker
wrangler kv namespace create everyai-use-cases   # put the id in wrangler.jsonc
wrangler dev --local                             # http://localhost:8787
wrangler deploy

# 2. the site
node scripts/build-muse-site.mjs                 # → dist/muse/
wrangler pages deploy dist/muse --project-name muse-every-ai
```

Point the page at a local worker without editing code:

```js
localStorage.setItem('everyai_uc_api', 'http://127.0.0.1:8787');
```

## API

| Endpoint | Returns |
| --- | --- |
| `GET /api/use-cases` | merged library: counts, per-source status, every case |
| `GET /api/status` | last sync result |
| `GET /muse/capabilities.md` | the capability pack (markdown) |
| `GET /muse/capabilities.json` | the pack, structured |
| `GET /muse/setup.txt` | the paste-into-Muse prompt |
| `GET /muse/chief-of-staff.txt` | the onboarding prompt |
| `POST /api/submissions` | submit a case (rate-limited, reviewed) |
| `GET /api/submissions?status=pending` | review queue — needs `REFRESH_TOKEN` |
| `POST /api/submissions/:id/approve` | publish it — needs `REFRESH_TOKEN` |

Run your own review queue:

```bash
cd worker && wrangler secret put REFRESH_TOKEN
curl -H "Authorization: Bearer $TOKEN" \
  https://<your-worker>/api/submissions?status=pending
```

## How the merge works

Cases are keyed on **source post + title**, never post alone — one thread often describes several
different cases, and collapsing on URL alone loses them. Two entries merge only when they share the
exact key, or when they come from *different* sources, share a post, and their titles share a
significant token. When they merge, the copy carrying a runnable prompt wins.

## Credits

Cases come from the [Muse use cases field guide](https://muse.ai/s/muse-use-cases-xuxf6fkdeq4oxw),
[musecases.netlify.app](https://musecases.netlify.app), [botdirectory.ai](https://botdirectory.ai) and
people who send them in. Every case keeps a link to the post it came from. Prompts are user-generated
and unverified — read before you run. Not affiliated with Meta.

## License

[MIT](LICENSE)
