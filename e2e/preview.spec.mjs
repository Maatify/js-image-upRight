import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(DIR, 'fixtures', name);
const toBase64 = (name) => fs.readFileSync(fixture(name)).toString('base64');

test.describe('attachImagePreview() + syncInputFiles() against a real <input type="file">', () => {
    test('selecting a rotated file updates the preview and syncs input.files with the normalized file', async ({ page }) => {
        await page.goto('/e2e/pages/harness.html');
        await page.evaluate(() => {
            window.__detach = window.__attachPreview();
        });

        // Playwright's setInputFiles() assigns real files to a real <input>
        // and dispatches a real `change` event — the thing the unit test
        // suite's fakes can't exercise at all.
        await page.setInputFiles('#fileInput', fixture('orientation-6.jpg'));
        await page.waitForFunction(() => window.__previewEvents.length > 0);

        const events = await page.evaluate(() => window.__previewEvents);
        expect(events).toHaveLength(1);
        expect(events[0].type).toBe('image/jpeg');

        // The preview <img> must show the actual (normalized) file as an
        // object URL — not the raw, still-rotated original.
        const previewSrc = await page.locator('#previewImg').evaluate((img) => img.src);
        expect(previewSrc).toMatch(/^blob:/);

        // Where the engine allows replacing input.files (every engine
        // Playwright drives does), the <input> itself must now hold the
        // normalized file too, so a plain form submit sends the corrected one.
        if (events[0].filesSynced) {
            const inputFile = await page.evaluate(() => {
                const file = document.getElementById('fileInput').files[0];
                return { name: file.name, type: file.type };
            });
            expect(inputFile).toEqual({ name: events[0].name, type: 'image/jpeg' });
        }

        await page.evaluate(() => window.__detach());
    });

    test('a validate() rejection never touches the preview', async ({ page }) => {
        await page.goto('/e2e/pages/harness.html');
        await page.evaluate(() => {
            window.__detach = window.__attachPreview({ validate: () => false });
        });

        await page.setInputFiles('#fileInput', fixture('orientation-1.jpg'));
        await page.waitForFunction(() => window.__invalidEvents.length > 0);

        const [previewSrc, events, invalidEvents] = await Promise.all([
            page.locator('#previewImg').evaluate((img) => img.src),
            page.evaluate(() => window.__previewEvents),
            page.evaluate(() => window.__invalidEvents),
        ]);

        expect(invalidEvents).toEqual(['orientation-1.jpg']);
        expect(events).toHaveLength(0);
        expect(previewSrc).toBe('');

        await page.evaluate(() => window.__detach());
    });

    test('selecting a second file while the first is still normalizing only shows the latest one', async ({ page }) => {
        await page.goto('/e2e/pages/harness.html');
        await page.evaluate(() => {
            window.__detach = window.__attachPreview();
        });

        // Dispatch both `change` events back to back in the same tick (see
        // __selectFilesSequentially's doc comment for why two awaited
        // page.setInputFiles() calls can't reliably reproduce this race —
        // their round-trip latency lets the first selection's normalization
        // finish before the second one ever starts).
        await page.evaluate((files) => window.__selectFilesSequentially(files), [
            { base64: toBase64('orientation-6.jpg'), name: 'orientation-6.jpg', type: 'image/jpeg' },
            { base64: toBase64('orientation-8.jpg'), name: 'orientation-8.jpg', type: 'image/jpeg' },
        ]);

        await page.waitForFunction(() => window.__previewEvents.length > 0);
        // Give a still-in-flight first normalization a chance to (wrongly)
        // land, if the race-safety in attachImagePreview() were broken.
        await page.waitForTimeout(200);

        const events = await page.evaluate(() => window.__previewEvents);
        expect(events).toHaveLength(1);
        expect(events[0].name).toBe('orientation-8.jpg');

        await page.evaluate(() => window.__detach());
    });
});
