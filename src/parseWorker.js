// Web Worker: parses the Health export off the main thread so the UI stays responsive.
import { parseFile } from './parseCore.js';

self.onmessage = async (e) => {
  const { file } = e.data || {};
  try {
    const dataset = await parseFile(file, (p) => self.postMessage({ progress: p }));
    self.postMessage({ result: dataset });
  } catch (err) {
    self.postMessage({ error: String((err && err.message) || err) });
  }
};
