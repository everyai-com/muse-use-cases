/* ================================================================
   Capability pack

   Turns the merged use-case library into something a Muse agent can
   be handed directly: what it can do, how to run it, the rules to
   follow, and the exact prompt behind every case.

     GET /muse/capabilities.md     – the playbook (markdown)
     GET /muse/capabilities.json   – same thing, structured
     GET /muse/setup.txt           – short prompt that points Muse here

   The point: someone pastes the setup prompt (or uploads the pack) and
   their Muse immediately knows the capabilities it can build for them —
   without them having to explain any of it.
   ================================================================ */

import {
  FIELD_GUIDE_GUARDRAILS,
  FIELD_GUIDE_MASTER_PROMPT,
  FIELD_GUIDE_PATTERNS
} from './data/field-guide.js';
import { CHIEF_OF_STAFF } from './prompts.js';

// A prompt may contain backticks; pick a fence that can't be closed early.
function fence(text) {
  const longest = (String(text).match(/`+/g) || []).reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function groupedByCategory(cases) {
  const groups = new Map();

  cases.forEach(item => {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  });

  return groups;
}

function caseBlock(item, index) {
  const lines = [`${index}. **${item.title}**`];
  const context = item.story || item.description;

  if (context) lines.push(`   - What it did: ${context}`);

  if (item.hasPrompt && item.prompt) {
    const mark = fence(item.prompt);
    lines.push('   - Prompt:');
    lines.push(`     ${mark}text`);
    item.prompt.split('\n').forEach(line => lines.push(`     ${line}`));
    lines.push(`     ${mark}`);
  } else {
    lines.push('   - No published prompt — the post below describes what it did.');
  }

  if (item.sourceUrl) lines.push(`   - Source: ${item.sourceUrl}`);

  return lines.join('\n');
}

// ── Markdown playbook ─────────────────────────────────────────────
export function buildCapabilityMarkdown(library, { packUrl, siteUrl }) {
  const { cases, counts, refreshedAt, agent } = library;
  const withPrompt = cases.filter(item => item.hasPrompt);
  const groups = groupedByCategory(cases);

  const out = [];

  out.push('# Muse Capability Pack');
  out.push('');
  out.push(
    `This is a playbook of **${counts.total} real things Muse has done**, built from public posts and a ` +
    `field guide. ${withPrompt.length} of them carry the exact prompt that ran the job.`
  );
  out.push('');
  out.push('| | |');
  out.push('| --- | --- |');
  out.push(`| Generated | ${refreshedAt} |`);
  out.push(`| Cases | ${counts.total} (${counts.withPrompt} with the exact prompt, ${counts.descriptionOnly} described only) |`);
  out.push(`| Categories | ${groups.size} |`);
  out.push(`| This file | ${packUrl} |`);
  out.push(`| Browse it | ${siteUrl} |`);
  out.push('');
  out.push('---');
  out.push('');

  // ── Instructions ──
  out.push('## Instructions for Muse');
  out.push('');
  out.push(
    'You are Muse, working for the person who gave you this pack. Everything below is a capability ' +
    'you already have. Use it to decide what you can do for them — don\'t wait to be told which case to run.'
  );
  out.push('');
  out.push('**When they ask for something:**');
  out.push('');
  out.push('1. Match the request to the closest case in this pack. Search the titles, categories and descriptions — a near-miss is fine, adapt the case.');
  out.push('2. Ask for every missing detail in one round, up front.');
  out.push('3. Then execute end to end without stopping. Only hand control back where a human decision, identity check, signature, payment, or approval is genuinely required.');
  out.push('4. Verify the outcome and report it — with receipts, links, or confirmation numbers.');
  out.push('');
  out.push('**When they ask what you can do:** pick the cases that fit what you already know about them, describe the outcome in one line each, and offer to start.');
  out.push('');
  out.push('**To run a case:** send its prompt wrapped in the master prompt below.');
  out.push('');
  out.push('### Master prompt wrapper');
  out.push('');
  const masterFence = fence(FIELD_GUIDE_MASTER_PROMPT);
  out.push(`${masterFence}text`);
  out.push(FIELD_GUIDE_MASTER_PROMPT);
  out.push(masterFence);
  out.push('');
  out.push('---');
  out.push('');

  // ── Start here ──
  out.push('## Start here: the Chief of Staff prompt');
  out.push('');
  out.push(
    `${CHIEF_OF_STAFF.tagline} Send it once, before anything else — it connects what needs ` +
    'connecting, learns the context behind the cases below, then keeps a memory and a weekly review going.'
  );
  out.push('');
  const chiefFence = fence(CHIEF_OF_STAFF.prompt);
  out.push(`${chiefFence}text`);
  out.push(CHIEF_OF_STAFF.prompt);
  out.push(chiefFence);
  out.push('');
  out.push('---');
  out.push('');

  // ── Rules + loops ──
  out.push('## Operating rules');
  out.push('');
  out.push('These came up again and again in hands-on reports. Build them into how you run every case.');
  out.push('');
  FIELD_GUIDE_GUARDRAILS.forEach(rule => {
    out.push(`- **${rule.title}** — ${rule.body}`);
  });
  out.push('');
  out.push('## Reusable loops');
  out.push('');
  out.push('Most new requests are one of these twelve shapes. Compose them to invent cases that aren\'t listed.');
  out.push('');
  FIELD_GUIDE_PATTERNS.forEach(pattern => {
    out.push(`- **${pattern.title}** — ${pattern.body}`);
  });
  out.push('');
  out.push('---');
  out.push('');

  // ── The library ──
  out.push('## Capabilities by category');
  out.push('');
  out.push(`Everything below is indexed for lookup. ${counts.withPrompt} cases include a runnable prompt; the rest link to the post that describes them.`);
  out.push('');

  groups.forEach((items, category) => {
    out.push(`### ${category} (${items.length})`);
    out.push('');
    items.forEach((item, index) => {
      out.push(caseBlock(item, index + 1));
      out.push('');
    });
  });

  out.push('---');
  out.push('');
  out.push(
    `Built from ${agent.name} use cases gathered from ${agent.collectedFrom} (field guide snapshot ${agent.snapshot}), ` +
    'merged and re-synced automatically. Every entry keeps a link to the post it came from.'
  );
  out.push('');

  return out.join('\n');
}

