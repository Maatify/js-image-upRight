/**
 * EXIF orientation correction and HEIC/HEIF -> JPEG conversion.
 *
 * Phones (iPhones especially) frequently save a photo in its raw sensor
 * orientation and record the correct display orientation in the EXIF
 * `Orientation` tag instead of rotating the pixels. Most server-side image
 * pipelines (plain GD conversion, for example) ignore that tag and strip it
 * when re-encoding, so the photo ends up stored sideways or upside down.
 *
 * normalizeOrientation() fixes this on the client, before the file ever
 * leaves the browser: it decodes the image respecting EXIF orientation,
 * redraws it onto a canvas (which bakes the correct orientation into the
 * pixels and drops the now-redundant EXIF tag), and returns a new File.
 * HEIC/HEIF files are converted to JPEG in the same pass, since most
 * browsers cannot decode or display HEIC directly.
 */

const HEIC_HEIF_EXTENSION = /\.(heic|heif)$/i;

/**
 * @param {File|Blob} file
 * @returns {boolean} true if this looks like a raster image worth normalizing.
 */
function isNormalizableImage(file) {
    if (!file || typeof file !== 'object') return false;
    const type = String(file.type || '').toLowerCase();
    if (!type.startsWith('image/')) return false;
    // SVG has no pixel orientation to fix, and re-rasterizing a GIF would
    // destroy its animation — leave both untouched.
    if (type === 'image/svg+xml' || type === 'image/gif') return false;
    return true;
}

/**
 * @param {string} type original MIME type
 * @returns {string} the MIME type to re-encode to (PNG stays PNG; everything
 *   else, including HEIC/HEIF, becomes JPEG, since that's universally
 *   displayable and most source photos are already lossy).
 */
function targetTypeFor(type) {
    return type === 'image/png' ? 'image/png' : 'image/jpeg';
}

function targetNameFor(file) {
    const originalName = file.name || 'image.jpg';
    // Only HEIC/HEIF needs renaming: it's the one format this module always
    // converts away from. Every other extension (.jpg, .png, ...) already
    // matches what canvas.toBlob() re-encodes to, so it's left as-is.
    return originalName.replace(HEIC_HEIF_EXTENSION, '.jpg');
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), type, quality);
    });
}

function buildNormalizedFile(originalFile, blob, targetType) {
    const name = targetNameFor(originalFile);
    const normalized = new File([blob], name, {
        type: targetType,
        lastModified: Date.now(),
    });
    // Lets a second normalizeOrientation() call (e.g. a caller that both
    // previews and later re-validates before upload) skip re-encoding —
    // re-running canvas.toBlob() on an already-normalized file would just
    // pay for a second lossy JPEG re-compression for no benefit.
    normalized.__orientationNormalized = true;
    return normalized;
}

async function viaCreateImageBitmap(file, targetType, quality) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d');
        if (!ctx || typeof canvas.toBlob !== 'function') {
            return null;
        }
        ctx.drawImage(bitmap, 0, 0);
        return await canvasToBlob(canvas, targetType, quality);
    } finally {
        if (typeof bitmap.close === 'function') bitmap.close();
    }
}

/**
 * Fallback for browsers without createImageBitmap()'s `imageOrientation`
 * option: decode through a plain <img>, which already applies EXIF
 * orientation when painting (per the CSS `image-orientation: from-image`
 * default most browsers ship), then redraw onto a canvas to bake it in.
 * This path cannot decode HEIC/HEIF (no native <img> support), so those
 * files are returned unchanged here — createImageBitmap is the only path
 * able to convert them.
 */
function viaImageElement(file, targetType, quality) {
    return new Promise((resolve, reject) => {
        if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof Image === 'undefined') {
            resolve(null);
            return;
        }

        const img = new Image();
        const objectUrl = URL.createObjectURL(file);

        img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;
                const ctx = canvas.getContext('2d');
                if (!ctx || typeof canvas.toBlob !== 'function') {
                    resolve(null);
                    return;
                }
                ctx.drawImage(img, 0, 0);
                canvasToBlob(canvas, targetType, quality).then(resolve, reject);
            } catch (err) {
                reject(err);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(null);
        };
        img.src = objectUrl;
    });
}

/**
 * Returns a new File with EXIF orientation baked into its pixels and
 * HEIC/HEIF converted to JPEG. Returns the original file unchanged (same
 * reference) whenever there is nothing to do or normalization isn't
 * possible in the current environment — callers can always use the result
 * as a drop-in replacement for the input file.
 *
 * @param {File} file
 * @param {{ quality?: number }} [options] JPEG/PNG re-encode quality, 0-1 (default 0.95).
 * @returns {Promise<File>}
 */
export async function normalizeOrientation(file, options = {}) {
    if (!isNormalizableImage(file)) return file;
    if (file.__orientationNormalized) return file;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return file;

    const type = String(file.type || '').toLowerCase();
    const targetType = targetTypeFor(type);
    const quality = typeof options.quality === 'number' ? options.quality : 0.95;

    if (typeof createImageBitmap === 'function') {
        try {
            const blob = await viaCreateImageBitmap(file, targetType, quality);
            if (blob) return buildNormalizedFile(file, blob, targetType);
        } catch {
            // Falls through to the <img> path below (e.g. a format
            // createImageBitmap itself can't decode in this browser).
        }
    }

    try {
        const blob = await viaImageElement(file, targetType, quality);
        if (blob) return buildNormalizedFile(file, blob, targetType);
    } catch {
        // Give up quietly — the caller gets the original file back below.
    }

    return file;
}
