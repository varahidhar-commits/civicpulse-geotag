// Explicit 12-hour AM/PM deadline conversion, shared by the browser and tests.
// The selected date/time is interpreted in the officer's local timezone.
(function(root) {
  'use strict';
  function toISO(dateString, hourString, minuteString, period, now = new Date()) {
    if (typeof dateString !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) return null;
    if (!['AM', 'PM'].includes(period)) return null;
    const hour = Number(hourString), minute = Number(minuteString);
    if (!Number.isInteger(hour) || hour < 1 || hour > 12 ||
        !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    const [year,month,day] = dateString.split('-').map(Number);
    const hour24 = (hour % 12) + (period === 'PM' ? 12 : 0);
    const local = new Date(year,month - 1,day,hour24,minute);
    if (!Number.isFinite(local.getTime()) ||
        local.getFullYear() !== year || local.getMonth() !== month - 1 ||
        local.getDate() !== day || local.getHours() !== hour24 ||
        local.getMinutes() !== minute || local.getTime() <= new Date(now).getTime()) return null;
    return local.toISOString();
  }
  const api = Object.freeze({ toISO });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DeadlineTime = api;
})(typeof window !== 'undefined' ? window : null);
