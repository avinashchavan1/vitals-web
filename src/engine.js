// Metrics engine. The derive() pipeline (baselines, TRIMP/ACWR, recovery/strain/sleep scores,
// VO2 decomposition, EF) runs identically on real parsed HealthKit data or a synthetic preview.
// Real data is injected on globalThis.__vitalsReal by App after parsing the Health export.

export class Engine {
  constructor(props, state, setState) { this.props = props; this.state = state; this._setState = setState; }
  setState(patch) { this._setState((prev) => ({ ...prev, ...patch })); }

  // ---------- utilities ----------
  lerp(a, b, t) { return a + (b - a) * t; }
  hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
  mix(c1, c2, t) { const a = this.hex(c1), b = this.hex(c2); return 'rgb(' + Math.round(this.lerp(a[0], b[0], t)) + ',' + Math.round(this.lerp(a[1], b[1], t)) + ',' + Math.round(this.lerp(a[2], b[2], t)) + ')'; }
  ramp(stops, t) { t = Math.max(0, Math.min(1, t)); const n = stops.length - 1; const i = Math.min(n - 1, Math.floor(t * n)); return this.mix(stops[i], stops[i + 1], t * n - i); }
  mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
  sd(a) { if (a.length < 2) return 1; const m = this.mean(a); return Math.sqrt(this.mean(a.map((v) => (v - m) * (v - m)))) || 1; }
  fmtHM(min) { const h = Math.floor(min / 60), m = Math.round(min % 60); return h + 'h ' + (m < 10 ? '0' : '') + m + 'm'; }
  ymd(t) { const d = new Date(t); const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']; return d.getUTCDate() + ' ' + M[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  rng(seed) { let a = seed >>> 0; return function () { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  interpAnchors(anchors, t) {
    if (t <= anchors[0][0]) return anchors[0][1];
    for (let i = 1; i < anchors.length; i++) if (t <= anchors[i][0]) { const p = anchors[i - 1], q = anchors[i]; return this.lerp(p[1], q[1], (t - p[0]) / (q[0] - p[0])); }
    return anchors[anchors.length - 1][1];
  }

  get $c() { return globalThis.__htCache || (globalThis.__htCache = {}); }
  get real() { return globalThis.__vitalsReal || null; }
  get SK() { return 83; }
  HRMAX() { return this.props.hrMax ?? 187; }
  HRREST() { return this.props.hrRest ?? 64; }

  // ---------- data ----------
  get data() {
    if (this.$c.data) return this.$c.data;
    const days = this.real ? this.real.days.map((d) => ({ ...d })) : this.synthDays();
    this.derive(days);
    this.$c.data = days;
    return days;
  }

  derive(days) {
    const n = days.length;
    days.forEach((d) => { d.trimp = (d.sessionTrimp || 0) + +(((d.steps || 0) * 0.0038).toFixed(1)); });

    // body mass provenance
    let lastM = null;
    for (let i = 0; i < n; i++) {
      if (days[i].mass != null) { days[i].massSrc = 'measured'; lastM = i; continue; }
      let nx = -1; for (let j = i + 1; j < n; j++) if (days[j].mass != null) { nx = j; break; }
      if (lastM != null && nx > 0) { days[i].mass = +this.lerp(days[lastM].mass, days[nx].mass, (i - lastM) / (nx - lastM)).toFixed(2); days[i].massSrc = 'interpolated'; }
      else if (lastM != null) { days[i].mass = days[lastM].mass; days[i].massSrc = 'extrapolated'; }
      else if (nx > 0) { days[i].mass = days[nx].mass; days[i].massSrc = 'extrapolated'; }
      else { days[i].mass = 0; days[i].massSrc = 'extrapolated'; }
    }

    // VO2 carry-forward, staleness-aware
    const firstV = days.findIndex((d) => d.vo2 != null);
    let lv = null, lvi = 0;
    days.forEach((d) => {
      if (d.vo2 != null) { lv = d.vo2; lvi = d.i; }
      d.vo2Shown = lv != null ? lv : (firstV >= 0 ? days[firstV].vo2 : 0);
      d.vo2StaleDays = d.i - lvi; d.vo2Measured = d.vo2 != null;
    });

    // rolling derived
    days.forEach((d, i) => {
      const w = days.slice(Math.max(0, i - 30), i);
      const hb = this.mean(w.map((x) => x.hrv).filter((v) => v > 0)), hs = this.sd(w.map((x) => x.hrv).filter((v) => v > 0));
      const rb = this.mean(w.map((x) => x.rhr).filter((v) => v > 0)), rs = this.sd(w.map((x) => x.rhr).filter((v) => v > 0));
      d.hrvBase = +(hb || d.hrv).toFixed(1); d.hrvSd = hs || 1; d.rhrBase = +(rb || d.rhr).toFixed(1); d.rhrSd = rs || 1;
      const w14 = days.slice(Math.max(0, i - 14), i);
      d.debt14 = Math.round(w14.reduce((s, x) => s + Math.max(0, 480 - x.sleepTotal), 0));
      const beds = w14.filter((x) => x.sleepTotal > 0).map((x) => x.bedtime).sort((a, b) => a - b);
      const bedMed = beds.length ? beds[Math.floor(beds.length / 2)] : d.bedtime;
      const yTrimp = i > 0 ? days[i - 1].trimp : 0;
      if (d.sleepTotal > 0 && d.inBed > 0) {
        const need = 480 + Math.min(d.debt14 * 0.35, 90) + (yTrimp / 100) * 15;
        d.sleepNeed = Math.round(need);
        const dur = Math.min(d.sleepTotal / need, 1), effc = d.sleepTotal / d.inBed;
        const cons = 1 - Math.min(Math.abs(d.bedtime - bedMed) / 120, 1);
        const deepc = d.deep > 0 ? Math.min(d.deep / (d.sleepTotal * 0.18), 1) : 0;
        d.sleepParts = { dur, effc, cons, deepc };
        d.sleepScore = Math.round(100 * (0.45 * dur + 0.20 * effc + 0.20 * cons + 0.15 * deepc));
      } else { d.sleepNeed = 480; d.sleepParts = { dur: 0, effc: 0, cons: 0, deepc: 0 }; d.sleepScore = 0; }
      const a7 = this.mean(days.slice(Math.max(0, i - 6), i + 1).map((x) => x.trimp));
      const c28 = this.mean(days.slice(Math.max(0, i - 27), i + 1).map((x) => x.trimp));
      d.acute = a7; d.chronic = c28; d.acwr = c28 > 0 ? +(a7 / c28).toFixed(2) : 1;
      d.zHrv = d.hrv > 0 ? (d.hrv - d.hrvBase) / d.hrvSd : 0;
      d.zRhr = d.rhr > 0 ? -(d.rhr - d.rhrBase) / d.rhrSd : 0;
      d.zLoad = -(d.acwr - 1);
      const raw = 0.40 * d.zHrv + 0.25 * d.zRhr + 0.25 * (d.sleepScore / 100 * 2 - 1) + 0.10 * d.zLoad;
      d.recovery = Math.round(100 / (1 + Math.exp(-1.2 * raw)));
      d.strain = +(21 * (1 - Math.exp(-d.trimp / this.SK))).toFixed(1);
      d.ef = (d.worked && d.hrAvg > 0) ? +(((d.durMin * 1000 * (2.55 + (d.vo2Shown - 30) * 0.055)) / (d.durMin * 60)) / d.hrAvg).toFixed(4) : null;
    });
  }

