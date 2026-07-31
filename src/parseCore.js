// Core Apple Health export parser — runs inside a Web Worker (see parseWorker.js) so the UI thread
// stays responsive. Streams the zip/xml and aggregates online (bounded memory). No data leaves the
// device. parse.js is the thin main-thread wrapper that drives the worker.

import { Unzip, UnzipInflate } from 'fflate'; // synchronous inflate — no nested workers

const LB_TO_KG = 0.45359237;
const MI_TO_KM = 1.609344;
const log = (...a) => { try { console.log('[vitals]', ...a); } catch {} };

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

class HealthAggregator {
  constructor(onProgress) {
    this.buf = ''; this.records = 0; this.bytes = 0; this.head = ''; this.sawHealthData = false;
    this.onProgress = onProgress; this.byDay = new Map();
    this.hourSum = new Array(24).fill(0); this.hourCount = new Array(24).fill(0);
    this.sleep = []; this.workouts = []; this.minDay = null; this.maxDay = null;
    this._lastPost = 0;
  }
  day(dateStr) {
    let d = this.byDay.get(dateStr);
    if (!d) {
      d = { steps_w: 0, steps_o: 0, energy_w: 0, energy_o: 0, rhrSum: 0, rhrN: 0, hrvSum: 0, hrvN: 0, hrMin: Infinity, mass: null, vo2: null };
      this.byDay.set(dateStr, d);
      if (this.minDay === null || dateStr < this.minDay) this.minDay = dateStr;
      if (this.maxDay === null || dateStr > this.maxDay) this.maxDay = dateStr;
    }
    return d;
  }
  feed(text) {
    if (!text) return;
    this.bytes += text.length;
    if (this.head.length < 500) this.head += text.slice(0, 500 - this.head.length);
    if (!this.sawHealthData && (this.buf + text).includes('<HealthData')) this.sawHealthData = true;
    this.buf += text;
    this.scan();
    // throttle progress posts (every ~25k records) — cheap and keeps postMessage light
    if (this.onProgress && this.records - this._lastPost >= 25000) { this._lastPost = this.records; this.onProgress({ records: this.records, bytes: this.bytes }); }
  }
  finish() { this.scan(true); if (this.onProgress) this.onProgress({ records: this.records, bytes: this.bytes }); }
  scan(final = false) {
    for (;;) {
      const iR = this.buf.indexOf('<Record ');
      const iW = this.buf.indexOf('<Workout ');
      if (iR === -1 && iW === -1) { if (this.buf.length > 1 << 20) this.buf = this.buf.slice(-4096); break; }
      const useW = iW !== -1 && (iR === -1 || iW < iR);
      if (useW) {
        const end = this.buf.indexOf('</Workout>', iW);
        if (end === -1) { if (!final) { this.buf = this.buf.slice(iW); return; } break; }
        this.handleWorkout(this.buf.slice(iW, end + 10)); this.buf = this.buf.slice(end + 10);
      } else {
        const gt = this.buf.indexOf('>', iR);
        if (gt === -1) { if (!final) { this.buf = this.buf.slice(iR); return; } break; }
        this.handleRecord(this.buf.slice(iR, gt + 1)); this.buf = this.buf.slice(gt + 1);
      }
      this.records++;
    }
  }
  static attrs(tag) { const a = {}; const re = /(\w+)="([^"]*)"/g; let m; while ((m = re.exec(tag))) a[m[1]] = m[2]; return a; }
  handleRecord(tag) {
    const a = HealthAggregator.attrs(tag); const type = a.type;
    if (!type || !a.startDate) return;
    const dateStr = a.startDate.slice(0, 10); const v = parseFloat(a.value);
    const isWatch = (a.sourceName || '').includes('Watch');
    switch (type) {
      case 'HKQuantityTypeIdentifierStepCount': { const d = this.day(dateStr); if (isWatch) d.steps_w += v || 0; else d.steps_o += v || 0; break; }
      case 'HKQuantityTypeIdentifierActiveEnergyBurned': { const d = this.day(dateStr); const kcal = a.unit === 'kJ' ? (v || 0) / 4.184 : (v || 0); if (isWatch) d.energy_w += kcal; else d.energy_o += kcal; break; }
      case 'HKQuantityTypeIdentifierRestingHeartRate': { const d = this.day(dateStr); if (v) { d.rhrSum += v; d.rhrN++; } break; }
      case 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN': { const d = this.day(dateStr); if (v) { d.hrvSum += v; d.hrvN++; } break; }
      case 'HKQuantityTypeIdentifierVO2Max': { if (v) this.day(dateStr).vo2 = v; break; }
      case 'HKQuantityTypeIdentifierBodyMass': { if (v) this.day(dateStr).mass = a.unit === 'lb' ? v * LB_TO_KG : v; break; }
      case 'HKQuantityTypeIdentifierHeartRate': { if (v) { const h = +a.startDate.slice(11, 13); if (h >= 0 && h < 24) { this.hourSum[h] += v; this.hourCount[h]++; } const d = this.day(dateStr); if (v < d.hrMin) d.hrMin = v; } break; }
      case 'HKCategoryTypeIdentifierSleepAnalysis': {
        if (!a.endDate) break;
        const stage = (a.value || '').replace('HKCategoryValueSleepAnalysis', '');
        const startMs = toMs(a.startDate), endMs = toMs(a.endDate);
        if (isFinite(startMs) && isFinite(endMs) && endMs > startMs) this.sleep.push({ stage, startMs, endMs, wakeDay: a.endDate.slice(0, 10) });
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
    const statRe = /<WorkoutStatistics\b[^>]*\/?>/g; let sm;
    while ((sm = statRe.exec(block))) {
      const s = HealthAggregator.attrs(sm[0]);
      if (s.type === 'HKQuantityTypeIdentifierHeartRate') { avgHR = parseFloat(s.average) || avgHR; maxHR = parseFloat(s.maximum) || maxHR; }
      else if (s.type === 'HKQuantityTypeIdentifierDistanceWalkingRunning' || s.type === 'HKQuantityTypeIdentifierDistanceCycling') { const d = parseFloat(s.sum); if (d) distKm = s.unit === 'mi' ? d * MI_TO_KM : d; }
      else if (s.type === 'HKQuantityTypeIdentifierActiveEnergyBurned') { const e = parseFloat(s.sum); if (e) kcal = s.unit === 'kJ' ? e / 4.184 : e; }
    }
    if (distKm === null && a.totalDistance) distKm = a.totalDistanceUnit === 'mi' ? parseFloat(a.totalDistance) * MI_TO_KM : parseFloat(a.totalDistance);
    if (kcal === null && a.totalEnergyBurned) kcal = parseFloat(a.totalEnergyBurned);
    if (!(durMin > 0) || !a.startDate) return;
    this.workouts.push({ typeRaw, name: WORKOUT_NAMES[typeRaw] || 'Workout', dateStr: a.startDate.slice(0, 10), startMs: toMs(a.startDate), durMin, avgHR, maxHR, distKm, kcal });
  }
}

// ---- streaming drivers ----

async function parseXMLStream(file, agg, onProgress) {
  const canStream = typeof file.stream === 'function' && typeof TextDecoderStream !== 'undefined';
  log('xml path, stream API:', canStream);
  if (!canStream) { agg.feed(await file.text()); agg.finish(); return; }
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let read = 0;
  for (;;) { const { value, done } = await reader.read(); if (done) break; read += value.length; agg.feed(value); onProgress && onProgress({ note: (read / 1e6).toFixed(1) + ' MB read' }); }
  agg.finish();
}

// full-buffer synchronous unzip (tests + no-stream fallback)
function unzipInto(bytes, agg, onEntry) {
  const dec = new TextDecoder();
  const unzip = new Unzip(); unzip.register(UnzipInflate);
  let matched = false, err = null; const seen = [];
  unzip.onfile = (f) => {
    seen.push(f.name); if (onEntry) onEntry(f.name);
    if (!matched && /(^|\/)export\.xml$/i.test(f.name)) {
      matched = true; log('found', f.name);
      f.ondata = (e, chunk, final) => { if (e) { err = e; return; } if (chunk && chunk.length) agg.feed(dec.decode(chunk, { stream: !final })); if (final) agg.finish(); };
      f.start();
    }
  };
  const CH = 1 << 22;
  for (let o = 0; o < bytes.length; o += CH) { unzip.push(bytes.subarray(o, Math.min(o + CH, bytes.length)), o + CH >= bytes.length); if (err) throw err; }
  return { matched, seen };
}

async function parseZipStream(file, agg, onProgress) {
  if (typeof file.stream !== 'function') {
    log('zip fallback: arrayBuffer');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { matched, seen } = unzipInto(bytes, agg, (name) => onProgress && onProgress({ note: 'reading ' + name }));
    if (!matched) throw new Error('No export.xml inside the archive. Entries: ' + (seen.slice(0, 10).join(', ') || 'none'));
    return;
  }
  const dec = new TextDecoder();
  const unzip = new Unzip(); unzip.register(UnzipInflate);
  let matched = false, thrown = null; const seen = [];
  unzip.onfile = (f) => {
    seen.push(f.name);
    onProgress && onProgress({ note: 'reading ' + f.name });
    if (!matched && /(^|\/)export\.xml$/i.test(f.name)) {
      matched = true; log('found', f.name);
      f.ondata = (e, chunk, final) => { if (e) { thrown = e; return; } if (chunk && chunk.length) agg.feed(dec.decode(chunk, { stream: !final })); if (final) agg.finish(); };
      f.start();
    }
  };
  const reader = file.stream().getReader();
  let read = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) { unzip.push(new Uint8Array(0), true); break; }
    read += value.length; unzip.push(value, false);
    if (thrown) throw thrown;
    onProgress && onProgress({ note: 'unzipping · ' + (read / 1e6).toFixed(1) + ' MB' });
  }
  if (thrown) throw thrown;
  if (!matched) throw new Error('No export.xml inside the archive. Entries seen: ' + (seen.slice(0, 10).join(', ') || 'none') + '. Is this the Health "Export All Health Data" zip?');
}

