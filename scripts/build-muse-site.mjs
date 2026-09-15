#!/usr/bin/env node
/**
 * Assemble the standalone Muse field guide for muse.every-ai.com.
 *
 * The page is already self-contained (its own tokens, type and components),
 * so the build only has to:
 *   1. promote use-cases.html to index.html at the root,
 *   2. add canonical + Open Graph tags,
 *   3. copy the assets it loads.
 *
 * use-cases.html stays the source of truth — never edit dist/muse/index.html.
 *
 *   node scripts/build-muse-site.mjs      → dist/muse/
 */

import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'dist', 'muse');

const SITE_URL = process.env.MUSE_SITE_URL || 'https://muse.every-ai.com';

const ASSETS = ['use-cases.css', 'use-cases.js', 'muse-use-cases.js'];

const META = `    <link rel="canonical" href="${SITE_URL}/" >
    <meta property="og:type" content="website" >
    <meta property="og:title" content="Muse Field Guide — use cases, prompts & capability pack" >
    <meta property="og:description" content="350+ real Muse use cases with the exact prompt behind them, a Chief of Staff prompt that sets your agent up properly, and a capability pack you can hand over in one paste." >
    <meta property="og:url" content="${SITE_URL}/" >
    <meta name="twitter:card" content="summary_large_image" >
`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  let html = await readFile(join(ROOT, 'use-cases.html'), 'utf8');

  const anchor = '    <link rel="stylesheet" href="use-cases.css" >';
  if (!html.includes(anchor)) {
    throw new Error('build: stylesheet anchor not found in use-cases.html — did the head change?');
  }
  html = html.replace(anchor, `${META}${anchor}`);

  await writeFile(join(OUT_DIR, 'index.html'), html);

  for (const asset of ASSETS) {
    await copyFile(join(ROOT, asset), join(OUT_DIR, asset));
  }

  console.log(`built dist/muse/  →  ${SITE_URL}`);
  console.log(`  index.html (${(html.length / 1024).toFixed(1)} KB), ${ASSETS.join(', ')}`);
}

main().catch(err => {
  console.error('build failed:', err.message);
  process.exit(1);
});