  // synthetic preview (no file) — the trough→climb story, no pinned values
  synthDays() {
    const U = (y, m, d) => Date.UTC(y, m, d);
    const A = [[U(2022, 8, 1), 0], [U(2023, 5, 1), 1], [U(2024, 2, 1), 2], [U(2024, 10, 1), 3], [U(2025, 3, 1), 4], [U(2025, 7, 1), 5], [U(2025, 11, 1), 6], [U(2026, 1, 1), 7], [U(2026, 6, 28), 8]];
    const mk = (v) => A.map((a, i) => [a[0], v[i]]);
    const S = { steps: mk([6800, 7400, 7000, 6100, 3200, 2500, 3400, 6200, 9400]), rhr: mk([68, 67, 67, 68, 71, 72, 71, 68, 62.5]), hrv: mk([44, 46, 45, 42, 36, 33, 35, 41, 50]), sleep: mk([398, 404, 394, 384, 374, 368, 378, 392, 412]), mass: mk([88.2, 89.4, 90.6, 91.6, 92.6, 93.1, 92.7, 92.0, 87.3]), vo2: mk([34.1, 35, 34.6, 33.2, 31.5, 30.2, 30, 30.6, 37.1]), load: mk([0.55, 0.62, 0.58, 0.44, 0.18, 0.12, 0.22, 0.5, 0.82]) };
    const DAY = 86400000, start = U(2022, 8, 1), end = U(2026, 6, 28), n = Math.round((end - start) / DAY) + 1;
    const r = this.rng(20260728), days = [];
    let nextM = 0, nextV = 0;
    for (let i = 0; i < n; i++) {
      const t = start + i * DAY, dow = new Date(t).getUTCDay(), we = (dow === 0 || dow === 6);
      const base = (k) => this.interpAnchors(S[k], t);
      const nz = (s) => (r() + r() + r() - 1.5) * s;
      const steps = Math.max(400, Math.round(base('steps') * (we ? 0.86 : 1.03) + nz(1400)));
      const rhr = +(base('rhr') + nz(2.2)).toFixed(1);
      const hrv = Math.max(14, +(base('hrv') + nz(7)).toFixed(1));
      const sleepTotal = Math.max(170, Math.round(base('sleep') + nz(62) + (we ? 22 : 0)));
      const eff = Math.min(0.97, 0.885 + nz(0.035)), inBed = Math.round(sleepTotal / eff);
      const deep = Math.round(sleepTotal * (0.098 + nz(0.022))), rem = Math.round(sleepTotal * (0.19 + nz(0.03)));
      const bedtime = Math.round(60 + nz(38)), wake = bedtime + inBed;
      const worked = r() < base('load');
      let durMin = 0, hrAvg = 0, sessionTrimp = 0;
      if (worked) { durMin = Math.round(32 + r() * 46); hrAvg = Math.round(126 + r() * 36); const hrr = (hrAvg - 64) / (this.HRMAX() - 64); sessionTrimp = +(durMin * hrr * 0.64 * Math.exp(1.92 * hrr)).toFixed(1); }
      const d = { i, t, steps, rhr, hrv, sleepTotal, inBed, deep, rem, core: sleepTotal - deep - rem, awake: inBed - sleepTotal, eff: +(eff * 100).toFixed(1), bedtime, wake, worked, durMin, hrAvg, sessionTrimp, mass: null, vo2: null, activeEnergy: Math.round(steps * 0.045) };
      if (i >= nextM) { d.mass = +(base('mass') + nz(0.35)).toFixed(2); nextM = i + 34 + Math.floor(r() * 16); }
      if (i >= nextV && worked) { d.vo2 = +(base('vo2') + nz(0.5)).toFixed(2); nextV = i + 8 + Math.floor(r() * 7); }
      days.push(d);
    }
    return days;
  }

  get workouts() {
    if (this.$c.wos) return this.$c.wos;
    if (this.real) { const wos = this.real.workouts.map((w) => ({ ...w, rec: (this.data[w.dayIdx] || {}).recovery || 0 })); this.$c.wos = wos; return wos; }
    // synthetic preview workouts
    const days = this.data, n = days.length, out = [];
    days.forEach((d) => { if (d.worked) out.push(this.synthWorkout(d)); });
    out.reverse();
    this.$c.wos = out; return out;
  }
  synthWorkout(d) {
    const kinds = ['Elliptical', 'Indoor Cycle', 'Outdoor Run', 'Rowing', 'Strength'];
    const type = kinds[d.i % 5], gps = type === 'Outdoor Run';
    const avg = d.hrAvg || 140, max = Math.min(this.HRMAX() - 2, avg + 20);
    const N = 24, series = [];
    for (let i = 0; i < N; i++) { const f = i / (N - 1); series.push(Math.round(avg - 12 + Math.min(1, f * 4) * 12 + (max - avg) * Math.max(0, Math.sin(f * Math.PI)))); }
    const zb = [0, 0.6, 0.7, 0.8, 0.9, 1.01].map((p) => this.HRREST() + (this.HRMAX() - this.HRREST()) * p);
    const zoneMin = [0, 0, 0, 0, 0]; series.forEach((v) => { for (let z = 0; z < 5; z++) if (v >= zb[z] && v < zb[z + 1]) zoneMin[z] += d.durMin / N; });
    return { dayIdx: d.i, t: d.t, type, gps, dur: d.durMin, avg, max, dist: gps ? +(9.4 * d.durMin / 60).toFixed(2) : null, cad: gps ? 162 : null, drift: 3, hrr60: Math.round(max - avg), interval: false, trimp: d.sessionTrimp, strain: +(21 * (1 - Math.exp(-d.sessionTrimp / this.SK))).toFixed(1), kcal: Math.round(d.durMin * 10.6), series, zoneMin: zoneMin.map((v) => Math.round(v)), rec: d.recovery };
  }

  session() {
    const wos = this.workouts;
    if (wos.length) return wos[0];
    return { type: '—', dur: 0, avg: 0, max: 0, trimp: 0, strain: 0, drift: 0, hrr60: 0, kcal: 0, zoneMin: [0, 0, 0, 0, 0], series: [] };
  }

  circadianProfile() {
    if (this.real && this.real.circadian && this.real.circadian.some((v) => v > 0)) return this.real.circadian;
    return [62, 60, 59, 58, 58, 60, 66, 74, 84, 88, 86, 84, 87, 89, 86, 84, 88, 92, 90, 84, 78, 72, 68, 64];
  }

