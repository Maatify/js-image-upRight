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
 * HEIC/HEIF files are converted to JPEG in the same pass wherever the
 * browser can decode HEIC at all (this is not every browser — see
 * viaImageElement() below) — it is a best-effort conversion, not a
 * guarantee. A browser that can't decode the source format at all gets the
 * original file back unchanged; check the result's `type`/`name` if your
 * code needs to know whether conversion actually happened.
 *
 * For JPEG and PNG (the formats that don't need a format conversion),
 * the file's EXIF `Orientation` tag is checked first: a file with no EXIF
 * data at all (most screenshots and already-processed images) or an
 * orientation of 1 is returned unchanged, skipping the lossy canvas
 * re-encode entirely.
 */

/**
 * Some environments (certain Android browsers in particular) report an
 * empty `file.type` for a real HEIC/HEIF photo. Falls back to the filename
 * extension in that case only — a declared MIME type always wins, since an
 * extension alone is never proof of the actual format.
 *
 * @param {File|Blob} file
 * @returns {string} a lowercase `image/...` MIME type, or '' if unknown.
 */
function resolveImageType(file) {
    const declared = String(file.type || '').toLowerCase();
    if (declared) return declared;

    const name = String(file.name || '').toLowerCase();
    if (/\.png$/.test(name)) return 'image/png';
    if (/\.(heic|heif)$/.test(name)) return 'image/heic';
    if (/\.(jpe?g)$/.test(name)) return 'image/jpeg';
    if (/\.webp$/.test(name)) return 'image/webp';
    if (/\.bmp$/.test(name)) return 'image/bmp';
    if (/\.avif$/.test(name)) return 'image/avif';
    if (/\.gif$/.test(name)) return 'image/gif';
    if (/\.svg$/.test(name)) return 'image/svg+xml';
    return '';
}

/**
 * @param {string} type a resolved `image/...` MIME type (see resolveImageType)
 * @returns {boolean} true if this looks like a raster image worth normalizing.
 */
function isNormalizableImage(type) {
    if (!type || !type.startsWith('image/')) return false;
    // SVG has no pixel orientation to fix, and re-rasterizing a GIF would
    // destroy its animation — leave both untouched.
    if (type === 'image/svg+xml' || type === 'image/gif') return false;
    return true;
}

/**
 * @param {string} type original (or extension-inferred) MIME type
 * @returns {string} the MIME type to re-encode to (PNG stays PNG; everything
 *   else, including HEIC/HEIF, becomes JPEG, since that's universally
 *   displayable and most source photos are already lossy).
 */
function targetTypeFor(type) {
    return type === 'image/png' ? 'image/png' : 'image/jpeg';
}

/**
 * Builds the output filename from `targetType`, not from the original
 * extension: canvas.toBlob() always re-encodes to `targetType` regardless of
 * what the source file was named, so e.g. a `.webp` source re-encoded to
 * JPEG must end up named `.jpg` — otherwise the extension would lie about
 * the actual file content.
 */
function targetNameFor(file, targetType) {
    const extension = targetType === 'image/png' ? '.png' : '.jpg';
    const originalName = file.name || 'image';
    const baseName = originalName.replace(/\.[^./\\]+$/, '');
    return (baseName || 'image') + extension;
}

/**
 * Reads the TIFF IFD0 `Orientation` tag (0x0112) starting at `tiffStart`,
 * where the TIFF header ("II" or "MM" + magic 42) itself begins.
 *
 * @param {DataView} view
 * @param {number} tiffStart
 * @returns {number|null} 1-8, or null if absent/unreadable.
 */
function parseTiffOrientation(view, tiffStart) {
    if (tiffStart + 8 > view.byteLength) return null;

    const byteOrderMarker = view.getUint16(tiffStart, false);
    let littleEndian;
    if (byteOrderMarker === 0x4949) littleEndian = true; // "II"
    else if (byteOrderMarker === 0x4d4d) littleEndian = false; // "MM"
    else return null;

    if (view.getUint16(tiffStart + 2, littleEndian) !== 42) return null;

    const ifd0Offset = view.getUint32(tiffStart + 4, littleEndian);
    const dirStart = tiffStart + ifd0Offset;
    if (dirStart < tiffStart || dirStart + 2 > view.byteLength) return null;

    const entryCount = view.getUint16(dirStart, littleEndian);
    for (let i = 0; i < entryCount; i++) {
        const entryOffset = dirStart + 2 + i * 12;
        if (entryOffset + 12 > view.byteLength) break;
        if (view.getUint16(entryOffset, littleEndian) === 0x0112) {
            const value = view.getUint16(entryOffset + 8, littleEndian);
            return value >= 1 && value <= 8 ? value : null;
        }
    }
    return null;
}

/**
 * Finds the EXIF `Orientation` tag in a JPEG's APP1 segment, without
 * parsing any other metadata.
 *
 * @param {DataView} view
 * @returns {number|null}
 */
function findJpegExifOrientation(view) {
    if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return null;

    let offset = 2;
    while (offset + 4 <= view.byteLength) {
        const marker = view.getUint16(offset, false);
        if ((marker & 0xff00) !== 0xff00) break;
        if (marker === 0xffd8 || marker === 0xffd9 || marker === 0xffda) break; // SOI/EOI/start-of-scan: no more metadata markers follow

        const segmentLength = view.getUint16(offset + 2, false);
        if (segmentLength < 2) break;

        if (marker === 0xffe1) {
            const exifHeader = offset + 4;
            const hasExifSignature = exifHeader + 6 <= view.byteLength
                && view.getUint32(exifHeader, false) === 0x45786966 // "Exif"
                && view.getUint16(exifHeader + 4, false) === 0x0000;
            if (hasExifSignature) return parseTiffOrientation(view, exifHeader + 6);
        }

        offset += 2 + segmentLength;
    }
    return null;
}

/**
 * Finds the EXIF `Orientation` tag in a PNG's `eXIf` chunk (the chunk
 * always precedes IDAT per the PNG spec, so it's safe to stop looking once
 * image data starts).
 *
 * @param {DataView} view
 * @returns {number|null}
 */
function findPngExifOrientation(view) {
    if (view.byteLength < 8) return null;

    let offset = 8; // past the 8-byte PNG signature
    while (offset + 8 <= view.byteLength) {
        const length = view.getUint32(offset, false);
        const type = String.fromCharCode(
            view.getUint8(offset + 4),
            view.getUint8(offset + 5),
            view.getUint8(offset + 6),
            view.getUint8(offset + 7),
        );
        const dataStart = offset + 8;

        if (type === 'eXIf') return parseTiffOrientation(view, dataStart);
        if (type === 'IDAT' || type === 'IEND') break;

        offset = dataStart + length + 4; // skip chunk data + its trailing CRC
    }
    return null;
}

/**
 * Reads just enough of `file` to determine its EXIF `Orientation` tag,
 * without parsing or allocating anything for the rest of the file's
 * metadata. Only JPEG and PNG are supported (the only formats
 * normalizeOrientation() can skip re-encoding for — see its caller).
 *
 * @param {File} file
 * @param {string} type resolved `image/...` MIME type
 * @returns {Promise<number|null>} 1-8, or null if there's no orientation tag
 *   (or the file can't be parsed) — both treated the same way by the caller.
 */
async function readExifOrientation(file, type) {
    try {
        const view = new DataView(await file.arrayBuffer());
        if (type === 'image/jpeg') return findJpegExifOrientation(view);
        if (type === 'image/png') return findPngExifOrientation(view);
        return null;
    } catch {
        return null;
    }
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve) => {
        canvas.toBlob((blob) => resolve(blob), type, quality);
    });
}

