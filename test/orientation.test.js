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

/** A minimal 26-byte TIFF IFD0 with a single Orientation (0x0112) entry. */
function buildTiffOrientationBytes(orientation, littleEndian = true) {
    const buffer = new ArrayBuffer(26);
    const view = new DataView(buffer);
    if (littleEndian) {
        view.setUint8(0, 0x49);
        view.setUint8(1, 0x49); // "II"
    } else {
        view.setUint8(0, 0x4d);
        view.setUint8(1, 0x4d); // "MM"
    }
    view.setUint16(2, 42, littleEndian);
    view.setUint32(4, 8, littleEndian); // IFD0 starts right after the 8-byte header
    view.setUint16(8, 1, littleEndian); // 1 entry
    view.setUint16(10, 0x0112, littleEndian); // tag: Orientation
    view.setUint16(12, 3, littleEndian); // type: SHORT
    view.setUint32(14, 1, littleEndian); // count: 1
    view.setUint16(18, orientation, littleEndian); // value
    view.setUint32(22, 0, littleEndian); // next IFD offset: none
    return new Uint8Array(buffer);
}

/** A JPEG with a real SOI + APP1/Exif segment carrying the given orientation. */
function buildJpegWithOrientation(orientation, littleEndian = true) {
    const tiff = buildTiffOrientationBytes(orientation, littleEndian);
    const exifBlockLength = 6 + tiff.length; // "Exif\0\0" + TIFF
    const app1Length = 2 + exifBlockLength; // length field counts itself
    const bytes = new Uint8Array(2 + 2 + 2 + exifBlockLength);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0xffd8, false); // SOI
    view.setUint16(2, 0xffe1, false); // APP1
    view.setUint16(4, app1Length, false);
    bytes.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 6); // "Exif\0\0"
    bytes.set(tiff, 12);
    return bytes;
}

/** A valid-but-empty JPEG (SOI immediately followed by EOI, no APP1 at all). */
function buildPlainJpeg() {
    return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
}

/** A PNG with a real `eXIf` chunk carrying the given orientation. */
function buildPngWithOrientation(orientation, littleEndian = true) {
    const tiff = buildTiffOrientationBytes(orientation, littleEndian);
    const bytes = new Uint8Array(8 + 4 + 4 + tiff.length + 4);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG signature
    new DataView(bytes.buffer).setUint32(8, tiff.length, false); // chunk length
    bytes.set([0x65, 0x58, 0x49, 0x66], 12); // "eXIf"
    bytes.set(tiff, 16);
    return bytes; // trailing CRC left as zero — the parser never checks it
}

/** A valid-but-empty PNG (just the signature, no chunks at all). */
function buildPlainPng() {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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

    // Orientation 6 (needs correction) so the re-encode pipeline actually runs.
    const original = new File([buildPngWithOrientation(6)], 'screenshot.png', { type: 'image/png' });
    const result = await normalizeOrientation(original);

    assert.equal(result.type, 'image/png');
    assert.equal(result.name, 'screenshot.png');
});

test('normalizeOrientation is a no-op when the file is already normalized', async (t) => {
    installFakeDocument('SHOULD-NOT-BE-USED-TWICE');
    globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
    t.after(uninstallFakeDom);

    // Orientation 6 (needs correction) so the first call actually re-encodes
    // and flags the result, instead of short-circuiting on "nothing to fix".
    const original = new File([buildJpegWithOrientation(6)], 'a.jpg', { type: 'image/jpeg' });
    const once = await normalizeOrientation(original);
    const twice = await normalizeOrientation(once);

    assert.notEqual(once, original, 'sanity check: the first call must have actually re-encoded');
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

    // Orientation 6 (needs correction) so the re-encode pipeline actually runs.
    const file = new File([buildJpegWithOrientation(6)], 'a.jpg', { type: 'image/jpeg' });
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

    // Orientation 6 (needs correction) so the re-encode pipeline actually runs.
    const original = new File([buildJpegWithOrientation(6)], 'photo.jpg', { type: 'image/jpeg' });
    const result = await normalizeOrientation(original);

    assert.notEqual(result, original);
    assert.equal(await arrayBufferToString(result), 'NORMALIZED-VIA-IMG-ELEMENT');
});

// --- skip-re-encoding when orientation is already normal -----------------

/**
 * Installs a fake document/createImageBitmap pair that would prove,
 * via `callCount`, whether the canvas re-encode pipeline actually ran.
 * Used by the tests below to assert the pipeline is *not* reached.
 */
function installTrackedFakeDom() {
    const calls = { createImageBitmap: 0, toBlob: 0 };
    globalThis.createImageBitmap = async () => {
        calls.createImageBitmap += 1;
        return { width: 1, height: 1, close() {} };
    };
    globalThis.document = {
        createElement(tag) {
            if (tag !== 'canvas') return {};
            return {
                width: 0,
                height: 0,
                getContext: () => ({ drawImage() {} }),
                toBlob(callback, type) {
                    calls.toBlob += 1;
                    callback(new Blob(['SHOULD-NOT-BE-PRODUCED'], { type: type || 'image/jpeg' }));
                },
            };
        },
    };
    return calls;
}