  // ---------- chart helpers ----------
  line(vals, w, h, padT, padB, padL) {
    const ok = vals.filter((v) => v != null); let mn = Math.min.apply(null, ok), mx = Math.max.apply(null, ok);
    if (!isFinite(mn)) { mn = 0; mx = 1; } if (mx - mn < 1e-6) mx = mn + 1;
    const pad = (mx - mn) * 0.12; mn -= pad; mx += pad;
    const X = (i) => padL + (w - padL) * (vals.length < 2 ? 0 : i / (vals.length - 1));
    const Y = (v) => padT + (h - padT - padB) * (1 - (v - mn) / (mx - mn));
    let p = '', started = false;
    vals.forEach((v, i) => { if (v == null) { started = false; return; } p += (started ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1) + ' '; started = true; });
    return { path: p, X, Y, mn, mx };
  }
  roll(vals, k) { return vals.map((v, i) => { const w = vals.slice(Math.max(0, i - k + 1), i + 1).filter((x) => x != null); return w.length ? this.mean(w) : null; }); }
  pearson(x, y) {
    const px = [], py = [];
    for (let i = 0; i < x.length; i++) if (x[i] != null && y[i] != null && isFinite(x[i]) && isFinite(y[i])) { px.push(x[i]); py.push(y[i]); }
    if (px.length < 8) return 0;
    const mx = this.mean(px), my = this.mean(py); let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < px.length; i++) { const a = px[i] - mx, b = py[i] - my; num += a * b; dx += a * a; dy += b * b; }
    return (dx && dy) ? num / Math.sqrt(dx * dy) : 0;
  }

  // ---------- canvases ----------
  ribbonColor(d, metric) {
    const risk = ['#E05252', '#E8A33D', '#4CC2D6', '#5BC98B'], cool = ['#131A22', '#1E4A5A', '#4CC2D6', '#A9EAF3'];
    if (metric === 'recovery') return this.ramp(risk, (d.recovery - 15) / 70);
    if (metric === 'strain') return this.ramp(cool, d.strain / 19);
    if (metric === 'sleep') return this.ramp(cool, (d.sleepTotal - 240) / 280);
    if (metric === 'steps') return this.ramp(cool, d.steps / 13000);
    if (metric === 'hrv') return this.ramp(cool, (d.hrv - 20) / 45);
    return this.ramp(risk, (d.recovery - 15) / 70);
  }
  drawRibbon(cv) {
    if (!cv) return; const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
    cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0B0F14'; g.fillRect(0, 0, W, H);
    const days = this.data, m = this.state.ribbonMetric, cw = W / days.length;
    days.forEach((d, i) => { g.fillStyle = this.ribbonColor(d, m); g.fillRect(i * cw, 0, Math.max(cw, 0.7), H); });
    g.fillStyle = 'rgba(11,15,20,0.85)';
    days.forEach((d, i) => { const dt = new Date(d.t); if (dt.getUTCMonth() === 0 && dt.getUTCDate() === 1) g.fillRect(i * cw, 0, 1, H); });
    const si = this.state.scrubIdx; if (si != null) { g.fillStyle = '#E6EDF3'; g.fillRect(si * cw - 0.5, 0, 1.6, H); }
  }
  drawEcg(cv) {
    if (!cv) return; const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; if (!W || !H) return;
    cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#12090B'; g.fillRect(0, 0, W, H); const sm = W / 50;
    for (let x = 0; x <= W; x += sm) { g.strokeStyle = (Math.round(x / sm) % 5 === 0) ? '#4A2A2E' : '#2A1B1E'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    for (let y = 0; y <= H; y += sm) { g.strokeStyle = (Math.round(y / sm) % 5 === 0) ? '#4A2A2E' : '#2A1B1E'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    const dur = 6, fs = 256, N = dur * fs, rr = 60 / 62, mid = H * 0.55;
    g.strokeStyle = '#E6EDF3'; g.lineWidth = 1.3; g.beginPath();
    for (let i = 0; i < N; i++) { const t = i / fs, ph = (t % rr) / rr; let v = 0; const G = (c, w, a) => a * Math.exp(-Math.pow((ph - c) / w, 2)); v += G(0.13, 0.028, 0.10); v -= G(0.215, 0.008, 0.055); v += G(0.24, 0.009, 1.0); v -= G(0.268, 0.011, 0.16); v += G(0.40, 0.045, 0.26); const x = W * (i / N), y = mid - v * H * 0.34; if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); }
    g.stroke();
  }
  paint() { this.drawRibbon(this._mini); this.drawRibbon(this._tall); this.drawRibbon(this._desk); this.drawEcg(this._ecg); }

  // ---------- panels ----------
  recoveryComponents(d) {
    const z = (v) => (v >= 0 ? '+' : '') + v.toFixed(2) + 'σ'; const col = (v) => v > 0.25 ? '#5BC98B' : v < -0.25 ? '#E05252' : '#E8A33D'; const pct = (v) => Math.round(Math.max(4, Math.min(100, 50 + v * 22)));
    const dr = d.rhrBase - d.rhr; const band = d.acwr < 0.8 ? 'below the adaptation window' : d.acwr <= 1.3 ? 'inside the adaptation window, so almost no penalty' : 'above the adaptation window';
    return [
      { name: 'HRV vs 30d', weight: '0.40', readout: z(d.zHrv), color: col(d.zHrv), pct: pct(d.zHrv), note: d.hrv.toFixed(1) + ' ms against a ' + d.hrvBase.toFixed(1) + ' ms baseline.' },
      { name: 'Resting HR', weight: '0.25', readout: z(d.zRhr), color: col(d.zRhr), pct: pct(d.zRhr), note: d.rhr.toFixed(0) + ' bpm, ' + Math.abs(dr).toFixed(1) + (dr >= 0 ? ' below' : ' above') + ' the 30-day baseline.' },
      { name: 'Sleep score', weight: '0.25', readout: d.sleepScore + '/100', color: d.sleepScore >= 70 ? '#5BC98B' : '#E8A33D', pct: d.sleepScore, note: this.fmtHM(d.sleepTotal) + ' against a ' + this.fmtHM(d.sleepNeed) + ' need.' },
      { name: 'Load penalty', weight: '0.10', readout: z(d.zLoad), color: col(d.zLoad), pct: pct(d.zLoad), note: 'ACWR ' + d.acwr.toFixed(2) + ' sits ' + band + '.' },
    ];
  }
  strainComponents(d, w, avg7) {
    const z4 = (w.zoneMin[3] || 0) + (w.zoneMin[4] || 0);
    return [
      { name: 'TRIMP today', weight: '—', readout: d.trimp.toFixed(0), color: '#4CC2D6', pct: Math.min(100, d.trimp / 1.8), note: 'Session ' + w.trimp + ' plus ' + Math.max(0, Math.round(d.trimp - w.trimp)) + ' ambulatory.' },
      { name: 'Zone 2 minutes', weight: '—', readout: (w.zoneMin[1] || 0) + ' min', color: '#4CC2D6', pct: Math.min(100, (w.zoneMin[1] || 0)), note: 'Base-building band for these constants.' },
      { name: 'Zone 4+ minutes', weight: '—', readout: z4 + ' min', color: '#E8A33D', pct: Math.min(100, z4 * 3), note: 'Threshold exposure.' },
      { name: '7d rolling strain', weight: '—', readout: avg7.toFixed(1) + ' avg', color: '#5BC98B', pct: Math.round(avg7 / 21 * 100), note: 'Rolling weekly load.' },
    ];
  }
  sleepComponents(d) {
    const p = d.sleepParts; const row = (n, w, v, note) => ({ name: n, weight: w, readout: Math.round(Math.min(1, v) * 100) + '%', color: v >= 0.9 ? '#5BC98B' : v >= 0.75 ? '#E8A33D' : '#E05252', pct: Math.round(Math.min(1, v) * 100), note });
    return [
      row('Duration', '0.45', p.dur, d.sleepTotal + ' min slept against a ' + d.sleepNeed + ' min need.'),
      row('Efficiency', '0.20', p.effc, d.sleepTotal + ' asleep of ' + d.inBed + ' in bed.'),
      row('Consistency', '0.20', p.cons, 'Onset within ' + Math.round((1 - p.cons) * 120) + ' min of the 14-night median.'),
      row('Deep', '0.15', p.deepc, d.deep + ' min deep = ' + (d.sleepTotal ? (d.deep / d.sleepTotal * 100).toFixed(1) : 0) + '% of sleep.'),
    ];
  }

  renderVals() {
    const days = this.data, n = days.length, D = days[n - 1], st = this.state;
    const set = (k, v) => () => this.setState({ [k]: v });
    const cyan = '#4CC2D6', warm = '#E8A33D', alert = '#E05252', pos = '#5BC98B', muted = '#7D8FA3', paper = '#E6EDF3', line = '#232C38';
    const recColor = D.recovery >= 67 ? pos : D.recovery >= 34 ? warm : alert; const C = 314.159;

    const tabDefs = [['today', 'Today'], ['trends', 'Trend'], ['train', 'Train'], ['week', 'Week'], ['sleep', 'Sleep'], ['fitness', 'Body'], ['cardio', 'Heart'], ['explore', 'Lab']];
    const tabs = tabDefs.map(([k, l]) => ({ label: l, color: (st.tab === k || (k === 'today' && st.tab === 'ribbon')) ? cyan : muted, onClick: set('tab', k) }));
    const deskNav = tabDefs.concat([['ribbon', 'Ribbon']]).map(([k, l]) => ({ label: l, color: st.tab === k ? paper : muted, rule: st.tab === k ? cyan : 'transparent', onClick: set('tab', k) }));

    const DN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dT = new Date(D.t), d0 = new Date(days[Math.max(0, n - 7)].t);
    const weekWindow = d0.getUTCDate() + (d0.getUTCMonth() === dT.getUTCMonth() ? '' : ' ' + MN[d0.getUTCMonth()]) + ' – ' + dT.getUTCDate() + ' ' + MN[dT.getUTCMonth()];
    const titles = { today: ['Ready state', DN[dT.getUTCDay()] + ' · ' + dT.getUTCDate() + ' ' + MN[dT.getUTCMonth()]], trends: ['Trends', 'Any metric, any window'], train: ['Workouts', 'Recent sessions'], week: ['Week in review', weekWindow], sleep: ['Sleep', 'Nightly architecture'], fitness: ['Fitness', 'Engine vs ballast'], cardio: ['Cardio', 'Autonomic markers'], explore: ['Explore', 'Lagged correlation'], ribbon: ['Ribbon', n.toLocaleString('en-US') + ' days'] };
    const ttl = titles[st.tab] || titles.today;

    const S7 = this.mean(days.slice(n - 7).map((d) => d.strain));
    const rec7 = Math.round(D.recovery - this.mean(days.slice(Math.max(0, n - 8), n - 1).map((d) => d.recovery)));
    const dialDefs = [
      { k: 'recovery', label: 'Recovery', value: D.recovery, unit: '/100', color: recColor, frac: D.recovery / 100, delta: (rec7 >= 0 ? '+' : '−') + Math.abs(rec7) + ' vs 7d' },
      { k: 'strain', label: 'Strain', value: D.strain.toFixed(1), unit: '/21', color: cyan, frac: D.strain / 21, delta: 'TRIMP ' + D.trimp.toFixed(0) },
      { k: 'sleep', label: 'Sleep', value: D.sleepScore, unit: '/100', color: D.sleepScore >= 70 ? warm : alert, frac: D.sleepScore / 100, delta: this.fmtHM(D.sleepTotal) },
    ];
    const dials = dialDefs.map((d) => ({ ...d, dash: (C * d.frac).toFixed(1) + ' ' + C.toFixed(1), border: st.open === d.k ? cyan : line, onClick: () => this.setState({ open: st.open === d.k ? null : d.k }) }));

    const sess = this.session();
    const panels = {
      recovery: { title: 'Recovery ' + D.recovery + ' · component breakdown', formula: '100 / (1 + e^(−1.2 · [0.40 z_hrv + 0.25 z_rhr + 0.25 (sleep·2−1) + 0.10 z_load]))', components: this.recoveryComponents(D) },
      strain: { title: 'Strain ' + D.strain.toFixed(1) + ' · inputs', formula: '21 · (1 − e^(−TRIMP / ' + this.SK + '))', components: this.strainComponents(D, sess, S7) },
      sleep: { title: 'Sleep ' + D.sleepScore + ' · component breakdown', formula: '100 · (0.45 duration + 0.20 efficiency + 0.20 consistency + 0.15 deep)', components: this.sleepComponents(D) },
    };

    const acwrBand = D.acwr < 0.8 ? ['DETRAINING', muted] : D.acwr <= 1.3 ? ['OPTIMAL', pos] : D.acwr <= 1.5 ? ['ELEVATED', warm] : ['HIGH RISK', alert];
    const acwr = { value: D.acwr.toFixed(2), band: acwrBand[0], color: acwrBand[1], acute: D.acute.toFixed(0), chronic: D.chronic.toFixed(0), markerPct: Math.max(1, Math.min(98, ((D.acwr - 0.5) / 1.5) * 100)).toFixed(1), note: 'Acute:chronic workload ratio. The band you want to hold to keep adapting without overreaching.' };

    // trends
    const metricDefs = { hrv: { label: 'HRV', title: 'HRV SDNN', unit: 'ms', key: 'hrv', dec: 1 }, rhr: { label: 'RESTING HR', title: 'Resting heart rate', unit: 'bpm', key: 'rhr', dec: 1 }, steps: { label: 'STEPS', title: 'Steps', unit: '/day', key: 'steps', dec: 0 }, sleepTotal: { label: 'SLEEP', title: 'Sleep duration', unit: 'min', key: 'sleepTotal', dec: 0 }, trimp: { label: 'TRIMP', title: 'Training load', unit: 'TRIMP', key: 'trimp', dec: 0 }, mass: { label: 'BODY MASS', title: 'Body mass', unit: 'kg', key: 'mass', dec: 1 } };
    const metricChips = Object.keys(metricDefs).map((k) => ({ label: metricDefs[k].label, bg: st.metric === k ? '#1E3A44' : '#161C24', fg: st.metric === k ? cyan : muted, border: st.metric === k ? cyan : line, onClick: set('metric', k) }));
    const winDefs = [[7, '7D'], [30, '30D'], [90, '90D'], [365, '1Y'], [99999, 'ALL']];
    const windowChips = winDefs.map(([v, l]) => ({ label: l, bg: st.win === v ? '#1E3A44' : '#161C24', fg: st.win === v ? cyan : muted, border: st.win === v ? cyan : line, onClick: set('win', v) }));
    const md = metricDefs[st.metric], wn = Math.min(st.win, n), slice = days.slice(n - wn);
    const vals = slice.map((d) => d[md.key]); const W = 340, H = 168; const Lc = this.line(vals, W, H, 8, 22, 26);
    const mline = this.roll(vals, Math.max(3, Math.round(wn / 8))), msd = this.sd(vals);
    let up = '', dn = ''; mline.forEach((v, i) => { up += (i ? 'L' : 'M') + Lc.X(i).toFixed(1) + ' ' + Lc.Y(Math.min(Lc.mx, v + msd)).toFixed(1) + ' '; });
    for (let i = mline.length - 1; i >= 0; i--) dn += 'L' + Lc.X(i).toFixed(1) + ' ' + Lc.Y(Math.max(Lc.mn, mline[i] - msd)).toFixed(1) + ' ';
    let mp = ''; mline.forEach((v, i) => { mp += (i ? 'L' : 'M') + Lc.X(i).toFixed(1) + ' ' + Lc.Y(v).toFixed(1) + ' '; });
    const sparse = st.metric === 'mass';
    const pts = sparse ? slice.map((d, i) => d.massSrc === 'measured' ? { cx: Lc.X(i).toFixed(1), cy: Lc.Y(d.mass).toFixed(1), r: 3, fill: '#0B0F14', stroke: paper } : null).filter(Boolean) : (wn <= 30 ? slice.map((d, i) => ({ cx: Lc.X(i).toFixed(1), cy: Lc.Y(vals[i]).toFixed(1), r: 2, fill: paper, stroke: 'none' })) : []);
    const fmt = (v) => md.dec ? (+v).toFixed(md.dec) : Math.round(v).toLocaleString('en-US');
    const xLabels = [0, 0.5, 1].map((f) => { const i = Math.round(f * (slice.length - 1)); const dt = new Date(slice[i].t); return { x: Lc.X(i).toFixed(1), text: (wn <= 30 ? dt.getUTCDate() + ' ' + MN[dt.getUTCMonth()] : MN[dt.getUTCMonth()] + ' ' + String(dt.getUTCFullYear()).slice(2)).toUpperCase() }; });
    const trend = { title: md.title, unit: md.unit, latest: fmt(vals[vals.length - 1]), delta: (vals[vals.length - 1] >= vals[0] ? '+' : '') + fmt(vals[vals.length - 1] - vals[0]) + ' over window', deltaColor: (md.key === 'rhr' ? (vals[vals.length - 1] < vals[0] ? pos : warm) : (vals[vals.length - 1] >= vals[0] ? pos : warm)), sigma: msd.toFixed(1), path: Lc.path, bandPath: up + dn + 'Z', meanPath: mp, pts, mean: fmt(this.mean(vals)), min: fmt(Math.min.apply(null, vals)), max: fmt(Math.max.apply(null, vals)), n: slice.length, yLabels: [0, 0.5, 1].map((f) => ({ y: (Lc.Y(Lc.mn + (Lc.mx - Lc.mn) * f) + 3).toFixed(1), text: fmt(Lc.mn + (Lc.mx - Lc.mn) * f) })), xLabels, reading: 'Latest ' + fmt(vals[vals.length - 1]) + ' ' + md.unit + ' against a window mean of ' + fmt(this.mean(vals)) + '. The band is the rolling baseline ±1σ; points outside it are the days worth explaining.' };

    // sleep screen
    const ni = Math.max(0, n - 1 - st.night), Sday = days[ni];
    const sw = 340, rows = { awake: 14, rem: 42, core: 70, deep: 98 };
    const total = Sday.inBed || 1;
    const order = ['core', 'deep', 'core', 'rem', 'core', 'deep', 'core', 'rem', 'awake', 'core', 'rem', 'core', 'rem'];
    const shares = { awake: Sday.awake, rem: Sday.rem, core: Sday.core, deep: Sday.deep };
    const counts = { awake: 0, rem: 0, core: 0, deep: 0 }; order.forEach((k) => counts[k]++);
    const fills = { awake: '#E8A33D', rem: '#4CC2D6', core: '#3D6B7D', deep: '#5BC98B' };
    const segs = []; let cur = 0;
    order.forEach((k) => { const len = (shares[k] || 0) / counts[k]; if (len <= 0) return; segs.push({ k, x: cur, w: Math.min(len, total - cur) }); cur += len; });
    const stages = segs.filter((s) => s.w > 0).map((s) => ({ x: (26 + (sw - 26) * (s.x / total)).toFixed(1), w: Math.max(2, ((sw - 26) * (s.w / total))).toFixed(1), y: rows[s.k], h: 22, fill: fills[s.k] }));
    const stageLabels = [['AWAKE', rows.awake + 14], ['REM', rows.rem + 14], ['CORE', rows.core + 14], ['DEEP', rows.deep + 14]].map(([t, y]) => ({ text: t, y }));
    const bedM = 22 * 60 + Sday.bedtime; const clock = (m) => { const h = Math.floor(m / 60) % 24, mm = Math.round(m % 60); return (h < 10 ? '0' : '') + h + ':' + (mm < 10 ? '0' : '') + mm; };
    const timeLabels = [0, 0.33, 0.66, 1].map((f) => ({ x: (26 + (sw - 26) * f).toFixed(1), text: clock(bedM + total * f) }));
    const sleepScreen = { dateLabel: 'Night → ' + this.ymd(Sday.t), duration: this.fmtHM(Sday.sleepTotal), need: this.fmtHM(Sday.sleepNeed), debt: this.fmtHM(Sday.debt14), debtColor: Sday.debt14 > 420 ? alert : Sday.debt14 > 200 ? warm : pos, score: Sday.sleepScore, scoreColor: Sday.sleepScore >= 70 ? warm : alert, nextColor: st.night > 0 ? cyan : line, stages, stageLabels, timeLabels, breakdown: [['DEEP', Sday.deep, fills.deep, Sday.sleepTotal || 1, 'asleep'], ['REM', Sday.rem, fills.rem, Sday.sleepTotal || 1, 'asleep'], ['CORE', Sday.core, fills.core, Sday.sleepTotal || 1, 'asleep'], ['AWAKE', Sday.awake, fills.awake, Sday.inBed || 1, 'in bed']].map(([l, v, c, den, base]) => ({ label: l, value: this.fmtHM(v), color: c, pct: Math.round(v / den * 100) + '% ' + base })) };

    const d60 = days.slice(n - 60), dv = d60.map((d) => d.debt14); const DL = this.line(dv, 340, 110, 8, 10, 26);
    const debt = { path: DL.path, area: DL.path + 'L' + DL.X(dv.length - 1).toFixed(1) + ' 100 L' + DL.X(0).toFixed(1) + ' 100 Z', yLabels: [0, 1].map((f) => ({ y: (DL.Y(DL.mn + (DL.mx - DL.mn) * f) + 3).toFixed(1), text: Math.round((DL.mn + (DL.mx - DL.mn) * f) / 60) + 'h' })), note: 'Rolling 14-night shortfall against an 8h reference. It plateaus around ' + Math.round(this.mean(dv) / 60) + 'h, which is why sleep need is raised, not fixed at 480 min.' };

    const c90 = days.slice(n - 90);
    const cpts = c90.map((d, i) => ({ cx: (30 + 310 * Math.max(0, Math.min(1, (d.bedtime + 120) / 240))).toFixed(1), cy: (14 + 104 * (1 - Math.max(0, Math.min(1, (d.wake - 380) / 240)))).toFixed(1), r: i > 75 ? 3 : 2.2, fill: i > 75 ? cyan : paper, op: i > 75 ? 1 : 0.35 }));
    const consistency = { pts: cpts, grid: [{ x1: 30, y1: 118, x2: 340, y2: 118 }, { x1: 30, y1: 14, x2: 30, y2: 118 }], labels: [{ x: 30, y: 132, text: '21:00', anchor: 'start' }, { x: 185, y: 132, text: 'ONSET 23:00', anchor: 'middle' }, { x: 340, y: 132, text: '01:00', anchor: 'end' }, { x: 28, y: 18, text: '08:30 WAKE', anchor: 'end' }], note: 'The onset axis is wider than the wake axis — bedtime is the irregular end, wake time is fixed by alarm.' };

    // fitness
    const f18 = days.slice(Math.max(0, n - 540));
    const relV = f18.map((d) => d.vo2Shown), absV = f18.map((d) => +(d.vo2Shown * d.mass / 1000).toFixed(3));
    const RL = this.line(relV, 270, 176, 10, 20, 26), AL = this.line(absV, 270, 176, 10, 20, 26);
    const projN = 120, k = 0.011, ceiling = this.props.vo2Ceiling ?? 50, v0 = D.vo2Shown;
    let pp = '', coneU = '', coneD = '';
    for (let i = 0; i <= projN; i++) { const v = ceiling - (ceiling - v0) * Math.exp(-k * i); const x = 270 + 70 * (i / projN), y = RL.Y(Math.min(RL.mx, v)); pp += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' '; coneU += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + RL.Y(Math.min(RL.mx, v + 0.9 * (i / projN) * 2.4)).toFixed(1) + ' '; }
    for (let i = projN; i >= 0; i--) { const v = ceiling - (ceiling - v0) * Math.exp(-k * i); coneD += 'L' + (270 + 70 * (i / projN)).toFixed(1) + ' ' + RL.Y(Math.max(RL.mn, v - 0.9 * (i / projN) * 2.4)).toFixed(1) + ' '; }
    const vo2 = { rel: D.vo2Shown.toFixed(1), abs: (D.vo2Shown * D.mass / 1000).toFixed(2), relPath: RL.path, absPath: AL.path, projPath: pp, conePath: coneU + coneD + 'Z', pts: f18.map((d, i) => d.vo2Measured ? { cx: RL.X(i).toFixed(1), cy: RL.Y(d.vo2Shown).toFixed(1) } : null).filter(Boolean).slice(-14), labels: [{ x: 26, y: 12, text: 'RELATIVE ml/kg/min', fill: cyan, anchor: 'start' }, { x: 338, y: 12, text: 'PROJECTION →', fill: muted, anchor: 'end' }, { x: 26, y: 24, text: 'ABSOLUTE L/min', fill: pos, anchor: 'start' }] };

    const mFrom = f18.find((d) => d.vo2Measured) || f18[0] || D;
    const dcomp = (() => { const relGain = D.vo2Shown - mFrom.vo2Shown; const engineOnly = (D.vo2Shown * D.mass / mFrom.mass) - mFrom.vo2Shown; const tr = relGain ? Math.max(0, Math.min(1, engineOnly / relGain)) : 1; return { tr: Math.round(tr * 100), sc: Math.round((1 - tr) * 100) }; })();
    const dc = [['', 'Then', 'Now', 'Δ', muted, 'transparent'], ['VO₂ ml/kg/min', mFrom.vo2Shown.toFixed(1), D.vo2Shown.toFixed(1), (mFrom.vo2Shown ? ((D.vo2Shown - mFrom.vo2Shown) / mFrom.vo2Shown * 100).toFixed(1) : '0') + '%', paper, line], ['Body mass kg', mFrom.mass.toFixed(1), D.mass.toFixed(1), (D.mass - mFrom.mass >= 0 ? '+' : '') + (D.mass - mFrom.mass).toFixed(1), paper, line], ['Absolute L/min', (mFrom.vo2Shown * mFrom.mass / 1000).toFixed(2), (D.vo2Shown * D.mass / 1000).toFixed(2), '+' + (mFrom.vo2Shown * mFrom.mass ? (((D.vo2Shown * D.mass) - (mFrom.vo2Shown * mFrom.mass)) / (mFrom.vo2Shown * mFrom.mass) * 100).toFixed(1) : '0') + '%', pos, 'transparent']];
    const decompCells = []; dc.forEach((row) => { row.slice(0, 4).forEach((cell, i) => decompCells.push({ text: cell, color: i === 0 ? (row[4] === pos ? pos : muted) : row[4], align: i === 0 ? 'left' : 'right', rule: row[5] })); });
    const decomp = { cells: decompCells, trPct: dcomp.tr, scPct: dcomp.sc, plain: dcomp.tr + '% of the gain is a stronger engine; ' + dcomp.sc + '% is a lighter one to carry — a distinction no consumer app draws.' };

    const cw = st.cfWeight || Math.round(D.mass) || 80;
    const counter = { weight: cw, value: ((D.vo2Shown * D.mass) / cw).toFixed(1), delta: (cw < D.mass ? '+' : '−') + Math.abs(((D.vo2Shown * D.mass) / cw) - D.vo2Shown).toFixed(1) + ' vs today' };

    const efDays = days.slice(Math.max(0, n - 240)).filter((d) => d.ef != null); const efV = efDays.map((d) => d.ef); const EL = this.line(efV.length ? efV : [0, 1], 340, 96, 8, 8, 4);
    let efFit = ''; this.roll(efV, 12).forEach((v, i) => { efFit += (i ? 'L' : 'M') + EL.X(i).toFixed(1) + ' ' + EL.Y(v).toFixed(1) + ' '; });
    const ef = { path: efV.length ? EL.path : '', fitPath: efFit, delta: efV.length ? '' : 'no runs', note: 'Metres per beat, per workout. EF tends to lead the VO₂ estimate by weeks.' };

    const m12 = days.slice(Math.max(0, n - 365)), mv = m12.map((d) => d.mass); const ML = this.line(mv, 340, 86, 8, 8, 4);
    const mass = { path: ML.path, pts: m12.map((d, i) => d.massSrc === 'measured' ? { cx: ML.X(i).toFixed(1), cy: ML.Y(d.mass).toFixed(1) } : null).filter(Boolean), note: m12.filter((d) => d.massSrc === 'measured').length + ' measured readings in the last year. Solid markers are scale readings; the dashed line between them is interpolation.' };

    // cardio
    const cardioStats = [
      { label: 'Resting HR', value: D.rhr.toFixed(0), color: pos, sub: 'baseline ' + D.rhrBase.toFixed(1) },
      { label: 'HRV SDNN', value: D.hrv.toFixed(0), color: cyan, sub: (D.zHrv >= 0 ? '+' : '') + D.zHrv.toFixed(1) + 'σ vs 30d' },
      { label: 'HRR 60s', value: String(sess.hrr60), color: pos, sub: 'floor 12' },
      { label: 'VO₂ max', value: D.vo2Shown.toFixed(1), color: cyan, sub: 'measured ' + D.vo2StaleDays + 'd ago' },
    ];
    const hrByHour = this.circadianProfile(); const present = hrByHour.map((v, i) => [v, i]).filter((x) => x[0] > 0);
    const hmax = present.length ? Math.max.apply(null, present.map((x) => x[0])) : 1, hmin = present.length ? Math.min.apply(null, present.map((x) => x[0])) : 0;
    const nadirH = present.length ? present.reduce((a, b) => a[0] < b[0] ? a : b)[1] : 0, peakH = present.length ? present.reduce((a, b) => a[0] > b[0] ? a : b)[1] : 0;
    const circadian = { has: present.length >= 4, bars: hrByHour.map((v, i) => { if (v <= 0) return null; const h = (v - hmin + 4) / (hmax - hmin + 4) * 88; return { x: (24 + i * 13.1).toFixed(1), w: 10, y: (100 - h).toFixed(1), h: h.toFixed(1), fill: this.ramp(['#1E4A5A', '#4CC2D6'], (v - hmin) / (hmax - hmin || 1)) }; }).filter(Boolean), labels: [0, 6, 12, 18, 23].map((i) => ({ x: (29 + i * 13.1).toFixed(1), text: (i < 10 ? '0' : '') + i + ':00' })), note: present.length ? 'Nadir ' + Math.round(hmin) + ' bpm at ' + (nadirH < 10 ? '0' : '') + nadirH + ':00, peak ' + Math.round(hmax) + ' at ' + (peakH < 10 ? '0' : '') + peakH + ':00 — a ' + Math.round(hmax - hmin) + ' bpm amplitude.' : 'Not enough heart-rate samples for an hourly profile.' };

    const hrrCurve = sess.max ? [sess.max, sess.max - sess.hrr60 * 0.42, sess.max - sess.hrr60 * 0.68, sess.max - sess.hrr60 * 0.85, sess.max - sess.hrr60 * 0.95, sess.max - sess.hrr60] : [0, 0];
    const HLc = this.line(hrrCurve, 340, 96, 8, 10, 4);
    const hrr = { path: sess.max ? HLc.path : '', thresholdY: HLc.Y((sess.max || 12) - 12).toFixed(1), labelY: (HLc.Y((sess.max || 12) - 12) - 4).toFixed(1), note: sess.max ? 'Latest session: ' + sess.max + ' → ' + (sess.max - sess.hrr60) + ' bpm in 60 s, a ' + sess.hrr60 + ' bpm drop. Above 25 is strong.' : 'No workout heart-rate data yet.' };

    // explore
    const lagDays = [0, 1, 2, 3, 7][st.lag]; const exMetrics = [['hrv', 'HRV'], ['rhr', 'RHR'], ['sleepTotal', 'SLEEP'], ['deep', 'DEEP'], ['trimp', 'LOAD'], ['recovery', 'RECOV']];
    const last = days.slice(Math.max(0, n - 365)); const cells = [{ text: 'lag ' + lagDays + 'd', bg: '#161C24', fg: muted, size: '8px', justify: 'center' }];
    exMetrics.forEach((m) => cells.push({ text: m[1], bg: '#161C24', fg: muted, size: '8.5px', justify: 'center' }));
    let best = { r: 0 };
    exMetrics.forEach((rowM) => { cells.push({ text: rowM[1], bg: '#161C24', fg: muted, size: '8.5px', justify: 'flex-start' });
      exMetrics.forEach((colM) => { const x = [], y = []; for (let i = lagDays; i < last.length; i++) { x.push(last[i - lagDays][rowM[0]]); y.push(last[i][colM[0]]); } const r = this.pearson(x, y); const same = rowM[0] === colM[0] && lagDays === 0; const t = Math.abs(r); const bg = same ? '#232C38' : (r >= 0 ? this.mix('#0B0F14', cyan, Math.min(1, t * 1.5)) : this.mix('#0B0F14', alert, Math.min(1, t * 1.5))); cells.push({ text: same ? '—' : (r >= 0 ? '+' : '−') + Math.abs(r).toFixed(2), bg, fg: t > 0.5 ? '#0B0F14' : paper, size: '10px', justify: 'center' }); if (rowM[0] !== colM[0] && t > Math.abs(best.r)) best = { r, rowM, colM, nn: last.length - lagDays }; }); });
    const nameMap = { hrv: 'HRV', rhr: 'resting HR', sleepTotal: 'sleep duration', deep: 'deep sleep', trimp: 'training load', recovery: 'recovery' };
    const explore = { lag: st.lag, lagLabel: lagDays === 0 ? 'same day' : lagDays + ' day' + (lagDays > 1 ? 's' : ''), cells, finding: best.r ? (nameMap[best.rowM[0]].charAt(0).toUpperCase() + nameMap[best.rowM[0]].slice(1)) + (lagDays ? ' ' + lagDays + ' day' + (lagDays > 1 ? 's' : '') + ' ago' : ' today') + (best.r > 0 ? ' tracks with ' : ' runs against ') + nameMap[best.colM[0]] + ' today.' : 'No relationship clears the noise floor at this lag.', findingR: (best.r >= 0 ? '+' : '−') + Math.abs(best.r || 0).toFixed(2), findingN: best.nn || 0 };

    // ribbon
    const ribbonDefs = [['recovery', 'RECOVERY'], ['strain', 'STRAIN'], ['sleep', 'SLEEP'], ['steps', 'STEPS'], ['hrv', 'HRV']];
    const ribbonChips = ribbonDefs.map(([k, l]) => ({ label: l, bg: st.ribbonMetric === k ? '#1E3A44' : '#161C24', fg: st.ribbonMetric === k ? cyan : muted, border: st.ribbonMetric === k ? cyan : line, onClick: set('ribbonMetric', k) }));
    const yrs = []; { const y0 = new Date(days[0].t).getUTCFullYear(), y1 = new Date(D.t).getUTCFullYear(); for (let y = y0; y <= y1; y++) yrs.push({ label: String(y) }); }
    const ribbon = { ticks: yrs };
    const SD = st.scrubIdx != null ? days[Math.max(0, Math.min(n - 1, Math.round(st.scrubIdx)))] : D;
    const scrub = { date: st.scrubIdx != null ? this.ymd(SD.t) : this.ymd(D.t) + ' · latest', border: st.scrubIdx != null ? cyan : line, hint: st.scrubIdx != null ? 'scrubbing' : 'drag the ribbon to scrub', stats: [{ label: 'Recovery', value: SD.recovery, color: SD.recovery >= 67 ? pos : SD.recovery >= 34 ? warm : alert }, { label: 'Strain', value: SD.strain.toFixed(1), color: cyan }, { label: 'Sleep', value: this.fmtHM(SD.sleepTotal), color: paper }, { label: 'HRV', value: SD.hrv.toFixed(0) + ' ms', color: paper }, { label: 'RHR', value: SD.rhr.toFixed(0) + ' bpm', color: paper }, { label: 'Steps', value: SD.steps.toLocaleString('en-US'), color: paper }] };

    // zones
    const hrMax = this.HRMAX(), hrRest = this.HRREST(), hrrRes = hrMax - hrRest;
    const zdef = [['1 Recovery', 0, 0.60, '#2A3644'], ['2 Aerobic', 0.60, 0.70, '#4CC2D6'], ['3 Tempo', 0.70, 0.80, '#4CC2D6'], ['4 Threshold', 0.80, 0.90, '#E8A33D'], ['5 Max', 0.90, 1.0, '#E05252']];
    const zones = { hrMax, hrRest, offset: Math.round(hrMax * 0.6 - (hrRest + hrrRes * 0.6)) * -1, rows: zdef.map(([nm, a, b, c], i) => ({ name: nm, left: (a * 100).toFixed(0), width: ((b - a) * 100).toFixed(0), color: c, op: 0.35 + i * 0.16, bpm: Math.round(hrRest + hrrRes * a) + '–' + Math.round(hrRest + hrrRes * b) })) };

    const drifty = this.workouts.find((w) => w.drift > 5); const slow = this.workouts.find((w) => w.cad && w.cad < 160); const nonRun = this.workouts.slice(0, 14).filter((w) => !w.gps).length;
    const flags = [
      drifty ? { color: warm, title: 'CARDIAC DRIFT +' + drifty.drift + '% · ' + drifty.type.toUpperCase(), body: 'Second-half HR ran above the first at the same pace.' } : null,
      slow ? { color: alert, title: 'CADENCE ' + slow.cad + ' SPM · BELOW KNEE FLOOR', body: 'Under 160 means overstriding. Shorten stride before adding volume.' } : null,
      this.workouts.length ? { color: cyan, title: 'VO₂ ESTIMATE MODALITY-BLIND', body: 'Apple only updates VO₂ from outdoor walk/run. ' + nonRun + ' of the last ' + Math.min(14, this.workouts.length) + ' sessions were indoor.' } : null,
      { color: pos, title: 'RECOVERY ' + D.recovery + ' · ' + (D.recovery >= 67 ? 'GREEN' : D.recovery >= 34 ? 'AMBER' : 'RED'), body: 'Today’s readiness from HRV, resting HR, sleep and load.' },
    ].filter(Boolean);

    const deskScores = [
      { label: 'Recovery', value: D.recovery, unit: '/100', color: recColor, delta: dialDefs[0].delta, dash: (C * D.recovery / 100).toFixed(1) + ' ' + C.toFixed(1), components: this.recoveryComponents(D), formula: 'logistic(0.40 z_hrv + 0.25 z_rhr + 0.25 sleep + 0.10 load)' },
      { label: 'Strain', value: D.strain.toFixed(1), unit: '/21', color: cyan, delta: 'TRIMP ' + D.trimp.toFixed(0), dash: (C * D.strain / 21).toFixed(1) + ' ' + C.toFixed(1), components: this.strainComponents(D, sess, S7), formula: '21 · (1 − e^(−TRIMP/' + this.SK + '))' },
      { label: 'Sleep', value: D.sleepScore, unit: '/100', color: D.sleepScore >= 70 ? warm : alert, delta: this.fmtHM(D.sleepTotal), dash: (C * D.sleepScore / 100).toFixed(1) + ' ' + C.toFixed(1), components: this.sleepComponents(D), formula: '0.45 dur + 0.20 eff + 0.20 cons + 0.15 deep' },
    ];

    // workouts screen
    const wos = this.workouts, W0 = wos[Math.min(st.wo, wos.length - 1)] || this.session();
    const typeColor = { 'Outdoor Run': cyan, 'Indoor Cycle': '#3D6B7D', Cycle: '#3D6B7D', Elliptical: pos, Rowing: warm, Strength: muted };
    const woList = wos.slice(0, 14).map((w, i) => ({ date: this.ymd(w.t), type: w.type, typeColor: typeColor[w.type] || muted, dur: w.dur + ' min', hr: (w.avg || '—') + '/' + (w.max || '—'), strain: w.strain.toFixed(1), dist: w.dist ? w.dist.toFixed(1) + ' km' : '—', driftColor: w.drift > 5 ? warm : muted, drift: (w.drift > 0 ? '+' : '') + w.drift + '%', bg: i === st.wo ? '#1E3A44' : '#161C24', border: i === st.wo ? cyan : line, onClick: () => this.setState({ wo: i, woOpen: true }) }));
    const hrRes2 = hrMax - hrRest; const wSeries = W0.series && W0.series.length ? W0.series : [hrRest, hrMax]; const HW = 340, HH = 150; const yLo = hrRest + hrRes2 * 0.35, yHi = hrMax; const yOf = (v) => (10 + (HH - 32) * (1 - (v - yLo) / (yHi - yLo)));
    let wPath = ''; wSeries.forEach((v, i) => { wPath += (i ? 'L' : 'M') + (26 + (HW - 26) * (i / (wSeries.length - 1))).toFixed(1) + ' ' + yOf(v).toFixed(1) + ' '; });
    const zoneShade = [[0.35, 0.6, '#2A3644'], [0.6, 0.7, '#1E4A5A'], [0.7, 0.8, '#22586B'], [0.8, 0.9, '#4A3A22'], [0.9, 1.0, '#4A2529']].map(([a, b, c]) => ({ y: yOf(hrRest + hrRes2 * b).toFixed(1), h: Math.max(1, (yOf(hrRest + hrRes2 * a) - yOf(hrRest + hrRes2 * b))).toFixed(1), fill: c }));
    const zoneAxis = [0.6, 0.7, 0.8, 0.9].map((p) => ({ y: (yOf(hrRest + hrRes2 * p) + 3).toFixed(1), text: Math.round(hrRest + hrRes2 * p) }));
    const zoneTotal = (W0.zoneMin || []).reduce((a, b) => a + b, 0) || 1;
    const wHrr = W0.max ? [W0.max, W0.max - W0.hrr60 * 0.42, W0.max - W0.hrr60 * 0.68, W0.max - W0.hrr60 * 0.85, W0.max - W0.hrr60 * 0.95, W0.max - W0.hrr60] : [0, 0];
    const WHc = this.line(wHrr, 340, 84, 8, 8, 4);
    const workout = { title: W0.type + ' · ' + this.ymd(W0.t), isRun: W0.gps, stats: [{ label: 'Duration', value: W0.dur + ' min' }, { label: 'Avg HR', value: (W0.avg || '—') + ' bpm' }, { label: 'Max HR', value: (W0.max || '—') + ' bpm' }, { label: 'TRIMP', value: String(Math.round(W0.trimp)) }, { label: 'Strain', value: W0.strain.toFixed(1) }, { label: 'Energy', value: (W0.kcal || 0) + ' kcal' }], hrPath: wPath, zoneShade, zoneAxis, driftValue: (W0.drift > 0 ? '+' : '') + W0.drift + '%', driftColor: W0.drift > 5 ? warm : pos, driftNote: W0.drift > 5 ? 'Second half ran hotter at the same pace.' : 'Drift not available from the export; per-workout HR series is summarised.', hrrValue: W0.hrr60 + ' bpm', hrrPath: WHc.path, cad: W0.cad ? W0.cad + ' spm' : '—', cadColor: W0.cad ? (W0.cad < 160 ? alert : pos) : muted, cadNote: W0.cad ? (W0.cad < 160 ? 'Below the 160 spm knee floor.' : 'Above the 160 spm knee floor.') : 'Non-impact modality or no cadence data.', zones: ['Z1 Recovery', 'Z2 Aerobic', 'Z3 Tempo', 'Z4 Threshold', 'Z5 Max'].map((nm, i) => ({ name: nm, min: (W0.zoneMin ? W0.zoneMin[i] : 0) + 'm', pct: Math.round((W0.zoneMin ? W0.zoneMin[i] : 0) / zoneTotal * 100), color: ['#2A3644', cyan, cyan, warm, alert][i] })), routeSegs: [], routeNote: '', splits: [], hasSplits: false };

    // week
    const wk = days.slice(n - 7); const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const bars = wk.map((d, i) => { const rh = d.recovery / 100 * 84, sh2 = d.strain / 21 * 84; return { label: dayNames[new Date(d.t).getUTCDay()], rY: (96 - rh).toFixed(1), rH: rh.toFixed(1), rFill: d.recovery >= 67 ? pos : d.recovery >= 34 ? warm : alert, sY: (96 - sh2).toFixed(1), sH: sh2.toFixed(1), x: (30 + i * 44).toFixed(1), sx: (46 + i * 44).toFixed(1), lx: (40 + i * 44).toFixed(1), mismatch: (d.strain / 21 * 100 - d.recovery) > 18 }; });
    const wkZone = [0, 0, 0, 0, 0]; wos.filter((w) => w.dayIdx >= n - 7).forEach((w) => (w.zoneMin || []).forEach((v, i) => wkZone[i] += v)); const wkZoneTotal = wkZone.reduce((a, b) => a + b, 0) || 1;
    const week = { window: weekWindow, bars, totals: [{ label: 'Sessions', value: String(wos.filter((w) => w.dayIdx >= n - 7).length), color: paper }, { label: 'Load', value: Math.round(wk.reduce((s, d) => s + d.trimp, 0)) + ' TRIMP', color: cyan }, { label: 'Avg recovery', value: String(Math.round(this.mean(wk.map((d) => d.recovery)))), color: pos }, { label: 'Sleep debt', value: this.fmtHM(D.debt14), color: warm }], zones: ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'].map((nm, i) => ({ name: nm, pct: Math.round(wkZone[i] / wkZoneTotal * 100), width: Math.max(1, Math.round(wkZone[i] / wkZoneTotal * 100)), min: Math.round(wkZone[i]) + 'm', color: ['#2A3644', cyan, '#3D8FA0', warm, alert][i] })), sleepRows: wk.map((d) => ({ label: dayNames[new Date(d.t).getUTCDay()], pct: Math.min(100, Math.round(d.sleepTotal / (d.sleepNeed || 480) * 100)), color: d.sleepTotal / (d.sleepNeed || 480) >= 0.95 ? pos : d.sleepTotal / (d.sleepNeed || 480) >= 0.85 ? warm : alert, value: this.fmtHM(d.sleepTotal) })), verdict: (() => { const dl = Math.round((D.acwr - 1) * 100); const above = wk.filter((d) => d.recovery > 60).length; return 'Load ' + (dl >= 0 ? 'up ' : 'down ') + Math.abs(dl) + '% on the 4-week average, with recovery above 60 on ' + above + ' of ' + wk.length + ' days.'; })(), compare: (() => { const p28 = days.slice(n - 28); const dl = Math.round((D.acwr - 1) * 100); const dr = Math.round(this.mean(wk.map((d) => d.recovery)) - this.mean(p28.map((d) => d.recovery))); const ds = Math.round(this.mean(wk.map((d) => d.sleepTotal)) - this.mean(p28.map((d) => d.sleepTotal))); return [{ label: 'Load vs 4-week avg', value: (dl >= 0 ? '+' : '−') + Math.abs(dl) + '%', color: dl >= 0 ? pos : warm }, { label: 'Recovery vs 4-week avg', value: (dr >= 0 ? '+' : '−') + Math.abs(dr), color: dr >= 0 ? pos : warm }, { label: 'Sleep vs 4-week avg', value: (ds >= 0 ? '+' : '−') + Math.abs(ds) + ' min', color: ds >= 0 ? pos : warm }, { label: 'Z2 share of minutes', value: Math.round(wkZone[1]) + ' min · ' + Math.round(wkZone[1] / wkZoneTotal * 100) + '%', color: cyan }]; })() };

    const meta = this.real ? { today: this.ymd(D.t), syncTime: new Date().toISOString().slice(11, 16), recordCount: this.real.meta.records.toLocaleString('en-US'), dayCount: n.toLocaleString('en-US'), imports: '1', revisions: '0', source: 'Apple Health export' } : { today: this.ymd(D.t), syncTime: '06:12', recordCount: 'SAMPLE', dayCount: n.toLocaleString('en-US'), imports: '—', revisions: '—', source: 'synthetic preview' };

    return {
      screenTitle: ttl[0], screenHeading: ttl[1],
      isTrain: st.tab === 'train', isWeek: st.tab === 'week', woList, workout, week,
      isToday: st.tab === 'today', isTrends: st.tab === 'trends', isSleep: st.tab === 'sleep', isFitness: st.tab === 'fitness', isCardio: st.tab === 'cardio', isExplore: st.tab === 'explore', isRibbon: st.tab === 'ribbon',
      tabs, deskNav, dials, deskScores,
      openPanel: st.open ? panels[st.open] : null, closePanel: () => this.setState({ open: null }), goRibbon: set('tab', 'ribbon'),
      today: { directive: D.recovery >= 67 ? 'Cleared for 4×4 intervals — 6 × 4 min at ' + Math.round(hrRest + (hrMax - hrRest) * 0.85) + ' bpm.' : D.recovery >= 34 ? 'Zone 2 only today — 45 min at 138–150 bpm.' : 'Rest. No structured session.', directiveSub: 'Recovery ' + D.recovery + ' · ACWR ' + D.acwr.toFixed(2) + ' · deep sleep ' + (D.sleepTotal ? (D.deep / D.sleepTotal * 100).toFixed(0) : 0) + '% of the night.' },
      acwr, flags, zones, trend, metricChips, windowChips,
      sleep: sleepScreen, prevNight: () => this.setState({ night: Math.min(89, st.night + 1) }), nextNight: () => this.setState({ night: Math.max(0, st.night - 1) }),
      debt, consistency, vo2, decomp, counter, ef, mass, setCounterWeight: (e) => this.setState({ cfWeight: +e.target.value }),
      cardioStats, circadian, hrr, explore, setLag: (e) => this.setState({ lag: +e.target.value }),
      ribbonChips, ribbon, scrub, meta,
      miniRibbonRef: (el) => { this._mini = el; }, tallRibbonRef: (el) => { this._tall = el; }, deskRibbonRef: (el) => { this._desk = el; }, ecgRef: (el) => { this._ecg = el; },
      onRibbonMove: (e) => { const r = e.currentTarget.getBoundingClientRect(); const f = (e.clientX - r.left) / r.width; this.setState({ scrubIdx: Math.round(f * (n - 1)) }); },
      onRibbonLeave: () => this.setState({ scrubIdx: null }),
    };
  }
}

export const INITIAL_STATE = { tab: 'today', open: null, metric: 'hrv', win: 90, ribbonMetric: 'recovery', scrubIdx: null, night: 0, lag: 1, cfWeight: 0, wo: 0, woOpen: true };
export const PROPS = { hrMax: 187, hrRest: 64, vo2Ceiling: 50 };
