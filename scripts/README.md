# scripts

## build-muse-site.mjs — publish the standalone Muse site

`use-cases.html` normally lives inside the EveryAI site, where sibling links
(`about`, `prompts`, …) resolve. On its own subdomain those pages don't exist, so
the build assembles a self-contained copy in `dist/muse/` with:

- the page promoted to `index.html` (root of the subdomain),
- internal links rewritten to absolute URLs on the main site,
- `Use Cases` pointing at `./`,
- canonical + Open Graph tags for `https://muse.every-ai.com/`,
- `style.css`, `use-cases.css`, `use-cases.js`, `muse-use-cases.js` copied alongside.

```bash
node scripts/build-muse-site.mjs            # → dist/muse/
wrangler pages deploy dist/muse --project-name muse-every-ai --branch main
```

`use-cases.html` stays the single source of truth — never edit `dist/muse/index.html`
by hand, it's regenerated on every build. `dist/` is gitignored.

Overrides, if the domains ever change:

```bash
MUSE_SITE_URL=https://muse.example.com MAIN_SITE_URL=https://example.com \
  node scripts/build-muse-site.mjs
```

### Custom domain

`muse.every-ai.com` is attached to the `muse-every-ai` Pages project. Because
`every-ai.com`'s DNS is managed at Hostinger (not Cloudflare), the record has to be
created there:

| Type | Name | Value |
| --- | --- | --- |
| CNAME | `muse` | `muse-every-ai.pages.dev` |

Pages issues the certificate once that record resolves. Check status with:

```bash
curl -s -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/muse-every-ai/domains/muse.every-ai.com"
```
