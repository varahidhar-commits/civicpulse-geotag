'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseGpsStamp, getImageDimensions } = require('../utils/photoGps');

test('accepts the coordinates in GPS Map Camera overlays', () => {
  assert.deepEqual(parseGpsStamp('Chennai, Tamil Nadu, India\nLat 13.033376° Long 80.180313°\nWednesday 14/10/2026'), {
    latitude: 13.033376,
    longitude: 80.180313,
    source: 'visible_stamp_ocr'
  });
});

test('reads alternate labelled GPS forms', () => {
  const gps = parseGpsStamp('Latitude: 13.033376 S  Longitude: 80.180313 W');
  assert.equal(gps.latitude, -13.033376);
  assert.equal(gps.longitude, -80.180313);
});

test('rejects images with unlabelled decimals or no GPS and out-of-range data', () => {
  assert.equal(parseGpsStamp('Chennai 14/10/2026 09:05 AM 600089'), null);
  assert.equal(parseGpsStamp('13.033376 80.180313'), null);
  assert.equal(parseGpsStamp('Lat 91.033376 Long 80.180313'), null);
  assert.equal(parseGpsStamp('Lat 13.033376 Long 1800.180313'), null);
  assert.equal(parseGpsStamp(''), null);
});

test('does not treat weekday or ordinary words as compass direction', () => {
  assert.equal(parseGpsStamp('Lat 13.033376° Long 80.180313° Wednesday').longitude, 80.180313);
});

test('reads PNG dimensions and rejects fake-image bytes', () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(png,0);
  png.writeUInt32BE(1200,16);
  png.writeUInt32BE(1600,20);
  assert.deepEqual(getImageDimensions(png), { width: 1200, height: 1600 });
  assert.equal(getImageDimensions(Buffer.from('not an image')),null);
});
