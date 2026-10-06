'use strict';

// Public Tracker export for Bhuryn. No Ubisoft credentials or cookies are used.
// Local install: npm install r6s-stats-api
// GitHub Actions sets R6_CLIENT_MODULE to a pinned, built source checkout.
// Requires Node.js >= 24.15.0. Run: node export-bhuryn.cjs
// This wrapper was tested offline; live Tracker access is NOT verified.

const fs = require('node:fs');
const path = require('node:path');

const PLAYER = 'Bhuryn';
const PLATFORM = 'ubi';
const ACCOUNT_ID = '2d86dc16-9c1b-4947-b283-4e6e909ccd6f';
const FATAL_CODES = new Set([
  'ACCESS_DENIED', 'RATE_LIMITED', 'PLAYER_NOT_FOUND',
  'BROWSER_UNAVAILABLE', 'CLIENT_CLOSED', 'UNSUPPORTED_PACKAGE'
]);
const SECTIONS = [
  ['overview', 'getOverview', 'Lifetime overview; retain source playlist/season labels.'],
  ['seasons', 'getSeasons', 'All recorded season/playlist segments returned by the source.'],
  ['quickMatchCurrentSeason', 'getQuickMatch', 'Current season Quick Match; null is unavailable, not zero.'],
  ['rankedCurrentSeason', 'getRanked', 'Current season Ranked; null is unavailable, not zero.'],
  ['unrankedCurrentSeason', 'getUnranked', 'Current season Unranked as defined by the source.'],
  ['operatorsDefaultFilters', 'getOperators', 'Default source filters; do not assume the Stats.cc baseline scope.'],
  ['mapsDefaultFilters', 'getMaps', 'Default source filters; do not assume the Stats.cc baseline scope.'],
  ['recentMatchesFirstPage', 'getMatches', 'First page only; this is NOT complete all-time match history.']
];

function serializeError(error) {
  // Deliberately exclude response bodies, headers, and stack traces.
  return {
    code: typeof error?.code === 'string' ? error.code : 'ERROR',
    status: Number.isFinite(error?.status) ? error.status : null,
    retryAfterMs: Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : null
  };
}

function makeReport() {
  return {
    schemaVersion: 1,
    requestedPlayer: { username: PLAYER, platform: PLATFORM, ubisoftId: ACCOUNT_ID },
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    notes: [
      'Public Tracker data, not Ubisoft Career or Stats.cc.',
      'Export timestamps and fetchedAt are NOT the latest played-match time.',
      'Verify the returned identity before interpreting the results.',
      'Preserve match-win and round-win statistics separately.',
      'Missing or null statistics are not zero.',
      'Source filters may differ from previous Stats.cc snapshots.',
      '3v3 support is not established by this client; do not relabel another mode as 3v3.',
      'Only the first page of recent matches is requested.'
    ],
    sections: {}
  };
}

async function collect(client, report, save, log = console.log) {
  let successes = 0;
  for (const [key, method, scope] of SECTIONS) {
    log(`Reading ${key}...`);
    try {
      if (typeof client[method] !== 'function') {
        throw Object.assign(new Error('Documented API not available.'), { code: 'UNSUPPORTED_PACKAGE' });
      }
      const result = await client[method](PLATFORM, PLAYER);
      if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'data')) {
        throw Object.assign(new Error('Unexpected result structure.'), { code: 'PARSE_ERROR' });
      }
      // Preserve the documented data envelope; never synthesize missing values.
      report.sections[key] = { status: 'retrieved', requestedScope: scope, result };
      successes += 1;
      log(result.data == null ? '  No recorded data for this scope.' : '  Response saved.');
    } catch (error) {
      const info = serializeError(error);
      report.sections[key] = { status: 'failed', requestedScope: scope, error: info };
      log(`  Failed: ${info.code}${info.status == null ? '' : ` (HTTP ${info.status})`}`);
      // Do not repeat a blocked overview request through several endpoints.
      if (key === 'overview' || FATAL_CODES.has(info.code)) {
        save();
        break;
      }
    }
    save();
  }
  for (const [key, , scope] of SECTIONS) {
    report.sections[key] ??= { status: 'not_attempted', requestedScope: scope };
  }
  report.finishedAt = new Date().toISOString();
  report.status = successes === SECTIONS.length ? 'complete' : successes ? 'partial' : 'failed';
  save();
  return report;
}

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 15)) {
    console.error(`Node ${process.versions.node} detected. This client's documentation requires Node 24.15.0 or newer.`);
    process.exitCode = 1;
    return;
  }
  let createClient;
  try {
    const modulePath = process.env.R6_CLIENT_MODULE;
    ({ createClient } = require(modulePath ? path.resolve(modulePath) : 'r6s-stats-api'));
  } catch {
    console.error('Client unavailable. Check the dependency-install/build steps, or locally run: npm install r6s-stats-api');
    process.exitCode = 1;
    return;
  }
  if (typeof createClient !== 'function') {
    console.error('The installed package does not expose the documented createClient API. No requests were made.');
    process.exitCode = 1;
    return;
  }
  const report = makeReport();
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const output = path.join(__dirname, `Bhuryn-stats-${stamp}.json`);
  const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });
  save();
  console.log('Read-only public Tracker export. No Ubisoft sign-in required.');
  console.log(`Output: ${output}`);
const client = createClient({
  timeoutMs: 240000,
  retries: 0,
  minRequestIntervalMs: 1000
});
  // Hard cap prevents an upstream/browser stall from leaving this running indefinitely.
  const watchdog = setTimeout(() => {
    report.status = Object.values(report.sections).some(section => section.status === 'retrieved') ? 'partial' : 'failed';
    report.stoppedReason = 'TOTAL_TIME_LIMIT';
    report.finishedAt = new Date().toISOString();
    save();
    console.error('Stopped at the total time limit. Any partial results were saved.');
    Promise.race([Promise.resolve().then(() => client.close()).catch(() => {}), new Promise(r => setTimeout(r, 1500))])
      .finally(() => process.exit(2));
  }, 180000);
  try {
    await collect(client, report, save);
    console.log(`Export ${report.status}: ${output}`);
    if (report.status === 'failed') {
      console.error('No fresh statistics were retrieved. Do not interpret missing sections as zero.');
      process.exitCode = 1;
    }
  } finally {
    await Promise.race([Promise.resolve().then(() => client.close()).catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
    clearTimeout(watchdog);
  }
}

module.exports = { collect, makeReport, SECTIONS };
if (require.main === module) {
  main().catch(error => {
    console.error(`Export stopped: ${serializeError(error).code}`);
    process.exitCode = 1;
  });
}
