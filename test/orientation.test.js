import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrientation } from '../src/orientation.js';

function makeFakeCanvas(blobContent) {
    return {
        width: 0,
        height: 0,
        getContext() {
            return { drawImage() {} };
        },
        toBlob(callback, type) {
            callback(new Blob([blobContent], { type: type || 'image/jpeg' }));
        },
    };
}

function installFakeDocument(blobContent) {
    globalThis.document = {
        createElement(tag) {
            if (tag === 'canvas') return makeFakeCanvas(blobContent);
            return {};
        },
    };
}

function uninstallFakeDom() {
    delete globalThis.document;
    delete globalThis.createImageBitmap;
    delete globalThis.Image;
    if (globalThis.URL) {
        delete globalThis.URL.createObjectURL;
        delete globalThis.URL.revokeObjectURL;
    }
}

async function arrayBufferToString(blobLike) {
    return Buffer.from(await blobLike.arrayBuffer()).toString('utf8');
}

test('normalizeOrientation converts a HEIC photo to a normalized JPEG via createImageBitmap', async (t) => {
    installFakeDocument('NORMALIZED-VIA-BITMAP');
    globalThis.createImageBitmap = async () => ({ width: 10, height: 20, close() {} });
    t.after(uninstallFakeDom);

    const original = new File(['HEIC-BYTES'], 'IMG_0001.HEIC', { type: 'image/heic' });
    const result = await normalizeOrientation(original);

    assert.notEqual(result, original, 'must return a new File, not the original HEIC one');
    assert.equal(result.type, 'image/jpeg');
    assert.equal(result.name, 'IMG_0001.jpg');
    assert.equal(result.__orientationNormalized, true);
    assert.equal(await arrayBufferToString(result), 'NORMALIZED-VIA-BITMAP');
});

test('normalizeOrientation keeps PNG as PNG', async (t) => {
    installFakeDocument('NORMALIZED-PNG');
    globalThis.createImageBitmap = async () => ({ width: 5, height: 5, close() {} });
    t.after(uninstallFakeDom);

    const original = new File(['PNG-BYTES'], 'screenshot.png', { type: 'image/png' });
    const result = await normalizeOrientation(original);

    assert.equal(result.type, 'image/png');
    assert.equal(result.name, 'screenshot.png');
});

test('normalizeOrientation is a no-op when the file is already normalized', async (t) => {
    installFakeDocument('SHOULD-NOT-BE-USED-TWICE');
    globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
    t.after(uninstallFakeDom);

    const original = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    const once = await normalizeOrientation(original);
    const twice = await normalizeOrientation(once);

    assert.equal(twice, once, 'a second call must return the exact same File, not re-encode it');
});

test('normalizeOrientation leaves SVG and GIF untouched (no pixel orientation / would break animation)', async () => {
    const svg = new File(['<svg/>'], 'icon.svg', { type: 'image/svg+xml' });
    const gif = new File(['GIF89a'], 'anim.gif', { type: 'image/gif' });

    assert.equal(await normalizeOrientation(svg), svg);
    assert.equal(await normalizeOrientation(gif), gif);
});

test('normalizeOrientation returns the original file when no browser APIs are available', async () => {
    const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    const result = await normalizeOrientation(file);
    assert.equal(result, file);
});

test('a WebP source re-encoded to JPEG is renamed .jpg, not left as .webp', async (t) => {
    installFakeDocument('NORMALIZED-FROM-WEBP');
    globalThis.createImageBitmap = async () => ({ width: 4, height: 4, close() {} });
    t.after(uninstallFakeDom);

    const original = new File(['WEBP-BYTES'], 'photo.webp', { type: 'image/webp' });
    const result = await normalizeOrientation(original);

    assert.equal(result.type, 'image/jpeg', 'the actual re-encoded bytes are JPEG');
    assert.equal(result.name, 'photo.jpg', 'the extension must match the real content, not the source format');
});

test('a BMP source with no extension at all still gets a usable .jpg name', async (t) => {
    installFakeDocument('NORMALIZED-NO-EXT');
    globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });
    t.after(uninstallFakeDom);

    const original = new File(['BMP-BYTES'], 'photo', { type: 'image/bmp' });
    const result = await normalizeOrientation(original);

    assert.equal(result.name, 'photo.jpg');
});

test('a HEIC file with an empty file.type (seen on some Android browsers) is still normalized via its extension', async (t) => {
    installFakeDocument('NORMALIZED-FROM-TYPELESS-HEIC');
    globalThis.createImageBitmap = async () => ({ width: 6, height: 6, close() {} });
    t.after(uninstallFakeDom);

    // No `type` at all — the real-world failure mode this guards against.
    const original = new File(['HEIC-BYTES'], 'IMG_0002.heic', { type: '' });
    const result = await normalizeOrientation(original);

    assert.notEqual(result, original, 'must not be silently skipped just because file.type is empty');
    assert.equal(result.type, 'image/jpeg');
    assert.equal(result.name, 'IMG_0002.jpg');
});

test('an out-of-range quality option falls back to the default instead of being passed through as-is', async (t) => {
    installFakeDocument('IGNORED');
    let seenQuality = null;
    globalThis.document.createElement = (tag) => {
        if (tag !== 'canvas') return {};
        return {
            width: 0,
            height: 0,
            getContext: () => ({ drawImage() {} }),
            toBlob(callback, type, quality) {
                seenQuality = quality;
                callback(new Blob(['x'], { type }));
            },
        };
    };
    globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
    t.after(uninstallFakeDom);

    const file = new File(['x'], 'a.jpg', { type: 'image/jpeg' });
    await normalizeOrientation(file, { quality: 5 });
    assert.equal(seenQuality, 0.95);

    await normalizeOrientation(file, { quality: -1 });
    assert.equal(seenQuality, 0.95);

    await normalizeOrientation(file, { quality: 0.5 });
    assert.equal(seenQuality, 0.5, 'a valid quality must still be honored');
});

test('normalizeOrientation falls back to the <img> + canvas path when createImageBitmap is unavailable', async (t) => {
    installFakeDocument('NORMALIZED-VIA-IMG-ELEMENT');
    t.after(uninstallFakeDom);

    class FakeImage {
        set src(value) {
            this._src = value;
            queueMicrotask(() => {
                this.naturalWidth = 3;
                this.naturalHeight = 4;
                if (typeof this.onload === 'function') this.onload();
            });
        }
        get src() {
            return this._src;
        }
    }
    globalThis.Image = FakeImage;
    globalThis.URL.createObjectURL = () => 'blob:fake-url';
    globalThis.URL.revokeObjectURL = () => {};

    const original = new File(['JPEG-BYTES'], 'photo.jpg', { type: 'image/jpeg' });
    const result = await normalizeOrientation(original);

    assert.notEqual(result, original);
    assert.equal(await arrayBufferToString(result), 'NORMALIZED-VIA-IMG-ELEMENT');
});