/// Actual parse (runs in the Worker). Returns the dataset.
export async function parseFile(file, onProgress) {
  log('file:', file && file.name, file && file.type, (file && file.size) + ' bytes');
  onProgress && onProgress({ note: 'reading ' + ((file && file.name) || 'file') + ' · ' + (((file && file.size) || 0) / 1e6).toFixed(1) + ' MB' });
  const agg = new HealthAggregator(onProgress);
  const isZip = /\.zip$/i.test(file.name || '') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
  log('detected:', isZip ? 'zip' : 'xml');
  if (isZip) await parseZipStream(file, agg, onProgress);
  else await parseXMLStream(file, agg, onProgress);
  return finalize(agg);
}

export function parseXMLText(text) { const agg = new HealthAggregator(); agg.feed(text); agg.finish(); return finalize(agg); }
export function parseZipBytes(bytes) { const agg = new HealthAggregator(); const { matched, seen } = unzipInto(bytes, agg); if (!matched) throw new Error('No export.xml. Entries: ' + seen.join(', ')); return finalize(agg); }

function finalize(agg) {
  log('parsed:', agg.records, 'records,', agg.bytes, 'chars,', agg.byDay.size, 'days,', agg.sleep.length, 'sleep segs,', agg.workouts.length, 'workouts');
  if (agg.records === 0 || !agg.minDay) {
    const head = agg.head.replace(/\s+/g, ' ').slice(0, 180);
    const hint = agg.bytes === 0 ? 'No data was read from the file (empty or unreadable stream).'
      : agg.sawHealthData ? 'The <HealthData> file was read but no <Record> elements matched.'
      : 'This does not look like an Apple Health export.xml.';
    throw new Error(`Read ${(agg.bytes / 1e6).toFixed(1)} MB but found 0 health records. ${hint} First bytes: “${head || '(none)'}”`);
  }
  return buildDataset(agg);
}

