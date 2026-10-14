'use strict';

// Photo location verification for citizen reports:
// (1) Prefer original GPS EXIF, (2) accept *visible* GPS Map Camera-style
//     latitude/longitude stamps using local OCR. A printed stamp is NOT proof
//     of authentic geolocation; its coordinates can be spoofed or edited.
const GeoTag = require('../../frontend/js/geotag');
const path = require('path');

function getImageDimensions(buffer) {
  const type = GeoTag.imageType(buffer);
  if (!type) return null;
  if (type === 'png' && buffer.length >= 24) {
    return checkedDimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
  }
  if (type === 'jpeg') {
    let offset = 2;
    while (offset + 4 <= buffer.length) {
      if (buffer[offset] !== 0xff) break;
      while (buffer[offset] === 0xff) offset++;
      if (offset >= buffer.length) break;
      const marker = buffer[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        return checkedDimensions(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
      }
      offset += length;
    }
  }
  if (type === 'webp') {
    let offset = 12;
    while (offset + 8 <= buffer.length) {
      const length = buffer.readUInt32LE(offset + 4);
      if (length > buffer.length - offset - 8) break;
      const tag = buffer.toString('ascii', offset, offset + 4);
      const at = offset + 8;
      if (tag === 'VP8X' && length >= 10) {
        return checkedDimensions(1 + buffer.readUIntLE(at + 4, 3), 1 + buffer.readUIntLE(at + 7, 3));
      }
      if (tag === 'VP8 ' && length >= 10 && buffer[at + 3] === 0x9d && buffer[at + 4] === 0x01 && buffer[at + 5] === 0x2a) {
        return checkedDimensions(buffer.readUInt16LE(at + 6) & 0x3fff, buffer.readUInt16LE(at + 8) & 0x3fff);
      }
      if (tag === 'VP8L' && length >= 5 && buffer[at] === 0x2f) {
        const b0 = buffer[at + 1], b1 = buffer[at + 2], b2 = buffer[at + 3], b3 = buffer[at + 4];
        return checkedDimensions(1 + (b0 | ((b1 & 0x3f) << 8)), 1 + ((b1 >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10)));
      }
      offset += 8 + length + (length % 2);
    }
  }
  return null;
}

function checkedDimensions(width, height) {
  // Avoid passing unrealistic sizes to the OCR engine.
  return width > 0 && height > 0 && width <= 12000 && height <= 12000 && width * height <= 55000000
    ? { width, height } : null;
}

function parseGpsStamp(rawText) {
  if (typeof rawText !== 'string') return null;
  // OCR occasionally inserts line breaks, degree symbols, or extra spaces.
  // GPS stamp must explicitly name both coordinates; random map or date
  // numbers, street numbers, and unlabelled decimals do not qualify.
  const text = rawText.replace(/[\u00b0\u00ba\u02da]/g, ' ').replace(/\s+/g, ' ');
  const pattern = /\bLat(?:itude)?\s*[:=]?\s*([+-]?\d{1,2}[.,]\d{4,8})\s*([NS](?![A-Za-z]))?\s*[,;|/\-\s]{0,14}\s*Lon(?:g|gitude)?\s*[:=]?\s*([+-]?\d{1,3}[.,]\d{4,8})\s*([EW](?![A-Za-z]))?/ig;
  let m;
  while ((m = pattern.exec(text))) {
    let latitude = Number(m[1].replace(',', '.'));
    let longitude = Number(m[3].replace(',', '.'));
    if (m[2]) latitude = (m[2].toUpperCase() === 'S' ? -1 : 1) * Math.abs(latitude);
    if (m[4]) longitude = (m[4].toUpperCase() === 'W' ? -1 : 1) * Math.abs(longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
      return { latitude, longitude, source: 'visible_stamp_ocr' };
    }
  }
  return null;
}

let workerPromise;
let queue = Promise.resolve();
async function getWorker() {
  if (!workerPromise) {
    // The English OCR language model ships with the project. Once npm
    // dependencies are installed, text recognition works on localhost/offline.
    const { createWorker } = require('tesseract.js');
    workerPromise = createWorker('eng', 1, { langPath: path.join(__dirname, '..', 'ocr-data'), gzip: true }).then(async (worker) => {
      await worker.setParameters({ tessedit_pageseg_mode: '6' });
      return worker;
    }).catch((err) => {
      workerPromise = undefined; // retry when OCR assets become available
      throw err;
    });
  }
  return workerPromise;
}

async function readVisibleStamp(buffer) {
  const dims = getImageDimensions(buffer);
  if (!dims) return null;
  // GPS Map Camera and similar apps usually overlay text at the bottom.
  // Limiting OCR to that strip avoids reading unrelated signs/trash labels.
  const rectangle = {
    left: 0,
    top: Math.floor(dims.height * 0.70),
    width: dims.width,
    height: dims.height - Math.floor(dims.height * 0.70)
  };
  const worker = await getWorker();
  const result = await worker.recognize(buffer, { rectangle });
  return parseGpsStamp(result.data.text);
}

async function findPhotoGps(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const embedded = GeoTag.readCoordinates(buffer);
  if (embedded) return { ...embedded, source: 'embedded_exif' };

  // Sequential OCR prevents concurrent calls from racing over one worker.
  const task = queue.then(() => readVisibleStamp(buffer));
  queue = task.catch(() => {});
  return task;
}

module.exports = { findPhotoGps, parseGpsStamp, getImageDimensions };
