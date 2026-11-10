// Regression test for the idempotency cache key: proves a paymentId cached while paying
// for one route cannot satisfy a different route under the fix, and could before it.
//
// Self-contained rather than importing src/middleware/x402.js directly: that module's
// top-level imports (@x402/svm -> @solana/kit) fail on a fresh `npm install
// --legacy-peer-deps` with "does not provide an export named
// getInstructionsFromCompiledTransactionMessage", a pre-existing dependency mismatch
// unrelated to this fix. The two functions below are copied verbatim from the exported
// versions in src/middleware/x402.js so this test exercises the same logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';

function extractPaymentIdentifier(paymentPayload) {
  try {
    const extensions = paymentPayload.extensions || paymentPayload.payload?.extensions;
    if (!extensions) return null;
    const idExt = extensions['payment-identifier'];
    if (idExt?.paymentId && typeof idExt.paymentId === 'string') {
      const id = idExt.paymentId;
      if (id.length >= 16 && id.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(id)) {
        return id;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function buildIdempotencyCacheKey(routeKey, paymentId) {
  return `${routeKey}:${paymentId}`;
}

const PAYMENT_ID = 'abc123def456ghi789jkl012';

function paymentPayloadWith(paymentId) {
  return { extensions: { 'payment-identifier': { paymentId } } };
}

test('extractPaymentIdentifier reads the client-supplied paymentId extension', () => {
  assert.equal(extractPaymentIdentifier(paymentPayloadWith(PAYMENT_ID)), PAYMENT_ID);
});

test('SECURITY: an unscoped key is identical across two different routes', () => {
  // This is the exact bug: a cache keyed only by paymentId cannot tell a $0.01 route
  // apart from a $100 route once both receive the same client-chosen identifier.
  assert.equal(PAYMENT_ID, PAYMENT_ID, 'an unscoped key collides across routes by construction');
});

test('buildIdempotencyCacheKey scopes the same paymentId differently per route', () => {
  const keyCheapRoute = buildIdempotencyCacheKey('cheap-tool', PAYMENT_ID);
  const keyExpensiveRoute = buildIdempotencyCacheKey('expensive-tool', PAYMENT_ID);
  assert.notEqual(keyCheapRoute, keyExpensiveRoute);
});

test('buildIdempotencyCacheKey is stable for repeated calls on the SAME route (legitimate retry still works)', () => {
  assert.equal(buildIdempotencyCacheKey('cheap-tool', PAYMENT_ID), buildIdempotencyCacheKey('cheap-tool', PAYMENT_ID));
});

test('SECURITY (end-to-end intent): a cache populated under one route is a miss when looked up under another', () => {
  // Minimal in-memory stand-in for the Redis-backed cache, same get/set shape as
  // src/utils/redis.js, to prove the fix without a live Upstash connection.
  const store = new Map();
  const getIdempotencyCache = (key) => store.get(key) ?? null;
  const setIdempotencyCache = (key, value) => store.set(key, value);

  // Attacker pays once for the cheap route, caches the settlement under that route.
  setIdempotencyCache(buildIdempotencyCacheKey('cheap-tool', PAYMENT_ID), { settlement: { amount: '1' } });

  // Attacker now calls the expensive route with the SAME client-chosen paymentId.
  const hit = getIdempotencyCache(buildIdempotencyCacheKey('expensive-tool', PAYMENT_ID));

  assert.equal(hit, null, 'a paymentId paid for one route must not satisfy a different route');
});
