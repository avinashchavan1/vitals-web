// Streaming, in-browser parser for an Apple Health "Export All Health Data" archive.
// Handles export.zip (unzipped in-browser) or a raw export.xml. Aggregates online so memory
// stays bounded regardless of file size (a real export can be hundreds of MB / millions of records).
// NOTHING is uploaded — this all runs client-side.

import { Unzip, AsyncUnzipInflate } from 'fflate';

const LB_TO_KG = 0.45359237;
const MI_TO_KM = 1.609344;

// "2024-01-01 08:30:00 -0800" → epoch ms (tz-correct). Used only where a real duration is needed.
function toMs(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) ([+-])(\d\d)(\d\d)$/.exec(s);
  if (!m) return NaN;
  const [, Y, Mo, D, H, Mi, S, sign, oh, om] = m;
  const wall = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S);
  const off = (+oh * 60 + +om) * (sign === '-' ? -1 : 1);
  return wall - off * 60000;
}

const WORKOUT_NAMES = {
  Running: 'Outdoor Run', Walking: 'Walk', Cycling: 'Cycle', Elliptical: 'Elliptical',
  Rowing: 'Rowing', TraditionalStrengthTraining: 'Strength', FunctionalStrengthTraining: 'Strength',
  HighIntensityIntervalTraining: 'HIIT', Swimming: 'Swim', CoreTraining: 'Core', Yoga: 'Yoga',
  Hiking: 'Hike', StairClimbing: 'Stairs',
};

/// Online aggregator. Feed it decoded XML text in chunks.
class HealthAggregator {
  constructor(onProgress) {
    this.buf = '';
    this.records = 0;
    this.onProgress = onProgress;
    this.byDay = new Map();               // dateStr -> day bucket
    this.hourSum = new Array(24).fill(0);
    this.hourCount = new Array(24).fill(0);
    this.sleep = [];                      // {stage, startMs, endMs, wakeDay}
    this.workouts = [];
    this.minDay = null; this.maxDay = null;
    this._inWorkout = false; this._wbuf = '';
  }

  day(dateStr) {
    let d = this.byDay.get(dateStr);
    if (!d) {
      d = { steps_w: 0, steps_o: 0, energy_w: 0, energy_o: 0, rhrSum: 0, rhrN: 0,
            hrvSum: 0, hrvN: 0, hrMin: Infinity, mass: null, vo2: null };
      this.byDay.set(dateStr, d);
      if (this.minDay === null || dateStr < this.minDay) this.minDay = dateStr;
      if (this.maxDay === null || dateStr > this.maxDay) this.maxDay = dateStr;
    }
    return d;
  }

  feed(text) {
    this.buf += text;
    this.scan();
  }
  finish() { this.scan(true); }

  scan(final = false) {
    // Process complete <Record .../> and <Workout>…</Workout> elements from the buffer.
    for (;;) {
      const iR = this.buf.indexOf('<Record ');
      const iW = this.buf.indexOf('<Workout ');
      if (iR === -1 && iW === -1) { if (this.buf.length > 1 << 20) this.buf = this.buf.slice(-4096); break; }
      const useW = iW !== -1 && (iR === -1 || iW < iR);
      if (useW) {
        const end = this.buf.indexOf('</Workout>', iW);
        if (end === -1) { if (!final) { this.buf = this.buf.slice(iW); return; } break; }
        this.handleWorkout(this.buf.slice(iW, end + 10));
        this.buf = this.buf.slice(end + 10);
      } else {
        const gt = this.buf.indexOf('>', iR);
        if (gt === -1) { if (!final) { this.buf = this.buf.slice(iR); return; } break; }
        this.handleRecord(this.buf.slice(iR, gt + 1));
        this.buf = this.buf.slice(gt + 1);
      }
      if ((++this.records & 0x3fff) === 0 && this.onProgress) this.onProgress(this.records);
    }
  }

