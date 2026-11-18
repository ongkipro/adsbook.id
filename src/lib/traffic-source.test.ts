import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrafficSource } from './traffic-source.ts';

test('parseTrafficSource identifies Meta Ads from fbclid, _fbc, or _fbp', () => {
  const sourceFbclid = parseTrafficSource(JSON.stringify({ fbclid: 'IwAR123456789' }));
  assert.equal(sourceFbclid.type, 'meta');
  assert.equal(sourceFbclid.label, 'Meta Ads');
  assert.ok(sourceFbclid.badgeClass.includes('blue'));
  assert.equal(parseTrafficSource(JSON.stringify({ _fbp: 'fb.1.1700000000.123' })).type, 'meta');

  const sourceInstagram = parseTrafficSource(JSON.stringify({ utm_source: 'instagram', fbclid: 'xyz' }));
  assert.equal(sourceInstagram.type, 'meta');
  assert.equal(sourceInstagram.label, 'Instagram Ads');
});

test('parseTrafficSource identifies Google Ads from gclid, gbraid, or wbraid', () => {
  const sourceGclid = parseTrafficSource(JSON.stringify({ gclid: 'Cj0KCQ_abc123' }));
  assert.equal(sourceGclid.type, 'google');
  assert.equal(sourceGclid.label, 'Google Ads');
  assert.ok(sourceGclid.badgeClass.includes('emerald'));

  const sourceGbraid = parseTrafficSource(JSON.stringify({ gbraid: '0AAAAA_xyz' }));
  assert.equal(sourceGbraid.type, 'google');
  assert.equal(sourceGbraid.label, 'Google Ads');
});

test('a ttclid reads as TikTok Ads again (tracking chapter 11 restored TikTok), with or without a UTM', () => {
  const source = parseTrafficSource(JSON.stringify({ ttclid: 'E_123456' }));
  assert.equal(source.type, 'tiktok');
  assert.equal(source.label, 'TikTok Ads');
  assert.equal(parseTrafficSource(JSON.stringify({ utm_source: 'tiktok' })).type, 'tiktok');
});

test('an explicit click id beats the passive _fbp cookie a Meta pixel mints on every visit', () => {
  const fbp = 'fb.1.1730000000000.123';
  assert.equal(parseTrafficSource(JSON.stringify({ ttclid: 'E.C.P.123', _fbp: fbp })).type, 'tiktok');
  assert.equal(parseTrafficSource(JSON.stringify({ gclid: 'Cj0abc', _fbp: fbp })).type, 'google');
  assert.equal(parseTrafficSource(JSON.stringify({ utm_source: 'google', _fbp: fbp })).type, 'google');
  assert.equal(parseTrafficSource(JSON.stringify({ _fbp: fbp })).type, 'meta', '_fbp alone still reads as Meta');
  assert.equal(parseTrafficSource(JSON.stringify({ fbclid: 'IwAR1', ttclid: 'E1' })).type, 'meta', 'two explicit clicks keep Meta first');
});

test('parseTrafficSource identifies Organic / Direct when adClickIds is empty or absent', () => {
  assert.equal(parseTrafficSource(null).type, 'organic');
  assert.equal(parseTrafficSource('').type, 'organic');
  assert.equal(parseTrafficSource('{}').type, 'organic');
  assert.equal(parseTrafficSource(null).label, 'Organic / Direct');
});
