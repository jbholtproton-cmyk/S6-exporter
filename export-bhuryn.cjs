'use strict';

// Public Tracker export for Bhuryn. No Ubisoft credentials or cookies are used.
// Local install: npm install r6s-stats-api
// GitHub Actions sets R6_CLIENT_MODULE to a pinned, built source checkout.
// Requires Node.js >= 24.15.0. Run: node export-bhuryn.cjs
// Diagnostic revision: 2026-10-07. Live Tracker retrieval remains unverified.
// Observe the pinned client browser, without replacing its retrieval algorithm.
// Diagnostics are embedded in the existing JSON artifact; no workflow changes.

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
    message: scrub(error?.message ?? 'Unspecified error.'),
    status: Number.isFinite(error?.status) ? error.status : null,
    retryAfterMs: Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : null
  };
}

function makeReport() {
  return {
    schemaVersion: 2,
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

/** Remove query values and common credential forms from public diagnostics. */
function safeUrl(value) {
  try {
    const u = new URL(String(value));
    return `${u.origin}${u.pathname}${u.search ? '?[redacted]' : ''}`;
  } catch { return '[unavailable URL]'; }
}
function scrub(value, maximum = 1000) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s<>"']+/gi, match => safeUrl(match))
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:access_token|refresh_token|id_token|password|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi, '[redacted credential]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted token]')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .slice(0, maximum);
}
function isTrackerUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return ['tracker.network', 'tracker.gg'].some(domain => host === domain || host.endsWith(`.${domain}`));
  } catch { return false; }
}
async function bounded(operation, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Diagnostic time limit.'), { code: 'DIAGNOSTIC_TIMEOUT' })), milliseconds);
      })
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * Observe the EXISTING client's Chromium session. This wraps launch/newContext/
 * close only to attach listeners and take a final snapshot; all supplied launch
 * settings, navigation, response predicates and requests remain unchanged.
 * No credentials, saved profiles, request bodies, cookies, storage or header
 * dumps are read. Screenshots are of the client's unauthenticated public tab.
 * This relies on the pinned client's use of the same Playwright Chromium object.
 */
