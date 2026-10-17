# maatify-image-upright

A small, dependency-free client-side toolkit for handling image uploads correctly:

- **EXIF orientation correction** — iPhones (and most cameras) save a photo in its raw sensor orientation and record the correct display orientation in an EXIF tag instead of rotating the pixels. Most server-side pipelines ignore that tag, so the photo ends up stored sideways. `normalizeOrientation()` bakes the correct orientation into the pixels before the file ever leaves the browser.
- **HEIC/HEIF → JPEG conversion** — the default format for iPhone photos, which most browsers can't even display. Converted in the same pass as the orientation fix.
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
  onChange: (normalizedFile) => {
    // normalizedFile is what input.files[0] now holds too (when the browser
    // allows replacing it) — submit the form as usual.
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
});

cancelButton.onclick = abort;
const { status, responseText } = await promise;
```

## API

| Export | Signature |
|---|---|
| `normalizeOrientation` | `(file: File, options?: { quality?: number }) => Promise<File>` |
| `attachImagePreview` | `(inputEl, imgEl, options?) => () => void` (returns a detach function) |
| `syncInputFiles` | `(inputEl, file: File) => boolean` |
| `readFileAsDataURL` | `(file: Blob) => Promise<string>` |
| `loadImageWithRetry` | `(imgEl, src: string, options?: { delays?: number[], onGiveUp?: () => void }) => void` |
| `cancelImageRetry` | `(imgEl) => void` |
| `uploadWithProgress` | `(url, body, options?) => { promise: Promise<{status, responseText}>, abort: () => void }` |

## Why

Extracted from a production image-upload flow where photos taken on an iPhone were appearing rotated after upload, and the live preview sometimes showed nothing at all for HEIC files the browser can't decode on its own. Fixing both at the point of file selection — rather than only at upload time — means what the user sees is always what gets stored.

## License

MIT
