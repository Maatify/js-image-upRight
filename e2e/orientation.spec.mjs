import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(DIR, 'fixtures');
const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'expected-colors.json'), 'utf8'));

function toBase64(fixtureName) {
    return fs.readFileSync(path.join(FIXTURES_DIR, fixtureName)).toString('base64');
}

/** JPEG re-compression shifts color values slightly; a generous tolerance
 *  still clearly distinguishes red/green/blue/yellow from one another. */
function assertColorClose(actual, expectedColor, tolerance = 40) {
    for (let channel = 0; channel < 3; channel++) {
        expect(Math.abs(actual[channel] - expectedColor[channel])).toBeLessThanOrEqual(tolerance);
    }
}

function assertCorners(corners) {
    expect(corners.width).toBe(expected.width);
    expect(corners.height).toBe(expected.height);
    assertColorClose(corners.topLeft, expected.colors.topLeft);
    assertColorClose(corners.topRight, expected.colors.topRight);
    assertColorClose(corners.bottomLeft, expected.colors.bottomLeft);
    assertColorClose(corners.bottomRight, expected.colors.bottomRight);
}

test.describe('normalizeOrientation() against real EXIF-rotated JPEGs', () => {
    for (let orientation = 1; orientation <= 8; orientation++) {
        test(`orientation ${orientation} decodes upright after normalizeOrientation()`, async ({ page }) => {
            await page.goto('/e2e/pages/harness.html');

            const corners = await page.evaluate(async ({ base64, name, type }) => {
                const file = window.__fileFromBase64(base64, name, type);
                const normalized = await window.__upright.normalizeOrientation(file);
                return window.__decodeCorners(normalized);
            }, { base64: toBase64(`orientation-${orientation}.jpg`), name: `orientation-${orientation}.jpg`, type: 'image/jpeg' });

            assertCorners(corners);
        });
    }

    test('an orientation 1 fixture (explicit tag, nothing to correct) is still re-encoded correctly', async ({ page }) => {
        // Covered by the loop above too (orientation 1), kept as its own
        // named case since it exercises a different code path internally
        // (normalizeOrientation()'s own EXIF-skip optimization) than 2-8.
        await page.goto('/e2e/pages/harness.html');
        const result = await page.evaluate(async ({ base64, name, type }) => {
            const file = window.__fileFromBase64(base64, name, type);
            const normalized = await window.__upright.normalizeOrientation(file);
            return { sameFile: normalized === file, corners: await window.__decodeCorners(normalized) };
        }, { base64: toBase64('orientation-1.jpg'), name: 'orientation-1.jpg', type: 'image/jpeg' });

        expect(result.sameFile).toBe(true); // nothing to correct — skip re-encoding entirely
        assertCorners(result.corners);
    });
});

test.describe('normalizeOrientation() against a real HEIC fixture', () => {
    test('HEIC is decoded and converted where the browser supports it, left untouched otherwise', async ({ page, browserName }) => {
        await page.goto('/e2e/pages/harness.html');

        const result = await page.evaluate(async ({ base64, name, type }) => {
            const file = window.__fileFromBase64(base64, name, type);
            const normalized = await window.__upright.normalizeOrientation(file);
            const converted = normalized.type === 'image/jpeg';
            return {
                converted,
                type: normalized.type,
                name: normalized.name,
                corners: converted ? await window.__decodeCorners(normalized) : null,
            };
        }, { base64: toBase64('sample.heic'), name: 'sample.heic', type: 'image/heic' });

        test.info().annotations.push({ type: 'heic-support', description: `${browserName}: ${result.converted}` });

        if (result.converted) {
            expect(result.name).toBe('sample.jpg');
            assertCorners(result.corners);
        } else {
            // This engine can't decode HEIC at all — normalizeOrientation()
            // must hand back the original file untouched, not fail or
            // silently corrupt it. See viaImageElement()'s doc comment in
            // src/orientation.js for why this varies by engine.
            expect(result.type).toBe('image/heic');
            expect(result.name).toBe('sample.heic');
        }
    });
});
