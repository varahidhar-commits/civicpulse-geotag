const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const GeoTag = require('../../frontend/js/geotag');

function tiffWithGps(latRef = 'N', lonRef = 'E') {
  const b = Buffer.alloc(128);
  b.write('II', 0); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4);
  b.writeUInt16LE(1, 8);
  b.writeUInt16LE(0x8825, 10); b.writeUInt16LE(4, 12);
  b.writeUInt32LE(1, 14); b.writeUInt32LE(26, 18);
  b.writeUInt16LE(4, 26);
  const writeRef = (p, tag, ref) => {
    b.writeUInt16LE(tag, p); b.writeUInt16LE(2, p + 2);
    b.writeUInt32LE(2, p + 4); b.write(ref, p + 8);
  };
  const writeTriplet = (p, tag, offset, values) => {
    b.writeUInt16LE(tag, p); b.writeUInt16LE(5, p + 2);
    b.writeUInt32LE(3, p + 4); b.writeUInt32LE(offset, p + 8);
    values.forEach(([n, d], i) => { b.writeUInt32LE(n, offset + i * 8); b.writeUInt32LE(d, offset + i * 8 + 4); });
  };
  writeRef(28, 1, latRef);
  writeTriplet(40, 2, 80, [[13, 1], [4, 1], [5772, 100]]);
  writeRef(52, 3, lonRef);
  writeTriplet(64, 4, 104, [[80, 1], [16, 1], [1452, 100]]);
  return b;
}
function jpeg(payload) {
  const exif = Buffer.concat([Buffer.from('Exif\0\0'), payload]);
  const len = Buffer.alloc(2); len.writeUInt16BE(exif.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, exif, Buffer.from([0xff, 0xd9])]);
}
function png(payload) {
  const size = Buffer.alloc(4); size.writeUInt32BE(payload.length);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), size, Buffer.from('eXIf'), payload, Buffer.alloc(4)]);
}
function webp(payload) {
  const size = Buffer.alloc(4); size.writeUInt32LE(payload.length);
  const riff = Buffer.alloc(4); riff.writeUInt32LE(4 + 8 + payload.length + payload.length % 2);
  return Buffer.concat([Buffer.from('RIFF'), riff, Buffer.from('WEBP'), Buffer.from('EXIF'), size, payload, Buffer.alloc(payload.length % 2)]);
}

test('accepts valid GPS EXIF in JPEG, PNG, WebP and honors negative coordinates', () => {
  for (const img of [jpeg(tiffWithGps()), png(tiffWithGps()), webp(tiffWithGps())]) {
    const gps = GeoTag.readCoordinates(img);
    assert.ok(gps);
    assert.ok(Math.abs(gps.latitude - 13.0827) < 0.000001);
    assert.ok(Math.abs(gps.longitude - 80.2707) < 0.000001);
  }
  const negativeGps = GeoTag.readCoordinates(jpeg(tiffWithGps('S', 'W')));
  assert.ok(negativeGps.latitude < 0 && negativeGps.longitude < 0);
});

test('rejects image with no EXIF, partial EXIF, wrong type and broken data', () => {
  assert.equal(GeoTag.readCoordinates(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
  assert.equal(GeoTag.readCoordinates(jpeg(Buffer.alloc(128))), null);
  assert.equal(GeoTag.readCoordinates(Buffer.from('not a photo')), null);
  assert.equal(GeoTag.readCoordinates(jpeg(tiffWithGps()).subarray(0, 19)), null);
  assert.equal(GeoTag.imageType(Buffer.from('not a photo')), null);
});

test('existing PNG sample has no embedded EXIF GPS', () => {
  const img = fs.readFileSync(path.join(__dirname, '..', 'uploads', '41c31f5c-68cb-49cc-bf1c-50a6fa8567a7.png'));
  assert.equal(GeoTag.imageType(img), 'png');
  assert.equal(GeoTag.readCoordinates(img), null);
});
