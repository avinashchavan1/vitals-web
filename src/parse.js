// Main-thread entry point. Runs the parse in a Web Worker (UI stays responsive), with a watchdog
// that surfaces a message if it stalls, and a fallback to main-thread parsing if the worker fails.
import { parseFile, parseXMLText, parseZipBytes } from './parseCore.js';

export { parseXMLText, parseZipBytes };

export function parseHealthExport(file, onProgress) {
  if (typeof Worker === 'undefined') return parseFile(file, onProgress);

  return new Promise((resolve, reject) => {
    let worker = null, settled = false, lastTick = Date.now();
    const wd = setInterval(() => {
      if (settled) return;
      const idle = Math.round((Date.now() - lastTick) / 1000);
      if (idle >= 12) {
        onProgress && onProgress({ note: `still working… ${idle}s with no update. Large exports take time; if this never moves, the file may be an iCloud file that hasn’t downloaded to this device — open it in Files first, or unzip and drop export.xml.` });
      }
    }, 4000);
    const done = (fn, arg) => { if (settled) return; settled = true; clearInterval(wd); try { worker && worker.terminate(); } catch {} fn(arg); };
    const fallback = (why) => {
      try { console.warn('[vitals] worker fallback:', why); } catch {}
      if (settled) return;
      try { worker && worker.terminate(); } catch {}
      parseFile(file, onProgress).then((d) => done(resolve, d), (e) => done(reject, e));
    };

    try {
      worker = new Worker(new URL('./parseWorker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      return parseFile(file, onProgress).then(resolve, reject);
    }
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.progress) { lastTick = Date.now(); onProgress && onProgress(m.progress); }
      else if (m.result) done(resolve, m.result);
      else if (m.error) done(reject, new Error(m.error));
    };
    worker.onerror = (err) => fallback('onerror: ' + (err && err.message || 'unknown'));
    worker.onmessageerror = () => fallback('messageerror');
    try { worker.postMessage({ file }); } catch (e) { fallback('postMessage: ' + e.message); }
  });
}