  static attrs(tag) {
    const a = {};
    const re = /(\w+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(tag))) a[m[1]] = m[2];
    return a;
  }

  handleRecord(tag) {
    const a = HealthAggregator.attrs(tag);
    const type = a.type;
    if (!type || !a.startDate) return;
    const dateStr = a.startDate.slice(0, 10);
    const v = parseFloat(a.value);
    const isWatch = (a.sourceName || '').includes('Watch');
    switch (type) {
      case 'HKQuantityTypeIdentifierStepCount': {
        const d = this.day(dateStr); if (isWatch) d.steps_w += v || 0; else d.steps_o += v || 0; break;
      }
      case 'HKQuantityTypeIdentifierActiveEnergyBurned': {
        const d = this.day(dateStr); const kcal = a.unit === 'kJ' ? (v || 0) / 4.184 : (v || 0);
        if (isWatch) d.energy_w += kcal; else d.energy_o += kcal; break;
      }
      case 'HKQuantityTypeIdentifierRestingHeartRate': { const d = this.day(dateStr); if (v) { d.rhrSum += v; d.rhrN++; } break; }
      case 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN': { const d = this.day(dateStr); if (v) { d.hrvSum += v; d.hrvN++; } break; }
      case 'HKQuantityTypeIdentifierVO2Max': { if (v) this.day(dateStr).vo2 = v; break; }
      case 'HKQuantityTypeIdentifierBodyMass': { if (v) this.day(dateStr).mass = a.unit === 'lb' ? v * LB_TO_KG : v; break; }
      case 'HKQuantityTypeIdentifierHeartRate': {
        if (v) {
          const h = +a.startDate.slice(11, 13);
          if (h >= 0 && h < 24) { this.hourSum[h] += v; this.hourCount[h]++; }
          const d = this.day(dateStr); if (v < d.hrMin) d.hrMin = v;
        }
        break;
      }
      case 'HKCategoryTypeIdentifierSleepAnalysis': {
        if (!a.endDate) break;
        const stage = (a.value || '').replace('HKCategoryValueSleepAnalysis', '');
        const startMs = toMs(a.startDate), endMs = toMs(a.endDate);
        if (isFinite(startMs) && isFinite(endMs) && endMs > startMs) {
          this.sleep.push({ stage, startMs, endMs, wakeDay: a.endDate.slice(0, 10) });
        }
        break;
      }
      default: break;
    }
  }

  handleWorkout(block) {
    const openEnd = block.indexOf('>');
    const a = HealthAggregator.attrs(block.slice(0, openEnd + 1));
    const typeRaw = (a.workoutActivityType || '').replace('HKWorkoutActivityType', '');
    const durMin = a.durationUnit === 'min' ? parseFloat(a.duration) : parseFloat(a.duration) / 60;
    let avgHR = 0, maxHR = 0, distKm = null, kcal = null;
    const statRe = /<WorkoutStatistics\b[^>]*\/?>/g;
    let sm;
    while ((sm = statRe.exec(block))) {
      const s = HealthAggregator.attrs(sm[0]);
      if (s.type === 'HKQuantityTypeIdentifierHeartRate') {
        avgHR = parseFloat(s.average) || avgHR; maxHR = parseFloat(s.maximum) || maxHR;
      } else if (s.type === 'HKQuantityTypeIdentifierDistanceWalkingRunning' || s.type === 'HKQuantityTypeIdentifierDistanceCycling') {
        const d = parseFloat(s.sum); if (d) distKm = s.unit === 'mi' ? d * MI_TO_KM : d;
      } else if (s.type === 'HKQuantityTypeIdentifierActiveEnergyBurned') {
        const e = parseFloat(s.sum); if (e) kcal = s.unit === 'kJ' ? e / 4.184 : e;
      }
    }
    if (distKm === null && a.totalDistance) distKm = a.totalDistanceUnit === 'mi' ? parseFloat(a.totalDistance) * MI_TO_KM : parseFloat(a.totalDistance);
    if (kcal === null && a.totalEnergyBurned) kcal = parseFloat(a.totalEnergyBurned);
    if (!(durMin > 0) || !a.startDate) return;
    this.workouts.push({
      typeRaw, name: WORKOUT_NAMES[typeRaw] || 'Workout', dateStr: a.startDate.slice(0, 10),
      startMs: toMs(a.startDate), durMin, avgHR, maxHR, distKm, kcal,
    });
  }
}

// ---- streaming drivers ----

async function streamXML(file, agg, onProgress) {
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let read = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    read += value.length;
    agg.feed(value);
    if (onProgress) onProgress(agg.records, read);
  }
  agg.finish();
}

