import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadImageWithRetry, cancelImageRetry } from '../src/retry.js';

function makeFakeImg() {
    return { src: '', onerror: null, removeAttribute() { this.src = ''; } };
}

test('retries the same src up to 3 times with growing delays, then gives up', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const img = makeFakeImg();
    let gaveUp = false;

    loadImageWithRetry(img, 'https://cdn.example.com/a.jpg', { onGiveUp: () => { gaveUp = true; } });
    assert.equal(img.src, 'https://cdn.example.com/a.jpg');

    for (const delay of [700, 1500, 3000]) {
        img.onerror();
        img.src = 'about:blank#broken';
        t.mock.timers.tick(delay - 1);
        assert.equal(img.src, 'about:blank#broken', 'must wait out the full delay before reloading');
        t.mock.timers.tick(1);
        assert.equal(img.src, 'https://cdn.example.com/a.jpg', 'reloads the exact same URL, no cache-busting param');
    }

    img.onerror();
    assert.equal(gaveUp, true, 'onGiveUp fires once every retry is exhausted');
    assert.equal(img.onerror, null, 'the handler detaches itself once it gives up');
});

test('cancelImageRetry stops a pending retry and clears the handler', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const img = makeFakeImg();

    loadImageWithRetry(img, 'https://cdn.example.com/a.jpg');
    img.onerror();
    img.src = 'about:blank#broken';

    cancelImageRetry(img);
    t.mock.timers.tick(10000);

    assert.equal(img.src, 'about:blank#broken', 'a cancelled retry must never reassign the src');
    assert.equal(img.onerror, null);
});

test('cancelImageRetry is a no-op when nothing is pending', () => {
    const img = makeFakeImg();
    assert.doesNotThrow(() => cancelImageRetry(img));
    assert.doesNotThrow(() => cancelImageRetry(null));
});

test('starting a new retry on the same element invalidates a still-pending one', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const img = makeFakeImg();

    loadImageWithRetry(img, 'https://cdn.example.com/item-A.jpg');
    img.onerror();
    img.src = 'about:blank#broken';

    // The element is reused for a different item before item A's retry fires
    // (e.g. a modal reopened for another row) — its stale retry must not be
    // able to reassign item A's URL over item B's.
    loadImageWithRetry(img, 'https://cdn.example.com/item-B.jpg');
    assert.equal(img.src, 'https://cdn.example.com/item-B.jpg');

    t.mock.timers.tick(10000);

    assert.equal(img.src, 'https://cdn.example.com/item-B.jpg', 'item B must remain the active source');
});
