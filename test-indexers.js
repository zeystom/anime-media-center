/**
 * Offline test suite for the BYOC indexer stack (electron/indexers.ts) and the
 * VPN tunnel guard (electron/vpnGuard.ts).
 *
 * No network access happens here: global.fetch is fully mocked and every feed
 * is an inline fixture. All URLs are obviously-fake example.com-style
 * endpoints — NO real tracker/indexer URLs appear anywhere (BYOC: providers
 * come exclusively from user configuration).
 *
 * Covered:
 * 1. buildQueryUrl — substitutions, encoding, placeholder preservation, invalid templates.
 * 2. fetchProviderFeed — RSS 2.0 fixtures (enclosure/link/magnet), Torznab
 *    fixtures (namespaced + plain attr seeders/leechers/size), HTTP errors,
 *    malformed XML, empty channels, request headers/timeout signal.
 * 3. searchProviders — allSettled merge across providers, dedupe by
 *    title+size, disabled providers skipped, provider failures tolerated.
 * 4. rankReleasesForEpisode — title/season/episode scoring, stable order,
 *    no mutation, empty-reference passthrough.
 * 5. import/exportProvidersConfig — round-trip, tolerant import, validation,
 *    20-provider cap.
 * 6. VPN guard — real os-based detection shape + cache/clear semantics.
 */

import assert from 'assert';
import {
  buildQueryUrl,
  fetchProviderFeed,
  searchProviders,
  rankReleasesForEpisode,
  importProvidersConfig,
  exportProvidersConfig,
} from './electron/indexers.ts';
import { detectVpnStatus, clearVpnCache } from './electron/vpnGuard.ts';

let passed = 0;
let failed = 0;

function runTest(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`✗ FAIL: ${name}`);
    console.error(`  ${err && err.stack ? String(err.stack).split('\n').slice(0, 4).join('\n  ') : err}`);
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`✗ FAIL: ${name}`);
    console.error(`  ${err && err.stack ? String(err.stack).split('\n').slice(0, 4).join('\n  ') : err}`);
  }
}

// ---------------------------------------------------------------------------
// fetch mock infrastructure (global.fetch replaced entirely; zero network)
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
let fetchCalls = [];
let fetchHandler = null;

