/**
 * Minimal, write-only EXIF helper used only to *build* test fixtures: given
 * a real JPEG (produced by `sips`, with real compressed pixel data), inject
 * a single-entry TIFF IFD0 carrying just the `Orientation` tag (0x0112) as
 * an APP1/Exif segment, replacing any APP1/Exif segment already there.
 *
 * This is the mirror image of the read-only parser in
 * `src/orientation.js` (`findJpegExifOrientation`) — it exists here,
 * duplicated, because it's test-fixture tooling, not library code.
 */

/** A minimal 26-byte TIFF IFD0 with a single Orientation entry. */
function buildTiffOrientationBytes(orientation) {
    const buffer = new ArrayBuffer(26);
    const view = new DataView(buffer);
    view.setUint8(0, 0x49);
    view.setUint8(1, 0x49); // "II" little-endian
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true); // IFD0 starts right after the 8-byte header
    view.setUint16(8, 1, true); // 1 entry
    view.setUint16(10, 0x0112, true); // tag: Orientation
    view.setUint16(12, 3, true); // type: SHORT
    view.setUint32(14, 1, true); // count: 1
    view.setUint16(18, orientation, true); // value
    view.setUint32(22, 0, true); // next IFD offset: none
    return Buffer.from(buffer);
}

function buildApp1ExifSegment(orientation) {
    const tiff = buildTiffOrientationBytes(orientation);
    const exifBlock = Buffer.concat([Buffer.from([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]), tiff]); // "Exif\0\0" + TIFF
    const app1Length = 2 + exifBlock.length; // the length field counts itself
    const segment = Buffer.alloc(4 + exifBlock.length);
    segment.writeUInt16BE(0xffe1, 0); // APP1 marker
    segment.writeUInt16BE(app1Length, 2);
    exifBlock.copy(segment, 4);
    return segment;
}

/**
 * Removes every existing APP1/Exif segment from a JPEG buffer, leaving
 * every other segment (APP0/JFIF, etc.) untouched.
 */
function stripExifApp1Segments(buffer) {
    if (buffer.readUInt16BE(0) !== 0xffd8) throw new Error('not a JPEG (missing SOI)');

    const kept = [buffer.subarray(0, 2)]; // SOI
    let offset = 2;
    while (offset + 4 <= buffer.length) {
        const marker = buffer.readUInt16BE(offset);
        if ((marker & 0xff00) !== 0xff00) throw new Error('malformed JPEG marker at offset ' + offset);
        if (marker === 0xffd9 || marker === 0xffda) {
            kept.push(buffer.subarray(offset)); // EOI, or start-of-scan through end of file
            break;
        }

        const segmentLength = buffer.readUInt16BE(offset + 2);
        const segmentEnd = offset + 2 + segmentLength;
        const exifHeader = offset + 4;
        const isExifApp1 = marker === 0xffe1
            && exifHeader + 6 <= buffer.length
            && buffer.readUInt32BE(exifHeader) === 0x45786966
            && buffer.readUInt16BE(exifHeader + 4) === 0x0000;

        if (!isExifApp1) kept.push(buffer.subarray(offset, segmentEnd));
        offset = segmentEnd;
    }
    return Buffer.concat(kept);
}

/**
 * @param {Buffer} jpegBuffer a real, already-compressed JPEG
 * @param {number} orientation 1-8
 * @returns {Buffer} the same JPEG with a single APP1/Exif Orientation tag
 *   inserted right after the SOI marker
 */
export function injectJpegOrientation(jpegBuffer, orientation) {
    const stripped = stripExifApp1Segments(jpegBuffer);
    const soi = stripped.subarray(0, 2);
    const rest = stripped.subarray(2);
    return Buffer.concat([soi, buildApp1ExifSegment(orientation), rest]);
}
