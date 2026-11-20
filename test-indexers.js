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
 * 1. buildQueryUrl — substitutions, encoding, query sanitization inside the
 *    builder, placeholder preservation, invalid templates.
 * 2. fetchProviderFeed — RSS 2.0 fixtures (enclosure/link/magnet), Torznab
 *    fixtures (namespaced + plain attr seeders/leechers/size), Nyaa-style
 *    fixtures (nyaa:infoHash magnet building, nyaa:size/seeders, .torrent
 *    links kept, link-less items dropped), HTTP errors (403/500), malformed
 *    XML, empty channels, request headers/timeout signal.
 * 3. searchProviders — {results, reports} shape, allSettled merge across
 *    providers, per-provider ok/failure reports, dedupe by infoHash +
 *    title+size fallback, disabled providers skipped, failures tolerated.
 * 4. rankReleasesForEpisode — title/season/episode scoring, batch/season-pack
 *    bonus when episode is null, stable order, no mutation, NEVER filters,
 *    empty-reference passthrough.
 * 5. import/exportProvidersConfig — round-trip, tolerant import, validation,
 *    20-provider cap.
 * 6. VPN guard — real os-based detection shape + cache/clear semantics.
 * 7. sanitizeSearchQuery / extractInfoHash — punctuation stripping + magnet
 *    hash extraction (hex + base32).
 */

import assert from 'assert';
import {
  buildQueryUrl,
  fetchProviderFeed,
  fetchReleaseDescription,
  inspectReleaseResults,
  searchProviders,
  rankReleasesForEpisode,
  getEpisodeReleaseSizeWarning,
  importProvidersConfig,
  exportProvidersConfig,
  sanitizeSearchQuery,
  extractInfoHash,
  computeTitleRelevance,
  isExplicitEpisodeMismatch,
  isExplicitSeasonMismatch,
  isFranchiseSeasonTitleMismatch,
  isExplicitSpinoffOrSpecialMismatch,
  deriveShortenedTitleQueries,
  buildLanguageFallbackQueries,
} from './electron/indexers.ts';
import { classifyRelease, decodeHtmlEntities, detectSeasonFromTitle, isMultiSeasonCollection, qualityRank, releaseDescriptionToText } from './src/lib/releaseParser/releaseClassification.ts';
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
      <description><![CDATA[<p>English Dub with English subtitles. 10bit HEVC.</p>]]></description>
      <link>https://mirror.example/get/1</link>
      <guid>https://indexer.example/release/1</guid>
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

// Nyaa-style fixture: namespaced nyaa:* extras as literal colon keys, .torrent
// <link> (NOT a magnet) + nyaa:infoHash, base32 hash without any link, and a
// link-less item that must be dropped.
const NYAA_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:nyaa="https://nyaa.example/xmlns/nyaa">
  <channel>
    <title>Example Nyaa-style Feed</title>
    <item>
      <title>[Group] Sousou no Frieren - 05 [1080p][HEVC].mkv</title>
      <link>https://nyaa.example/download/12345.torrent</link>
      <guid>https://nyaa.example/view/12345</guid>
      <nyaa:infoHash>0123abcd0123abcd0123abcd0123abcd0123abcd</nyaa:infoHash>
      <nyaa:seeders>42</nyaa:seeders>
      <nyaa:leechers>3</nyaa:leechers>
      <nyaa:size>1.4 GiB</nyaa:size>
      <pubDate>Tue, 04 Nov 2025 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>[Group] Sousou no Frieren - 06 [1080p]</title>
      <link>https://nyaa.example/download/12346.torrent</link>
      <nyaa:seeders>17</nyaa:seeders>
      <nyaa:size>890 MiB</nyaa:size>
    </item>
    <item>
      <title>[Group] Sousou no Frieren - Season 01 [Batch]</title>
      <nyaa:infoHash>ABCDEFGHIJKLMNOPQRSTUVWXYZ234567</nyaa:infoHash>
    </item>
    <item>
      <title>[Group] Description-only item with no download source</title>
      <description>nothing usable here</description>
    </item>
  </channel>