async function streamZip(file, agg, onProgress) {
  const dec = new TextDecoder();
  await new Promise((resolve, reject) => {
    const unzip = new Unzip();
    unzip.register(AsyncUnzipInflate);
    let target = null;
    unzip.onfile = (f) => {
      if (/(^|\/)export\.xml$/.test(f.name) && !target) {
        target = f;
        f.ondata = (err, chunk, final) => {
          if (err) return reject(err);
          agg.feed(dec.decode(chunk, { stream: !final }));
          if (onProgress) onProgress(agg.records, 0);
          if (final) { agg.finish(); resolve(); }
        };
        f.start();
      }
    };
    (async () => {
      const reader = file.stream().getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { unzip.push(new Uint8Array(0), true); break; }
        unzip.push(value, false);
      }
      if (!target) reject(new Error('No export.xml found inside the archive.'));
    })().catch(reject);
  });
}

/// Parse an in-memory XML string (used by tests / non-browser callers).
export function parseXMLText(text) {
  const agg = new HealthAggregator();
  agg.feed(text);
  agg.finish();
  return buildDataset(agg);
}

/// Parse a dropped File and return the dataset the engine consumes.
export async function parseHealthExport(file, onProgress) {
  const agg = new HealthAggregator((n) => onProgress && onProgress({ records: n }));
  const isZip = /\.zip$/i.test(file.name) || file.type === 'application/zip';
  if (isZip) await streamZip(file, agg, (n) => onProgress && onProgress({ records: n }));
  else await streamXML(file, agg, (n) => onProgress && onProgress({ records: n }));
  return buildDataset(agg);
}

// ---- shape aggregates into the engine's day/workout model ----

function buildDataset(agg) {
  if (!agg.minDay) throw new Error('No health records found in this file.');
  const DAY = 86400000;
  const start = Date.UTC(+agg.minDay.slice(0, 4), +agg.minDay.slice(5, 7) - 1, +agg.minDay.slice(8, 10));
  const end = Date.UTC(+agg.maxDay.slice(0, 4), +agg.maxDay.slice(5, 7) - 1, +agg.maxDay.slice(8, 10));
  const n = Math.round((end - start) / DAY) + 1;

  const key = (t) => { const d = new Date(t); return d.toISOString().slice(0, 10); };

  // sleep nights (cluster < 60 min gaps, attribute to final segment's wake date)
  const nights = clusterSleep(agg.sleep);

  // workouts grouped by day
  const woByDay = new Map();
  const workouts = agg.workouts.filter(w => w.durMin > 0).sort((a, b) => a.startMs - b.startMs);

  const days = [];
  for (let i = 0; i < n; i++) {
    const t = start + i * DAY;
    const ds = key(t);
    const b = agg.byDay.get(ds);
    const steps = b ? (b.steps_w > 0 ? b.steps_w : b.steps_o) : 0;
    const rhr = b && b.rhrN ? b.rhrSum / b.rhrN : (b && isFinite(b.hrMin) ? b.hrMin : 0);
    const hrv = b && b.hrvN ? b.hrvSum / b.hrvN : 0;
    const night = nights.get(ds);
    const d = {
      i, t, steps: Math.round(steps), rhr: +rhr.toFixed(1), hrv: +hrv.toFixed(1),
      activeEnergy: b ? Math.round(b.energy_w > 0 ? b.energy_w : b.energy_o) : 0,
      sleepTotal: night ? night.total : 0, inBed: night ? night.inBed : 0,
      deep: night ? night.deep : 0, rem: night ? night.rem : 0, core: night ? night.core : 0,
      awake: night ? night.awake : 0, bedtime: night ? night.bedtime : 60, wake: night ? night.wake : 480,
      eff: night && night.inBed ? +(night.total / night.inBed * 100).toFixed(1) : 88,
      mass: b && b.mass != null ? +b.mass.toFixed(2) : null,
      vo2: b && b.vo2 != null ? +b.vo2.toFixed(2) : null,
      worked: false, durMin: 0, hrAvg: 0, sessionTrimp: 0,
    };
    days.push(d);
  }
  const idxOf = new Map(days.map((d, i) => [key(d.t), i]));

  // shape workouts + per-day session load
  const outW = [];
  for (const w of workouts) {
    const di = idxOf.get(w.dateStr);
    if (di == null) continue;
    const ws = shapeWorkout(w, di, days[di]);
    outW.push(ws);
    woByDay.set(di, (woByDay.get(di) || 0) + ws.trimp);
    const d = days[di];
    if (w.durMin > d.durMin) { d.worked = true; d.durMin = w.durMin; d.hrAvg = ws.avg; }
  }
  for (const [di, tr] of woByDay) days[di].sessionTrimp = tr;
  outW.sort((a, b) => b.t - a.t);
  outW.forEach((w, k) => { w.woIdx = k; });

  const circadian = agg.hourSum.map((s, i) => (agg.hourCount[i] ? s / agg.hourCount[i] : 0));

  return {
    days, workouts: outW, circadian,
    meta: {
      records: agg.records, dayCount: n, firstDay: agg.minDay, lastDay: agg.maxDay,
      sleepNights: nights.size, workoutCount: outW.length,
    },
  };
}

