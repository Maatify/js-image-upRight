import { normalizeOrientation } from './orientation.js';

/**
 * Reads a File/Blob as a data: URL.
 * @param {Blob} file
 * @returns {Promise<string>}
 */
export function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(event.target.result);
        reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
        reader.readAsDataURL(file);
    });
}

/**
 * Replaces an <input type="file">'s FileList with a single file, so a
 * file produced client-side (e.g. by normalizeOrientation()) becomes what
 * actually gets submitted with the form. Browsers without DataTransfer
 * support (or that restrict assigning `.files`) leave the input untouched —
 * check the return value if your upload path relies on the native form
 * submission rather than sending the file you got from `onChange` directly.
 *
 * @param {HTMLInputElement} inputEl
 * @param {File} file
 * @returns {boolean} whether the swap succeeded
 */
export function syncInputFiles(inputEl, file) {
    if (typeof DataTransfer === 'undefined') return false;
    try {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        inputEl.files = transfer.files;
        return true;
    } catch {
        return false;
    }
}

/**
 * Wires an <input type="file"> to an <img> preview that always shows the
 * same, orientation-corrected file that will end up being uploaded —
 * instead of the raw file, which browsers can't even decode for HEIC/HEIF,
 * and which may still need an EXIF rotation applied.
 *
 * Every invocation of the `change` handler invalidates any earlier one still
 * in flight — regardless of how it concludes (no file, a rejected file, or a
 * normalized one) — so a slow normalization for a since-superseded selection
 * can never land after the fact and overwrite a newer or reverted selection.
 *
 * @param {HTMLInputElement} inputEl
 * @param {HTMLImageElement} imgEl
 * @param {{
 *   validate?: (file: File) => boolean,
 *   onInvalid?: (file: File) => void,
 *   onChange?: (file: File, meta: { filesSynced: boolean }) => void,
 *   quality?: number,
 * }} [options]
 * @returns {() => void} detach function; removes the wired listener and
 *   releases the current preview's object URL, if any.
 */
export function attachImagePreview(inputEl, imgEl, options = {}) {
    let requestId = 0;
    let currentObjectUrl = null;

    function releaseCurrentObjectUrl() {
        if (currentObjectUrl) {
            URL.revokeObjectURL(currentObjectUrl);
            currentObjectUrl = null;
        }
    }

    const handleChange = async (event) => {
        // Bumped unconditionally, before any validation or early return, so
        // *every* selection — including an empty or rejected one — retires
        // whatever selection came before it, not just a successful one.
        const thisRequestId = ++requestId;

        const input = event.target;
        const selectedFile = input.files && input.files[0];
        if (!selectedFile) return;

        if (typeof options.validate === 'function' && !options.validate(selectedFile)) {
            if (typeof options.onInvalid === 'function') options.onInvalid(selectedFile);
            return;
        }

        const normalized = await normalizeOrientation(selectedFile, { quality: options.quality });
        if (thisRequestId !== requestId) return;

        const filesSynced = syncInputFiles(input, normalized);

        // Prefer an object URL over a data: URL for the preview — a data:
        // URL holds the entire base64-encoded image as a JS string, which
        // for a large photo is meaningfully more memory than a lightweight
        // object URL the browser manages for us.
        const supportsObjectUrl = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
        let previewSrc = null;
        if (supportsObjectUrl) {
            try {
                previewSrc = URL.createObjectURL(normalized);
            } catch {
                previewSrc = null;
            }
        }
        if (previewSrc === null) {
            try {
                previewSrc = await readFileAsDataURL(normalized);
            } catch {
                return;
            }
            if (thisRequestId !== requestId) return;
        }

        releaseCurrentObjectUrl();
        currentObjectUrl = supportsObjectUrl ? previewSrc : null;
        imgEl.src = previewSrc;

        if (typeof options.onChange === 'function') options.onChange(normalized, { filesSynced });
    };

    inputEl.addEventListener('change', handleChange);

    return function detach() {
        requestId += 1; // invalidate any selection still normalizing
        inputEl.removeEventListener('change', handleChange);
        releaseCurrentObjectUrl();
    };
}
