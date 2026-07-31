// Verify the synchronous unzip path: build a zip containing apple_health_export/export.xml
// (as Apple's archive does) and parse it with parseZipBytes.
import { zipSync, strToU8 } from 'fflate';
import { parseZipBytes, parseXMLText } from '../src/parse.js';

const two = (n) => String(n).padStart(2, '0');
const stamp = (y, mo, d, h, mi) => `${y}-${two(mo)}-${two(d)} ${two(h)}:${two(mi)}:00 -0700`;
const rows = ['<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE HealthData>', '<HealthData locale="en_US">'];
const rec = (t, u, s, e, v) => rows.push(`<Record type="${t}" sourceName="Apple Watch" unit="${u}" startDate="${s}" endDate="${e}" value="${v}"/>`);
const base = new Date(Date.UTC(2026, 4, 1));
for (let i = 0; i < 40; i++) {
  const dt = new Date(base.getTime() + i * 86400000);
  const Y = dt.getUTCFullYear(), M = dt.getUTCMonth() + 1, D = dt.getUTCDate();
  rec('HKQuantityTypeIdentifierStepCount', 'count', stamp(Y, M, D, 9, 0), stamp(Y, M, D, 9, 10), 5000 + i * 100);
  rec('HKQuantityTypeIdentifierRestingHeartRate', 'count/min', stamp(Y, M, D, 8, 0), stamp(Y, M, D, 8, 1), 64);
  rec('HKQuantityTypeIdentifierHeartRateVariabilitySDNN', 'ms', stamp(Y, M, D, 3, 0), stamp(Y, M, D, 3, 1), 45);
  for (const h of [4, 12, 19]) rec('HKQuantityTypeIdentifierHeartRate', 'count/min', stamp(Y, M, D, h, 0), stamp(Y, M, D, h, 1), h === 4 ? 58 : h === 12 ? 82 : 92);
  rec('HKCategoryTypeIdentifierSleepAnalysis', '', stamp(Y, M, D, 0, 0), stamp(Y, M, D, 6, 30), 'HKCategoryValueSleepAnalysisAsleepCore');
}
rows.push('</HealthData>');
const xml = rows.join('\n');

const zipped = zipSync({ 'apple_health_export/export.xml': strToU8(xml), 'apple_health_export/export_cda.xml': strToU8('<x/>') });
console.log('zip size', zipped.length, 'bytes');

function check(name, cond, detail) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!cond) process.exitCode = 1; }

const dsZip = parseZipBytes(zipped);
const dsXml = parseXMLText(xml);
console.log('zip →', dsZip.meta);
check('zip records > 0', dsZip.meta.records > 0, `${dsZip.meta.records}`);
check('zip days = 40', dsZip.meta.dayCount === 40, `${dsZip.meta.dayCount}`);
check('zip nights parsed', dsZip.meta.sleepNights >= 39, `${dsZip.meta.sleepNights}`);
check('zip == xml records', dsZip.meta.records === dsXml.meta.records, `${dsZip.meta.records} vs ${dsXml.meta.records}`);
check('zip circadian present', dsZip.circadian.filter((v) => v > 0).length >= 3);
