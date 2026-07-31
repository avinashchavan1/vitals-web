# Vitals — Web

A **client-side** health-analytics dashboard. Drop your Apple Health export and it computes
recovery, strain, sleep, VO₂, training load and the record ribbon **entirely in your browser** —
the file never leaves your device, there is no backend, and nothing is uploaded.

Same clinical-telemetry design and metrics engine as the native Vitals app; the difference is the
data source: instead of reading HealthKit live (impossible from a web page), it parses the export
Apple already lets you produce.

## Use it

```bash
npm install
npm run dev      # http://localhost:5174
npm run build    # static bundle → dist/ (host anywhere, or open locally)
```

1. On your iPhone: **Health** → your **profile picture** → **Export All Health Data** → save/AirDrop
   `export.zip` to your computer.
2. Open the app and **drop `export.zip`** (or an unzipped `export.xml`) onto the page.
3. It parses in-browser and renders. Or click **explore with sample data** for a synthetic preview.

## How it works

- `src/parse.js` — a **streaming** parser. It unzips (`fflate`) and scans the XML in chunks,
  aggregating online, so memory stays bounded even for a multi-hundred-MB export with millions of
  records. Produces daily series, sleep nights (clustered + attributed to the wake date), workouts,
  hourly-HR (circadian), body-mass and VO₂ readings — with iPhone/Watch source de-duplication and
  lb→kg / mi→km / kJ→kcal conversions.
- `src/engine.js` — the metrics engine: rolling baselines & z-scores, Banister TRIMP, ACWR,
  recovery/strain/sleep scores, VO₂ decomposition (engine vs. ballast) with an exponential
  projection, efficiency factor, and the correlation lab. Runs identically on real data or the
  synthetic preview.
- `src/App.jsx` — the responsive UI: Today · Trends · Workouts · Week · Sleep · Fitness · Cardio ·
  Explore · Ribbon, plus the Canvas ribbon.

## Verify

```bash
node test/parse.test.mjs     # synthesizes a realistic export.xml, parses + derives, asserts sanity
```

## Honest limits (from the export format)

- **Per-workout HR series** isn't in the export at full resolution, so zone bars / HR traces are
  summarised from the workout's average & maximum; cardiac drift isn't shown.
- **ECG voltage** is exported as separate CSVs inside the archive — not parsed yet; the ECG card
  shows a representative trace, clearly labelled.
- **GPS routes** (GPX in the archive) aren't parsed yet.

Everything displayed is derived from your export; where a signal isn't in the file, the card says so.
Scores are published sports-science heuristics — an analysis tool, not a diagnostic device.
