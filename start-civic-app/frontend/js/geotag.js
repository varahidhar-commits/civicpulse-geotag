// CivicPulse: shared browser/Node.js GPS EXIF reader.
// Supports EXIF metadata in original JPEG, PNG (eXIf) and WebP (EXIF) files.
// IMPORTANT: this checks embedded GPS tags, not whether the location is genuine.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GeoTag = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function asBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return null;
  }

  function isAscii(bytes, offset, value) {
    if (offset < 0 || offset + value.length > bytes.length) return false;
    for (let i = 0; i < value.length; i++) {
      if (bytes[offset + i] !== value.charCodeAt(i)) return false;
    }
    return true;
  }

  function imageType(input) {
    const bytes = asBytes(input);
    if (!bytes) return null;
    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
    if (bytes.length >= 8 && isAscii(bytes, 1, 'PNG') && bytes[0] === 0x89 &&
        bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
    if (bytes.length >= 12 && isAscii(bytes, 0, 'RIFF') && isAscii(bytes, 8, 'WEBP')) return 'webp';
    return null;
  }

  function parseTiff(bytes, offset, length) {
    if (length < 8 || offset < 0 || offset + length > bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length);
    const little = view.getUint8(0) === 0x49 && view.getUint8(1) === 0x49;
    const big = view.getUint8(0) === 0x4d && view.getUint8(1) === 0x4d;
    if (!little && !big) return null;

    const inside = (p, n) => Number.isSafeInteger(p) && p >= 0 && n >= 0 && p + n <= length;
    const u16 = (p) => { if (!inside(p, 2)) throw Error('Invalid EXIF offset'); return view.getUint16(p, little); };
    const u32 = (p) => { if (!inside(p, 4)) throw Error('Invalid EXIF offset'); return view.getUint32(p, little); };

    function findTag(ifdOffset, wanted) {
      if (!inside(ifdOffset, 2)) return null;
      const count = u16(ifdOffset);
      if (count > 200 || !inside(ifdOffset + 2, count * 12)) return null;
      for (let i = 0; i < count; i++) {
        const entry = ifdOffset + 2 + i * 12;
        if (u16(entry) === wanted) return entry;
      }
      return null;
    }

    function readRef(entry) {
      if (entry === null || u16(entry + 2) !== 2) return null; // ASCII
      const count = u32(entry + 4);
      if (count < 1 || count > 3) return null;
      const data = count <= 4 ? entry + 8 : u32(entry + 8);
      if (!inside(data, count)) return null;
      return String.fromCharCode(view.getUint8(data));
    }

    function readDms(entry) {
      if (entry === null || u16(entry + 2) !== 5 || u32(entry + 4) !== 3) return null;
      const p = u32(entry + 8);
      if (!inside(p, 24)) return null;
      const values = [];
      for (let i = 0; i < 3; i++) {
        const numerator = u32(p + i * 8);
        const denominator = u32(p + i * 8 + 4);
        if (!denominator) return null;
        values.push(numerator / denominator);
      }
      if (values[0] < 0 || values[1] >= 60 || values[2] >= 60) return null;
      return values[0] + values[1] / 60 + values[2] / 3600;
    }

    try {
      if (u16(2) !== 42) return null;
      const gpsPointer = findTag(u32(4), 0x8825); // GPSInfoIFDPointer
      if (gpsPointer === null || u16(gpsPointer + 2) !== 4 || u32(gpsPointer + 4) !== 1) return null;
      const gpsIfd = u32(gpsPointer + 8);
      const latRef = readRef(findTag(gpsIfd, 1));
      const lat = readDms(findTag(gpsIfd, 2));
      const lonRef = readRef(findTag(gpsIfd, 3));
      const lon = readDms(findTag(gpsIfd, 4));
      if (!['N', 'S'].includes(latRef) || !['E', 'W'].includes(lonRef) || lat === null || lon === null) return null;
      if (lat > 90 || lon > 180) return null;
      return { latitude: latRef === 'S' ? -lat : lat, longitude: lonRef === 'W' ? -lon : lon };
    } catch (_err) {
      return null; // malformed metadata never counts as geotagged
    }
  }

  function readCoordinates(input) {
    const bytes = asBytes(input);
    const type = imageType(bytes);
    if (!type) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (type === 'jpeg') {
      let p = 2;
      while (p + 4 <= bytes.length) {
        if (bytes[p] !== 0xff) break;
        while (bytes[p] === 0xff) p++;
        if (p >= bytes.length) break;
        const marker = bytes[p++];
        if (marker === 0xda || marker === 0xd9) break; // scan data / end of image
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (p + 2 > bytes.length) break;
        const segLength = view.getUint16(p, false);
        if (segLength < 2 || p + segLength > bytes.length) break;
        if (marker === 0xe1 && segLength >= 8 && isAscii(bytes, p + 2, 'Exif\0\0')) {
          const start = p + 8;
          const found = parseTiff(bytes, start, p + segLength - start);
          if (found) return found;
        }
        p += segLength;
      }
    } else if (type === 'png') {
      let p = 8;
      while (p + 12 <= bytes.length) {
        const length = view.getUint32(p, false);
        if (length > bytes.length - p - 12) break;
        if (isAscii(bytes, p + 4, 'eXIf')) {
          const start = p + 8;
          const hasHeader = isAscii(bytes, start, 'Exif\0\0');
          const found = parseTiff(bytes, start + (hasHeader ? 6 : 0), length - (hasHeader ? 6 : 0));
          if (found) return found;
        }
        if (isAscii(bytes, p + 4, 'IEND')) break;
        p += 12 + length;
      }
    } else if (type === 'webp') {
      let p = 12;
      while (p + 8 <= bytes.length) {
        const length = view.getUint32(p + 4, true);
        if (length > bytes.length - p - 8) break;
        if (isAscii(bytes, p, 'EXIF')) {
          const start = p + 8;
          const hasHeader = isAscii(bytes, start, 'Exif\0\0');
          const found = parseTiff(bytes, start + (hasHeader ? 6 : 0), length - (hasHeader ? 6 : 0));
          if (found) return found;
        }
        p += 8 + length + (length % 2);
      }
    }
    return null;
  }

  return { imageType, readCoordinates };
});