// ── Structured version ────────────────────────────────────────────
export function buildCapabilityJson(library, { packUrl, siteUrl }) {
  return {
    version: 1,
    kind: 'muse-capability-pack',
    generatedAt: library.refreshedAt,
    packUrl,
    siteUrl,
    agent: library.agent,
    counts: library.counts,
    instructions: {
      role: 'Muse, working for the person who handed you this pack. Everything here is a capability you already have.',
      start_here: 'Send the chief_of_staff prompt once, before anything else.',
      run_a_case: [
        'Match the request to the closest case below; adapt near-misses.',
        'Ask for every missing detail in one round, up front.',
        'Execute end to end without stopping.',
        'Pause only for human decisions, identity checks, signatures, payments, or approvals.',
        'Verify the outcome and report receipts.'
      ],
      when_asked_what_can_you_do: 'Pick the cases that fit what you know about the person, one line each, and offer to start.',
      master_prompt: FIELD_GUIDE_MASTER_PROMPT
    },
    chief_of_staff: CHIEF_OF_STAFF,
    rules: FIELD_GUIDE_GUARDRAILS,
    loops: FIELD_GUIDE_PATTERNS,
    cases: library.cases.map(item => ({
      id: item.id,
      title: item.title,
      category: item.category,
      hasPrompt: item.hasPrompt,
      prompt: item.prompt,
      summary: item.story || item.description,
      sourceUrl: item.sourceUrl,
      sourceName: item.sourceName,
      origins: item.origins
    }))
  };
}

// ── The paste-into-Muse prompt ────────────────────────────────────
export function buildSetupPrompt(library, { packUrl, siteUrl }) {
  const { counts } = library;

  return [
    'You are Muse. Before we start, load your capability pack and make it your playbook:',
    '',
    packUrl,
    '',
    `It covers ${counts.total} real use cases you can run end to end — ${counts.withPrompt} with the exact prompt, plus your operating rules and the guardrails to apply. Read it, then tell me the handful of things from it you can do for me today, one line each.`,
    '',
    'When I ask for something that matches a case, run it end to end: ask for anything you are missing in one round, then execute without stopping. Pause only for payments, signatures, sends, identity checks, or approvals, verify the outcome, and show me the receipts.',
    '',
    `Browse the library: ${siteUrl}`
  ].join('\n');
}