function observeChromium(chromium, report, save, log = console.log) {
  const expected = `https://api.tracker.gg/api/v2/r6siege/standard/profile/${PLATFORM}/${encodeURIComponent(PLAYER)}`;
  const d = report.diagnostics = {
    kind: 'public-browser-observation-v1',
    installed: true,
    browserLaunched: false,
    expectedProfileApiUrl: expected,
    expectedRequestSeen: false,
    expectedResponseSeen: false,
    events: [],
    eventsDropped: 0,
    pages: [],
    limitations: [
      'Only the existing browser fallback is observed; initial direct HTTP traffic is not captured.',
      'Response events report arrival of response headers, not completion of JSON parsing.',
      'Snapshots describe a public browser page, not a verified stats export.',
      'URL queries are redacted; no cookies, storage, credentials or request bodies are exported.',
      'Screenshots are embedded in this JSON so the existing workflow uploads them.'
    ]
  };
  const start = Date.now();
  const persist = () => { try { save(); } catch { /* main export reports I/O failures */ } };
  function event(kind, details = {}) {
    if (d.events.length < 240) d.events.push({ elapsedMs: Date.now() - start, kind, ...details });
    else d.eventsDropped++;
  }
  const previous = Object.getOwnPropertyDescriptor(chromium, 'launch');
  const launch = chromium.launch;
  if (typeof launch !== 'function') throw new Error('Chromium launch API unavailable.');
  const wrapped = async function (...launchArgs) {
    event('browser_launch_started');
    const browser = await launch.apply(this, launchArgs);
    d.browserLaunched = true;
    event('browser_launched');
    log('[diagnostics] Observing the client browser; no additional navigation or login.');
    persist();
    const pages = [];
    const newContext = browser.newContext;
    browser.newContext = async function (...args) {
      const context = await newContext.apply(this, args);
      context.on('page', page => {
        if (pages.length >= 3) { event('page_observation_limit'); return; }
        const info = { index: pages.length, finalUrl: null, pageErrors: [], consoleErrorCount: 0 };
        pages.push({ page, info });
        d.pages.push(info);
        page.on('request', request => {
          const raw = request.url();
          if (!isTrackerUrl(raw)) return;
          const exact = raw.split('?')[0] === expected;
          if (exact) { d.expectedRequestSeen = true; persist(); }
          if (['document', 'xhr', 'fetch'].includes(request.resourceType()) || exact) {
            event('request', { page: info.index, url: safeUrl(raw), resourceType: request.resourceType(), expectedProfileApi: exact });
          }
        });
        page.on('response', response => {
          const raw = response.url();
          if (!isTrackerUrl(raw)) return;
          const exact = raw.split('?')[0] === expected;
          if (exact) { d.expectedResponseSeen = true; persist(); }
          const type = response.request().resourceType();
          if (['document', 'xhr', 'fetch'].includes(type) || response.status() >= 400 || exact) {
            event('response', { page: info.index, url: safeUrl(raw), status: response.status(), resourceType: type, expectedProfileApi: exact });
          }
        });
        page.on('requestfailed', request => {
          if (isTrackerUrl(request.url())) {
            event('request_failed', { page: info.index, url: safeUrl(request.url()), resourceType: request.resourceType(), error: scrub(request.failure()?.errorText) });
            persist();
          }
        });
        page.on('pageerror', error => {
          if (info.pageErrors.length < 12) info.pageErrors.push(scrub(error?.message));
        });
        // Do not dump console arguments, which could contain session material.
        page.on('console', message => { if (message.type() === 'error') info.consoleErrorCount++; });
        page.on('framenavigated', frame => {
          if (frame === page.mainFrame()) {
            info.finalUrl = safeUrl(page.url());
            event('navigation', { page: info.index, url: info.finalUrl });
          }
        });
      });
      return context;
    };
    async function snapshot({page, info}) {
      if (page.isClosed()) { info.snapshotStatus = 'page_already_closed'; return; }
      const rawUrl = page.url();
      info.finalUrl = safeUrl(rawUrl);
      // Never snapshot a redirected sign-in or unrelated page.
      const u = (() => { try { return new URL(rawUrl); } catch { return null; } })();
      if (!u || u.hostname !== 'r6.tracker.network' || !u.pathname.startsWith('/r6siege/profile/')) {
        info.snapshotStatus = 'skipped_non_profile_page';
        return;
      }
      info.snapshotAt = new Date().toISOString();
      const jobs = [
        bounded(page.title(), 2000).then(title => { info.title = scrub(title, 500); }),
        bounded(page.locator('body').innerText({ timeout: 2000 }), 2200).then(text => {
          info.visibleText = scrub(text, 10000);
          const lower = info.visibleText.toLowerCase();
          info.challengeTextMarkers = ['verify you are human', 'just a moment', 'access denied', 'you have been blocked', 'checking your browser'].filter(s => lower.includes(s));
          info.errorTextMarkers = ['network error', 'runtime error', 'application error', 'something went wrong'].filter(s => lower.includes(s));
        }),
        bounded(page.screenshot({ type: 'jpeg', quality: 45, fullPage: false, timeout: 3000 }), 3200).then(bytes => {
          if (bytes.length <= 1024 * 1024) info.screenshot = { mimeType: 'image/jpeg', encoding: 'base64', data: bytes.toString('base64') };
          else info.screenshotStatus = 'omitted_over_1MiB';
        })
      ];
      const results = await Promise.allSettled(jobs);
      info.snapshotStatus = results.every(r => r.status === 'fulfilled') ? 'captured' : 'partial';
      info.snapshotFailures = results.map((r, i) => r.status === 'rejected' ? ['title', 'visibleText', 'screenshot'][i] : null).filter(Boolean);
      persist();
    }
    const close = browser.close;
    let closing;
    browser.close = function (...closeArgs) {
      if (!closing) closing = (async () => {
        try { await bounded(Promise.allSettled(pages.map(snapshot)), 4500); }
        catch { event('snapshot_time_limit'); }
        finally {
          event('browser_closing');
          persist();
        }
        return close.apply(browser, closeArgs);
      })();
      return closing;
    };
    return browser;
  };
  chromium.launch = wrapped;
  return () => {
    if (chromium.launch === wrapped) {
      if (previous) Object.defineProperty(chromium, 'launch', previous);
      else delete chromium.launch;
    }
  };
}

