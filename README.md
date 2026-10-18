[pkg]: <https://www.npmjs.com/package/maatify-image-upright>
[pkg-stats]: <https://www.npmjs.com/package/maatify-image-upright>

# **maatify-image-upright**

![**Maatify.dev**](https://www.maatify.dev/assets/img/img/maatify_logo_white.svg)
---
[![npm version](https://img.shields.io/npm/v/maatify-image-upright)][pkg]
[![node](https://img.shields.io/node/v/maatify-image-upright)][pkg]
[![Monthly Downloads](https://img.shields.io/npm/dm/maatify-image-upright)][pkg-stats]
[![Total Downloads](https://img.shields.io/npm/dt/maatify-image-upright)][pkg-stats]
[![Stars](https://img.shields.io/github/stars/Maatify/js-image-upRight)](https://github.com/Maatify/js-image-upRight/stargazers)

---

A small, dependency-free client-side toolkit for handling image uploads correctly:

- **EXIF orientation correction** — iPhones (and most cameras) save a photo in its raw sensor orientation and record the correct display orientation in an EXIF tag instead of rotating the pixels. Most server-side pipelines ignore that tag, so the photo ends up stored sideways. `normalizeOrientation()` bakes the correct orientation into the pixels before the file ever leaves the browser.
- **HEIC/HEIF → JPEG conversion** — the default format for iPhone photos, which most browsers can't even display. Converted in the same pass as the orientation fix, on every browser that can decode HEIC at all (this is best-effort, not a guarantee — see [`normalizeOrientation`](#api)).
- **A preview that matches the upload** — `attachImagePreview()` shows the user the *actual* file that will be uploaded (normalized, converted), not the raw one, and keeps the `<input>`'s `FileList` in sync so there's no mismatch between what's shown and what's sent.
- **Resilient image loading** — `loadImageWithRetry()` retries a signed/presigned URL a few times with a growing delay, for the common case where an object briefly 404s right after upload before becoming readable from every storage node.
- **Upload with progress** — `uploadWithProgress()` wraps `XMLHttpRequest` to give you upload progress and the ability to abort, which `fetch()` still doesn't support natively.

No dependencies, no build step. Plain ES modules, runs directly in any modern browser.

## Install

```bash
npm install maatify-image-upright
```

## Usage

### Wire a file input to a live, corrected preview

```js
import { attachImagePreview } from 'maatify-image-upright';

const input = document.querySelector('input[type="file"]');
const preview = document.querySelector('img#preview');

const detach = attachImagePreview(input, preview, {
  validate: (file) => file.size <= 10 * 1024 * 1024,
  onInvalid: (file) => alert('File too large: ' + file.name),
  onChange: (normalizedFile, { filesSynced }) => {
    // filesSynced is true when input.files[0] now holds normalizedFile too
    // (so a plain form submit will send it). When the browser didn't allow
    // replacing the FileList, filesSynced is false and input.files[0] is
    // still the original, unprocessed file — upload normalizedFile directly
    // (e.g. with uploadWithProgress()) instead of relying on the form.
  },
});

// detach() later if the input is removed from the page.
```

### Just the orientation/HEIC fix, without wiring a preview

```js
import { normalizeOrientation } from 'maatify-image-upright';

const fixedFile = await normalizeOrientation(file);
```

### Retry a signed URL that might briefly 404 right after upload

```js
import { loadImageWithRetry, cancelImageRetry } from 'maatify-image-upright';

loadImageWithRetry(imgEl, signedUrl, {
  onGiveUp: () => showBrokenImagePlaceholder(),
});

// Before removing imgEl from the DOM (e.g. re-rendering a list), cancel any
// retry still pending so it doesn't keep the detached element alive:
cancelImageRetry(imgEl);
```

### Upload with progress and the ability to cancel

```js
import { uploadWithProgress } from 'maatify-image-upright';

const { promise, abort } = uploadWithProgress('/api/upload', formData, {
  onProgress: (percent) => progressBar.style.width = percent + '%',
  timeout: 30000, // ms; give up on a hung upload instead of waiting forever
});

cancelButton.onclick = abort;

try {
  const { status, responseText } = await promise;
} catch (error) {
  if (error.aborted) { /* cancelButton was clicked */ }
  if (error.timedOut) { /* the upload didn't finish within `timeout` */ }
}
```

## API

| Export | Signature |
|---|---|
| `normalizeOrientation` | `(file: File, options?: { quality?: number }) => Promise<File>` |
| `attachImagePreview` | `(inputEl, imgEl, options?: { validate?, onInvalid?, onChange?: (file, { filesSynced }) => void, quality? }) => () => void` (returns a detach function) |
| `syncInputFiles` | `(inputEl, file: File) => boolean` |
| `readFileAsDataURL` | `(file: Blob) => Promise<string>` |
| `loadImageWithRetry` | `(imgEl, src: string, options?: { delays?: number[], onGiveUp?: () => void }) => void` |
| `cancelImageRetry` | `(imgEl) => void` |
| `uploadWithProgress` | `(url, body, options?: { method?, headers?, onProgress?, timeout? }) => { promise: Promise<{status, responseText}>, abort: () => void }` |

## Why

Extracted from a production image-upload flow where photos taken on an iPhone were appearing rotated after upload, and the live preview sometimes showed nothing at all for HEIC files the browser can't decode on its own. Fixing both at the point of file selection — rather than only at upload time — means what the user sees is always what gets stored.

## License

MIT
