import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadWindySourcesFromApi,
  windyWebcamToSource,
} from '../../server/providers/cctv/sources.js';
import {
  DEFAULT_WINDY_MAX_SOURCES,
  WINDY_IMAGE_ORIGIN,
  WINDY_PAGE_SIZE,
} from '../../server/providers/cctv/constants.js';
import { allocateSourceCap } from '../../server/providers/cctv/cap.js';
import { createCctvCatalog } from '../../server/providers/cctv/catalog.js';

/** One Windy Webcams v3 row, shaped like the documented live payload. */
const webcam = (overrides = {}) => ({
  webcamId: '12345678',
  title: 'Hobart Waterfront',
  status: 'active',
  viewCount: 12000,
  location: {
    city: 'Hobart',
    region: 'Tasmania',
    country: 'AU',
    latitude: -42.8821,
    longitude: 147.3272,
  },
  images: {
    current: {
      preview: 'https://images.windy.com/webcams2/123/12345678/current/preview.jpg',
      webcam: 'https://images.windy.com/webcams2/123/12345678/current/full.jpg',
    },
  },
  ...overrides,
});

test('windyWebcamToSource maps an active webcam onto the registered CDN origin', () => {
  const source = windyWebcamToSource(webcam());
  assert.ok(source, 'active webcam with a CDN image maps');
  assert.equal(source.id, 'windy-12345678');
  assert.equal(source.provider, 'Windy Webcams');
  assert.equal(source.feedType, 'image');
  assert.equal(source.sourceKind, 'windy-webcams');
  assert.ok(
    source.url.startsWith(WINDY_IMAGE_ORIGIN),
    'snapshot URL pinned to the Windy CDN origin',
  );
  assert.equal(source.snapshotUrl, source.url);
  assert.equal(source.headingConfidence, 'low', 'Windy publishes no facing');
  assert.equal(source.city, 'Hobart, Tasmania');
});

test('windyWebcamToSource drops inactive, misplaced, off-origin and malformed rows', () => {
  assert.equal(windyWebcamToSource(webcam({ status: 'inactive' })), null);
  assert.equal(
    windyWebcamToSource(
      webcam({ location: { latitude: 0, longitude: 0, city: '', region: '', country: '' } }),
    ),
    null,
    '0/0 is not a real webcam location',
  );
  assert.equal(
    windyWebcamToSource(
      webcam({
        images: { current: { preview: 'https://evil.example/preview.jpg' } },
      }),
    ),
    null,
    'off-origin image hosts are refused',
  );
  assert.equal(
    windyWebcamToSource(webcam({ webcamId: '../escape' })),
    null,
    'malformed ids never reach the catalog',
  );
  assert.equal(windyWebcamToSource(null), null);
});

test('windyWebcamToSource prefers the full webcam frame over the preview', () => {
  const source = windyWebcamToSource(webcam());
  assert.equal(
    source.url,
    'https://images.windy.com/webcams2/123/12345678/current/full.jpg',
  );
});

test('windy loader is a no-op without the API key (BYOK semantics)', async () => {
  const previousKey = process.env.WINDY_API_KEY;
  try {
    delete process.env.WINDY_API_KEY;
    assert.deepEqual(await loadWindySourcesFromApi(), []);
  } finally {
    if (previousKey !== undefined) process.env.WINDY_API_KEY = previousKey;
  }
});

test('windy loader pages, dedupes, ranks by viewCount and caps', async () => {
  const previousKey = process.env.WINDY_API_KEY;
  const calls = [];
  const makePage = (offset, ids) => ({
    total: ids.length + offset,
    webcams: ids.map((id, index) => webcam({ webcamId: String(id), viewCount: 100 - index })),
  });
  const fetchMock = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.host, 'api.windy.com');
    assert.equal(parsed.searchParams.get('limit'), String(WINDY_PAGE_SIZE));
    assert.equal(init.headers['x-windy-api-key'], 'test-key');
    calls.push(parsed.searchParams.get('offset'));
    const offset = Number(parsed.searchParams.get('offset'));
    const page = makePage(offset, Array.from({ length: WINDY_PAGE_SIZE }, (_, i) => offset + i));
    page.webcams[0].viewCount = 5;
    page.webcams[1].viewCount = 999999;
    return new Response(JSON.stringify(page), { status: 200 });
  };
  const originalFetch = globalThis.fetch;
  const originalMax = process.env.CCTV_WINDY_MAX_SOURCES;
  try {
    process.env.WINDY_API_KEY = 'test-key';
    process.env.CCTV_WINDY_MAX_SOURCES = '40';
    globalThis.fetch = fetchMock;
    const sources = await loadWindySourcesFromApi();
    assert.equal(sources.length, 40, 'cap respected');
    assert.equal(sources[0].id, 'windy-1', 'highest viewCount ranked first');
    assert.equal(calls.length, 1, 'one full page covers the cap');
  } finally {
    if (previousKey !== undefined) process.env.WINDY_API_KEY = previousKey;
    if (originalMax !== undefined) process.env.CCTV_WINDY_MAX_SOURCES = originalMax;
    else delete process.env.CCTV_WINDY_MAX_SOURCES;
    globalThis.fetch = originalFetch;
  }
});

test('windy pack size respects the shared catalog cap', () => {
  const { packs } = allocateSourceCap(
    [
      { name: 'windy', sources: Array.from({ length: DEFAULT_WINDY_MAX_SOURCES }, (_, i) => ({ id: `windy-${i}` })) },
      { name: 'tallinn', sources: Array.from({ length: 255 }, (_, i) => ({ id: `tln-${i}` })) },
    ],
    6000,
  );
  const windy = packs.find((pack) => pack.name === 'windy');
  assert.ok(windy && windy.kept > 0, 'windy participates in the round-robin cap');
});
