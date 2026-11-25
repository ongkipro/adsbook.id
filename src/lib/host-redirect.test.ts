import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHostRedirect } from './host-redirect.ts';

const go = (href: string) => resolveHostRedirect(new URL(href));

test('http goes to https on the same host with path and query; https stays', () => {
  assert.equal(go('http://toko.adsbook.my.id/produk?utm_source=fb&fbclid=x'), 'https://toko.adsbook.my.id/produk?utm_source=fb&fbclid=x');
  assert.equal(go('http://www.merchant.com/'), 'https://www.merchant.com/');
  assert.equal(go('https://toko.adsbook.my.id/produk'), null);
});

test('api paths and local hosts are never moved', () => {
  assert.equal(go('http://toko.adsbook.my.id/api/webhooks/autolaris'), null);
  assert.equal(go('http://toko.adsbook.my.id/api/webhooks/mengantar/tok'), null);
  assert.equal(go('http://merchant.com/api/submit-order'), null);
  assert.equal(go('http://localhost:4321/'), null);
  assert.equal(go('http://toko.localhost:8787/'), null);
  assert.equal(go('http://127.0.0.1:8798/produk'), null);
  assert.equal(go('http://100.127.67.86:4321/produk/asoka-wallet'), null);
  assert.equal(go('http://[fd7a:115c:a1e0::1]:4321/produk'), null);
});
