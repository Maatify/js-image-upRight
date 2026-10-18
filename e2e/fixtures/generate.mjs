#!/usr/bin/env node
/**
 * Regenerates the E2E fixture images committed under e2e/fixtures/.
 *
 * macOS-only (uses the `sips` CLI, which ships with macOS) — this is a
 * one-off authoring tool, not something CI or `npm test` ever runs. The
 * *output* fixture files are what the Playwright suite actually uses, and
 * those are plain committed binary files with no build-time dependency on
 * this script or on macOS.
 *
 * Produces:
 *   - orientation-1.jpg .. orientation-8.jpg — a 240x160 (or 160x240, for
 *     the 90/270-rotated ones) JPEG with four solid-color quadrants, real
 *     sips-compressed pixel data, and a real EXIF APP1 Orientation tag for
 *     each of the 8 standard values. The "sensor" pixel data for each tag
 *     is the geometric inverse of what that tag's correction transform
 *     is — see the ORIENTATIONS table below — so a correct EXIF-aware
 *     decode of any of the 8 files must reproduce the exact same upright
 *     image (red/green/blue/yellow top-left/top-right/bottom-left/
 *     bottom-right, always 240x160).
 *   - sample.heic — the same upright image, encoded as HEIC.
 *   - expected-colors.json — the canonical quadrant colors + dimensions,
 *     for the Playwright spec to assert against without duplicating them.
 *
 * Usage: node e2e/fixtures/generate.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectJpegOrientation } from './exif-writer.mjs';

const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));
const WIDTH = 240;
const HEIGHT = 160;
const COLORS = {
    topLeft: [255, 0, 0],
    topRight: [0, 255, 0],
    bottomLeft: [0, 0, 255],
    bottomRight: [255, 255, 0],
};

/**
 * Standard EXIF Orientation semantics: `correction` is the transform a
 * correct decoder must apply to the *stored* pixels to display the image
 * upright. `sensorOps` is the sequence of `sips` operations that produces
 * sensor pixel data from the canonical (already-upright) image such that
 * applying `correction` to it reproduces the canonical image again — i.e.
 * `sensorOps` bakes in the geometric inverse of `correction`.
 *
 * Verified empirically against `sips`' actual output (not just worked out
 * on paper) while authoring this script — see the PR description.
 */
const ORIENTATIONS = {
    1: { sensorOps: [] },
    2: { sensorOps: [['--flip', 'horizontal']] }, // correction: flip horizontal (self-inverse)
    3: { sensorOps: [['--rotate', '180']] }, // correction: rotate 180 (self-inverse)
    4: { sensorOps: [['--flip', 'vertical']] }, // correction: flip vertical (self-inverse)
    5: { sensorOps: [['--rotate', '90'], ['--flip', 'horizontal']] }, // correction: transpose (self-inverse)
    6: { sensorOps: [['--rotate', '270']] }, // correction: rotate 90 CW (inverse: rotate 270 CW)
    7: { sensorOps: [['--rotate', '270'], ['--flip', 'horizontal']] }, // correction: transverse (self-inverse)
    8: { sensorOps: [['--rotate', '90']] }, // correction: rotate 90 CCW (inverse: rotate 90 CW)
};

function sips(args) {
    execFileSync('sips', args, { stdio: ['ignore', 'ignore', 'inherit'] });
}

function buildCanonicalBmp(scratchDir) {
    const rowSize = Math.ceil((WIDTH * 3) / 4) * 4;
    const pixelArraySize = rowSize * HEIGHT;
    const buf = Buffer.alloc(54 + pixelArraySize);

    buf.write('BM', 0, 'ascii');
    buf.writeUInt32LE(buf.length, 2);
    buf.writeUInt32LE(54, 10); // pixel data offset
    buf.writeUInt32LE(40, 14); // DIB header size
    buf.writeInt32LE(WIDTH, 18);
    buf.writeInt32LE(HEIGHT, 22); // positive = bottom-up row order
    buf.writeUInt16LE(1, 26); // planes
    buf.writeUInt16LE(24, 28); // bits per pixel
    buf.writeUInt32LE(pixelArraySize, 34);

    for (let y = 0; y < HEIGHT; y++) {
        const isTop = y < HEIGHT / 2;
        const bmpRow = HEIGHT - 1 - y; // BMP stores rows bottom-up
        const rowOffset = 54 + bmpRow * rowSize;
        for (let x = 0; x < WIDTH; x++) {
            const isLeft = x < WIDTH / 2;
            const [r, g, b] = isTop
                ? (isLeft ? COLORS.topLeft : COLORS.topRight)
                : (isLeft ? COLORS.bottomLeft : COLORS.bottomRight);
            const off = rowOffset + x * 3;
            buf[off] = b;
            buf[off + 1] = g;
            buf[off + 2] = r;
        }
    }

    const bmpPath = path.join(scratchDir, 'canonical.bmp');
    fs.writeFileSync(bmpPath, buf);
    return bmpPath;
}

function main() {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upright-fixtures-'));
    try {
        const bmpPath = buildCanonicalBmp(scratchDir);
        const canonicalJpgPath = path.join(scratchDir, 'canonical.jpg');
        sips(['-s', 'format', 'jpeg', '-s', 'formatOptions', '95', bmpPath, '--out', canonicalJpgPath]);

        for (const [value, { sensorOps }] of Object.entries(ORIENTATIONS)) {
            let currentPath = canonicalJpgPath;
            sensorOps.forEach((op, i) => {
                const nextPath = path.join(scratchDir, `sensor-${value}-step${i}.jpg`);
                sips([...op, currentPath, '--out', nextPath]);
                currentPath = nextPath;
            });

            const sensorBytes = fs.readFileSync(currentPath);
            const tagged = injectJpegOrientation(sensorBytes, Number(value));
            const outPath = path.join(FIXTURES_DIR, `orientation-${value}.jpg`);
            fs.writeFileSync(outPath, tagged);
            console.log('wrote', path.relative(process.cwd(), outPath));
        }

        const heicPath = path.join(FIXTURES_DIR, 'sample.heic');
        sips(['-s', 'format', 'heic', canonicalJpgPath, '--out', heicPath]);
        console.log('wrote', path.relative(process.cwd(), heicPath));

        const expectedColorsPath = path.join(FIXTURES_DIR, 'expected-colors.json');
        fs.writeFileSync(expectedColorsPath, JSON.stringify({ width: WIDTH, height: HEIGHT, colors: COLORS }, null, 2) + '\n');
        console.log('wrote', path.relative(process.cwd(), expectedColorsPath));
    } finally {
        fs.rmSync(scratchDir, { recursive: true, force: true });
    }
}

main();