function clusterSleep(segs) {
  const nights = new Map();
  if (!segs.length) return nights;
  segs.sort((a, b) => a.startMs - b.startMs);
  let cluster = [];
  let lastEnd = null;
  const flush = () => {
    if (!cluster.length) return;
    const firstStart = Math.min(...cluster.map(s => s.startMs));
    const finalEnd = Math.max(...cluster.map(s => s.endMs));
    const wakeDay = new Date(finalEnd).toISOString().slice(0, 10);
    let deep = 0, rem = 0, core = 0, unspec = 0, awake = 0;
    for (const s of cluster) {
      const mins = (s.endMs - s.startMs) / 60000;
      if (s.stage === 'AsleepDeep') deep += mins;
      else if (s.stage === 'AsleepREM') rem += mins;
      else if (s.stage === 'AsleepCore') core += mins;
      else if (s.stage === 'AsleepUnspecified' || s.stage === 'Asleep') unspec += mins;
      else if (s.stage === 'Awake') awake += mins;
    }
    const total = Math.round(deep + rem + core + unspec);
    if (total > 30) {
      const inBed = Math.round((finalEnd - firstStart) / 60000);
      const ref = new Date(firstStart); ref.setUTCHours(22, 0, 0, 0);
      const bedtime = Math.round((firstStart - ref.getTime()) / 60000);
      const existing = nights.get(wakeDay);
      const night = { total, inBed, deep: Math.round(deep), rem: Math.round(rem),
        core: Math.round(core + unspec), awake: Math.max(0, inBed - total),
        bedtime, wake: bedtime + inBed };
      if (!existing || existing.total < total) nights.set(wakeDay, night);
    }
    cluster = [];
  };
  for (const s of segs) {
    if (lastEnd != null && s.startMs - lastEnd > 3600000) flush();
    cluster.push(s);
    lastEnd = Math.max(lastEnd ?? s.endMs, s.endMs);
  }
  flush();
  return nights;
}

function shapeWorkout(w, dayIdx, day) {
  const HRMAX = 187, HRREST = 64, reserve = HRMAX - HRREST;   // engine overwrites via config anyway
  const avg = Math.round(w.avgHR || 0);
  const max = Math.round(w.maxHR || avg);
  // synthesize a plausible HR trace from avg/max for the zone bars + HR trace visual
  const N = 24, series = [];
  for (let i = 0; i < N; i++) {
    const f = i / (N - 1);
    const v = avg ? Math.round(avg - 12 + Math.min(1, f * 4) * 12 + (max - avg) * Math.max(0, Math.sin(f * Math.PI))) : 0;
    series.push(v);
  }
  const zb = [0, 0.6, 0.7, 0.8, 0.9, 1.01].map(p => HRREST + reserve * p);
  const zoneMin = [0, 0, 0, 0, 0];
  if (avg) series.forEach(v => { for (let z = 0; z < 5; z++) if (v >= zb[z] && v < zb[z + 1]) zoneMin[z] += w.durMin / N; });
  const hrr = avg ? (avg - HRREST) / reserve : 0;
  const trimp = avg ? +(w.durMin * hrr * 0.64 * Math.exp(1.92 * hrr)).toFixed(1) : 0;
  const strain = +(21 * (1 - Math.exp(-trimp / 83))).toFixed(1);
  const gps = (w.name === 'Outdoor Run' || w.name === 'Walk' || w.name === 'Cycle') && (w.distKm || 0) > 0;
  const cad = w.name === 'Outdoor Run' && w.distKm ? Math.round(w.durMin > 0 ? (day.steps ? 160 : 168) : 168) : null;
  return {
    dayIdx, t: w.t ?? new Date(w.dateStr + 'T18:00:00Z').getTime(), type: w.name, gps,
    dur: Math.round(w.durMin), avg, max, dist: w.distKm != null ? +w.distKm.toFixed(2) : null,
    cad, drift: 0, hrr60: Math.max(0, Math.round(max - avg)), interval: false,
    trimp, strain, kcal: Math.round(w.kcal || w.durMin * 9),
    series, zoneMin: zoneMin.map(v => Math.round(v)), rec: 0,
  };
}
