# Contributing

Two ways to add a case: send it in through the form on
[muse.every-ai.com](https://muse.every-ai.com/#submit), or open a pull request here.

## Add a case by pull request

A case is one object in a JSON array. The easiest path is to add it to a
source file and let the build regenerate the bundles:

1. Add your case to the field-guide snapshot in `worker/src/data/field-guide.js`:

```js
{"id": "guide:chase-late-parcel", "title": "Chase a late parcel across three carriers",
 "category": "Admin",
 "prompt": "My parcel [tracking] has not moved in [X] days. Find where it stalled, chase the right carrier, and get it delivered.",
 "description": null,
 "story": "Parcel went missing between carriers; the agent found where it stalled and got it moving again.",
 "sourceHandle": "@you", "sourceUrl": "https://x.com/you/status/…",
 "sourceName": "Muse use cases field guide", "hasPrompt": true, "addedAt": null,
 "origins": ["field-guide"]}
```

2. Regenerate the site's fallback bundle so both stay in step:

```bash
node scripts/build-muse-site.mjs      # sanity-check the build
```

3. Open the pull request.

If you don't want to touch the data files, submit through the form instead — those cases go into the
same review queue and land in the library once approved, no PR needed.

## What makes a good case

- **It actually ran.** Not a hypothetical, not a demo. A real thing you did.
- **The prompt is the gold.** Paste it verbatim. Keep placeholders in `[square brackets]` so others
  know what to fill in.
- **No prompt published?** That's fine — send the description and the link to the post. It ships as a
  "description only" card that links out.
- **Credit stays attached.** Add a handle or a source URL.
- **Say what went wrong, too.** Cases that needed three tries are more useful than ones that sound
  perfect.

## Ground rules

Be accurate about what happened. Don't include anything private — no account numbers, addresses,
tokens or personal data belonging to someone else. Cases are read before they ship; anything that
can't be traced to a real run gets rejected.

## Working on the code

```bash
cd worker
wrangler dev --local          # worker on :8787
curl localhost:8787/api/use-cases
curl "localhost:8787/cdn-cgi/local/scheduled"    # fire the cron once

node ../scripts/build-muse-site.mjs              # site build
```

The page is deliberately dependency-free — plain ES modules, no framework, no build step for the
stylesheet. Keep it that way where you can.
