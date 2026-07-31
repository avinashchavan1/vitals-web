// Emit a small realistic Apple Health export.xml into public/ for the in-browser upload smoke test.
import { writeFileSync } from 'node:fs';

const two = (n) => String(n).padStart(2, '0');
const stamp = (y, mo, d, h, mi) => `${y}-${two(mo)}-${two(d)} ${two(h)}:${two(mi)}:00 -0700`;
const rows = ['<?xml version="1.0" encoding="UTF-8"?>', '<HealthData locale="en_US">'];
const rec = (type, unit, s, e, val) => rows.push(`<Record type="${type}" sourceName="Apple Watch" unit="${unit}" startDate="${s}" endDate="${e}" value="${val}"/>`);

const base = new Date(Date.UTC(2026, 3, 1)); // 1 Apr 2026
const N = 100;
for (let i = 0; i < N; i++) {
  const dt = new Date(base.getTime() + i * 86400000);
  const Y = dt.getUTCFullYear(), M = dt.getUTCMonth() + 1, D = dt.getUTCDate();
  const c = i / (N - 1);
  const wob = Math.sin(i / 6);
  rec('HKQuantityTypeIdentifierStepCount', 'count', stamp(Y, M, D, 9, 0), stamp(Y, M, D, 9, 10), Math.round(3500 + c * 6500 + wob * 800));
  rec('HKQuantityTypeIdentifierActiveEnergyBurned', 'kcal', stamp(Y, M, D, 9, 0), stamp(Y, M, D, 9, 10), Math.round(280 + c * 320));
  rec('HKQuantityTypeIdentifierRestingHeartRate', 'count/min', stamp(Y, M, D, 8, 0), stamp(Y, M, D, 8, 1), (71 - c * 9 + wob).toFixed(1));
  rec('HKQuantityTypeIdentifierHeartRateVariabilitySDNN', 'ms', stamp(Y, M, D, 3, 0), stamp(Y, M, D, 3, 1), (33 + c * 20 + wob * 3).toFixed(1));
  const circ = { 4: 58, 8: 74, 12: 83, 16: 86, 19: 92, 22: 71 };
  for (const h in circ) rec('HKQuantityTypeIdentifierHeartRate', 'count/min', stamp(Y, M, D, +h, 0), stamp(Y, M, D, +h, 1), circ[h]);
  const prev = new Date(dt.getTime() - 86400000);
  const PY = prev.getUTCFullYear(), PM = prev.getUTCMonth() + 1, PD = prev.getUTCDate();
  rec('HKCategoryTypeIdentifierSleepAnalysis', '', stamp(PY, PM, PD, 23, 10), stamp(Y, M, D, 2, 10), 'HKCategoryValueSleepAnalysisAsleepCore');
  rec('HKCategoryTypeIdentifierSleepAnalysis', '', stamp(Y, M, D, 2, 10), stamp(Y, M, D, 3, 10), 'HKCategoryValueSleepAnalysisAsleepDeep');
  rec('HKCategoryTypeIdentifierSleepAnalysis', '', stamp(Y, M, D, 3, 10), stamp(Y, M, D, 4, 40), 'HKCategoryValueSleepAnalysisAsleepREM');
  rec('HKCategoryTypeIdentifierSleepAnalysis', '', stamp(Y, M, D, 4, 40), stamp(Y, M, D, 6, 30), 'HKCategoryValueSleepAnalysisAsleepCore');
  if (i % 9 === 0) rec('HKQuantityTypeIdentifierVO2Max', 'mL/min·kg', stamp(Y, M, D, 12, 0), stamp(Y, M, D, 12, 1), (30 + c * 7).toFixed(1));
  if (i % 22 === 0) rec('HKQuantityTypeIdentifierBodyMass', 'lb', stamp(Y, M, D, 7, 30), stamp(Y, M, D, 7, 31), (205 - c * 11).toFixed(1));
  if (i % 2 === 0) {
    rows.push(`<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="42" durationUnit="min" totalDistance="6.4" totalDistanceUnit="km" totalEnergyBurned="440" totalEnergyBurnedUnit="kcal" startDate="${stamp(Y, M, D, 18, 0)}" endDate="${stamp(Y, M, D, 18, 42)}">`);
    rows.push('<WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="150" maximum="171" unit="count/min"/>');
    rows.push('</Workout>');
  }
}
rows.push('</HealthData>');
writeFileSync(new URL('../public/sample_export.xml', import.meta.url), rows.join('\n'));
console.log('wrote public/sample_export.xml', rows.length, 'lines');