// ---- shape aggregates into the engine's day/workout model ----

function buildDataset(agg) {
  const DAY = 86400000;
  const start = Date.UTC(+agg.minDay.slice(0, 4), +agg.minDay.slice(5, 7) - 1, +agg.minDay.slice(8, 10));
  const end = Date.UTC(+agg.maxDay.slice(0, 4), +agg.maxDay.slice(5, 7) - 1, +agg.maxDay.slice(8, 10));
  const n = Math.round((end - start) / DAY) + 1;
  const key = (t) => new Date(t).toISOString().slice(0, 10);
  const nights = clusterSleep(agg.sleep);
  const workouts = agg.workouts.filter(w => w.durMin > 0).sort((a, b) => a.startMs - b.startMs);
  const days = [];
  for (let i = 0; i < n; i++) {
    const t = start + i * DAY; const ds = key(t); const b = agg.byDay.get(ds);
    const steps = b ? (b.steps_w > 0 ? b.steps_w : b.steps_o) : 0;
    const rhr = b && b.rhrN ? b.rhrSum / b.rhrN : (b && isFinite(b.hrMin) ? b.hrMin : 0);
    const hrv = b && b.hrvN ? b.hrvSum / b.hrvN : 0;
    const night = nights.get(ds);
    days.push({
      i, t, steps: Math.round(steps), rhr: +rhr.toFixed(1), hrv: +hrv.toFixed(1),
      activeEnergy: b ? Math.round(b.energy_w > 0 ? b.energy_w : b.energy_o) : 0,
      sleepTotal: night ? night.total : 0, inBed: night ? night.inBed : 0, deep: night ? night.deep : 0, rem: night ? night.rem : 0, core: night ? night.core : 0, awake: night ? night.awake : 0,
      bedtime: night ? night.bedtime : 60, wake: night ? night.wake : 480, eff: night && night.inBed ? +(night.total / night.inBed * 100).toFixed(1) : 88,
      mass: b && b.mass != null ? +b.mass.toFixed(2) : null, vo2: b && b.vo2 != null ? +b.vo2.toFixed(2) : null,
      worked: false, durMin: 0, hrAvg: 0, sessionTrimp: 0,
    });
  }
  const idxOf = new Map(days.map((d, i) => [key(d.t), i]));
  const woByDay = new Map(); const outW = [];
  for (const w of workouts) {
    const di = idxOf.get(w.dateStr); if (di == null) continue;
    const ws = shapeWorkout(w, di, days[di]); outW.push(ws);
    woByDay.set(di, (woByDay.get(di) || 0) + ws.trimp);
    const d = days[di]; if (w.durMin > d.durMin) { d.worked = true; d.durMin = w.durMin; d.hrAvg = ws.avg; }
  }
  for (const [di, tr] of woByDay) days[di].sessionTrimp = tr;
  outW.sort((a, b) => b.t - a.t); outW.forEach((w, k) => { w.woIdx = k; });
  const circadian = agg.hourSum.map((s, i) => (agg.hourCount[i] ? s / agg.hourCount[i] : 0));
  return { days, workouts: outW, circadian, meta: { records: agg.records, dayCount: n, firstDay: agg.minDay, lastDay: agg.maxDay, sleepNights: nights.size, workoutCount: outW.length } };
}