function buildNormalizedFile(originalFile, blob, targetType) {
    const name = targetNameFor(originalFile, targetType);
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
 * Most browsers (Chromium, Firefox) cannot decode HEIC/HEIF in an <img> at
 * all, so those files come back unchanged here. Safari is an exception — it
 * decodes HEIC/HEIF natively in both <img> and createImageBitmap() — so HEIC
 * conversion is NOT guaranteed across browsers in general: check the
 * returned file's `type`/`name` (or `__orientationNormalized`) if your code
 * needs to know whether conversion actually happened.
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
    if (!file || typeof file !== 'object') return file;
    if (file.__orientationNormalized) return file;

    const type = resolveImageType(file);
    if (!isNormalizableImage(type)) return file;
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return file;

    const targetType = targetTypeFor(type);

    // No format conversion needed (JPEG stays JPEG, PNG stays PNG) — check
    // whether there's actually an orientation to fix before paying for a
    // lossy re-encode. A file with no EXIF tag at all (most screenshots and
    // already-processed images) or an explicit orientation of 1 needs none.
    if (targetType === type) {
        const orientation = await readExifOrientation(file, type);
        if (orientation === null || orientation === 1) return file;
    }

    const quality = typeof options.quality === 'number' && options.quality > 0 && options.quality <= 1
        ? options.quality
        : 0.95;

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
