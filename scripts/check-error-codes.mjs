#!/usr/bin/env node
/**
 * Checks that every error code a client branches on is one a backend service can answer.
 *
 * The services expose stable codes (`USR-BUS-004`, `CHT-TEC-002`…) in their RFC 7807
 * responses, and wely-web and wely-ios compare against those strings. Nothing ties the two
 * sides together: a code renamed or removed in a service keeps compiling in the clients and
 * simply stops matching. This script reads both sides from a local checkout of the
 * repositories and fails on any client code that no service declares.
 *
 * Usage: node scripts/check-error-codes.mjs [workspace]
 *   workspace: the directory holding the repositories side by side (default: `..`).
 *
 * The backend catalogue is every code-shaped string literal under `src/main/java`, so it
 * covers the error-code enums and the codes the error handlers write directly
 * (`<PFX>-VAL-001`, `<PFX>-REQ-000`, `<PFX>-TEC-000`). Client tests are skipped: they may
 * use made-up codes on purpose.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const CODE = /"([A-Z]{3}-(?:BUS|VAL|REQ|TEC)-\d{3})"|'([A-Z]{3}-(?:BUS|VAL|REQ|TEC)-\d{3})'/g;

// Local directory names: the repositories were renamed on GitHub, the checkouts were not.
const BACKENDS = [
  'calendar-users-api',
  'calendar-social-api',
  'calendar-chat-api',
  'calendar-events-api',
  'wely-media',
  'wely-notifications',
  'calendar-gateway',
];

const CLIENTS = [
  { name: 'wely-web', dir: 'calendar-app/src', extension: '.ts', isTest: (path) => path.endsWith('.spec.ts') },
  { name: 'wely-ios', dir: 'wely-ios/Wely', extension: '.swift', isTest: () => false },
];

const workspace = resolve(process.argv[2] ?? '..');

function filesUnder(dir, extension) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return filesUnder(path, extension);
    }
    return path.endsWith(extension) ? [path] : [];
  });
}

function codesIn(path) {
  return [...readFileSync(path, 'utf8').matchAll(CODE)].map((match) => match[1] ?? match[2]);
}

function requireDir(dir) {
  if (!existsSync(dir)) {
    console.error(`Missing ${relative(workspace, dir)}: run from wely-platform with every repository checked out alongside.`);
    process.exit(2);
  }
  return dir;
}

const catalogue = new Set(
  BACKENDS.flatMap((backend) =>
    filesUnder(requireDir(join(workspace, backend, 'src/main/java')), '.java').flatMap(codesIn),
  ),
);

let unknown = 0;
for (const client of CLIENTS) {
  const sources = filesUnder(requireDir(join(workspace, client.dir)), client.extension).filter(
    (path) => !client.isTest(path),
  );
  const used = sources.flatMap((path) => codesIn(path).map((code) => ({ code, path })));
  const missing = used.filter(({ code }) => !catalogue.has(code));

  console.log(`${client.name}: ${new Set(used.map(({ code }) => code)).size} codes used, ${missing.length} unknown`);
  for (const { code, path } of missing) {
    console.log(`  ${code}  ${relative(workspace, path)}`);
  }
  unknown += missing.length;
}

console.log(`backend catalogue: ${catalogue.size} codes`);
process.exit(unknown === 0 ? 0 : 1);