</rss>`;

/** A provider whose template points at a fake Nyaa-style indexer. */
const nyaaProvider = {
  id: 'prov-nyaa',
  name: 'Example Nyaa',
  urlTemplate: 'https://nyaa.example/?page=rss&q={query}',
  type: 'rss',
  enabled: true,
};

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

  runTest('1.9 sanitizes the query inside the builder (encode AFTER sanitizing)', () => {
    // Raw titles with colons/dashes must not hit the wire verbatim.
    assert.strictEqual(
      buildQueryUrl('https://indexer.example/rss?q={query}', { query: 'Frieren: Beyond' }),
      'https://indexer.example/rss?q=Frieren%20Beyond'
    );
    assert.strictEqual(
      buildQueryUrl('https://indexer.example/rss?q={query}', { query: 'Re:Zero - Starting Life' }),
      'https://indexer.example/rss?q=Re%20Zero%20Starting%20Life'
    );
    // Word characters and unicode survive sanitization unchanged.
    assert.strictEqual(
      buildQueryUrl('https://indexer.example/rss?q={query}', { query: '鬼滅の刃' }),
      `https://indexer.example/rss?q=${encodeURIComponent('鬼滅の刃')}`
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
      assert.match(r0.description, /English subtitles/, 'RSS description is preserved');
      assert.strictEqual(r0.detailsUrl, 'https://indexer.example/release/1', 'permalink is retained separately from download URL');
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

  await runAsyncTest('2.2 request shape: browser-like User-Agent, Accept, timeout signal', async () => {
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
      assert.strictEqual(
        headers.get('user-agent'),
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'must present a browser-like UA — non-browser agents are 403-blocked by real indexers'
      );
      assert.ok(!/AnimeMediaCenter/i.test(headers.get('user-agent') ?? ''), 'custom app UA must be gone');
      assert.strictEqual(headers.get('accept'), 'application/rss+xml, application/xml, text/xml, */*;q=0.8');
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

  await runAsyncTest('2.4b HTTP 403 → throws with Cloudflare hint in the message', async () => {
    installFetchMock(() => jsonResponse(403, 'forbidden'));
    try {
      await assert.rejects(
        () => fetchProviderFeed(rssProvider, { query: 'x' }),
        (err) => /HTTP 403/.test(err.message) && /Cloudflare/i.test(err.message)
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

  await runAsyncTest('2.9 Nyaa-style feed: .torrent link preserves embedded trackers; infoHash is retained', async () => {
    let logs = [];
    const originalLog = console.log;
    installFetchMock((url, init, calls) => {
      calls.push({ url, init });
      return jsonResponse(200, NYAA_FIXTURE);
    });
    try {
      console.log = (...args) => { logs.push(args.join(' ')); };
      const results = await fetchProviderFeed(nyaaProvider, { query: 'Frieren' });
      // 4 raw items; the 4th (no link/enclosure/infoHash) is dropped → 3 parsed.
      assert.strictEqual(results.length, 3, `expected 3 parsed items, got ${results.length}`);

      const [r0, r1, r2] = results;
      assert.strictEqual(r0.providerId, 'prov-nyaa');
      assert.strictEqual(r0.providerName, 'Example Nyaa');
      assert.strictEqual(r0.title, '[Group] Sousou no Frieren - 05 [1080p][HEVC].mkv');
      assert.strictEqual(r0.detailsUrl, 'https://nyaa.example/view/12345', 'human release page is retained separately from the torrent URL');
      assert.strictEqual(r0.downloadUrl, 'https://nyaa.example/download/12345.torrent', 'direct .torrent must be used so its announce list is preserved');
      assert.strictEqual(r0.infoHash, '0123abcd0123abcd0123abcd0123abcd0123abcd', 'separate infoHash remains available for deduplication');
      assert.ok(
        Math.abs(r0.sizeBytes - 1.4 * 2 ** 30) <= 1,
        `nyaa:size "1.4 GiB" must parse to ~1.4*2^30 bytes, got ${r0.sizeBytes}`
      );
      assert.strictEqual(r0.seeders, 42, 'nyaa:seeders parsed');
      assert.strictEqual(r0.leechers, 3, 'nyaa:leechers parsed');
      assert.strictEqual(r0.pubDate, Date.parse('Tue, 04 Nov 2025 12:00:00 GMT'));

      // No infoHash, plain .torrent <link> → kept with the http URL as-is.
      assert.strictEqual(r1.downloadUrl, 'https://nyaa.example/download/12346.torrent');
      assert.strictEqual(r1.seeders, 17, 'nyaa:seeders parsed without torznab attrs');
      assert.strictEqual(r1.leechers, null);
      assert.strictEqual(r1.sizeBytes, 890 * 1024 ** 2, 'nyaa:size "890 MiB" → bytes');
      assert.strictEqual(r1.pubDate, null);

      // base32 infoHash, no link at all → lowercased magnet, still kept.
      assert.strictEqual(r2.title, '[Group] Sousou no Frieren - Season 01 [Batch]');
      assert.strictEqual(
        r2.downloadUrl,
        `magnet:?xt=urn:btih:abcdefghijklmnopqrstuvwxyz234567&dn=${encodeURIComponent('[Group] Sousou no Frieren - Season 01 [Batch]')}`
      );
      assert.strictEqual(r2.sizeBytes, null);
      assert.strictEqual(r2.seeders, null);

      // Feed logging: GET line + response line with raw vs parsed counts.
      const joined = logs.join('\n');
      assert.ok(/\[Indexers\] GET https:\/\/nyaa\.example\/\?page=rss&q=Frieren \(provider "Example Nyaa"\)/.test(joined), 'GET log line missing');
      assert.ok(joined.includes('items: 4, parsed: 3'), `response log must count raw vs parsed, got: ${joined}`);
    } finally {
      console.log = originalLog;
      globalThis.fetch = originalFetch;
    }
  });

  await runAsyncTest('2.10 Nyaa-style: item with no link/enclosure/infoHash at all → dropped (parsed 0)', async () => {
    const linklessFeed = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0" xmlns:nyaa="https://nyaa.example/xmlns/nyaa">
        <channel>
          <title>Linkless Feed</title>
          <item>
            <title>[Group] No source here [1080p]</title>
            <nyaa:seeders>99</nyaa:seeders>
            <description>only metadata</description>
          </item>
        </channel>
      </rss>`;
    installFetchMock(() => jsonResponse(200, linklessFeed));
    try {
      const results = await fetchProviderFeed(nyaaProvider, { query: 'x' });
      assert.deepStrictEqual(results, [], 'items without any download source must be skipped');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // =========================================================================
  // 3. searchProviders
  // =========================================================================
  console.log('\n--- SUITE 3: searchProviders (allSettled merge + dedupe) ---');

  await runAsyncTest('3.1 {results, reports}: merge across providers, tolerate rejection, skip disabled, dedupe title+size', async () => {
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
      const { results: merged, reports } = await searchProviders([providerA, providerB, providerDisabled, providerDead], { query: 'Example' });
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

      // One report per ATTEMPTED provider: a, b ok with feed item counts; d failed.
      assert.strictEqual(reports.length, 3, `expected 3 reports (a, b, d), got ${JSON.stringify(reports)}`);
      assert.deepStrictEqual(
        reports.map((r) => `${r.providerId}:${r.ok}:${r.itemCount}`),
        ['a:true:2', 'b:true:2', 'd:false:0'],
        'report itemCounts reflect each feed before cross-provider dedupe'
      );
      assert.match(reports[2].error, /network unreachable/);
      assert.ok(!reports.some((r) => r.providerId === 'c'), 'disabled provider must not be attempted/reported');
    } finally {
      console.warn = originalWarn;
      globalThis.fetch = originalFetch;
    }
  });

  await runAsyncTest('3.2 all providers failing → empty results + failure reports, still no throw', async () => {
    installFetchMock(() => Promise.reject(new Error('network unreachable')));
    console.warn = () => {};
    try {
      const { results, reports } = await searchProviders([rssProvider, torznabProvider], { query: 'x' });
      assert.deepStrictEqual(results, []);
      assert.strictEqual(reports.length, 2);
      assert.ok(reports.every((r) => r.ok === false && /network unreachable/.test(r.error ?? '')));
    } finally {
      console.warn = originalWarn;
      globalThis.fetch = originalFetch;
    }
  });

  await runAsyncTest('3.3 empty / non-array provider lists → empty results + empty reports', async () => {
    globalThis.fetch = originalFetch;
    assert.deepStrictEqual(await searchProviders([], { query: 'x' }), { results: [], reports: [] });
    assert.deepStrictEqual(await searchProviders(null, { query: 'x' }), { results: [], reports: [] });
  });

  await runAsyncTest('3.4 HTTP 403 provider → failure report contains "HTTP 403"', async () => {
    installFetchMock(() => jsonResponse(403, 'forbidden'));
    console.warn = () => {};
    try {
      const { results, reports } = await searchProviders([rssProvider], { query: 'x' });
      assert.deepStrictEqual(results, []);
      assert.strictEqual(reports.length, 1);
      assert.strictEqual(reports[0].providerId, 'prov-rss');
      assert.strictEqual(reports[0].providerName, 'Example RSS');
      assert.strictEqual(reports[0].ok, false);
      assert.ok(reports[0].error.includes('HTTP 403'), `error must carry the HTTP status, got: ${reports[0].error}`);
    } finally {
      console.warn = originalWarn;
      globalThis.fetch = originalFetch;
    }
  });

  await runAsyncTest('3.5 mixed ok/failure providers merge results and reports together', async () => {
    const goodProvider = { id: 'good', name: 'Good', urlTemplate: 'https://good.example/rss?q={query}', type: 'rss', enabled: true };
    installFetchMock((url) => {
      if (url.startsWith('https://good.example/')) {
        return jsonResponse(200, `<?xml version="1.0"?><rss version="2.0"><channel>
          <item><title>Example Anime - 05</title><link>https://mirror.example/get/1</link>
            <enclosure url="https://mirror.example/dl/1.torrent" length="1000" type="application/x-bittorrent" /></item>
        </channel></rss>`);
      }
      return jsonResponse(503, 'service unavailable');
    });
    console.warn = () => {};
    try {
      const { results, reports } = await searchProviders([goodProvider, rssProvider], { query: 'Example' });
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].providerId, 'good');
      assert.strictEqual(reports.length, 2);
      assert.strictEqual(reports[0].ok, true);
      assert.strictEqual(reports[0].itemCount, 1);
      assert.strictEqual(reports[1].ok, false);
      assert.ok(reports[1].error.includes('HTTP 503'), `503 must be reported, got: ${reports[1].error}`);
      assert.ok(reports[1].error.includes('Cloudflare'), `503 should hint at Cloudflare/bot protection, got: ${reports[1].error}`);
    } finally {
      console.warn = originalWarn;
      globalThis.fetch = originalFetch;
    }
  });

  await runAsyncTest('3.6 dedupe by infoHash across providers (different titles, same torrent)', async () => {
    const providerA = { id: 'a', name: 'Alpha', urlTemplate: 'https://alpha.example/rss?q={query}', type: 'rss', enabled: true };
    const providerB = { id: 'b', name: 'Beta', urlTemplate: 'https://beta.example/rss?q={query}', type: 'rss', enabled: true };
    const hash = '0123abcd0123abcd0123abcd0123abcd0123abcd';
    installFetchMock((url) => {
      if (url.startsWith('https://alpha.example/')) {
        return jsonResponse(200, `<?xml version="1.0"?><rss version="2.0" xmlns:nyaa="https://nyaa.example/xmlns/nyaa"><channel>
          <item><title>Alpha Release of Show - 01</title><link>https://alpha.example/dl.torrent</link>
            <nyaa:infoHash>${hash}</nyaa:infoHash><nyaa:size>1.0 GiB</nyaa:size></item>
        </channel></rss>`);
      }
      // Beta reports the SAME torrent (same infoHash) under a totally different title/size.
      return jsonResponse(200, `<?xml version="1.0"?><rss version="2.0"><channel>
        <item><title>Completely Different Name 720p</title>
          <enclosure url="magnet:?xt=urn:btih:${hash.toUpperCase()}&dn=whatever" length="999" type="application/x-bittorrent" /></item>
      </channel></rss>`);
    });
    console.warn = () => {};
    try {
      const { results, reports } = await searchProviders([providerA, providerB], { query: 'Show' });
      assert.strictEqual(results.length, 1, `same infoHash must dedupe across providers, got ${results.length}`);
      assert.strictEqual(results[0].providerId, 'a', 'first provider to report the torrent wins');
      assert.strictEqual(reports.length, 2, 'both providers still report ok');
      assert.ok(reports.every((r) => r.ok === true));
    } finally {
      console.warn = originalWarn;
      globalThis.fetch = originalFetch;
    }
  });

  // =========================================================================
  // 4. rankReleasesForEpisode
  // =========================================================================
  console.log('\n--- SUITE 4: rankReleasesForEpisode ---');

  runTest('4.0 whole-word title relevance: "Monster" must not match "Pocket Monsters" (in-word substring)', () => {
    const refs = ['Monster'];
    assert.strictEqual(
      computeTitleRelevance('[SOSSubs] Pocket Monsters (Pokemon) - Full Diamond & Pearl (Eps 1-193 + Movies 10-23 + Specials and Bonus Content) ENG SOFTSUB', refs),
      'none',
      '"monster" inside "monsters" is an in-word hit, not a title match',
    );
    assert.strictEqual(computeTitleRelevance('[Group] Monster - 01 [1080p]', refs), 'exact');
    // The parser extracts "S2" into parsed.season, so the show name alone is
    // an exact match; the season check happens separately in scoring.
    assert.strictEqual(computeTitleRelevance('[Group] Monster S2 - 02 [1080p]', refs), 'exact');
    assert.strictEqual(computeTitleRelevance('[Group] Monsters The Anime - 03 [1080p]', refs), 'none', 'pluralized title is a different word');
    // A whole-season pack whose parsed title scores 'none' must never survive
    // the automatic-selection relevance gate, even though classify-first
    // ranking may float packs above single episodes.
    const monster = makeResult('[Group] Monster - 01 [1080p]', 10);
    const pokemon = makeResult('[SOSSubs] Pocket Monsters (Pokemon) - Full Diamond & Pearl (Eps 1-193 + Movies 10-23 + Specials and Bonus Content) ENG SOFTSUB', 400);
    const ranked = rankReleasesForEpisode([pokemon, monster], { animeTitle: 'Monster', episode: 1 });
    const annotated = ranked.map((r) => ({ ...r, titleRelevance: computeTitleRelevance(r.title, refs) }));
    const autoPickable = annotated.filter((r) => r.titleRelevance !== 'none');
    assert.strictEqual(autoPickable.length, 1, 'only the real Monster release stays auto-pickable');
    assert.strictEqual(autoPickable[0].title, monster.title);
  });

  runTest('4.1 exact title+episode match ranks first; title relevance outranks release kind', () => {
    const ref = { animeTitle: 'Frieren Beyond Journeys End', season: 1, episode: 5 };
    const r1 = makeResult('[SubsPlease] Frieren Beyond Journeys End - 05 [1080p]', 15); // exact 60 +25 +5 = 90
    const r2 = makeResult('[Group] Frieren Beyond Journeys End - 12 [1080p]', 10);      // exact 60 -15 +5 = 50
    const r3 = makeResult('[Group] Some Other Show - 05 [1080p]', 40);                  // none  0 +25 +5 = 30
    const r4 = makeResult('[SubsPlease] Frieren Beyond Journeys End S02E09 1080p', 99); // exact 60 -40 -15 +5 = 10
    const r5 = makeResult('[Group] Frieren Sequel Show - 05', null);                    // related 25 +25 = 50
    const input = [r3, r4, r2, r1, r5];

    const ranked = rankReleasesForEpisode(input, ref);

    // Title relevance sorts above release kind: the same-show releases (exact)
    // come first even when a wrong-season one has the most seeders, then the
    // related title, then the unrelated one. Wrong-season r4 is dropped later
    // by isExplicitEpisodeMismatch in the search pipeline.
    assert.strictEqual(ranked[0], r1, 'exact title + episode match must rank first');
    assert.strictEqual(ranked[1], r2, 'correct title + wrong episode ranks second');
    assert.strictEqual(ranked[2], r4, 'same-show wrong-season ranks third (filtered later by explicit-mismatch)');
    assert.strictEqual(ranked[3], r5, 'related title (whole word) follows');
    assert.strictEqual(ranked[4], r3, 'unrelated title sinks despite its higher seeder count');
    assert.strictEqual(ranked.length, input.length);
  });

  runTest('4.1a size floor is codec-aware and duration-proportional (no hard 80 MiB block for shorts/HEVC)', () => {
    const warning = getEpisodeReleaseSizeWarning(76.82 * 1024 ** 2, 24);
    assert.ok(warning && warning.includes('96 MiB'), '76.82 MiB is below the 24-minute H.264 floor (4 MB/min)');
    assert.strictEqual(getEpisodeReleaseSizeWarning(450 * 1024 ** 2, 24), null);
    assert.ok(getEpisodeReleaseSizeWarning(null, 24)?.includes('did not report'));
    // A talky 8-minute episode: 8 min x 4 MB/min = 32 MiB floor — 75 MiB passes.
    assert.strictEqual(getEpisodeReleaseSizeWarning(75 * 1024 ** 2, 8), null, 'no absolute 80 MiB block when the runtime is known');
    assert.ok(getEpisodeReleaseSizeWarning(10 * 1024 ** 2, 8), '10 MiB for 8 minutes is still flagged (32 MiB floor)');
    // HEVC density: 24 min x 2.5 MB/min = 60 MiB floor — a 70 MiB Judas-style encode passes.
    assert.strictEqual(getEpisodeReleaseSizeWarning(70 * 1024 ** 2, 24, '[Judas] Show - 01 [1080p][hevc]'), null);
    assert.ok(getEpisodeReleaseSizeWarning(70 * 1024 ** 2, 24, '[Group] Show - 01 [1080p x264]'), 'H.264 keeps the 96 MiB floor');
    // Short-form show (3-minute episodes): 3 x 4 = 12 MiB floor — 15 MiB passes.
    assert.strictEqual(getEpisodeReleaseSizeWarning(15 * 1024 ** 2, 3), null, 'short-form shows are not blocked by an absolute floor');
  });

  runTest('4.1b prefix relevance requires a season-shaped tail ("Monster Hunter" is another show)', () => {
    const refs = ['Monster'];
    assert.strictEqual(computeTitleRelevance('[Group] Monster Hunter - 01 [1080p]', refs), 'related',
      'free-form tail words downgrade prefix to related (auto-pick refuses related)');
    assert.strictEqual(computeTitleRelevance('[Group] Monster Musume no Iru Nichijou - 01', refs), 'related');
    assert.strictEqual(computeTitleRelevance('[Group] Re:Monster - 01 [1080p]', refs), 'related',
      'whole-word mention inside another title stays related, never prefix');
    assert.strictEqual(computeTitleRelevance('[Group] Monster - 01 [1080p]', refs), 'exact');
  });

  runTest('4.1d content-type tails keep prefix relevance ("Show - S01+02+OVA+Movie" is the show)', () => {
    // Franchise bundles append content-type words ("+OVA", "+Movie",
    // "Specials") after the show name; observed live on Nyaa while searching
    // "K-On! Live House!". They describe WHAT is bundled, not a different
    // show, so they must not downgrade prefix → related (which the automatic
    // picker refuses).
    const refs = ['K-On!'];
    assert.strictEqual(computeTitleRelevance('[Trix] K-ON! - S01+02+OVA+Movie [Dual Audio] (BD 1080p AV1)', refs), 'prefix');
    assert.strictEqual(computeTitleRelevance('K-On! S1 S2 Movie OVAs Specials [Dual Audio] [HEVC] [BDRip]', refs), 'prefix');
    assert.strictEqual(computeTitleRelevance('[Group] K-On! OVA', refs), 'exact',
      'the parser strips the OVA marker from the show name → exact, never related');
    assert.strictEqual(computeTitleRelevance('[Group] K-On! Movie + Specials + Extras', refs), 'prefix');
    assert.strictEqual(computeTitleRelevance('K-ON all seasons + specials + OVA + MOVIE', refs), 'prefix');
    // Free-form tail words still downgrade (4.1b), including after a content word.
    assert.strictEqual(computeTitleRelevance('[Group] K-On! OVA Apocalypse', refs), 'related',
      'a free-form word after the content marker is still a different-show tail');
    // The whitelisted words only count in the TAIL, never inside the show name.
    assert.strictEqual(computeTitleRelevance('[Group] Monster Movie Night - 01 [1080p]', ['Monster']), 'related');
  });

  runTest('4.1e an OVA published under the parent season numbering is not an episode mismatch', () => {
    // Trackers commonly publish an OVA as "K-ON! - 14 (OVA)" — the number is
    // the PARENT season's episode slot, so from an OVA title page (its own
    // episodes are numbered 1..N) that release must stay auto-pickable.
    const e14 = { title: '[CoalGuys] K-ON! - 14 (OVA) [72A0FDDB].mkv' };
    assert.strictEqual(isExplicitEpisodeMismatch(e14, 1, 'OVA'), false,
      'OVA format + "(OVA)" marker: parent-season numbering is not a wrong episode');
    assert.strictEqual(isExplicitEpisodeMismatch(e14, 14, 'TV'), false);
    assert.strictEqual(isExplicitEpisodeMismatch(e14, 1, 'TV'), true,
      'on a TV page the same release is still episode 14, not episode 1');
    // Without an OVA/OAD marker on the release the escape must not fire: a
    // bare "K-ON! - 14" found while searching an OVA may be the parent's
    // regular episode 14.
    assert.strictEqual(isExplicitEpisodeMismatch({ title: '[Group] K-ON! - 14' }, 1, 'OVA'), true);
    assert.strictEqual(isExplicitEpisodeMismatch({ title: '[Group] K-ON! S01E14 (OVA)' }, 1, 'OVA'), false,
      'SxxExx + OVA marker escapes too');
  });

  runTest('4.1f a Nyaa "English Subtitles (PGS)" description classifies as English subs', () => {
    // anime4live-style K-ON! bundle description (observed live 2026-11-13):
    // signs/songs alone must not count, but the full "English Subtitles" track does.
    const title = '[anime4life.] K-ON! 1-13+OVA Complete (BD1080p AC3 10bit) [x265_HEVC] Dual Audio';
    const desc = 'Subtitles\nTrack 1: English Signs/Songs (PGS)\nTrack 2: English Subtitles (PGS)\nPlease Seed!';
    const cls = classifyRelease(title, desc);
    assert.deepStrictEqual(cls.audioLanguageCodes, ['en', 'ja'], 'Dual Audio in the title gives en+ja audio');
    assert.deepStrictEqual(cls.subtitleLanguageCodes, ['en'], '"English Subtitles (PGS)" must yield the en subtitle code');
    assert.strictEqual(cls.languageGroup, 'eng-dub-subs');
    assert.strictEqual(cls.kind, 'season-pack');
    // Signs/songs only: no English dialogue subs → no en subtitle code.
    const signsOnly = classifyRelease(title, 'Subtitles\nTrack 1: English Signs/Songs (PGS)');
    assert.strictEqual(signsOnly.subtitleLanguageCodes.includes('en'), false,
      '"English Signs/Songs" alone is not English subtitles');
  });

  runTest('4.1c a seasonless release sinks below a season-marked one for season>1 requests', () => {
    const ref = { animeTitle: 'Show', season: 2, episode: 5 };
    const marked = makeResult('[Group] Show S2 - 05 [1080p]', 5);     // exact 60 +15 +25 = 100
    const seasonless = makeResult('[Group] Show - 05 [1080p]', 50);   // exact 60 -10 +25 = 75
    const ranked = rankReleasesForEpisode([seasonless, marked], ref);
    assert.strictEqual(ranked[0], marked, 'the season-marked release wins despite 10x fewer seeders');
    assert.strictEqual(ranked[1], seasonless, 'the seasonless release stays available (relative order among them is fair)');
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

  runTest('4.3 empty animeTitle still applies language ordering and seeder tie-break', () => {
    const a = makeResult('[Group] Some Other Show - 05 [1080p]', 1);
    const b = makeResult('[SubsPlease] Frieren Beyond Journeys End - 05 [1080p]', 99);
    const input = [a, b];
    const ranked = rankReleasesForEpisode(input, { animeTitle: '', season: 1, episode: 5 });
    assert.deepStrictEqual(ranked, [b, a]);
    assert.notStrictEqual(ranked, input, 'still a new array, not the input reference');
  });

  runTest('4.4 punctuation-only animeTitle still applies language ordering', () => {
    const a = makeResult('[Group] Some Other Show - 05 [1080p]', 1);
    const b = makeResult('[SubsPlease] Frieren Beyond Journeys End - 05 [1080p]', 99);
    const ranked = rankReleasesForEpisode([a, b], { animeTitle: '!!!', season: 1, episode: 5 });
    assert.deepStrictEqual(ranked, [b, a]);
  });

  runTest('4.8 explicit English dub/subtitle confidence outranks ambiguous tags and seeders', () => {
    const unknown = makeResult('[Group] Show S01E01 [1080p]', 999);
    const japanese = makeResult('[Group] Show S01E01 [Japanese Audio]', 1);
    const englishSubs = makeResult('[Group] Show S01E01 [English Dub][English Subs]', 5);
    const dubtitles = makeResult('[Group] Show S01E01 [English Dub][Dubtitles]', 2);
    assert.deepStrictEqual(
      rankReleasesForEpisode([unknown, japanese, englishSubs, dubtitles], { animeTitle: 'Show', season: 1, episode: 1 }),
      [dubtitles, englishSubs, japanese, unknown],
    );
    assert.strictEqual(classifyRelease(unknown.title).languageGroup, 'unknown');
  });

  runTest('4.8b Dual-Audio and Multi-Subs are classified as eng-dub-subs with English audio and subtitles', () => {
    const dualMulti = makeResult('[Group] Show S01E01 [Dual-Audio][Multi-Subs]', 999);
    const classification = classifyRelease(dualMulti.title);
    assert.strictEqual(classification.languageGroup, 'eng-dub-subs');
    assert.strictEqual(classification.rank, 1);
    assert.ok(classification.audioLanguageCodes.includes('en'));
    assert.ok(classification.audioLanguageCodes.includes('ja'));
    assert.ok(classification.subtitleLanguageCodes.includes('en'));
    assert.strictEqual(classification.subtitleLabel, 'Multi-Subs');
  });

  runTest('4.8c isExplicitSeasonMismatch rejects releases targeting a different season', () => {
    const s1 = makeResult('Show - S01E02 (WEB 1080p) [ENG]', 10);
    const s2 = makeResult('Show S02 2160p (Dual-Audio, Multi-Subs, Batch)', 10);
    assert.strictEqual(isExplicitSeasonMismatch(s1, 2), true);
    assert.strictEqual(isExplicitSeasonMismatch(s2, 2), false);
    assert.strictEqual(isExplicitSeasonMismatch(s1, 1), false);
  });

  runTest('4.8d detectSeasonFromTitle extracts season from various anime and release title formats', () => {
    assert.strictEqual(detectSeasonFromTitle('Cyberpunk: Edgerunners 2'), 2);
    assert.strictEqual(detectSeasonFromTitle('KonoSuba 2'), 2);
    assert.strictEqual(detectSeasonFromTitle('Mob Psycho 100 II'), 2);
    assert.strictEqual(detectSeasonFromTitle('Mob Psycho 100 III'), 3);
    assert.strictEqual(detectSeasonFromTitle('Overlord IV'), 4);
    assert.strictEqual(detectSeasonFromTitle('Jujutsu Kaisen Season 2'), 2);
    assert.strictEqual(detectSeasonFromTitle('DanMachi S5'), 5);
    assert.strictEqual(detectSeasonFromTitle('DanMachi 4th Season'), 4);
    assert.strictEqual(detectSeasonFromTitle('Bleach'), null);
    assert.strictEqual(detectSeasonFromTitle('86'), null);
    assert.strictEqual(detectSeasonFromTitle('Mob Psycho 100'), null);
    assert.strictEqual(detectSeasonFromTitle('Steins;Gate 0'), null);
    assert.strictEqual(detectSeasonFromTitle('Show (2024)'), null);
  });

  runTest('4.8e quality filtering prefers 2160p over 1080p within same dub+sub confidence, regardless of seeds', () => {
    const ntb2160p = makeResult('Cyberpunk Edgerunners S02 2160p NF WEB-DL DDP5.1 DV HDR HEVC-NTb (Cyberpunk: Edgerunners 2, Dual-Audio, Multi-Subs, Batch)', 1218);
    const varyg1080p = makeResult('Cyberpunk Edgerunners S02 1080p NF WEB-DL DUAL DDP5.1 H.264-VARYG (Cyberpunk: Edgerunners 2, Dual-Audio, Multi-Subs, Batch)', 2403);
    const judas1080p = makeResult('[Judas] Cyberpunk Edgerunners (Season 2) [1080p HDR][HEVC x265 10bit][Dual-Audio][Multi-Subs] (Batch)', 1050);
    const ranked = rankReleasesForEpisode([varyg1080p, judas1080p, ntb2160p], { animeTitle: 'Cyberpunk: Edgerunners 2' });
    assert.strictEqual(ranked[0], ntb2160p);
    assert.strictEqual(ranked[1], varyg1080p);
    assert.strictEqual(ranked[2], judas1080p);
  });

  runTest('4.8f quality filtering never sacrifices dub & sub for higher resolution', () => {
    const raw2160p = makeResult('Cyberpunk Edgerunners S02 2160p [Japanese RAW]', 5000);
    const dubSub1080p = makeResult('Cyberpunk Edgerunners S02 1080p [Dual-Audio][Multi-Subs] (Batch)', 100);
    const ranked = rankReleasesForEpisode([raw2160p, dubSub1080p], { animeTitle: 'Cyberpunk: Edgerunners 2' });
    assert.strictEqual(ranked[0], dubSub1080p);
    assert.strictEqual(ranked[1], raw2160p);
  });

  runTest('4.8g verified dubtitles strictly outrank higher resolution releases without dubtitles', () => {
    const dubtitles1080p = makeResult('Cyberpunk Edgerunners S02 1080p [English Dub][Dubtitles] (Batch)', 50);
    const multiSubs2160p = makeResult('Cyberpunk Edgerunners S02 2160p (Cyberpunk: Edgerunners 2, Dual-Audio, Multi-Subs, Batch)', 1500);
    const ranked = rankReleasesForEpisode([multiSubs2160p, dubtitles1080p], { animeTitle: 'Cyberpunk: Edgerunners 2' });
    assert.strictEqual(ranked[0], dubtitles1080p);
    assert.strictEqual(ranked[1], multiSubs2160p);
  });

  runTest('4.8h isExplicitSeasonMismatch rejects Season 1 releases using titleHint when requestedSeason is null', () => {
    const s1 = makeResult('[Judas] Cyberpunk Edgerunners (Season 1) [1080p][Multi-Subs] (Batch)', 100);
    assert.strictEqual(isExplicitSeasonMismatch(s1, null, 'Cyberpunk: Edgerunners 2'), true);
  });

  runTest('4.9 English dub without subtitle data precedes Japanese, then other known audio', () => {
    const other = makeResult('[Group] Show S01E01 [French audio]', 999);
    const japanese = makeResult('[Group] Show S01E01 [Japanese audio]', 1);
    const dub = makeResult('[Group] Show S01E01 [English Dub]', 2);
    assert.deepStrictEqual(
      rankReleasesForEpisode([other, japanese, dub], { animeTitle: 'Show', season: 1, episode: 1 }),
      [dub, japanese, other],
    );
  });

  runTest('4.10 release type labels distinguish episodes, ranges, packs, movies, and OVAs', () => {
    assert.strictEqual(classifyRelease('Show S02E03 [English Dub]').kind, 'episode');
    assert.strictEqual(classifyRelease('Show 01-12 Complete [English Dub]').kind, 'season-pack');
    assert.strictEqual(classifyRelease('Show S02E01-12 [English Dub]').kind, 'episode-range');
    assert.strictEqual(classifyRelease('Show Movie [English Dub]').kind, 'movie');
    assert.strictEqual(classifyRelease('Show OVA [English Dub]').kind, 'ova');
  });

  runTest('4.12 adversarial season matrix rejects 96 wrong-season release title variants', () => {
    const franchises = [
      { seasons: [{ season: 1, titles: ['K-On!'] }, { season: 2, titles: ['K-On!!'] }], names: ['K-On!', 'K-On!!'] },
      { seasons: [{ season: 1, titles: ['Jujutsu Kaisen'] }, { season: 2, titles: ['Jujutsu Kaisen Season 2'] }], names: ['Jujutsu Kaisen', 'Jujutsu Kaisen Season 2'] },
      { seasons: [{ season: 1, titles: ['Mob Psycho 100'] }, { season: 2, titles: ['Mob Psycho 100 II'] }], names: ['Mob Psycho 100', 'Mob Psycho 100 II'] },
      { seasons: [{ season: 1, titles: ['DanMachi'] }, { season: 2, titles: ['DanMachi II'] }], names: ['DanMachi', 'DanMachi II'] },
      { seasons: [{ season: 1, titles: ['Re:Zero'] }, { season: 2, titles: ['Re:Zero 2nd Season'] }], names: ['Re:Zero', 'Re:Zero 2nd Season'] },
      { seasons: [{ season: 1, titles: ['Attack on Titan'] }, { season: 2, titles: ['Attack on Titan Season 2'] }], names: ['Attack on Titan', 'Attack on Titan Season 2'] },
    ];
    const releaseShapes = [
      (name, season) => `[Group] ${name} - 01 [1080p]`,
      (name, season) => `[SubsPlease] ${name} S0${season}E01 [1080p]`,
      (name, season) => `[Group] ${name} (Season ${season}) [Batch] [BD]`,
      (name, season) => `[Fansub] ${name} Episode 01 [Dual Audio]`,
      (name, season) => `[Anime Time] ${name} [Complete Series] [Dual Audio]`,
      (name, season) => `[Group] ${name} 01-12 Complete [BD 1080p]`,
      (name, season) => `[Group] ${name} - 01 [English Dub][Multi-Subs]`,
      (name, season) => `[Group] ${name} 1-26+OVA Complete (BD1080p AC3)`,
    ];
    let checked = 0;
    for (const franchise of franchises) {
      for (const targetSeason of [1, 2]) {
        const foreignSeason = targetSeason === 1 ? 2 : 1;
        for (const buildTitle of releaseShapes) {
          const title = buildTitle(franchise.names[foreignSeason - 1], foreignSeason);
          const result = makeResult(title, 10);
          const rejected = isExplicitSeasonMismatch(result, targetSeason, undefined, franchise.seasons)
            || isFranchiseSeasonTitleMismatch(result, targetSeason, franchise.seasons);
          // A title-less Season 1 release can be genuinely ambiguous when
          // AniList lists the same root title for both seasons. Numbered
          // season markers and distinct franchise titles must still reject.
          const ambiguousBase = targetSeason === 2 && foreignSeason === 1
            && [0, 3, 4, 5, 6, 7].includes(releaseShapes.indexOf(buildTitle))
            && !franchise.names[0].startsWith('K-On')
            && franchise.names[0].replace(/[^a-z0-9]/gi, '').toLowerCase() === franchise.names[1].replace(/[^a-z0-9]/gi, '').toLowerCase();
          const isCrossSeasonBundle = releaseShapes.indexOf(buildTitle) === 7;
          // Range+OVA+Complete bundles that name the FOREIGN season's title
          // ("K-On! 1-26+OVA Complete" while requesting season 2) are now
          // rejected too: the raw title names one season and that season is
          // not the requested one (observed live — the auto-pick downloaded
          // season 1's bundle for season 2's OVA). Genuine multi-season
          // listings escape via isMultiSeasonCollection instead.
          assert.strictEqual(rejected, !ambiguousBase, `wrong result for season ${targetSeason}: ${title}`);
          checked++;
        }
      }
    }
    assert.strictEqual(checked, 96);
  });

  runTest('4.13 season bundle fixtures classify correctly and explicit multi-season packs are marked', () => {
    const allSeasons = '[Anime Time] K-On! [Complete Series] (Season 01 + Season 02 + Movie + OVA + Specials) [BD][Dual Audio][1080p]';
    const packedSeason = '[anime4life.] K-ON!! 1-26+OVA Complete (BD1080p AC3 10bit) [x265_HEVC] Dual Audio';
    assert.strictEqual(classifyRelease(allSeasons).kind, 'season-pack');
    assert.strictEqual(classifyRelease(allSeasons).kindLabel, 'Complete series pack');
    assert.strictEqual(isMultiSeasonCollection(allSeasons), true);
    assert.strictEqual(classifyRelease(packedSeason).kind, 'season-pack');
    assert.strictEqual(isMultiSeasonCollection(packedSeason), false);
    const chain = [{ season: 1, titles: ['K-On!'] }, { season: 2, titles: ['K-On!!'] }];
    assert.strictEqual(isExplicitSeasonMismatch({ title: allSeasons }, 2, undefined, chain), false, 'a whole-series bundle is compatible with a selected constituent season');
    assert.strictEqual(isFranchiseSeasonTitleMismatch({ title: allSeasons }, 2, chain), false);
    assert.strictEqual(isFranchiseSeasonTitleMismatch({ title: packedSeason }, 1, chain), true,
      '"K-ON!! 1-26+OVA Complete" names season 2 — season 1\'s search must not use it');
    assert.strictEqual(isFranchiseSeasonTitleMismatch({ title: packedSeason }, 2, chain), false);
  });

  runTest('4.14 an OVA page must not take the WRONG parent season\'s bundle (K-ON! Season 2: Plan! case)', () => {
    // Live failure 2026-11-13: searching "K-ON! Season 2: Plan!" (season 2's
    // OVA) auto-picked "[anime4life.] K-ON! 1-13+OVA Complete" — season 1's
    // bundle carrying Live House! — because the OVA page had no franchise
    // chain and both bundles scored 'exact'. The OVA page's chain now comes
    // from the PARENT TV season, so the raw-title hits decide.
    const chain = [
      { season: 1, titles: ['K-On!', 'K-ON!', 'けいおん!', 'K-On! Season 1'] },
      { season: 2, titles: ['K-On!!', 'K-ON!!', 'けいおん!!', 'K-On!! Season 2'] },
    ];
    const s1Bundle = '[anime4life.] K-ON! 1-13+OVA Complete (BD1080p AC3 10bit) [x265_HEVC] Dual Audio';
    const s2Bundle = '[anime4life.] K-ON!! 1-26+OVA Complete (BD1080p AC3 10bit) [x265_HEVC] Dual Audio';
    const wholeSeries = '[Anime Time] K-On! [Complete Series] (Season 01 + Season 02 + Movie + OVA + Specials) [BD][Dual Audio][1080p][HEVC 10bit x265][AAC][Eng Sub]';
    const numericShort = '[Trix] K-ON! - S01+02+OVA+Movie [Dual Audio] (BD 1080p AV1)';
    assert.strictEqual(isFranchiseSeasonTitleMismatch({ title: s1Bundle }, 2, chain), true, 'season 1\'s bundle is a mismatch for the season 2 OVA');
    assert.strictEqual(isFranchiseSeasonTitleMismatch({ title: s1Bundle }, 1, chain), false, 'season 1\'s bundle stays for season 1');
    assert.strictEqual(isFranchiseSeasonTitleMismatch({ title: s2Bundle }, 2, chain), false, 'season 2\'s bundle stays for the season 2 OVA');
    assert.strictEqual(isFranchiseSeasonTitleMismatch({ title: wholeSeries }, 2, chain), false, 'a genuine multi-season listing stays for any member season');
    assert.strictEqual(isFranchiseSeasonTitleMismatch({ title: numericShort }, 2, chain), false, 'an "S01+02" numeric multi-season listing stays');
  });

  runTest('4.15 wrong-season OVA bundles rejected across DxD / KonoSuba / Haikyuu franchises', () => {
    // Real AniList chains (checked 2026-11-13); bundles are live Nyaa shapes.
    const dxdChain = [
      { season: 1, titles: ['High School DxD', 'ハイスクールD×D'] },
      { season: 2, titles: ['High School DxD NEW', 'ハイスクールD×D NEW'] },
      { season: 3, titles: ['High School DxD BorN', 'ハイスクールD×D BorN'] },
      { season: 4, titles: ['High School DxD HERO', 'ハイスクールD×D HERO'] },
    ];
    assert.strictEqual(isFranchiseSeasonTitleMismatch({ title: '[anime4life.] High School DxD BorN 01-12+OVA Complete (BD1080p) Dual Audio' }, 2, dxdChain), true,
      'the BorN (S3) bundle must not satisfy the NEW (S2) OVA page');
    assert.strictEqual(isFranchiseSeasonTitleMismatch({ title: '[anime4life.] High School DxD NEW 01-13+OVA Complete (BD1080p) Dual Audio' }, 2, dxdChain), false);
    const konosubaChain = [
      { season: 1, titles: ['Kono Subarashii Sekai ni Shukufuku wo!', 'この素晴らしい世界に祝福を!'] },
      { season: 2, titles: ['Kono Subarashii Sekai ni Shukufuku wo! 2', 'この素晴らしい世界に祝福を!2'] },
      { season: 3, titles: ['Kono Subarashii Sekai ni Shukufuku wo! 3', 'この素晴らしい世界に祝福を!3'] },
    ];
    assert.strictEqual(isFranchiseSeasonTitleMismatch({ title: '[Konosuba] Kono Subarashii Sekai ni Shukufuku wo! 01-10+OVA Complete [BD]' }, 2, konosubaChain), true,
      'the S1 bundle must not satisfy the S2 OVA page');
    assert.strictEqual(isFranchiseSeasonTitleMismatch({ title: 'Kono Subarashii Sekai ni Shukufuku wo! 2 01-10+OVA Complete [BD 1080p]' }, 2, konosubaChain), false);
    const haikyuuChain = [
      { season: 1, titles: ['Haikyuu!!', 'ハイキュー!!'] },
      { season: 2, titles: ['Haikyuu!! 2nd Season', 'ハイキュー!! セカンドシーズン'] },
    ];
    assert.strictEqual(isFranchiseSeasonTitleMismatch({ title: '[Group] Haikyuu!! 2nd Season 01-25+OVA Complete [BD 1080p]' }, 1, haikyuuChain), true,
      'the 2nd Season bundle must not satisfy the S1 "Lev Kenzan!" OVA page');
    assert.strictEqual(isFranchiseSeasonTitleMismatch({ title: '[Group] Haikyuu!! 01-25+OVA Complete [BD 1080p]' }, 1, haikyuuChain), false);
  });

  await runAsyncTest('4.11 detail page inspection enriches search results and stays on the configured source origin', async () => {
    const original = globalThis.fetch;
    let request = null;
    globalThis.fetch = async (url, init) => {
      request = { url: String(url), init };
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: null,
        text: async () => '<p>English Dubtitles and English audio</p>',
      };
    };
    try {
      const html = await fetchReleaseDescription('prov-rss', 'https://indexer.example/release/1', [rssProvider]);
      assert.match(html, /English Dubtitles/);
      assert.strictEqual(request.url, 'https://indexer.example/release/1');
      const release = { ...makeResult('Show S01E01 1080p', 20), providerId: 'prov-rss', providerName: rssProvider.name, detailsUrl: 'https://indexer.example/release/1' };
      const inspected = await inspectReleaseResults([release], [rssProvider], 5);
      assert.strictEqual(classifyRelease(inspected[0].title, inspected[0].description).languageGroup, 'eng-dub-dubtitles');
      await assert.rejects(
        () => fetchReleaseDescription('prov-rss', 'https://other.example/release/1', [rssProvider]),
        /outside the configured source/i,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  runTest('4.5 episode=null → batch/season-pack releases get +20 and float up', () => {
    const ref = { animeTitle: 'Show', season: null, episode: null };
    const singleEpisode = makeResult('[Group] Show - 05 [1080p]', 5);      // exact 60 + 5 = 65
    const rangePack = makeResult('[Group] Show - 01-12 [1080p]', 5);       // exact 60 + multi-ep bonus 20 + 5 = 85
    const batchPack = makeResult('[Group] Show Season Pack [Batch] [1080p]', 10); // "Season Pack"/"Batch" are release decorations → exact 60 + 20 + 10 = 90
    const ranked = rankReleasesForEpisode([singleEpisode, batchPack, rangePack], ref);
    // All three are the same show (decorations stripped before matching), so
    // release-kind rank orders the packs above the single episode, then score
    // (batch 90 / range 85 / single 65).
    assert.strictEqual(ranked[0], batchPack, 'the season pack floats to the top');
    assert.strictEqual(ranked[1], rangePack, 'the multi-episode range pack follows');
    assert.strictEqual(ranked[2], singleEpisode, 'plain single episode stays below batches');
    assert.strictEqual(ranked.length, 3);
  });

  runTest('4.6 episode=null + equal scores → plain episode still wins tie-break, bonus never filters', () => {
    const ref = { animeTitle: 'Show', season: null, episode: null };
    const batch = makeResult('[Group] Show Complete [1080p]', 5);   // 60 + 20 + 5 = 85
    const single = makeResult('[Group] Show - 05 [1080p]', 5);      // 60 + 5 = 65
    const unrelated = makeResult('[Group] Unrelated Show Complete', 1); // containment 40 + 20 + 5 = 65
    const garbage = makeResult('???-??? ??? [1080p]', null);
    const input = [batch, single, unrelated, garbage];
    const ranked = rankReleasesForEpisode(input, ref);
    // NEVER filters: every input element must come back, just reordered.
    assert.strictEqual(ranked.length, input.length, 'rank must not drop any input element');
    for (const item of input) assert.ok(ranked.includes(item), 'rank must not lose any input element');
    assert.strictEqual(ranked[0], batch, 'batch floats to the top');
  });

  runTest('4.7 episode=null bonus does not apply when a specific episode is requested', () => {
    const ref = { animeTitle: 'Show', season: null, episode: 5 };
    const batch = makeResult('[Group] Show Complete [1080p]', 5);      // 60 -15(episode mismatch... no episodeNumbers→ no penalty) +5 = 65
    const single = makeResult('[Group] Show - 05 [1080p]', 5);         // 60 +25 +5 = 90
    const ranked = rankReleasesForEpisode([batch, single], ref);
    assert.strictEqual(ranked[0], single, 'with episode=5 the requested episode beats the batch (no +20)');
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
  // 6. VPN guard stub — the guard was intentionally removed (user manages
  //    their own network safety); vpnGuard.ts keeps the API as a stub.
  // =========================================================================
  console.log('\n--- SUITE 6: VPN guard stub ---');

  runTest('6.1 detectVpnStatus stub reports active with no interfaces and clearVpnCache stays harmless', () => {
    const a = detectVpnStatus();
    assert.strictEqual(a.active, true, 'stub always reports active — nothing blocks P2P anymore');
    assert.ok(Array.isArray(a.interfaces), 'interfaces must be an array');
    assert.strictEqual(a.interfaces.length, 0, 'stub reports no interfaces (no detection)');
    assert.strictEqual(typeof a.checkedAt, 'number');
    assert.ok(Number.isFinite(a.checkedAt));

    clearVpnCache(); // kept for API compatibility — must not throw
    const b = detectVpnStatus();
    assert.strictEqual(b.active, true);
    assert.ok(b.checkedAt >= a.checkedAt, 'checkedAt must not go backwards');
  });

  // =========================================================================
  // 7. sanitizeSearchQuery + extractInfoHash
  // =========================================================================
  console.log('\n--- SUITE 7: query sanitization + info-hash extraction ---');

  runTest('7.1 sanitizeSearchQuery strips release-name punctuation, collapses whitespace', () => {
    assert.strictEqual(sanitizeSearchQuery('Cyberpunk: Edgerunners 2'), 'Cyberpunk Edgerunners 2');
    assert.strictEqual(sanitizeSearchQuery('Re:Zero - Starting Life in Another World...'), 'Re Zero Starting Life in Another World');
    assert.strictEqual(sanitizeSearchQuery('Frieren_BD [1080p]'), 'Frieren BD 1080p');
    assert.strictEqual(sanitizeSearchQuery("Show's Name!? (2024)"), 'Show s Name 2024');
    assert.strictEqual(sanitizeSearchQuery('  multiple   spaces\tand\nnewlines  '), 'multiple spaces and newlines');
    assert.strictEqual(sanitizeSearchQuery('鬼滅の刃 Second Season'), '鬼滅の刃 Second Season', 'unicode word characters survive');
    assert.strictEqual(sanitizeSearchQuery('!!!'), '', 'punctuation-only input sanitizes to empty');
    assert.strictEqual(sanitizeSearchQuery(''), '');
  });

  runTest('7.1a sanitizeSearchQuery keeps intra-word hyphens, drops separator hyphens', () => {
    // Nyaa fulltext treats "K-ON" and "K ON" as different queries; every
    // release name carries the hyphen, so stripping it starved the search
    // (observed live: "K ON" found nothing on Nyaa while "K-ON" does).
    assert.strictEqual(sanitizeSearchQuery('K-ON!'), 'K-ON');
    assert.strictEqual(sanitizeSearchQuery('K-ON!! Season 2'), 'K-ON Season 2');
    assert.strictEqual(sanitizeSearchQuery('erai-raws [1080p]'), 'erai-raws 1080p', 'group names keep their hyphen');
    assert.strictEqual(sanitizeSearchQuery('10-bit hevc'), '10-bit hevc');
    assert.strictEqual(sanitizeSearchQuery('Re:Zero - Starting Life'), 'Re Zero Starting Life', 'a spaced hyphen is a separator');
    assert.strictEqual(sanitizeSearchQuery('Title -5'), 'Title 5', 'hyphen adjacent to a space is a separator');
    assert.strictEqual(sanitizeSearchQuery('K - ON'), 'K ON', 'spaced hyphen never becomes intra-word');
    assert.strictEqual(sanitizeSearchQuery('-Leading and Trailing-'), 'Leading and Trailing');
  });

  runTest('7.2 sanitizeSearchQuery handles non-string input defensively', () => {
    assert.strictEqual(sanitizeSearchQuery(undefined), '');
    assert.strictEqual(sanitizeSearchQuery(null), '');
    assert.strictEqual(sanitizeSearchQuery(42), '');
  });

  runTest('7.3 extractInfoHash: 40-hex magnet → lowercase hash', () => {
    assert.strictEqual(
      extractInfoHash('magnet:?xt=urn:btih:CAFEBABE00000000000000000000000000000000&dn=Show'),
      'cafebabe00000000000000000000000000000000'
    );
    assert.strictEqual(
      extractInfoHash('magnet:?xt=urn:btih:0123abcd0123abcd0123abcd0123abcd0123abcd&dn=x&tr=udp://tracker.example'),
      '0123abcd0123abcd0123abcd0123abcd0123abcd'
    );
  });

  runTest('7.4 extractInfoHash: 32-char base32 magnet → lowercase hash', () => {
    assert.strictEqual(
      extractInfoHash('magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&dn=Show'),
      'abcdefghijklmnopqrstuvwxyz234567'
    );
    assert.strictEqual(extractInfoHash('magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234560'), null, '0 is not base32');
  });

  runTest('7.5 extractInfoHash: non-magnet URLs and garbage → null', () => {
    assert.strictEqual(extractInfoHash('https://mirror.example/dl/1.torrent'), null);
    assert.strictEqual(extractInfoHash('https://nyaa.example/download/12345.torrent'), null);
    assert.strictEqual(extractInfoHash('magnet:?dn=only-name'), null);
    assert.strictEqual(extractInfoHash('magnet:?xt=urn:btih:NOTHEXNOTHEXNOTHEXNOTHEXNOTHEXNOTH'), null, '40 chars but not hex');
    assert.strictEqual(extractInfoHash(''), null);
    assert.strictEqual(extractInfoHash(null), null);
    assert.strictEqual(extractInfoHash(undefined), null);
  });

  await runAsyncTest('7.6 decodeHtmlEntities & fetchProviderFeed decode single and double-encoded RSS titles', async () => {
    assert.strictEqual(decodeHtmlEntities("I&#39;m Dating &amp; Learning"), "I'm Dating & Learning");
    assert.strictEqual(decodeHtmlEntities("I&amp;#39;m"), "I'm");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Feed</title>
  <item>
    <title>[Judas] Dark Summoner to Dekite Iru (I&amp;#39;m Dating a Dark Summoner) - S01E01 [Eng-Subs]</title>
    <link>https://mirror.example/dl/1.torrent</link>
  </item>
  <item>
    <title>[SubsPlus+] I&amp;amp;#39;m Dating a Dark Summoner - S01E01</title>
    <link>https://mirror.example/dl/2.torrent</link>
  </item>
</channel></rss>`;
    installFetchMock(async () => jsonResponse(200, xml));
    const items = await fetchProviderFeed(rssProvider, { query: 'Dark Summoner' });
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].title, "[Judas] Dark Summoner to Dekite Iru (I'm Dating a Dark Summoner) - S01E01 [Eng-Subs]");
    assert.strictEqual(items[1].title, "[SubsPlus+] I'm Dating a Dark Summoner - S01E01");
  });

  runTest('7.7 classifyRelease + releaseDescriptionToText ignore Nyaa nav/select chrome and classify [Eng-Subs] without false English Dub', () => {
    const nyaaHtml = `<!DOCTYPE html><html><head><title>Nyaa</title></head><body>
      <nav>Anime - English-translated - Raw Audio - Lossless</nav>
      <select><option>Literature - English</option><option>Audio - Lossy</option></select>
      <div id="torrent-description">
        <div class="markdown"><p><strong>Audio</strong>: Japanese<br><strong>Subtitles</strong>: English</p></div>
      </div>
      <footer>Comments</footer>
    </body></html>`;
    const descText = releaseDescriptionToText(nyaaHtml);
    assert.ok(!/English-translated|Literature/i.test(descText), `nav/select chrome leaked into description: ${descText}`);
    assert.ok(descText.includes('Audio: Japanese') && descText.includes('Subtitles: English'));

    const releaseTitle = "[Judas] Dark Summoner to Dekite Iru (I'm Dating a Dark Summoner) [Uncensored] - S01E01 [1080p][HEVC x265 10bit][Eng-Subs] (Weekly)";
    const classified = classifyRelease(releaseTitle, descText);
    assert.deepStrictEqual(classified.audioLanguageCodes, ['ja']);
    assert.strictEqual(classified.audioLabels.includes('English Dub'), false);
    assert.deepStrictEqual(classified.subtitleLanguageCodes, ['en']);
    assert.strictEqual(classified.subtitleLabel, 'English Subs');
  });

  runTest('7.8 sanitizeSearchQuery strips curly quotes cleanly', () => {
    assert.strictEqual(sanitizeSearchQuery('I’m Dating a Dark Summoner Omake Shorts'), 'I m Dating a Dark Summoner Omake Shorts');
    assert.strictEqual(sanitizeSearchQuery('“Test” Show‘s Title'), 'Test Show s Title');
  });

  runTest('7.9 computeTitleRelevance matches space-collapsed romanized compounds as exact', () => {
    assert.strictEqual(
      computeTitleRelevance('[Judas] Dark Summoner to Dekite Iru - S01E01 [1080p]', ['Dark Summoner to Dekiteiru']),
      'exact'
    );
  });

  runTest('7.10 isExplicitSpinoffOrSpecialMismatch filters Omake Shorts & S00E01 from main series search while keeping spin-off searches and full bundles', () => {
    const omake = makeResult('[ASW] Dark Summoner to Dekiteiru - Omake Shorts - 01 [1080p HEVC x265 10Bit][AAC]', 84);
    const s00 = makeResult('[Group] Dark Summoner to Dekiteiru - S00E01 [1080p]', 20);
    const fullBundle = makeResult('[Group] Dark Summoner to Dekiteiru (01-12 + Omake Shorts) [Complete Series] [BD 1080p]', 50);

    assert.strictEqual(
      isExplicitSpinoffOrSpecialMismatch(omake, ["I'm Dating a Dark Summoner", 'Dark Summoner to Dekiteiru'], 'TV_SHORT'),
      true
    );
    assert.strictEqual(
      isExplicitSpinoffOrSpecialMismatch(s00, ["I'm Dating a Dark Summoner", 'Dark Summoner to Dekiteiru'], 'TV'),
      true
    );
    assert.strictEqual(
      isExplicitSpinoffOrSpecialMismatch(fullBundle, ["I'm Dating a Dark Summoner", 'Dark Summoner to Dekiteiru'], 'TV_SHORT'),
      false
    );
    assert.strictEqual(
      isExplicitSpinoffOrSpecialMismatch(omake, ['I’m Dating a Dark Summoner Omake Shorts', 'Dark Summoner to Dekiteiru Omake Shorts'], 'TV_SHORT'),
      false
    );
  });

  runTest('7.11 sanitizeSearchQuery strips ×, ・, fullwidth colons and brackets', () => {
    assert.strictEqual(
      sanitizeSearchQuery('Jujutsu Kaisen: Kaigyoku・Gyokusetsu'),
      'Jujutsu Kaisen Kaigyoku Gyokusetsu'
    );
    assert.strictEqual(sanitizeSearchQuery('A × B'), 'A B');
    assert.strictEqual(sanitizeSearchQuery('JUJUTSU KAISEN： Execution 【Movie】'), 'JUJUTSU KAISEN Execution Movie');
  });

  runTest('7.12 deriveShortenedTitleQueries shortens long subtitle-heavy titles safely without stripping seasons or colliding with parent series', () => {
    const jjkExec = deriveShortenedTitleQueries([
      'JUJUTSU KAISEN: Execution -Shibuya Incident x The Culling Game Begins-',
    ]);
    assert.ok(
      jjkExec.includes('JUJUTSU KAISEN: Execution'),
      `expected "JUJUTSU KAISEN: Execution", got: ${JSON.stringify(jjkExec)}`
    );

    const hiddenInv = deriveShortenedTitleQueries([
      'JUJUTSU KAISEN: Hidden Inventory / Premature Death – The Movie',
    ]);
    assert.ok(
      hiddenInv.includes('JUJUTSU KAISEN: Hidden Inventory / Premature Death'),
      `expected without "– The Movie", got: ${JSON.stringify(hiddenInv)}`
    );
    assert.ok(
      hiddenInv.includes('JUJUTSU KAISEN: Hidden Inventory'),
      `expected slash prefix "JUJUTSU KAISEN: Hidden Inventory", got: ${JSON.stringify(hiddenInv)}`
    );

    const hashiraExcluded = deriveShortenedTitleQueries(
      ['Demon Slayer: Kimetsu no Yaiba -To the Hashira Training-'],
      ['Demon Slayer: Kimetsu no Yaiba']
    );
    assert.strictEqual(
      hashiraExcluded.some((q) => /Demon Slayer:\s*Kimetsu no Yaiba$/i.test(q)),
      false,
      `must not collapse onto excluded parent title: ${JSON.stringify(hashiraExcluded)}`
    );

    const seasonPreserved = deriveShortenedTitleQueries([
      'Re:Zero - Starting Life in Another World Season 2',
    ]);
    assert.strictEqual(
      seasonPreserved.length,
      0,
      `must never strip Season 2 tail: ${JSON.stringify(seasonPreserved)}`
    );
  });

  // =========================================================================
  // 8. Multi-Audio / Multi-Subs, MediaInfo, inspection, and language ranking
  // =========================================================================
  console.log('\n--- SUITE 8: Multi-Audio / MediaInfo / language-aware ranking & search ---');

  runTest('8.1 Multi-Audio + Multi-Subs long lists (ToonsHub / Netflix / Cyrillic) extract all languages', () => {
    const title = '[ToonsHub] Solo Leveling S02E01 (CR 1080p) [Multi-Audio][Multi-Subs]';
    const desc = [
      'Audio: Japanese, English, German, French, Spanish (Latin America), Portuguese (Brazil), Italian, Russian',
      'Subtitles: Arabic, Chinese (Simplified), Chinese (Traditional), English, French, German, Indonesian, Italian, Japanese, Korean, Malay, Portuguese (Brazil), Russian, Spanish, Thai, Vietnamese',
    ].join('\n');
    const cls = classifyRelease(title, desc);
    assert.strictEqual(cls.isMultiAudio, true);
    assert.strictEqual(cls.isMultiSubs, true);
    assert.strictEqual(cls.hasUnlistedMultiAudio, false);
    assert.strictEqual(cls.hasUnlistedMultiSubs, false);
    for (const code of ['en', 'ja', 'de', 'fr', 'es', 'it', 'ru', 'pt']) {
      assert.ok(cls.audioLanguageCodes.includes(code), `missing audio code ${code}: ${JSON.stringify(cls.audioLanguageCodes)}`);
    }
    for (const code of ['en', 'ja', 'de', 'fr', 'es', 'it', 'ru', 'pt', 'zh', 'ko']) {
      assert.ok(cls.subtitleLanguageCodes.includes(code), `missing subtitle code ${code}: ${JSON.stringify(cls.subtitleLanguageCodes)}`);
    }

    const cyrillicDesc = [
      'Аудио: Японский, Русский (AniLibria), Английский',
      'Субтитры: Русские, Английские',
    ].join('\n');
    const clsRu = classifyRelease('[AniLibria] Show - 01 [1080p]', cyrillicDesc);
    assert.deepStrictEqual(clsRu.audioLanguageCodes, ['en', 'ja', 'ru']);
    assert.deepStrictEqual(clsRu.subtitleLanguageCodes, ['en', 'ru']);
  });

  runTest('8.2 MediaInfo multi-line blocks avoid Text-to-Audio bleed and exclude Signs/Forced tracks', () => {
    const mediaInfo = [
      'General',
      'Unique ID : 12345',
      'Format : Matroska',
      '',
      'Audio #1',
      'ID : 2',
      'Format : FLAC',
      'Language : Japanese',
      'Title : Japanese Original',
      '',
      'Audio #2',
      'ID : 3',
      'Format : AAC',
      'Language : Russian',
      'Title : Russian Dub',
      '',
      'Audio #3',
      'ID : 4',
      'Format : AAC',
      'Language : English',
      'Title : English Dub',
      '',
      'Text #1',
      'ID : 5',
      'Format : ASS',
      'Language : Russian',
      'Title : Signs & Songs',
      'Forced : Yes',
      '',
      'Text #2',
      'ID : 6',
      'Format : ASS',
      'Language : English',
      'Title : English Full',
      'Forced : No',
      '',
      'Text #3',
      'ID : 7',
      'Format : ASS',
      'Language : Russian',
      'Title : Russian Full',
      'Forced : No',
      '',
      'Text #4',
      'ID : 8',
      'Format : ASS',
      'Language : German',
      'Title : German Signs',
      'Forced : Yes',
    ].join('\n');
    const cls = classifyRelease('[Group] Show - 01 [1080p][Multi-Audio]', mediaInfo);
    assert.deepStrictEqual(cls.audioLanguageCodes, ['en', 'ja', 'ru']);
    assert.deepStrictEqual(cls.subtitleLanguageCodes, ['en', 'ru']);
    assert.strictEqual(cls.subtitleLanguageCodes.includes('de'), false, 'forced/signs German track must be excluded');
  });

  runTest('8.3 ffprobe stream lines & HTML table track lists classify accurately', () => {
    const ffprobeDesc = [
      'Stream #0:0(jpn): Video: hevc',
      'Stream #0:1(jpn): Audio: flac, 48000 Hz, stereo',
      'Stream #0:2(rus): Audio: aac, 48000 Hz, stereo',
      'Stream #0:3(eng): Subtitle: ass (default)',
      'Stream #0:4(rus): Subtitle: ass (Signs & Songs)',
      'Stream #0:5(rus): Subtitle: ass (Full)',
    ].join('\n');
    const ffCls = classifyRelease('[Group] Show - 01', ffprobeDesc);
    assert.deepStrictEqual(ffCls.audioLanguageCodes, ['ja', 'ru']);
    assert.deepStrictEqual(ffCls.subtitleLanguageCodes, ['en', 'ru']);

    const htmlTable = '<table><tr><th>Audio</th><td>Japanese, French</td></tr><tr><th>Subtitles</th><td>French, German</td></tr></table>';
    const htmlCls = classifyRelease('[Group] Show - 01', htmlTable);
    assert.deepStrictEqual(htmlCls.audioLanguageCodes, ['ja', 'fr']);
    assert.deepStrictEqual(htmlCls.subtitleLanguageCodes, ['de', 'fr']);
  });

  runTest('8.4 false-positive regressions: Alya in Russian, "It was ripped", Nyaa English-translated', () => {
    const alya = classifyRelease('Alya Sometimes Hides Her Feelings in Russian - 01 [1080p][Dual Audio]');
    assert.deepStrictEqual(alya.audioLanguageCodes, ['en', 'ja'], 'title word "Russian" must not falsely trigger Russian audio');
    assert.strictEqual(alya.audioLanguageCodes.includes('ru'), false);

    const itProse = classifyRelease('[Group] Show - 01', 'Audio: It was ripped from Blu-ray with high bitrate');
    assert.strictEqual(itProse.audioLanguageCodes.includes('it'), false, '"It was ripped" must not trigger Italian');

    const nyaaRss = classifyRelease('[SubsPlease] Show - 01 (1080p)', 'View | 500 MiB | Anime - English-translated | hash');
    assert.strictEqual(nyaaRss.audioLanguageCodes.includes('en'), false, 'Nyaa "English-translated" category must not trigger English dub');
  });

  runTest('8.5 Dual-Audio / Multi-Audio with explicit non-English description avoids hallucinated English', () => {
    const dualRu = classifyRelease('[Group] Show - 01 [Dual-Audio]', 'Audio: Japanese, Russian\nSubtitles: Russian');
    assert.deepStrictEqual(dualRu.audioLanguageCodes, ['ja', 'ru']);
    assert.deepStrictEqual(dualRu.subtitleLanguageCodes, ['ru']);
    assert.strictEqual(dualRu.audioLanguageCodes.includes('en'), false);

    const dualRuSingle = classifyRelease('[Group] Show - 01 [Dual-Audio]', 'Audio: Russian');
    assert.deepStrictEqual(dualRuSingle.audioLanguageCodes, ['ja', 'ru']);
  });

  runTest('8.6 VOSTFR, RUS+JPN, multi-sub brackets, scene .DUAL./.MULTI., and Dublado tags', () => {
    const vostfr = classifyRelease('[Team] Show - 01 [1080p][VOSTFR]');
    assert.deepStrictEqual(vostfr.audioLanguageCodes, ['ja']);
    assert.deepStrictEqual(vostfr.subtitleLanguageCodes, ['fr']);

    const rusJpn = classifyRelease('[Release] Show - 01 [RUS+JPN][EN/DE/FR/RU Subs]');
    assert.deepStrictEqual(rusJpn.audioLanguageCodes, ['ja', 'ru']);
    assert.deepStrictEqual(rusJpn.subtitleLanguageCodes, ['en', 'de', 'fr', 'ru']);

    const sceneDual = classifyRelease('Show.Name.S01E01.1080p.CR.WEB-DL.DUAL.DDP2.0.H.264-Group');
    assert.strictEqual(sceneDual.isDualAudio, true);
    assert.deepStrictEqual(sceneDual.audioLanguageCodes, ['en', 'ja']);

    const sceneMulti = classifyRelease('Show.Name.S01E01.1080p.NF.WEB-DL.MULTi.DDP5.1.H.264-Group');
    assert.strictEqual(sceneMulti.isMultiAudio, true);
    assert.strictEqual(sceneMulti.hasUnlistedMultiAudio, true);

    const dublado = classifyRelease('[Group] Show - 01 [1080p][Dublado]');
    assert.deepStrictEqual(dublado.audioLanguageCodes, ['pt']);
  });

  await runAsyncTest('8.7 inspectReleaseResults DOES inspect [Multi-Audio][Multi-Subs] and [Dual-Audio][Multi-Subs] detail pages', async () => {
    const original = globalThis.fetch;
    const requestedUrls = [];
    globalThis.fetch = async (url) => {
      requestedUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        body: null,
        text: async () => '<div id="torrent-description"><p>Audio: Japanese, English, German, Russian<br>Subtitles: English, German, Russian</p></div>',
      };
    };
    try {
      const multiRelease = {
        ...makeResult('[ToonsHub] Show S01E01 (WEB 1080p) [Multi-Audio][Multi-Subs]', 100),
        providerId: 'prov-rss',
        providerName: rssProvider.name,
        detailsUrl: 'https://indexer.example/release/multi-1',
        description: '<a href="https://indexer.example/view/1">#1 | View</a> | 1.1 GiB | Anime - English-translated',
      };
      const dualRelease = {
        ...makeResult('[Judas] Show S01E01 [1080p][Dual-Audio][Multi-Subs]', 80),
        providerId: 'prov-rss',
        providerName: rssProvider.name,
        detailsUrl: 'https://indexer.example/release/dual-2',
      };
      const inspected = await inspectReleaseResults([multiRelease, dualRelease], [rssProvider], 10, {
        preferredAudioLanguages: ['ru'],
        preferredSubtitleLanguages: ['ru'],
      });
      assert.strictEqual(requestedUrls.length, 2, 'both Multi-Audio and Dual-Audio releases must be inspected');
      const cls0 = classifyRelease(inspected[0].title, inspected[0].description);
      assert.ok(cls0.audioLanguageCodes.includes('ru'));
      assert.ok(cls0.audioLanguageCodes.includes('de'));
      assert.ok(cls0.subtitleLanguageCodes.includes('ru'));
      assert.strictEqual(cls0.hasUnlistedMultiAudio, false);
    } finally {
      globalThis.fetch = original;
    }
  });

  runTest('8.8 rankReleasesForEpisode respects preferredAudioLanguages / preferredSubtitleLanguages including priority order and Any ([])', () => {
    const enRelease = makeResult('[Group] Show - 01 [1080p][English Dub][English Subs]', 500);
    const jaRuRelease = makeResult('[Group] Show - 01 [1080p][Japanese Audio][Russian Subs]', 100);
    const ruRelease = makeResult('[Group] Show - 01 [1080p][Russian Audio][Russian Subs]', 25);
    const highRes4k = makeResult('[Group] Show - 01 [2160p][Japanese RAW]', 900);

    const rankedRu = rankReleasesForEpisode([enRelease, jaRuRelease, ruRelease, highRes4k], {
      animeTitle: 'Show',
      episode: 1,
      preferredAudioLanguages: ['ru'],
      preferredSubtitleLanguages: ['ru'],
    });
    assert.strictEqual(rankedRu[0], ruRelease, 'Russian audio + subs wins for ru/ru');
    assert.strictEqual(rankedRu[1], jaRuRelease, 'Japanese audio + Russian subs follows');

    const rankedPriority = rankReleasesForEpisode([enRelease, ruRelease], {
      animeTitle: 'Show',
      episode: 1,
      preferredAudioLanguages: ['ru', 'en'],
      preferredSubtitleLanguages: ['ru', 'en'],
    });
    assert.strictEqual(rankedPriority[0], ruRelease, 'priority #1 (ru) beats #2 (en) despite fewer seeders');

    const rankedAny = rankReleasesForEpisode([enRelease, ruRelease, highRes4k], {
      animeTitle: 'Show',
      episode: 1,
      preferredAudioLanguages: [],
      preferredSubtitleLanguages: [],
    });
    assert.strictEqual(rankedAny[0], highRes4k, 'with Any/Any ([]/[]), quality & seeders decide without language bias');
  });

  runTest('8.9 buildLanguageFallbackQueries emits targeted tracker keywords per language combination', () => {
    assert.deepStrictEqual(buildLanguageFallbackQueries('Frieren: Beyond', ['ru'], ['ru']), ['Frieren Beyond Multi Audio', 'Frieren Beyond RUS']);
    assert.deepStrictEqual(buildLanguageFallbackQueries('Frieren', ['en'], ['en']), ['Frieren Dual Audio', 'Frieren Multi Audio']);
    assert.deepStrictEqual(buildLanguageFallbackQueries('Frieren', ['de'], ['de']), ['Frieren Multi Audio', 'Frieren German']);
    assert.deepStrictEqual(buildLanguageFallbackQueries('Frieren', ['ja'], ['fr']), ['Frieren Multi Subs', 'Frieren VOSTFR']);
    assert.deepStrictEqual(buildLanguageFallbackQueries('Frieren', [], ['fr']), ['Frieren Multi Subs', 'Frieren VOSTFR']);
    assert.deepStrictEqual(buildLanguageFallbackQueries('Frieren', ['ja'], ['ru']), ['Frieren Multi Subs', 'Frieren RUS']);
    assert.deepStrictEqual(buildLanguageFallbackQueries('Frieren', ['ja'], ['en']), ['Frieren Multi Subs']);
    assert.deepStrictEqual(buildLanguageFallbackQueries('Frieren', ['ja'], []), []);
    assert.deepStrictEqual(buildLanguageFallbackQueries('Frieren', [], []), []);
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
