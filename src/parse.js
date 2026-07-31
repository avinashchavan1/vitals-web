// Main-thread entry point. Reads the file HERE (reliable File I/O on iOS), streams raw chunks to a
// Web Worker that does the heavy unzip + parse, with a watchdog and a main-thread fallback.
import { parseFile, parseXMLText, parseZipBytes, isZipFile } from './parseCore.js';

export { parseXMLText, parseZipBytes };
const log = (...a) => { try { console.log('[vitals]', ...a); } catch {} };

// Read a File as sequential ArrayBuffer chunks, calling onChunk(ArrayBuffer) and onRead(totalBytes).
async function readChunks(file, onChunk, onRead) {
  if (typeof file.stream === 'function') {
    const reader = file.stream().getReader();
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      const ab = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      onChunk(ab, total);
      onRead(total);
    }
  } else {
    const ab = await file.arrayBuffer();
    onChunk(ab, ab.byteLength);
    onRead(ab.byteLength);
  }
}

export function parseHealthExport(file, onProgress) {
  const isZip = isZipFile(file);
  log('file:', file && file.name, file && file.type, (file && file.size) + ' bytes; zip:', isZip);

  if (typeof Worker === 'undefined') return parseFile(file, onProgress);

  return new Promise((resolve, reject) => {
    let worker = null, settled = false, lastTick = Date.now(), readBytes = 0, readDone = false;
    const wd = setInterval(() => {
      if (settled) return;
      const idle = Math.round((Date.now() - lastTick) / 1000);
      if (idle >= 12) {
        const stage = readBytes === 0 ? 'the file hasn’t started reading' : readDone ? 'parsing' : `read ${(readBytes / 1e6).toFixed(1)} MB, still reading`;
        onProgress && onProgress({ note: `still working… ${idle}s (${stage}). If the file never starts reading, it’s likely an iCloud file that hasn’t downloaded — open it once in Files, or drop it on a computer.` });
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
    worker.onerror = (err) => fallback('onerror: ' + ((err && err.message) || 'unknown'));
    worker.onmessageerror = () => fallback('messageerror');

    worker.postMessage({ init: true, isZip });
    onProgress && onProgress({ note: 'reading ' + ((file && file.name) || 'file') + ' · ' + (((file && file.size) || 0) / 1e6).toFixed(1) + ' MB' });

    readChunks(
      file,
      (ab) => { try { worker.postMessage({ chunk: ab }, [ab]); } catch (e) { worker.postMessage({ chunk: ab }); } },
      (total) => { readBytes = total; lastTick = Date.now(); onProgress && onProgress({ note: 'read ' + (total / 1e6).toFixed(1) + ' MB' }); }
    ).then(
      () => { readDone = true; lastTick = Date.now(); worker.postMessage({ final: true }); },
      (e) => { log('read error:', e); done(reject, new Error('Could not read the file: ' + (e && e.message || e) + '. If it’s in iCloud, download it first (open it in Files).')); }
    );
  });
}