test('normalizeOrientation skips re-encoding a JPEG with no EXIF data at all (e.g. a desktop screenshot)', async (t) => {
    const calls = installTrackedFakeDom();
    t.after(uninstallFakeDom);

    const original = new File([buildPlainJpeg()], 'screenshot.jpg', { type: 'image/jpeg' });
    const result = await normalizeOrientation(original);

    assert.equal(result, original, 'must return the exact original File, unmodified');
    assert.equal(calls.createImageBitmap, 0, 'must never touch createImageBitmap');
    assert.equal(calls.toBlob, 0, 'must never re-encode through canvas');
});

test('normalizeOrientation skips re-encoding a JPEG whose EXIF orientation is already 1', async (t) => {
    const calls = installTrackedFakeDom();
    t.after(uninstallFakeDom);

    const original = new File([buildJpegWithOrientation(1)], 'photo.jpg', { type: 'image/jpeg' });
    const result = await normalizeOrientation(original);

    assert.equal(result, original);
    assert.equal(calls.createImageBitmap, 0);
    assert.equal(calls.toBlob, 0);
});

test('normalizeOrientation skips re-encoding a PNG with no eXIf chunk at all', async (t) => {
    const calls = installTrackedFakeDom();
    t.after(uninstallFakeDom);

    const original = new File([buildPlainPng()], 'screenshot.png', { type: 'image/png' });
    const result = await normalizeOrientation(original);

    assert.equal(result, original);
    assert.equal(calls.createImageBitmap, 0);
    assert.equal(calls.toBlob, 0);
});

test('normalizeOrientation skips re-encoding a PNG whose EXIF orientation is already 1', async (t) => {
    const calls = installTrackedFakeDom();
    t.after(uninstallFakeDom);

    const original = new File([buildPngWithOrientation(1)], 'photo.png', { type: 'image/png' });
    const result = await normalizeOrientation(original);

    assert.equal(result, original);
    assert.equal(calls.createImageBitmap, 0);
    assert.equal(calls.toBlob, 0);
});

test('normalizeOrientation still re-encodes a JPEG whose EXIF orientation needs correction', async (t) => {
    const calls = installTrackedFakeDom();
    t.after(uninstallFakeDom);

    const original = new File([buildJpegWithOrientation(6)], 'photo.jpg', { type: 'image/jpeg' });
    const result = await normalizeOrientation(original);

    assert.notEqual(result, original);
    assert.equal(calls.createImageBitmap, 1);
});

test('normalizeOrientation still re-encodes a PNG whose EXIF orientation needs correction', async (t) => {
    const calls = installTrackedFakeDom();
    t.after(uninstallFakeDom);

    const original = new File([buildPngWithOrientation(3)], 'photo.png', { type: 'image/png' });
    const result = await normalizeOrientation(original);

    assert.notEqual(result, original);
    assert.equal(calls.createImageBitmap, 1);
});

test('normalizeOrientation reads a big-endian ("MM") EXIF orientation just as well as little-endian', async (t) => {
    const calls = installTrackedFakeDom();
    t.after(uninstallFakeDom);

    const normal = new File([buildJpegWithOrientation(1, false)], 'a.jpg', { type: 'image/jpeg' });
    assert.equal(await normalizeOrientation(normal), normal, 'orientation 1 (MM) must still be skipped');

    const rotated = new File([buildJpegWithOrientation(6, false)], 'b.jpg', { type: 'image/jpeg' });
    const result = await normalizeOrientation(rotated);
    assert.notEqual(result, rotated, 'orientation 6 (MM) must still be re-encoded');
    assert.equal(calls.createImageBitmap, 1);
});

test('normalizeOrientation treats an unparsable/corrupted EXIF block as absent rather than throwing', async (t) => {
    const calls = installTrackedFakeDom();
    t.after(uninstallFakeDom);

    // A JPEG with a real APP1/Exif signature, but an IFD0 offset that points
    // past the end of the buffer — must be treated like "no orientation
    // found" (skip), not crash normalizeOrientation().
    const bytes = buildJpegWithOrientation(6);
    const corrupted = new Uint8Array(bytes);
    // The TIFF header starts right after "SOI(2) + APP1 marker(2) + length(2) + Exif\0\0(6)" = offset 12.
    // Its IFD0 offset field is 4 bytes at offset 12 + 4 = 16; point it way out of bounds.
    new DataView(corrupted.buffer).setUint32(16, 0xffffff, true);

    const original = new File([corrupted], 'broken.jpg', { type: 'image/jpeg' });
    const result = await normalizeOrientation(original);

    assert.equal(result, original, 'corrupted/unreadable EXIF must be treated as absent, not rejected or re-encoded');
    assert.equal(calls.createImageBitmap, 0);
});

test('normalizeOrientation still converts WebP/BMP to JPEG even when a (hypothetical) orientation would be normal', async (t) => {
    // WebP/BMP always need a format change to JPEG regardless of orientation,
    // so the EXIF-skip optimization must never apply to them.
    installFakeDocument('NORMALIZED-FORMAT-CHANGE');
    globalThis.createImageBitmap = async () => ({ width: 2, height: 2, close() {} });
    t.after(uninstallFakeDom);

    const webp = new File(['WEBP-BYTES'], 'photo.webp', { type: 'image/webp' });
    const result = await normalizeOrientation(webp);

    assert.notEqual(result, webp);
    assert.equal(result.type, 'image/jpeg');
});
