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
 * support (or that restrict assigning `.files`) leave the input untouched.
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
 * Handles the case of the user picking a second file while the first one
 * is still being normalized: only the most recent selection ever reaches
 * the preview or validate/onChange callbacks.
 *
 * @param {HTMLInputElement} inputEl
 * @param {HTMLImageElement} imgEl
 * @param {{
 *   validate?: (file: File) => boolean,
 *   onInvalid?: (file: File) => void,
 *   onChange?: (file: File) => void,
 *   quality?: number,
 * }} [options]
 * @returns {() => void} detach function; removes the wired listener
 */
export function attachImagePreview(inputEl, imgEl, options = {}) {
    let requestId = 0;

    const handleChange = async (event) => {
        const input = event.target;
        const selectedFile = input.files && input.files[0];
        if (!selectedFile) return;

        if (typeof options.validate === 'function' && !options.validate(selectedFile)) {
            if (typeof options.onInvalid === 'function') options.onInvalid(selectedFile);
            return;
        }

        const thisRequestId = ++requestId;
        const normalized = await normalizeOrientation(selectedFile, { quality: options.quality });

        // A newer selection (or a reset — see cancelPreview()) arrived while
        // this one was still normalizing: drop this one silently.
        if (thisRequestId !== requestId) return;

        syncInputFiles(input, normalized);

        let dataUrl;
        try {
            dataUrl = await readFileAsDataURL(normalized);
        } catch {
            return;
        }
        if (thisRequestId !== requestId) return;

        imgEl.src = dataUrl;
        if (typeof options.onChange === 'function') options.onChange(normalized);
    };

    inputEl.addEventListener('change', handleChange);

    return function detach() {
        requestId += 1; // invalidate any selection still normalizing
        inputEl.removeEventListener('change', handleChange);
    };
}
