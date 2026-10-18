# E2E tests

Real-browser tests (Playwright) for the things the Node unit test suite
(`npm test`, in `../test/`) can't actually exercise, because it fakes
`createImageBitmap`/canvas entirely: real EXIF orientation decoding (values
1-8), real HEIC decoding, and real `<input type="file">` + `DataTransfer`
behavior.

## Running

```bash
npx playwright install chromium firefox webkit   # once, downloads the browsers
npm run test:e2e
```

This starts a tiny static file server (`server.mjs`) serving the repo root
so the harness page can `import` the library's real ES modules, then runs
every `*.spec.mjs` file here against Chromium, Firefox, and WebKit.

## Layout

- `fixtures/orientation-1.jpg` .. `orientation-8.jpg` — a 240x160 image with
  four solid-color quadrants (red/green/blue/yellow, top-left/top-right/
  bottom-left/bottom-right), one file per EXIF `Orientation` tag value,
  **committed as plain binary files** — generating them needs `sips`
  (macOS-only), so tests never regenerate them at run time. Regenerate with
  `node fixtures/generate.mjs` on a Mac if the canonical image ever needs to
  change.
- `fixtures/sample.heic` — the same image, HEIC-encoded.
- `fixtures/expected-colors.json` — the canonical quadrant colors/dimensions,
  read by `orientation.spec.mjs` so the expected values live in one place.
- `fixtures/exif-writer.mjs` — write-only EXIF helper used only by
  `generate.mjs` to inject a minimal, real APP1/Exif Orientation segment into
  a `sips`-produced JPEG. Not used by the library or by `src/`.
- `pages/harness.html` — a minimal page that imports `src/index.js` as a
  real ES module and exposes a few helpers on `window` (building a `File`
  from base64 bytes handed over from Node, decoding a file's corner pixel
  colors via canvas, firing two `change` events back-to-back for the race
  test) for the specs to call through `page.evaluate()`.
- `orientation.spec.mjs` — runs each `orientation-N.jpg` (and the HEIC
  fixture) through `normalizeOrientation()` and asserts the decoded output
  is actually upright and the correct 240x160, by sampling each corner's
  color. The HEIC case tolerates either outcome per engine (converted to a
  correct JPEG, or returned unchanged) since HEIC decode support genuinely
  differs across engines — see `viaImageElement()`'s doc comment in
  `../src/orientation.js`.
- `preview.spec.mjs` — drives a real `<input type="file">` through
  `attachImagePreview()` + `syncInputFiles()`: a normal selection, a
  `validate()` rejection, and two selections racing (fired in the same tick,
  not via two awaited `setInputFiles()` calls — see that test's comment for
  why the latter can't actually reproduce the race).

## How the orientation fixtures were built

Each `orientation-N.jpg`'s *stored* pixel data is the canonical image
transformed by the geometric inverse of what tag `N` means a correct
decoder must do to it — so decoding any of the 8 correctly must reproduce
the exact same upright canonical image. The transform-to-`sips`-operations
mapping used by `generate.mjs` was verified empirically (actual pixel
sampling, not just worked out on paper) against `sips`' real output before
being used to produce the committed fixtures, and the resulting files are
in turn verified for real by `orientation.spec.mjs` passing in real
Chromium/Firefox/WebKit:

| Tag | Correct decoder must apply | Stored (`sips`) pixel data is |
|---|---|---|
| 1 | nothing | the canonical image |
| 2 | flip horizontal | flip horizontal of canonical (self-inverse) |
| 3 | rotate 180° | rotate 180° of canonical (self-inverse) |
| 4 | flip vertical | flip vertical of canonical (self-inverse) |
| 5 | transpose (reflect over main diagonal) | transpose of canonical (self-inverse) |
| 6 | rotate 90° CW | rotate 270° CW of canonical |
| 7 | transverse (reflect over anti-diagonal) | transverse of canonical (self-inverse) |
| 8 | rotate 90° CCW (= 270° CW) | rotate 90° CW of canonical |