function installFetchMock(handler) {
  fetchCalls = [];
  fetchHandler = handler;
  globalThis.fetch = async (url, init) => fetchHandler(String(url), init, fetchCalls);
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

/** A provider whose template points at a fake indexer (never a real site). */
const rssProvider = {
  id: 'prov-rss',
  name: 'Example RSS',
  urlTemplate: 'https://indexer.example/rss?q={query}',
  type: 'rss',
  enabled: true,
};

const torznabProvider = {
  id: 'prov-torznab',
  name: 'Example Torznab',
  urlTemplate: 'https://indexer.example/api?t=search&q={query}',
  type: 'torznab',
  enabled: true,
};

// RSS 2.0 fixture: enclosure+length, link fallback, magnet link, bad pubDate.
const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <item>
      <title>[Group] Example Anime - 05 [1080p]</title>
      <link>https://mirror.example/get/1</link>
      <enclosure url="https://mirror.example/dl/1.torrent" length="734003200" type="application/x-bittorrent" />
      <pubDate>Tue, 04 Nov 2025 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>[Group] Example Anime - 06 [1080p]</title>
      <link>https://mirror.example/get/2</link>
      <pubDate>not a date</pubDate>
    </item>
    <item>
      <title>[Group] Example Anime - 07 [1080p]</title>
      <link>magnet:?xt=urn:btih:CAFEBABE00000000000000000000000000000000</link>
    </item>
  </channel>
</rss>`;

// Torznab fixture: namespaced attrs + plain attr, size attr vs enclosure length, magnet enclosure.
const TORZNAB_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <title>Example Torznab Feed</title>
    <item>
      <title>[Group] Example Anime S02E03 [1080p]</title>
      <link>https://mirror.example/get/9</link>
      <enclosure url="https://mirror.example/dl/9.torrent" length="1468006400" type="application/x-bittorrent" />
      <torznab:attr name="seeders" value="42" />
      <torznab:attr name="leechers" value="3" />
      <torznab:attr name="size" value="1468006401" />
    </item>
    <item>
      <title>[Group] Example Anime S02E04 [1080p]</title>
      <enclosure url="magnet:?xt=urn:btih:DEADBEEF00000000000000000000000000000000" />
      <attr name="seeders" value="7" />
    </item>
  </channel>
</rss>`;

const EMPTY_FEED_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Empty Feed</title>
  </channel>
</rss>`;

async function main() {
  console.log('Testing BYOC indexers + VPN guard (offline, mocked fetch)...\n');

  // =========================================================================
  // 1. buildQueryUrl
  // =========================================================================
  console.log('--- SUITE 1: buildQueryUrl ---');

  runTest('1.1 substitutes {query}, {season}, {episode}', () => {
    const url = buildQueryUrl('https://indexer.example/rss?q={query}&season={season}&ep={episode}', {
      query: 'Frieren 05',
      season: 2,
      episode: 5,
    });
    assert.strictEqual(url, 'https://indexer.example/rss?q=Frieren%2005&season=2&ep=5');
  });

  runTest('1.2 URL-encodes spaces and unicode query characters', () => {
    const url = buildQueryUrl('https://indexer.example/rss?q={query}', { query: '鬼滅の刃 Second Season' });
    assert.strictEqual(url, `https://indexer.example/rss?q=${encodeURIComponent('鬼滅の刃 Second Season')}`);
    assert.ok(!url.includes(' '), 'encoded URL must not contain raw spaces');
  });

  runTest('1.3 null/undefined season+episode leave placeholders untouched', () => {
    const template = 'https://indexer.example/rss?q={query}&season={season}&ep={episode}';
    assert.strictEqual(
      buildQueryUrl(template, { query: 'x', season: null, episode: null }),
      'https://indexer.example/rss?q=x&season={season}&ep={episode}'
    );
    assert.strictEqual(
      buildQueryUrl(template, { query: 'x' }),
      'https://indexer.example/rss?q=x&season={season}&ep={episode}'
    );
  });

  runTest('1.4 season+episode are independent (only provided ones replaced)', () => {
    const url = buildQueryUrl('https://indexer.example/rss?q={query}&s={season}&e={episode}', {
      query: 'x',
      season: 3,
      episode: null,
    });
    assert.strictEqual(url, 'https://indexer.example/rss?q=x&s=3&e={episode}');
  });

  runTest('1.5 missing {query} placeholder → null', () => {
    assert.strictEqual(buildQueryUrl('https://indexer.example/search?term=', { query: 'x' }), null);
    assert.strictEqual(buildQueryUrl('https://indexer.example/rss?q={term}', { query: 'x' }), null);
  });

  runTest('1.6 non-http(s) template → null', () => {
    assert.strictEqual(buildQueryUrl('ftp://indexer.example/rss?q={query}', { query: 'x' }), null);
    assert.strictEqual(buildQueryUrl('indexer.example/rss?q={query}', { query: 'x' }), null);
    assert.strictEqual(buildQueryUrl('', { query: 'x' }), null);
    assert.strictEqual(buildQueryUrl('   ', { query: 'x' }), null);
  });

  runTest('1.7 whitespace around template/query is trimmed', () => {
    const url = buildQueryUrl('  https://indexer.example/rss?q={query}  ', { query: '  Frieren  ' });
    assert.strictEqual(url, 'https://indexer.example/rss?q=Frieren');
  });

  runTest('1.8 http (non-tls) templates are allowed', () => {
    assert.strictEqual(
      buildQueryUrl('http://indexer.example/rss?q={query}', { query: 'a b' }),
      'http://indexer.example/rss?q=a%20b'
    );
  });

  // =========================================================================
  // 2. fetchProviderFeed (mocked fetch)
  // =========================================================================
  console.log('\n--- SUITE 2: fetchProviderFeed (RSS + Torznab fixtures) ---');

  await runAsyncTest('2.1 RSS fixture: 3 items normalized (enclosure, link fallback, magnet)', async () => {
    installFetchMock((url, init, calls) => {
      calls.push({ url, init });
      return jsonResponse(200, RSS_FIXTURE);
    });
    try {
      const results = await fetchProviderFeed(rssProvider, { query: 'Example Anime' });
      assert.strictEqual(results.length, 3);

      const [r0, r1, r2] = results;
      assert.strictEqual(r0.providerId, 'prov-rss');
      assert.strictEqual(r0.providerName, 'Example RSS');
      assert.strictEqual(r0.title, '[Group] Example Anime - 05 [1080p]');
      assert.strictEqual(r0.downloadUrl, 'https://mirror.example/dl/1.torrent', 'enclosure URL must win over link');
      assert.strictEqual(r0.sizeBytes, 734003200, 'size from enclosure length');
      assert.strictEqual(r0.seeders, null, 'plain RSS has no seeders');
      assert.strictEqual(r0.leechers, null);
      assert.strictEqual(r0.pubDate, Date.parse('Tue, 04 Nov 2025 12:00:00 GMT'));

      assert.strictEqual(r1.downloadUrl, 'https://mirror.example/get/2', 'link used when no enclosure');
      assert.strictEqual(r1.sizeBytes, null);
      assert.strictEqual(r1.pubDate, null, 'unparseable pubDate → null');

      assert.strictEqual(r2.downloadUrl, 'magnet:?xt=urn:btih:CAFEBABE00000000000000000000000000000000', 'magnet: passes through as-is');
      assert.strictEqual(r2.pubDate, null);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await runAsyncTest('2.2 request shape: encoded URL, User-Agent, Accept, timeout signal', async () => {
    let captured = null;
    installFetchMock((url, init, calls) => {
      calls.push({ url, init });
      captured = { url, init };
      return jsonResponse(200, RSS_FIXTURE);
    });
    try {
      await fetchProviderFeed(rssProvider, { query: 'Example Anime' });
      assert.strictEqual(captured.url, 'https://indexer.example/rss?q=Example%20Anime');
      const headers = new Headers(captured.init.headers);
      assert.strictEqual(headers.get('user-agent'), 'AnimeMediaCenter/1.0');
      assert.strictEqual(headers.get('accept'), 'application/rss+xml, application/xml, text/xml');
      assert.ok(captured.init.signal instanceof AbortSignal, 'fetch must carry an AbortSignal timeout');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await runAsyncTest('2.3 Torznab fixture: namespaced + plain attrs, size attr wins over enclosure length', async () => {
    installFetchMock((url, init, calls) => {
      calls.push({ url, init });
      return jsonResponse(200, TORZNAB_FIXTURE);
    });
    try {
      const results = await fetchProviderFeed(torznabProvider, { query: 'Example Anime' });
      assert.strictEqual(results.length, 2);

      const [r0, r1] = results;
      assert.strictEqual(r0.downloadUrl, 'https://mirror.example/dl/9.torrent', 'enclosure preferred');
      assert.strictEqual(r0.seeders, 42, 'torznab:attr seeders parsed');
      assert.strictEqual(r0.leechers, 3, 'torznab:attr leechers parsed');
      assert.strictEqual(r0.sizeBytes, 1468006401, 'torznab size attr beats enclosure length 1468006400');
      assert.strictEqual(r0.pubDate, null, 'missing pubDate → null');

      assert.strictEqual(r1.downloadUrl, 'magnet:?xt=urn:btih:DEADBEEF00000000000000000000000000000000', 'magnet enclosure passes through');
      assert.strictEqual(r1.seeders, 7, 'plain (non-namespaced) attr parsed');
      assert.strictEqual(r1.leechers, null);
      assert.strictEqual(r1.sizeBytes, null, 'no size attr and no enclosure length → null');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await runAsyncTest('2.4 HTTP 500 → throws (searchProviders catches per provider)', async () => {
    installFetchMock(() => jsonResponse(500, 'server error'));
    try {
      await assert.rejects(
        () => fetchProviderFeed(rssProvider, { query: 'x' }),
        /HTTP 500/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await runAsyncTest('2.5 malformed XML → throws', async () => {
    installFetchMock(() => jsonResponse(200, '<rss><channel><item><title>unclosed</rss>'));
    try {
      await assert.rejects(() => fetchProviderFeed(rssProvider, { query: 'x' }), /malformed/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await runAsyncTest('2.6 non-XML garbage → throws', async () => {
    installFetchMock(() => jsonResponse(200, 'not xml at all'));
    try {
      await assert.rejects(() => fetchProviderFeed(rssProvider, { query: 'x' }));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await runAsyncTest('2.7 well-formed feed with empty channel → []', async () => {
    installFetchMock(() => jsonResponse(200, EMPTY_FEED_FIXTURE));
    try {
      const results = await fetchProviderFeed(rssProvider, { query: 'x' });
      assert.deepStrictEqual(results, []);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await runAsyncTest('2.8 invalid URL template → throws', async () => {
    globalThis.fetch = originalFetch; // must fail before any fetch
    await assert.rejects(
      () => fetchProviderFeed({ ...rssProvider, urlTemplate: 'https://indexer.example/search?term=' }, { query: 'x' })
    );
    await assert.rejects(
      () => fetchProviderFeed({ ...rssProvider, urlTemplate: 'ftp://indexer.example/rss?q={query}' }, { query: 'x' })
    );
  });

  // =========================================================================
  // 3. searchProviders
  // =========================================================================
  console.log('\n--- SUITE 3: searchProviders (allSettled merge + dedupe) ---');

  await runAsyncTest('3.1 merge across providers, tolerate rejection, skip disabled, dedupe title+size', async () => {
    const providerA = { id: 'a', name: 'Alpha', urlTemplate: 'https://alpha.example/api?q={query}', type: 'rss', enabled: true };
    const providerB = { id: 'b', name: 'Beta', urlTemplate: 'https://beta.example/feed?q={query}', type: 'rss', enabled: true };
    const providerDisabled = { id: 'c', name: 'Gamma', urlTemplate: 'https://gamma.example/rss?q={query}', type: 'rss', enabled: false };
    const providerDead = { id: 'd', name: 'Delta', urlTemplate: 'https://delta.example/rss?q={query}', type: 'rss', enabled: true };

    // Beta re-reports Alpha's first release with different case/whitespace → deduped.
    const betaFixture = `<?xml version="1.0"?><rss version="2.0"><channel>
      <item>
        <title>  EXAMPLE   anime   - 05 </title>
        <link>https://mirror.example/get/1</link>
        <enclosure url="https://mirror.example/dl/1.torrent" length="1000" type="application/x-bittorrent" />
      </item>
      <item>
        <title>Other Show - 01</title>
        <link>https://mirror.example/get/3</link>
        <enclosure url="https://mirror.example/dl/3.torrent" length="3000" type="application/x-bittorrent" />
      </item>
    </channel></rss>`;

    installFetchMock((url, init, calls) => {
      calls.push({ url, init });
      if (url.startsWith('https://alpha.example/')) {
        return jsonResponse(200, `<?xml version="1.0"?><rss version="2.0"><channel>
          <item><title>Example Anime - 05</title><link>https://mirror.example/get/1</link>
            <enclosure url="https://mirror.example/dl/1.torrent" length="1000" type="application/x-bittorrent" /></item>
          <item><title>Example Anime - 06</title><link>https://mirror.example/get/2</link>
            <enclosure url="https://mirror.example/dl/2.torrent" length="2000" type="application/x-bittorrent" /></item>
        </channel></rss>`);
      }
      if (url.startsWith('https://beta.example/')) return jsonResponse(200, betaFixture);
      if (url.startsWith('https://gamma.example/')) return jsonResponse(200, betaFixture);
      return Promise.reject(new Error('network unreachable'));
    });

    let warningText = null;
    console.warn = (...args) => { warningText = args.join(' '); };
    try {
      const merged = await searchProviders([providerA, providerB, providerDisabled, providerDead], { query: 'Example' });
      // Alpha: 2 items; Beta: 2 items (1 dup of Alpha's first, 1 unique); Delta rejected.
      assert.strictEqual(merged.length, 3, `expected 3 merged results, got ${merged.length}: ${JSON.stringify(merged)}`);
      assert.deepStrictEqual(
        merged.map((r) => `${r.providerId}:${r.title}`),
        ['a:Example Anime - 05', 'a:Example Anime - 06', 'b:Other Show - 01'],
        'first duplicate (case/whitespace variant, same size) must be deduped away'
      );
      assert.ok(!merged.some((r) => r.providerId === 'c'), 'disabled provider must be skipped');
      assert.ok(fetchCalls.every((c) => c && !String(c.url).startsWith('https://gamma.example/')), 'disabled provider fetch must never fire');
      assert.ok(/delta/i.test(warningText ?? ''), 'rejected provider must be logged via console.warn');
    } finally {
      console.warn = originalWarn;
      globalThis.fetch = originalFetch;
    }
  });

  await runAsyncTest('3.2 all providers failing → empty array, still no throw', async () => {
    installFetchMock(() => Promise.reject(new Error('network unreachable')));
    console.warn = () => {};
    try {
      const merged = await searchProviders([rssProvider, torznabProvider], { query: 'x' });
      assert.deepStrictEqual(merged, []);
    } finally {
      console.warn = originalWarn;
      globalThis.fetch = originalFetch;
    }
  });

  await runAsyncTest('3.3 empty / non-array provider lists → []', async () => {
    globalThis.fetch = originalFetch;
    assert.deepStrictEqual(await searchProviders([], { query: 'x' }), []);
    assert.deepStrictEqual(await searchProviders(null, { query: 'x' }), []);
  });

  // =========================================================================
  // 4. rankReleasesForEpisode
  // =========================================================================
  console.log('\n--- SUITE 4: rankReleasesForEpisode ---');

  runTest('4.1 exact title+episode match ranks first; season mismatch sinks; ties break by seeders', () => {
    const ref = { animeTitle: 'Frieren Beyond Journeys End', season: 1, episode: 5 };
    const r1 = makeResult('[SubsPlease] Frieren Beyond Journeys End - 05 [1080p]', 15); // 60 +25 +5 = 90
    const r2 = makeResult('[Group] Frieren Beyond Journeys End - 12 [1080p]', 10);      // 60 -15 +5 = 50
    const r3 = makeResult('[Group] Some Other Show - 05 [1080p]', 40);                  //  0 +25 +5 = 30
    const r4 = makeResult('[SubsPlease] Frieren Beyond Journeys End S02E09 1080p', 99); // 60 -40 -15 +5 = 10
    const r5 = makeResult('[Group] Frieren Sequel Show - 05', null);                    // ~5 +25 = 30
    const input = [r3, r4, r2, r1, r5];

    const ranked = rankReleasesForEpisode(input, ref);

    assert.strictEqual(ranked[0], r1, 'exact title + episode match must rank first');
    assert.strictEqual(ranked[1], r2, 'correct title + wrong episode ranks second');
    assert.strictEqual(ranked[2], r3, 'wrong title + right episode next (seeders win the 30-point tie)');
    assert.strictEqual(ranked[3], r5, 'token-overlap fallback ties with r3, no seeders → after');
    assert.strictEqual(ranked[4], r4, 'season mismatch must sink even with the most seeders');
    assert.strictEqual(ranked.length, input.length);
  });

  runTest('4.2 input array is never mutated and a new array is returned', () => {
    const ref = { animeTitle: 'Frieren Beyond Journeys End', season: 1, episode: 5 };
    const r1 = makeResult('[SubsPlease] Frieren Beyond Journeys End - 05 [1080p]', 15);
    const r2 = makeResult('[Group] Some Other Show - 05 [1080p]', 40);
    const input = [r2, r1];
    const snapshot = JSON.parse(JSON.stringify(input));

    const ranked = rankReleasesForEpisode(input, ref);
    assert.notStrictEqual(ranked, input, 'must return a new array');
    assert.deepStrictEqual(input, snapshot, 'input array must not be reordered or mutated');
    assert.strictEqual(input[0], r2, 'input keeps original order');
  });

  runTest('4.3 empty animeTitle → input order returned unchanged (new array)', () => {
    const a = makeResult('[Group] Some Other Show - 05 [1080p]', 1);
    const b = makeResult('[SubsPlease] Frieren Beyond Journeys End - 05 [1080p]', 99);
    const input = [a, b];
    const ranked = rankReleasesForEpisode(input, { animeTitle: '', season: 1, episode: 5 });
    assert.deepStrictEqual(ranked, input);
    assert.notStrictEqual(ranked, input, 'still a new array, not the input reference');
  });

  runTest('4.4 punctuation-only animeTitle behaves like empty', () => {
    const a = makeResult('[Group] Some Other Show - 05 [1080p]', 1);
    const b = makeResult('[SubsPlease] Frieren Beyond Journeys End - 05 [1080p]', 99);
    const ranked = rankReleasesForEpisode([a, b], { animeTitle: '!!!', season: 1, episode: 5 });
    assert.deepStrictEqual(ranked, [a, b]);
  });

  // =========================================================================
  // 5. import/exportProvidersConfig
  // =========================================================================
  console.log('\n--- SUITE 5: provider config import/export ---');

  runTest('5.1 export → import round-trip preserves providers', () => {
    const providers = [
      { id: 'mine-1', name: 'My Feed', urlTemplate: 'https://indexer.example/rss?q={query}', type: 'rss', enabled: true },
      { id: 'mine-2', name: 'My Torznab', urlTemplate: 'https://indexer.example/api?q={query}&season={season}', type: 'torznab', enabled: false },
    ];
    const exported = exportProvidersConfig(providers);
    const envelope = JSON.parse(exported);
    assert.strictEqual(envelope.format, 'animecenter-providers');
    assert.strictEqual(envelope.version, 1);
    assert.deepStrictEqual(importProvidersConfig(exported), providers);
  });

  runTest('5.2 invalid JSON → null', () => {
    assert.strictEqual(importProvidersConfig('{not json'), null);
    assert.strictEqual(importProvidersConfig(''), null);
  });

  runTest('5.3 garbage shapes → null (number, object without providers, empty array)', () => {
    assert.strictEqual(importProvidersConfig('42'), null);
    assert.strictEqual(importProvidersConfig(JSON.stringify({ foo: 1 })), null);
    assert.strictEqual(importProvidersConfig('[]'), null);
    assert.strictEqual(importProvidersConfig(JSON.stringify({ providers: [] })), null);
  });

  runTest('5.4 bare array accepted (wrapper optional)', () => {
    const bare = JSON.stringify([
      { id: 'x', name: 'Solo', urlTemplate: 'https://indexer.example/rss?q={query}', type: 'torznab', enabled: false },
    ]);
    assert.deepStrictEqual(importProvidersConfig(bare), [
      { id: 'x', name: 'Solo', urlTemplate: 'https://indexer.example/rss?q={query}', type: 'torznab', enabled: false },
    ]);
  });

  runTest('5.5 invalid entries dropped; defaults applied; ids generated', () => {
    const json = JSON.stringify([
      { name: 'Good', urlTemplate: 'https://good.example/rss?q={query}' },               // valid → id provider-1, rss, enabled
      { urlTemplate: 'https://noquery.example/rss?q=x' },                                 // missing name → dropped
      { name: 'No Placeholder', urlTemplate: 'https://noq.example/search?term=' },        // missing {query} → dropped
      { name: 'Wrong Scheme', urlTemplate: 'ftp://noq.example/rss?q={query}' },           // non-http(s) → dropped
      { name: '', urlTemplate: 'https://x.example/rss?q={query}' },                       // empty name → dropped
      42, null, 'junk',                                                                   // non-objects → dropped
    ]);
    const imported = importProvidersConfig(json);
    assert.ok(Array.isArray(imported));
    assert.strictEqual(imported.length, 1);
    assert.deepStrictEqual(imported[0], {
      id: 'provider-1',
      name: 'Good',
      urlTemplate: 'https://good.example/rss?q={query}',
      type: 'rss',
      enabled: true,
    });
  });

  runTest('5.6 more than 20 valid providers → truncated to 20', () => {
    const many = [];
    for (let i = 1; i <= 25; i++) {
      many.push({ id: `p${i}`, name: `Feed ${i}`, urlTemplate: `https://feed${i}.example/rss?q={query}`, type: 'rss', enabled: true });
    }
    const imported = importProvidersConfig(JSON.stringify(many));
    assert.strictEqual(imported.length, 20);
    assert.strictEqual(imported[19].id, 'p20');
    assert.ok(!imported.some((p) => p.id === 'p21'));
  });

  // =========================================================================
  // 6. VPN guard (real os-based detection, no network)
  // =========================================================================
  console.log('\n--- SUITE 6: VPN guard ---');

  runTest('6.1 detectVpnStatus returns the documented shape and caches within TTL', () => {
    clearVpnCache();
    const a = detectVpnStatus();
    assert.strictEqual(typeof a.active, 'boolean');
    assert.ok(Array.isArray(a.interfaces), 'interfaces must be an array');
    assert.strictEqual(typeof a.checkedAt, 'number');
    assert.ok(Number.isFinite(a.checkedAt));
    for (const name of a.interfaces) {
      assert.strictEqual(typeof name, 'string');
      assert.ok(name.length > 0, 'interface names must be non-empty');
    }
    if (a.active) assert.ok(a.interfaces.length > 0, 'active status implies at least one reported interface');

    const b = detectVpnStatus();
    assert.strictEqual(b.checkedAt, a.checkedAt, 'second call within 10s must be served from cache');
  });

  runTest('6.2 clearVpnCache forces a fresh detection', () => {
    clearVpnCache();
    const a = detectVpnStatus();
    clearVpnCache();
    const c = detectVpnStatus();
    assert.notStrictEqual(c, a, 'after clear the cache must be rebuilt');
    assert.ok(c.checkedAt >= a.checkedAt, 'fresh checkedAt must not go backwards');
    assert.strictEqual(typeof c.active, 'boolean');
    assert.ok(Array.isArray(c.interfaces));
    assert.strictEqual(typeof c.checkedAt, 'number');
  });

  runTest('6.3 reported interfaces all match tunnel naming patterns', () => {
    clearVpnCache();
    const status = detectVpnStatus();
    const pattern = /(tun|tap|wg|wireguard|vpn|ppp|tailscale|protonvpn|nord|mullvad|surfshark|expressvpn|openvpn)/i;
    for (const name of status.interfaces) {
      assert.ok(
        pattern.test(name),
        `interface "${name}" was reported but does not match the tunnel pattern`
      );
    }
  });

  // =========================================================================
  // Summary
  // =========================================================================
  console.log('\n================================================================');
  console.log(`INDEXER + VPN GUARD TESTS: ${passed} passed, ${failed} failed`);
  console.log('================================================================');
  if (failed === 0) {
    console.log('ALL TESTS PASSED');
  } else {
    process.exitCode = 1;
  }
}

function makeResult(title, seeders) {
  return {
    providerId: 'test',
    providerName: 'Test Provider',
    title,
    downloadUrl: 'https://mirror.example/dl/x.torrent',
    sizeBytes: 1000,
    seeders,
    leechers: null,
    pubDate: null,
  };
}

main().finally(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
});
