# everyai-use-cases worker

Keeps the `/use-cases` page stocked with fresh, merged use-case data — no manual
step, no redeploy of the static site.

```
botdirectory.ai API ────────────────┐
muse.ai field guide (bundled, 185) ─┼─→ sync (cron, every 6h) ─→ KV ─→ GET /api/use-cases ─→ use-cases.html
musecases.netlify.app feed ─────────┤
Exa search (optional, key-gated) ───┘
```

Live: `https://everyai-use-cases.everyai-com.workers.dev`

## Endpoints

| Endpoint | What it returns |
| --- | --- |
| `GET /api/use-cases` | The merged library: `{ version, refreshedAt, agent, counts, cases[] }` |
| `GET /api/status` | Last sync result — when it ran, counts, per-source outcome |
| `POST /api/refresh` | Force a sync now. Requires `Authorization: Bearer <REFRESH_TOKEN>` |
| `GET /muse/capabilities.md` | **Capability pack** — the playbook you hand to a Muse agent |
| `GET /muse/capabilities.json` | Same pack, structured for programmatic use |
| `GET /muse/setup.txt` | The short prompt that points a Muse at the pack |

CORS is open (`access-control-allow-origin: *`) so the static site can read it
straight from the browser. Responses are cached at the edge and in KV; the
worker only rebuilds when the cron fires or the cache is cold.

## The capability pack

This is the piece that makes the library *usable by an agent* rather than just
readable by a person. Anyone can paste the setup prompt into their Muse:

```bash
curl https://everyai-use-cases.everyai-com.workers.dev/muse/setup.txt
```

Muse fetches `/muse/capabilities.md`, and from that point it knows:

- every case, what it did, and the exact prompt behind it,
- how to run one end to end (match → ask once → execute → verify),
- the operating rules and the guardrails to respect,
- the twelve reusable loops for composing cases that aren't listed.

The markdown pack is assembled at request time from the live library, so the
numbers and case list in it are never stale. Prompt code fences are widened
automatically when a prompt itself contains backticks.

Regenerate the bundled field-guide half with `scratchpad/build-worker-seed.py`
if the guide itself is ever revised; the crowd half arrives on its own via cron.


## How the merge works

Cases are keyed by **source post + title**, never by post alone — one article or
thread can describe several different use cases, so collapsing on URL would lose
content. Two entries merge only when:

1. they share the exact key (`url|title`) — a straight duplicate, or
2. they come from **different sources**, share the same post, and their titles
   share a significant token (stopwords stripped, simple stemming).

Rule 2 is what folds "Three-day trip booking" into the field guide's "Book a
three-day trip end to end" while still keeping "Recurring Sunday-morning fantasy
football briefing" and "Daily morning briefing" apart.

When two entries merge, the one carrying a runnable prompt wins, every origin is
recorded on `origins[]`, and any description/story the other one had is kept.

Current split: **185 with prompts** (field guide) + **97 description-only**
(crowd feed), **20 merged across sources** → **282 cases**.

## Sources

- **Field guide** — bundled in `src/data/field-guide.js`. These carry the exact
  prompts, so they can't be fetched; regenerate with
  `scratchpad/build-worker-seed.py` if the guide is ever revised.
- **Crowd feed** — `https://musecases.netlify.app/usecases.json`, refreshed
  continuously by its own curator. Titles + descriptions, no prompts.
- **Exa** (dormant) — set the key and it starts contributing discovered posts:
  ```bash
  wrangler secret put EXA_API_KEY
  ```

## Run it

```bash
cd worker
wrangler dev --local          # http://localhost:8787
curl localhost:8787/api/use-cases
curl "localhost:8787/cdn-cgi/local/scheduled"   # fire the cron locally
wrangler deploy
```

Point the site at a local worker while developing (in the browser console):

```js
localStorage.setItem('everyai_uc_api', 'http://127.0.0.1:8787');  // removeItem to reset
```

## Operate

Change how often it syncs — edit `triggers.crons` in `wrangler.jsonc` and redeploy
(`0 */6 * * *` is every 6 hours; `0 * * * *` is hourly).

Enable on-demand refresh:

```bash
wrangler secret put REFRESH_TOKEN        # value of your choice
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://everyai-use-cases.everyai-com.workers.dev/api/refresh
```

Check health:

```bash
curl https://everyai-use-cases.everyai-com.workers.dev/api/status
```

If a source fails, the sync records the error in `sources` and keeps serving the
last good library — a broken upstream never empties the page.

## Layout

```
worker/
  wrangler.jsonc        config: KV binding, cron schedule
  src/index.js          routes + cron handler
  src/sync.js           source fetching, merge, KV read/write
  src/data/field-guide.js   bundled 185 field-guide cases
```

The static page keeps its own bundled copy of the field guide
(`../muse-use-cases.js`) as an offline fallback — if the worker is ever
unreachable, `/use-cases` still renders the full guide.
