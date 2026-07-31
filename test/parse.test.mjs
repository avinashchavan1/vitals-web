// Node harness: synthesize a realistic Apple Health export.xml, parse it with the real parser,
// run the real engine, and assert the derived metrics are sane. Proves the real-data path.
import { parseXMLText } from '../src/parse.js';
import { Engine, INITIAL_STATE, PROPS } from '../src/engine.js';

function two(n) { return String(n).padStart(2, '0'); }
function stamp(y, mo, d, h, mi) { return `${y}-${two(mo)}-${two(d)} ${two(h)}:${two(mi)}:00 -0700`; }

const rows = ['<?xml version="1.0" encoding="UTF-8"?>', '<HealthData locale="en_US">'];
const rec = (type, unit, s, e, val, src = 'Apple Watch') =>
  rows.push(`<Record type="${type}" sourceName="${src}" unit="${unit}" startDate="${s}" endDate="${e}" value="${val}"/>`);

const NDAYS = 70;
const y = 2026, mo = 5; // build within May–Jul 2026 range; use day offsets
const base = new Date(Date.UTC(2026, 4, 1)); // 1 May 2026
for (let i = 0; i < NDAYS; i++) {
  const dt = new Date(base.getTime() + i * 86400000);
  const Y = dt.getUTCFullYear(), M = dt.getUTCMonth() + 1, D = dt.getUTCDate();
  const climb = i / (NDAYS - 1);
  // daily aggregates
  rec('HKQuantityTypeIdentifierStepCount', 'count', stamp(Y, M, D, 9, 0), stamp(Y, M, D, 9, 10), Math.round(4000 + climb * 6000));
  rec('HKQuantityTypeIdentifierActiveEnergyBurned', 'kcal', stamp(Y, M, D, 9, 0), stamp(Y, M, D, 9, 10), Math.round(300 + climb * 300));
  rec('HKQuantityTypeIdentifierRestingHeartRate', 'count/min', stamp(Y, M, D, 8, 0), stamp(Y, M, D, 8, 1), (70 - climb * 8).toFixed(1));
  rec('HKQuantityTypeIdentifierHeartRateVariabilitySDNN', 'ms', stamp(Y, M, D, 3, 0), stamp(Y, M, D, 3, 1), (35 + climb * 20).toFixed(1));
  // hourly heart rate (for circadian) — nadir at night, peak evening
  const circ = { 4: 58, 8: 74, 12: 82, 16: 86, 19: 92, 22: 72 };
  for (const h in circ) rec('HKQuantityTypeIdentifierHeartRate', 'count/min', stamp(Y, M, D, +h, 0), stamp(Y, M, D, +h, 1), circ[h]);
  // sleep the night before, ending this morning
  const prev = new Date(dt.getTime() - 86400000);
  const PY = prev.getUTCFullYear(), PM = prev.getUTCMonth() + 1, PD = prev.getUTCDate();
  rec('HKCategoryTypeIdentifierSleepAnalysis', '', stamp(PY, PM, PD, 23, 10), stamp(Y, M, D, 2, 0), 'HKCategoryValueSleepAnalysisAsleepCore');
  rec('HKCategoryTypeIdentifierSleepAnalysis', '', stamp(Y, M, D, 2, 0), stamp(Y, M, D, 3, 0), 'HKCategoryValueSleepAnalysisAsleepDeep');
  rec('HKCategoryTypeIdentifierSleepAnalysis', '', stamp(Y, M, D, 3, 0), stamp(Y, M, D, 4, 30), 'HKCategoryValueSleepAnalysisAsleepREM');
  rec('HKCategoryTypeIdentifierSleepAnalysis', '', stamp(Y, M, D, 4, 30), stamp(Y, M, D, 6, 20), 'HKCategoryValueSleepAnalysisAsleepCore');
  // sparse vo2 + mass
  if (i % 10 === 0) rec('HKQuantityTypeIdentifierVO2Max', 'mL/min·kg', stamp(Y, M, D, 12, 0), stamp(Y, M, D, 12, 1), (31 + climb * 6).toFixed(1));
  if (i % 20 === 0) rec('HKQuantityTypeIdentifierBodyMass', 'lb', stamp(Y, M, D, 7, 30), stamp(Y, M, D, 7, 31), (203 - climb * 10).toFixed(1)); // lb → tests conversion
  // workout every other day
  if (i % 2 === 0) {
    rows.push(`<Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="42" durationUnit="min" totalDistance="6.5" totalDistanceUnit="km" totalEnergyBurned="450" totalEnergyBurnedUnit="kcal" startDate="${stamp(Y, M, D, 18, 0)}" endDate="${stamp(Y, M, D, 18, 42)}">`);
    rows.push('<WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="150" maximum="172" unit="count/min"/>');
    rows.push('</Workout>');
  }
}
rows.push('</HealthData>');
const xml = rows.join('\n');

// ---- parse + engine ----
const ds = parseXMLText(xml);
globalThis.__vitalsReal = ds;
globalThis.__htCache = {};
const eng = new Engine(PROPS, { ...INITIAL_STATE }, () => {});
const v = eng.renderVals();
const derived = eng.data;   // raw parsed days are undrived; engine.data() runs derive()

function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) process.exitCode = 1;
}

console.log('--- dataset ---');
console.log(`records=${ds.meta.records} days=${ds.meta.dayCount} nights=${ds.meta.sleepNights} workouts=${ds.meta.workoutCount}`);
console.log(`first=${ds.meta.firstDay} last=${ds.meta.lastDay}`);
const D = derived[derived.length - 1];
console.log(`today: recovery=${D.recovery} strain=${D.strain} sleepScore=${D.sleepScore} acwr=${D.acwr} rhr=${D.rhr} hrv=${D.hrv} mass=${D.mass} vo2=${D.vo2Shown}`);
console.log(`circadian note: ${v.circadian.note}`);
console.log(`explore: ${v.explore.finding} (r=${v.explore.findingR}, n=${v.explore.findingN})`);
console.log('--- checks ---');
check('days span ~70', ds.meta.dayCount >= 69 && ds.meta.dayCount <= 72, `${ds.meta.dayCount}`);
check('sleep nights parsed', ds.meta.sleepNights >= 60, `${ds.meta.sleepNights}`);
check('workouts parsed', ds.meta.workoutCount >= 30, `${ds.meta.workoutCount}`);
check('recovery in range', D.recovery >= 0 && D.recovery <= 100, `${D.recovery}`);
check('acwr finite', isFinite(D.acwr) && D.acwr > 0, `${D.acwr}`);
check('rhr recovered (~62)', D.rhr > 55 && D.rhr < 66, `${D.rhr}`);
check('hrv rising (~55)', D.hrv > 45, `${D.hrv}`);
check('mass lb→kg (~87.5)', D.mass > 84 && D.mass < 90, `${D.mass}`);
check('vo2 measured (~37)', D.vo2Shown > 34 && D.vo2Shown < 39, `${D.vo2Shown}`);
check('circadian has profile', v.circadian.has === true);
check('sleep total sane (5–9h)', D.sleepTotal > 300 && D.sleepTotal < 540, `${D.sleepTotal} min`);
check('workout distance km', ds.workouts[0] && ds.workouts[0].dist > 5 && ds.workouts[0].dist < 8, `${ds.workouts[0] && ds.workouts[0].dist}`);
check('trend renders', typeof v.trend.path === 'string' && v.trend.path.length > 0);
check('week renders', v.week.totals.length === 4);
