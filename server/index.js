// Vitals parse server — streams a multipart file upload straight through the shared parser and
// returns the derived-metrics dataset as JSON. No file is written to disk; parsing is streaming so
// memory stays bounded even for a multi-hundred-MB export.
//
// PRIVACY: unlike the client-side app, the uploaded export is processed on this server. It is held
// only in memory for the duration of the request and never persisted.

import express from 'express';
import Busboy from 'busboy';
import { StreamParser, isZipFile } from './parseCore.js';

const app = express();
const PORT = process.env.PORT || 8787;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MAX_BYTES = Number(process.env.MAX_BYTES || 3 * 1024 * 1024 * 1024); // 3 GB

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (_req, res) => res.json({ ok: true, service: 'vitals-parse', maxBytes: MAX_BYTES }));

app.post('/parse', (req, res) => {
  let bb;
  try { bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_BYTES } }); }
  catch (e) { return res.status(400).json({ error: 'Bad upload: ' + (e.message || e) }); }

  let handled = false, hadFile = false;
  const fail = (code, msg) => { if (handled) return; handled = true; try { res.status(code).json({ error: msg }); } catch {} };

  bb.on('file', (_name, stream, info) => {
    hadFile = true;
    const t0 = Date.now();
    const zip = isZipFile({ name: info.filename, type: info.mimeType });
    console.log('[parse] file:', info.filename, info.mimeType, 'zip:', zip);
    const sp = new StreamParser(zip, () => {});
    stream.on('data', (chunk) => {
      if (handled) return;
      try { sp.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); }
      catch (e) { stream.resume(); fail(400, String(e.message || e)); }
    });
    stream.on('limit', () => fail(413, 'File exceeds the ' + (MAX_BYTES / 1e9).toFixed(0) + ' GB limit.'));
    stream.on('end', () => {
      if (handled) return;
      try {
        const dataset = sp.finish();
        handled = true;
        console.log('[parse] done in', Date.now() - t0, 'ms —', dataset.meta.records, 'records,', dataset.meta.dayCount, 'days');
        res.json(dataset);
      } catch (e) { fail(400, String(e.message || e)); }
    });
  });
  bb.on('error', (e) => fail(400, String(e.message || e)));
  bb.on('finish', () => { if (!hadFile) fail(400, 'No file was uploaded (expected a "file" field).'); });
  req.pipe(bb);
});

app.listen(PORT, () => console.log('vitals-parse listening on :' + PORT));