function finalFailure(report, error, phase) {
  report.error = serializeError(error);
  report.failedPhase = phase;
  report.status = Object.values(report.sections).some(s => s.status === 'retrieved') ? 'partial' : 'failed';
  report.finishedAt = new Date().toISOString();
  for (const [key, , scope] of SECTIONS) report.sections[key] ??= { status: 'not_attempted', requestedScope: scope };
}

async function main() {
  const report = makeReport();
  report.exporterRevision = '2026-10-07-browser-diagnostics-1';
  report.execution = { commit: process.env.GITHUB_SHA ?? null, runId: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null, requestTimeoutMs: 60000, overallTimeoutMs: 180000 };
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const output = path.join(__dirname, `Bhuryn-stats-${stamp}.json`);
  const save = () => {
    const temporary = output + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, output);
  };
  let client, watchdog;
  let restore = () => {};
  let phase = 'initialization';
  save();
  console.log('Read-only public Tracker export. No Ubisoft sign-in required.');
  console.log(`Output: ${output}`);
  console.log(`Exporter: ${report.exporterRevision}; request timeout: 60000 ms; total limit: 180000 ms.`);
  console.log(`Commit: ${report.execution.commit ?? '(local run)'}`);
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 24 || (major === 24 && minor < 15)) {
      throw Object.assign(new Error('This pinned client requires Node.js 24.15.0 or newer.'), { code: 'UNSUPPORTED_NODE' });
    }
    const modulePath = process.env.R6_CLIENT_MODULE;
    const resolved = modulePath ? path.resolve(modulePath) : require.resolve('r6s-stats-api');
    const {createClient} = require(resolved);
    if (typeof createClient !== 'function') throw Object.assign(new Error('createClient is missing.'), { code: 'UNSUPPORTED_PACKAGE' });
    try {
      const {createRequire} = require('node:module');
      const clientRequire = createRequire(resolved);
      const {chromium} = clientRequire('playwright');
      restore = observeChromium(chromium, report, save);
    } catch (error) {
      report.diagnostics = { installed: false, error: serializeError(error) };
      console.error(`[diagnostics] Could not install observation: ${scrub(error.message)}. Export still uses the original client.`);
    }
    client = createClient({ timeoutMs: 60000, retries: 0, minRequestIntervalMs: 1000 });
    phase = 'collection';
    watchdog = setTimeout(() => {
      finalFailure(report, Object.assign(new Error('Overall export time limit reached.'), { code: 'TOTAL_TIME_LIMIT' }), phase);
      report.stoppedReason = 'TOTAL_TIME_LIMIT';
      try { save(); } catch { /* exit even if disk writing fails */ }
      console.error('Stopped at the total time limit. Available diagnostics were saved.');
      bounded(Promise.resolve().then(() => client.close()), 6000).catch(() => {})
        .finally(() => { restore(); process.exit(2); });
    }, 180000);
    await collect(client, report, save);
    console.log(`Export ${report.status}: ${output}`);
    if (report.status === 'failed') {
      console.error('No fresh statistics were retrieved. Do not interpret missing sections as zero.');
      process.exitCode = 1;
    }
  } catch (error) {
    finalFailure(report, error, phase);
    save();
    console.error(`Export stopped: ${report.error.code}: ${report.error.message}`);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    if (client) {
      try { await bounded(Promise.resolve().then(() => client.close()), 6000); }
      catch (error) {
        report.cleanupError = serializeError(error);
        // Guarantee termination if a browser cannot close normally.
        setTimeout(() => process.exit(process.exitCode || 2), 250).unref();
      }
    }
    restore();
    save();
    const d = report.diagnostics;
    if (d?.installed) console.log(`[diagnostics] Browser launched=${d.browserLaunched}; expected request seen=${d.expectedRequestSeen}; expected response seen=${d.expectedResponseSeen}. Details are in the JSON.`);
  }
}

module.exports = { collect, makeReport, SECTIONS, observeChromium, safeUrl, scrub, finalFailure };
if (require.main === module) main().catch(error => {
  console.error(`Fatal exporter error: ${scrub(error?.message)}`);
  process.exitCode = 1;
});
