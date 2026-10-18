const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const DeadlineTime = require('../../frontend/js/deadlineTime');

test('12 AM means midnight, and 12 PM means noon', () => {
  const now = new Date('2034-12-31T00:00:00Z');
  assert.equal(DeadlineTime.toISO('2035-01-01', 12, 0, 'AM', now),
    new Date(2035, 0, 1, 0, 0).toISOString());
  assert.equal(DeadlineTime.toISO('2035-01-01', 12, 0, 'PM', now),
    new Date(2035, 0, 1, 12, 0).toISOString());
  assert.equal(DeadlineTime.toISO('2035-01-01', 1, 15, 'PM', now),
    new Date(2035, 0, 1, 13, 15).toISOString());
});

test('reject invalid hours, dates, minutes and past times', () => {
  const now = new Date('2034-12-31T00:00:00Z');
  for (const inputs of [
    ['2035-01-01', 0, 0, 'AM'], ['2035-01-01', 13, 0, 'PM'],
    ['2035-01-01', 11, 60, 'AM'], ['2035-02-30', 11, 0, 'AM'],
    ['2035-01-01', 11, 0, 'invalid'], ['', 11, 0, 'PM'],
    ['2030-01-01', 11, 0, 'PM']
  ]) assert.equal(DeadlineTime.toISO(...inputs, now), null, String(inputs));
});

function translated(language) {
  const window = {};
  const localStorage = { getItem: () => language, setItem() {} };
  const document = { readyState: 'loading', addEventListener() {} };
  const context = vm.createContext({ window, localStorage, document });
  const root = path.resolve(__dirname, '../../frontend/js');
  vm.runInContext(fs.readFileSync(path.join(root, 'translations.js'), 'utf-8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'i18n.js'), 'utf-8'), context);
  return window.I18n;
}

test('Tamil and Hindi translations are available throughout the primary workflow', () => {
  for (const locale of ['ta', 'hi']) {
    const i18n = translated(locale);
    for (const label of [
      'Home', 'Public', 'Government', 'Worker', 'My tasks', 'All complaints',
      'Assign with deadline', 'Start work deadline', 'Hour', 'Minute', 'AM / PM',
      'Worker delay alerts', 'Submit report', 'Log in'
    ]) assert.notEqual(i18n.t(label), label, `${locale}: ${label}`);
    assert.equal(i18n.t('Random user-written complaint'), 'Random user-written complaint');
  }
});

test('English remains unchanged', () => {
  const i18n = translated('en');
  assert.equal(i18n.t('Start work deadline'), 'Start work deadline');
  assert.equal(i18n.t('Worker delay alerts'), 'Worker delay alerts');
});
