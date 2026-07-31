// Web Worker: receives raw byte chunks read on the main thread (reliable File I/O on iOS) and does
// the CPU-heavy unzip + XML parse off the UI thread. Posts progress + the final dataset.
import { StreamParser } from './parseCore.js';

let sp = null;

self.onmessage = (e) => {
  const m = e.data || {};
  try {
    if (m.init) {
      sp = new StreamParser(!!m.isZip, (p) => self.postMessage({ progress: p }));
    } else if (m.chunk) {
      sp && sp.push(new Uint8Array(m.chunk));
    } else if (m.final) {
      const dataset = sp.finish();
      self.postMessage({ result: dataset });
    }
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