function clusterSleep(segs) {
  const nights = new Map();
  if (!segs.length) return nights;
  segs.sort((a, b) => a.startMs - b.startMs);
  let cluster = [], lastEnd = null;
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
      const night = { total, inBed, deep: Math.round(deep), rem: Math.round(rem), core: Math.round(core + unspec), awake: Math.max(0, inBed - total), bedtime, wake: bedtime + inBed };
      if (!existing || existing.total < total) nights.set(wakeDay, night);
    }
    cluster = [];
  };
  for (const s of segs) { if (lastEnd != null && s.startMs - lastEnd > 3600000) flush(); cluster.push(s); lastEnd = Math.max(lastEnd ?? s.endMs, s.endMs); }
  flush();
  return nights;
}

function shapeWorkout(w, dayIdx, day) {
  const HRMAX = 187, HRREST = 64, reserve = HRMAX - HRREST;
  const avg = Math.round(w.avgHR || 0), max = Math.round(w.maxHR || avg);
  const N = 24, series = [];
  for (let i = 0; i < N; i++) { const f = i / (N - 1); const v = avg ? Math.round(avg - 12 + Math.min(1, f * 4) * 12 + (max - avg) * Math.max(0, Math.sin(f * Math.PI))) : 0; series.push(v); }
  const zb = [0, 0.6, 0.7, 0.8, 0.9, 1.01].map(p => HRREST + reserve * p);
  const zoneMin = [0, 0, 0, 0, 0];
  if (avg) series.forEach(v => { for (let z = 0; z < 5; z++) if (v >= zb[z] && v < zb[z + 1]) zoneMin[z] += w.durMin / N; });
  const hrr = avg ? (avg - HRREST) / reserve : 0;
  const trimp = avg ? +(w.durMin * hrr * 0.64 * Math.exp(1.92 * hrr)).toFixed(1) : 0;
  const strain = +(21 * (1 - Math.exp(-trimp / 83))).toFixed(1);
  const gps = (w.name === 'Outdoor Run' || w.name === 'Walk' || w.name === 'Cycle') && (w.distKm || 0) > 0;
  const cad = w.name === 'Outdoor Run' && w.distKm ? 162 : null;
  return { dayIdx, t: w.startMs || new Date(w.dateStr + 'T18:00:00Z').getTime(), type: w.name, gps, dur: Math.round(w.durMin), avg, max, dist: w.distKm != null ? +w.distKm.toFixed(2) : null, cad, drift: 0, hrr60: Math.max(0, Math.round(max - avg)), interval: false, trimp, strain, kcal: Math.round(w.kcal || w.durMin * 9), series, zoneMin: zoneMin.map(v => Math.round(v)), rec: 0 };
}
