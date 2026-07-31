import React, { useEffect, useRef, useState } from 'react';
import { Engine, INITIAL_STATE, PROPS } from './engine.js';
import { parseHealthExport } from './parse.js';

const S = (str) => {
  const o = {};
  String(str).split(';').forEach((p) => {
    const i = p.indexOf(':');
    if (i < 0) return;
    const k = p.slice(0, i).trim();
    if (!k) return;
    o[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = p.slice(i + 1).trim();
  });
  return o;
};
const MONO = "'JetBrains Mono',monospace";
const GEIST = "'Geist',sans-serif";
const PLEX = "'IBM Plex Sans',sans-serif";

export default function App() {
  const [phase, setPhase] = useState('landing'); // landing | parsing | ready | error
  const [progress, setProgress] = useState(0);
  const [errMsg, setErrMsg] = useState('');
  const [isReal, setIsReal] = useState(false);
  const [state, setState] = useState(INITIAL_STATE);

  async function ingest(file) {
    setPhase('parsing'); setProgress(0); setErrMsg('');
    try {
      const dataset = await parseHealthExport(file, ({ records }) => setProgress(records));
      globalThis.__vitalsReal = dataset;
      globalThis.__htCache = {};
      setIsReal(true); setState(INITIAL_STATE); setPhase('ready');
    } catch (e) {
      setErrMsg(String(e && e.message || e)); setPhase('error');
    }
  }
  function preview() {
    globalThis.__vitalsReal = null; globalThis.__htCache = {};
    setIsReal(false); setState(INITIAL_STATE); setPhase('ready');
  }
  function reset() {
    globalThis.__vitalsReal = null; globalThis.__htCache = {};
    setPhase('landing');
  }

  if (phase === 'ready') return <Dashboard state={state} setState={setState} isReal={isReal} onReset={reset} />;
  return <Landing phase={phase} progress={progress} errMsg={errMsg} onFile={ingest} onPreview={preview} onRetry={() => setPhase('landing')} />;
}

function Landing({ phase, progress, errMsg, onFile, onPreview, onRetry }) {
  const inputRef = useRef(null);
  const [drag, setDrag] = useState(false);
  const pick = (f) => { if (f) onFile(f); };
  return (
    <div style={S(`min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;font-family:${PLEX}`)}>
      <div style={S('width:100%;max-width:560px;display:flex;flex-direction:column;gap:20px')}>
        <div style={S('display:flex;flex-direction:column;gap:6px')}>
          <span style={S(`font-family:${MONO};font-size:12px;letter-spacing:0.22em;color:#4CC2D6;text-transform:uppercase`)}>◈ Vitals · Health Telemetry</span>
          <span style={S(`font-family:${GEIST};font-size:28px;font-weight:600;letter-spacing:-0.02em`)}>On-device health analytics</span>
          <span style={S(`font-family:${PLEX};font-size:14px;color:#7D8FA3;line-height:1.6`)}>Recovery, strain, sleep, VO₂ and the four-year ribbon — computed from your Apple Health export, entirely in this browser. Nothing is uploaded.</span>
        </div>

        {phase === 'parsing' ? (
          <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:22px;display:flex;flex-direction:column;gap:10px;align-items:center')}>
            <span style={S(`font-family:${MONO};font-size:12px;color:#4CC2D6`)}>PARSING EXPORT…</span>
            <span style={S(`font-family:${MONO};font-size:22px;font-weight:700`)}>{progress.toLocaleString('en-US')}</span>
            <span style={S(`font-family:${MONO};font-size:10px;color:#7D8FA3`)}>records read · all in-browser</span>
          </div>
        ) : phase === 'error' ? (
          <div style={S('background:#161C24;border:1px solid #E05252;border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:8px')}>
            <span style={S(`font-family:${MONO};font-size:11px;color:#E05252;letter-spacing:0.1em`)}>COULDN’T READ THAT FILE</span>
            <span style={S(`font-family:${PLEX};font-size:13px;color:#E6EDF3`)}>{errMsg}</span>
            <span onClick={onRetry} style={S(`font-family:${MONO};font-size:11px;color:#4CC2D6;cursor:pointer`)}>← try another file</span>
          </div>
        ) : (
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); pick(e.dataTransfer.files[0]); }}
            onClick={() => inputRef.current && inputRef.current.click()}
            style={S(`background:#161C24;border:1px dashed ${drag ? '#4CC2D6' : '#232C38'};border-radius:14px;padding:34px 22px;display:flex;flex-direction:column;gap:8px;align-items:center;cursor:pointer;transition:border-color 140ms ease`)}>
            <span style={S(`font-family:${MONO};font-size:13px;color:#4CC2D6`)}>Drop export.zip or export.xml</span>
            <span style={S(`font-family:${PLEX};font-size:12px;color:#7D8FA3;text-align:center;line-height:1.6`)}>or click to choose. The file never leaves your device.</span>
            <input ref={inputRef} type="file" accept=".zip,.xml" onChange={(e) => pick(e.target.files[0])} style={S('display:none')} />
          </div>
        )}

        <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;gap:6px')}>
          <span style={S(`font-family:${MONO};font-size:9px;letter-spacing:0.2em;color:#7D8FA3;text-transform:uppercase`)}>How to get your export</span>
          <span style={S(`font-family:${PLEX};font-size:12.5px;color:#7D8FA3;line-height:1.7`)}>On iPhone: open <b style={S('color:#E6EDF3')}>Health</b> → tap your <b style={S('color:#E6EDF3')}>profile picture</b> → <b style={S('color:#E6EDF3')}>Export All Health Data</b> → save/AirDrop <b style={S('color:#E6EDF3')}>export.zip</b> to this computer, then drop it above.</span>
        </div>

        <div style={S('display:flex;align-items:center;gap:10px')}>
          <div style={S('flex:1;height:1px;background:#232C38')} />
          <span style={S(`font-family:${MONO};font-size:10px;color:#7D8FA3`)}>OR</span>
          <div style={S('flex:1;height:1px;background:#232C38')} />
        </div>
        <span onClick={onPreview} style={S(`text-align:center;font-family:${MONO};font-size:12px;color:#4CC2D6;cursor:pointer`)}>explore with sample data →</span>
      </div>
    </div>
  );
}

function Dashboard({ state, setState, isReal, onReset }) {
  const eng = new Engine(PROPS, state, setState);
  const v = eng.renderVals();
  const engRef = useRef(null); engRef.current = eng;
  useEffect(() => { eng.paint(); });
  useEffect(() => { const on = () => engRef.current && engRef.current.paint(); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  const { meta } = v;

  return (
    <div style={S('min-height:100vh;display:flex;justify-content:center;background:#0B0F14')}>
      <div style={S('width:100%;max-width:520px;min-height:100vh;display:flex;flex-direction:column;border-left:1px solid #161C24;border-right:1px solid #161C24;position:relative')}>

        {/* header */}
        <div style={S('flex:0 0 auto;padding:16px 18px 12px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #161C24')}>
          <div style={S('display:flex;flex-direction:column;gap:3px')}>
            <span style={S(`font-family:${MONO};font-size:10px;letter-spacing:0.18em;color:#4CC2D6;text-transform:uppercase`)}>{v.screenTitle}</span>
            <span style={S(`font-family:${GEIST};font-size:19px;font-weight:600;letter-spacing:-0.01em`)}>{v.screenHeading}</span>
          </div>
          <div style={S(`display:flex;flex-direction:column;align-items:flex-end;gap:3px;font-family:${MONO};font-size:9px;color:#7D8FA3;line-height:1.4`)}>
            <span onClick={onReset} style={S('cursor:pointer')}>{meta.recordCount} REC · ↺</span>
            <span style={S('color:#5BC98B')}>{meta.dayCount} DAYS · {isReal ? 'APPLE HEALTH' : 'SAMPLE'}</span>
          </div>
        </div>

        {/* scroll body */}
        <div style={S('flex:1 1 auto;overflow-y:auto;padding:16px 16px 96px;display:flex;flex-direction:column;gap:14px')}>
          {v.isToday && <Today v={v} />}
          {v.isTrends && <Trends v={v} />}
          {v.isSleep && <Sleep v={v} />}
          {v.isFitness && <Fitness v={v} />}
          {v.isCardio && <Cardio v={v} isReal={isReal} />}
          {v.isExplore && <Explore v={v} />}
          {v.isRibbon && <Ribbon v={v} />}
          {v.isTrain && <Workouts v={v} />}
          {v.isWeek && <Week v={v} />}
        </div>

        {/* tab bar */}
        <div style={S('position:sticky;bottom:0;flex:0 0 auto;border-top:1px solid #232C38;background:#0B0F14;padding:9px 4px 12px;display:flex;justify-content:space-between')}>
          {v.tabs.map((t, i) => (
            <div key={i} onClick={t.onClick} style={S('flex:1 1 0;display:flex;flex-direction:column;align-items:center;gap:5px;cursor:pointer;padding:2px 0')}>
              <div style={S(`width:14px;height:2px;border-radius:2px;background:${t.color}`)} />
              <span style={S(`font-family:${MONO};font-size:8px;letter-spacing:0.02em;color:${t.color};text-transform:uppercase`)}>{t.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- shared bits ----------
const cap = (t) => <span style={S(`font-family:${MONO};font-size:9px;letter-spacing:0.2em;color:#7D8FA3;text-transform:uppercase`)}>{t}</span>;
const card = (children, extra = '') => <div style={S(`background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 16px;display:flex;flex-direction:column;gap:12px;${extra}`)}>{children}</div>;

function Today({ v }) {
  const { meta } = v;
  return (
    <div style={S('display:flex;flex-direction:column;gap:14px')}>
      <div style={S('background:#161C24;border:1px solid #232C38;border-left:2px solid #4CC2D6;border-radius:14px;padding:15px 16px;display:flex;flex-direction:column;gap:7px')}>
        {cap('Directive')}
        <span style={S(`font-family:${GEIST};font-size:17px;font-weight:500;line-height:1.35`)}>{v.today.directive}</span>
        <span style={S(`font-family:${MONO};font-size:11px;color:#7D8FA3;line-height:1.5`)}>{v.today.directiveSub}</span>
      </div>
      <div style={S('display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px')}>
        {v.dials.map((d, i) => (
          <div key={i} onClick={d.onClick} style={S(`background:#161C24;border:1px solid ${d.border};border-radius:14px;padding:12px 8px 11px;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer`)}>
            <svg viewBox="0 0 120 120" style={S('width:82px;height:82px;transform:rotate(-90deg)')}>
              <circle cx="60" cy="60" r="50" fill="none" stroke="#232C38" strokeWidth="9" />
              <circle cx="60" cy="60" r="50" fill="none" stroke={d.color} strokeWidth="9" strokeLinecap="round" strokeDasharray={d.dash} />
            </svg>
            <div style={S('margin-top:-56px;display:flex;flex-direction:column;align-items:center')}>
              <span style={S(`font-family:${MONO};font-size:23px;font-weight:700;color:${d.color};letter-spacing:-0.02em`)}>{d.value}</span>
              <span style={S(`font-family:${MONO};font-size:8px;color:#7D8FA3`)}>{d.unit}</span>
            </div>
            <div style={S('margin-top:20px;display:flex;flex-direction:column;align-items:center;gap:2px')}>
              <span style={S(`font-family:${MONO};font-size:9px;letter-spacing:0.12em;color:#E6EDF3;text-transform:uppercase`)}>{d.label}</span>
              <span style={S(`font-family:${MONO};font-size:9px;color:#7D8FA3`)}>{d.delta}</span>
            </div>
          </div>
        ))}
      </div>
      {v.openPanel && (
        <div style={S('background:#161C24;border:1px solid #4CC2D6;border-radius:14px;padding:15px 16px;display:flex;flex-direction:column;gap:12px')}>
          <div style={S('display:flex;align-items:baseline;justify-content:space-between')}>
            <span style={S(`font-family:${GEIST};font-size:14px;font-weight:600`)}>{v.openPanel.title}</span>
            <span onClick={v.closePanel} style={S(`font-family:${MONO};font-size:10px;color:#7D8FA3;cursor:pointer`)}>CLOSE ×</span>
          </div>
          <span style={S(`font-family:${MONO};font-size:11px;color:#7D8FA3;line-height:1.5`)}>{v.openPanel.formula}</span>
          {v.openPanel.components.map((c, i) => (
            <div key={i} style={S('display:flex;flex-direction:column;gap:5px')}>
              <div style={S(`display:flex;align-items:baseline;justify-content:space-between;font-family:${MONO};font-size:11px`)}>
                <span style={S('color:#E6EDF3')}>{c.name} <span style={S('color:#7D8FA3')}>·w{c.weight}</span></span>
                <span style={S(`color:${c.color}`)}>{c.readout}</span>
              </div>
              <div style={S('height:5px;border-radius:3px;background:#0B0F14;overflow:hidden;position:relative')}>
                <div style={S(`position:absolute;left:0;top:0;bottom:0;width:${c.pct}%;background:${c.color}`)} />
              </div>
              <span style={S(`font-family:${PLEX};font-size:11px;color:#7D8FA3;line-height:1.45`)}>{c.note}</span>
            </div>
          ))}
        </div>
      )}
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 16px;display:flex;flex-direction:column;gap:12px')}>
        <div style={S('display:flex;align-items:baseline;justify-content:space-between')}>{cap('Acute : Chronic load')}<span style={S(`font-family:${MONO};font-size:10px;color:${v.acwr.color}`)}>{v.acwr.band}</span></div>
        <div style={S('display:flex;align-items:flex-end;gap:10px')}>
          <span style={S(`font-family:${MONO};font-size:34px;font-weight:700;line-height:0.9;color:${v.acwr.color};letter-spacing:-0.03em`)}>{v.acwr.value}</span>
          <span style={S(`font-family:${MONO};font-size:10px;color:#7D8FA3;line-height:1.5;padding-bottom:3px`)}>7d {v.acwr.acute} TRIMP<br />28d {v.acwr.chronic} TRIMP</span>
        </div>
        <div style={S('position:relative;height:24px')}>
          <div style={S('position:absolute;left:0;right:0;top:8px;height:6px;border-radius:3px;display:flex;overflow:hidden')}>
            <div style={S('flex:0 0 32%;background:#2A3644')} /><div style={S('flex:0 0 28%;background:#5BC98B')} /><div style={S('flex:0 0 12%;background:#E8A33D')} /><div style={S('flex:1 1 auto;background:#E05252')} />
          </div>
          <div style={S(`position:absolute;top:2px;left:${v.acwr.markerPct}%;width:2px;height:18px;background:#E6EDF3`)} />
        </div>
        <div style={S(`display:flex;justify-content:space-between;font-family:${MONO};font-size:9px;color:#7D8FA3`)}><span>0.5</span><span>0.8</span><span>1.3</span><span>1.5</span><span>2.0</span></div>
        <span style={S(`font-family:${PLEX};font-size:12px;color:#7D8FA3;line-height:1.5`)}>{v.acwr.note}</span>
      </div>
      <div onClick={v.goRibbon} style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 16px 13px;display:flex;flex-direction:column;gap:10px;cursor:pointer')}>
        <div style={S('display:flex;align-items:baseline;justify-content:space-between')}>{cap('The record ribbon')}<span style={S(`font-family:${MONO};font-size:9px;color:#4CC2D6`)}>OPEN →</span></div>
        <canvas ref={v.miniRibbonRef} style={S('width:100%;height:44px;display:block;border-radius:3px')} />
        <div style={S(`display:flex;justify-content:space-between;font-family:${MONO};font-size:9px;color:#7D8FA3`)}><span>{v.ribbon.ticks[0] && v.ribbon.ticks[0].label}</span><span>{meta.dayCount} DAYS · RECOVERY</span><span>{v.ribbon.ticks.length ? v.ribbon.ticks[v.ribbon.ticks.length - 1].label : ''}</span></div>
      </div>
      <div style={S('display:flex;flex-direction:column;gap:8px')}>
        {cap('Automatic flags')}
        {v.flags.map((f, i) => (
          <div key={i} style={S('background:#161C24;border:1px solid #232C38;border-radius:12px;padding:12px 14px;display:flex;gap:11px;align-items:flex-start')}>
            <div style={S(`flex:0 0 auto;width:6px;height:6px;border-radius:4px;background:${f.color};margin-top:5px`)} />
            <div style={S('display:flex;flex-direction:column;gap:3px')}>
              <span style={S(`font-family:${MONO};font-size:11px;color:#E6EDF3`)}>{f.title}</span>
              <span style={S(`font-family:${PLEX};font-size:12px;color:#7D8FA3;line-height:1.5`)}>{f.body}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Trends({ v }) {
  return (
    <div style={S('display:flex;flex-direction:column;gap:14px')}>
      <div style={S('display:flex;flex-wrap:wrap;gap:6px')}>
        {v.metricChips.map((m, i) => <span key={i} onClick={m.onClick} style={S(`font-family:${MONO};font-size:10px;padding:6px 9px;border-radius:7px;cursor:pointer;background:${m.bg};color:${m.fg};border:1px solid ${m.border}`)}>{m.label}</span>)}
      </div>
      <div style={S('display:flex;gap:6px')}>
        {v.windowChips.map((w, i) => <span key={i} onClick={w.onClick} style={S(`flex:1 1 0;text-align:center;font-family:${MONO};font-size:10px;padding:6px 0;border-radius:7px;cursor:pointer;background:${w.bg};color:${w.fg};border:1px solid ${w.border}`)}>{w.label}</span>)}
      </div>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 14px 12px;display:flex;flex-direction:column;gap:10px')}>
        <div style={S('display:flex;align-items:flex-end;justify-content:space-between')}>
          <div style={S('display:flex;flex-direction:column;gap:2px')}>
            {cap(v.trend.title)}
            <span style={S(`font-family:${MONO};font-size:26px;font-weight:700;letter-spacing:-0.03em`)}>{v.trend.latest}<span style={S('font-size:11px;color:#7D8FA3;font-weight:400')}> {v.trend.unit}</span></span>
          </div>
          <div style={S(`display:flex;flex-direction:column;align-items:flex-end;gap:2px;font-family:${MONO};font-size:10px`)}>
            <span style={S(`color:${v.trend.deltaColor}`)}>{v.trend.delta}</span><span style={S('color:#7D8FA3')}>σ {v.trend.sigma}</span>
          </div>
        </div>
        <svg viewBox="0 0 340 168" style={S('width:100%;height:168px;display:block;overflow:visible')}>
          <path d={v.trend.bandPath} fill="#4CC2D6" opacity="0.09" />
          <path d={v.trend.meanPath} fill="none" stroke="#4CC2D6" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
          <path d={v.trend.path} fill="none" stroke="#E6EDF3" strokeWidth="1.4" strokeLinejoin="round" />
          {v.trend.pts.map((p, i) => <circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill={p.fill} stroke={p.stroke} strokeWidth="1.2" />)}
          {v.trend.yLabels.map((l, i) => <text key={i} x="0" y={l.y} fill="#7D8FA3" style={S(`font-family:${MONO};font-size:8px`)}>{l.text}</text>)}
          {v.trend.xLabels.map((l, i) => <text key={i} x={l.x} y="166" fill="#7D8FA3" textAnchor="middle" style={S(`font-family:${MONO};font-size:8px`)}>{l.text}</text>)}
        </svg>
        <div style={S(`display:flex;justify-content:space-between;font-family:${MONO};font-size:9px;color:#7D8FA3;border-top:1px solid #232C38;padding-top:9px`)}>
          <span>MEAN {v.trend.mean}</span><span>MIN {v.trend.min}</span><span>MAX {v.trend.max}</span><span>N {v.trend.n}</span>
        </div>
      </div>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:6px')}>{cap('Reading')}<span style={S(`font-family:${PLEX};font-size:13px;line-height:1.55`)}>{v.trend.reading}</span></div>
    </div>
  );
}

function Sleep({ v }) {
  const sp = v.sleep;
  return (
    <div style={S('display:flex;flex-direction:column;gap:14px')}>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 14px 12px;display:flex;flex-direction:column;gap:12px')}>
        <div style={S('display:flex;align-items:center;justify-content:space-between')}>
          <span onClick={v.prevNight} style={S(`font-family:${MONO};font-size:11px;color:#4CC2D6;cursor:pointer`)}>← PREV</span>
          <span style={S(`font-family:${MONO};font-size:11px`)}>{sp.dateLabel}</span>
          <span onClick={v.nextNight} style={S(`font-family:${MONO};font-size:11px;color:${sp.nextColor};cursor:pointer`)}>NEXT →</span>
        </div>
        <div style={S('display:flex;align-items:flex-end;gap:14px')}>
          <span style={S(`font-family:${MONO};font-size:32px;font-weight:700;letter-spacing:-0.03em;line-height:0.9`)}>{sp.duration}</span>
          <div style={S(`display:flex;flex-direction:column;gap:2px;font-family:${MONO};font-size:10px;color:#7D8FA3;padding-bottom:2px`)}>
            <span>NEED {sp.need}</span><span style={S(`color:${sp.debtColor}`)}>DEBT {sp.debt}</span>
          </div>
          <div style={S('margin-left:auto;display:flex;flex-direction:column;align-items:flex-end')}>
            <span style={S(`font-family:${MONO};font-size:22px;font-weight:700;color:${sp.scoreColor}`)}>{sp.score}</span><span style={S(`font-family:${MONO};font-size:8px;color:#7D8FA3`)}>SCORE</span>
          </div>
        </div>
        <svg viewBox="0 0 340 132" style={S('width:100%;height:132px;display:block')}>
          {sp.stages.map((s, i) => <rect key={i} x={s.x} y={s.y} width={s.w} height={s.h} fill={s.fill} rx="1.5" />)}
          {sp.stageLabels.map((l, i) => <text key={i} x="0" y={l.y} fill="#7D8FA3" style={S(`font-family:${MONO};font-size:8px`)}>{l.text}</text>)}
          {sp.timeLabels.map((l, i) => <text key={i} x={l.x} y="130" fill="#7D8FA3" textAnchor="middle" style={S(`font-family:${MONO};font-size:8px`)}>{l.text}</text>)}
        </svg>
        <div style={S('display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:8px;border-top:1px solid #232C38;padding-top:10px')}>
          {sp.breakdown.map((b, i) => (
            <div key={i} style={S('display:flex;flex-direction:column;gap:2px')}>
              <span style={S(`font-family:${MONO};font-size:8px;color:#7D8FA3;letter-spacing:0.1em`)}>{b.label}</span>
              <span style={S(`font-family:${MONO};font-size:13px;color:${b.color};font-weight:500`)}>{b.value}</span>
              <span style={S(`font-family:${MONO};font-size:8px;color:#7D8FA3`)}>{b.pct}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 14px 12px;display:flex;flex-direction:column;gap:10px')}>
        {cap('Debt accumulation · 60 nights')}
        <svg viewBox="0 0 340 110" style={S('width:100%;height:110px;display:block')}>
          <path d={v.debt.area} fill="#E8A33D" opacity="0.16" /><path d={v.debt.path} fill="none" stroke="#E8A33D" strokeWidth="1.4" />
          {v.debt.yLabels.map((l, i) => <text key={i} x="0" y={l.y} fill="#7D8FA3" style={S(`font-family:${MONO};font-size:8px`)}>{l.text}</text>)}
        </svg>
        <span style={S(`font-family:${PLEX};font-size:12px;color:#7D8FA3;line-height:1.5`)}>{v.debt.note}</span>
      </div>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 14px 12px;display:flex;flex-direction:column;gap:10px')}>
        {cap('Bedtime consistency · onset vs wake')}
        <svg viewBox="0 0 340 150" style={S('width:100%;height:150px;display:block')}>
          {v.consistency.grid.map((g, i) => <line key={i} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke="#232C38" strokeWidth="1" />)}
          {v.consistency.pts.map((p, i) => <circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill={p.fill} opacity={p.op} />)}
          {v.consistency.labels.map((l, i) => <text key={i} x={l.x} y={l.y} fill="#7D8FA3" textAnchor={l.anchor} style={S(`font-family:${MONO};font-size:8px`)}>{l.text}</text>)}
        </svg>
        <span style={S(`font-family:${PLEX};font-size:12px;color:#7D8FA3;line-height:1.5`)}>{v.consistency.note}</span>
      </div>
    </div>
  );
}

function Fitness({ v }) {
  return (
    <div style={S('display:flex;flex-direction:column;gap:14px')}>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 14px 12px;display:flex;flex-direction:column;gap:12px')}>
        <div style={S('display:flex;align-items:flex-start;justify-content:space-between')}>
          <div style={S('display:flex;flex-direction:column;gap:2px')}>{cap('VO₂ max · relative')}<span style={S(`font-family:${MONO};font-size:28px;font-weight:700;letter-spacing:-0.03em;color:#4CC2D6`)}>{v.vo2.rel}<span style={S('font-size:10px;color:#7D8FA3;font-weight:400')}> ml/kg/min</span></span></div>
          <div style={S('display:flex;flex-direction:column;align-items:flex-end;gap:2px')}>{cap('Absolute')}<span style={S(`font-family:${MONO};font-size:28px;font-weight:700;letter-spacing:-0.03em;color:#5BC98B`)}>{v.vo2.abs}<span style={S('font-size:10px;color:#7D8FA3;font-weight:400')}> L/min</span></span></div>
        </div>
        <svg viewBox="0 0 340 176" style={S('width:100%;height:176px;display:block;overflow:visible')}>
          <path d={v.vo2.conePath} fill="#4CC2D6" opacity="0.10" />
          <path d={v.vo2.projPath} fill="none" stroke="#4CC2D6" strokeWidth="1.2" strokeDasharray="4 3" opacity="0.8" />
          <path d={v.vo2.relPath} fill="none" stroke="#4CC2D6" strokeWidth="1.6" />
          <path d={v.vo2.absPath} fill="none" stroke="#5BC98B" strokeWidth="1.6" />
          {v.vo2.pts.map((p, i) => <circle key={i} cx={p.cx} cy={p.cy} r="2.4" fill="#0B0F14" stroke="#4CC2D6" strokeWidth="1.3" />)}
          {v.vo2.labels.map((l, i) => <text key={i} x={l.x} y={l.y} fill={l.fill} textAnchor={l.anchor} style={S(`font-family:${MONO};font-size:8px`)}>{l.text}</text>)}
        </svg>
      </div>
      <div style={S('background:#161C24;border:1px solid #232C38;border-left:2px solid #5BC98B;border-radius:14px;padding:15px 16px;display:flex;flex-direction:column;gap:11px')}>
        {cap('Decomposition')}
        <div style={S(`display:grid;grid-template-columns:1.3fr 1fr 1fr 1fr;gap:6px;font-family:${MONO};font-size:10px`)}>
          {v.decomp.cells.map((c, i) => <span key={i} style={S(`color:${c.color};text-align:${c.align};padding:3px 0;border-bottom:1px solid ${c.rule}`)}>{c.text}</span>)}
        </div>
        <div style={S('display:flex;height:8px;border-radius:4px;overflow:hidden')}>
          <div style={S(`flex:0 0 ${v.decomp.trPct}%;background:#5BC98B`)} /><div style={S('flex:1 1 auto;background:#E8A33D')} />
        </div>
        <div style={S(`display:flex;justify-content:space-between;font-family:${MONO};font-size:9px`)}><span style={S('color:#5BC98B')}>{v.decomp.trPct}% TRAINING</span><span style={S('color:#E8A33D')}>{v.decomp.scPct}% SCALE</span></div>
        <span style={S(`font-family:${PLEX};font-size:13px;color:#E6EDF3;line-height:1.55`)}>{v.decomp.plain}</span>
        <div style={S('background:#0B0F14;border:1px solid #232C38;border-radius:10px;padding:11px 12px;display:flex;flex-direction:column;gap:7px')}>
          {cap('Counterfactual · at ' + v.counter.weight + ' kg')}
          <div style={S('display:flex;align-items:baseline;gap:8px')}><span style={S(`font-family:${MONO};font-size:24px;font-weight:700;color:#4CC2D6`)}>{v.counter.value}</span><span style={S(`font-family:${MONO};font-size:10px;color:#7D8FA3`)}>ml/kg/min · {v.counter.delta}</span></div>
          <input type="range" min="60" max="110" step="1" value={v.counter.weight} onChange={v.setCounterWeight} style={S('width:100%;accent-color:#4CC2D6')} />
        </div>
      </div>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 14px 12px;display:flex;flex-direction:column;gap:10px')}>
        <div style={S('display:flex;align-items:baseline;justify-content:space-between')}>{cap('Efficiency factor')}<span style={S(`font-family:${MONO};font-size:11px;color:#5BC98B`)}>{v.ef.delta}</span></div>
        <svg viewBox="0 0 340 96" style={S('width:100%;height:96px;display:block')}><path d={v.ef.path} fill="none" stroke="#5BC98B" strokeWidth="1.5" /><path d={v.ef.fitPath} fill="none" stroke="#7D8FA3" strokeWidth="1" strokeDasharray="3 3" /></svg>
        <span style={S(`font-family:${PLEX};font-size:12px;color:#7D8FA3;line-height:1.5`)}>{v.ef.note}</span>
      </div>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:10px')}>
        {cap('Body mass · provenance honest')}
        <svg viewBox="0 0 340 86" style={S('width:100%;height:86px;display:block')}><path d={v.mass.path} fill="none" stroke="#7D8FA3" strokeWidth="1.2" strokeDasharray="3 3" />{v.mass.pts.map((p, i) => <circle key={i} cx={p.cx} cy={p.cy} r="3" fill="#0B0F14" stroke="#E6EDF3" strokeWidth="1.4" />)}</svg>
        <span style={S(`font-family:${PLEX};font-size:12px;color:#7D8FA3;line-height:1.5`)}>{v.mass.note}</span>
      </div>
    </div>
  );
}

function Cardio({ v, isReal }) {
  return (
    <div style={S('display:flex;flex-direction:column;gap:14px')}>
      <div style={S('display:grid;grid-template-columns:1fr 1fr;gap:10px')}>
        {v.cardioStats.map((s, i) => (
          <div key={i} style={S('background:#161C24;border:1px solid #232C38;border-radius:12px;padding:12px 13px;display:flex;flex-direction:column;gap:4px')}>
            <span style={S(`font-family:${MONO};font-size:8px;letter-spacing:0.14em;color:#7D8FA3;text-transform:uppercase`)}>{s.label}</span>
            <span style={S(`font-family:${MONO};font-size:21px;font-weight:700;color:${s.color};letter-spacing:-0.02em`)}>{s.value}</span>
            <span style={S(`font-family:${MONO};font-size:9px;color:#7D8FA3`)}>{s.sub}</span>
          </div>
        ))}
      </div>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 14px 12px;display:flex;flex-direction:column;gap:10px')}>
        {cap('Circadian HR profile · mean bpm by hour')}
        {v.circadian.has ? (
          <svg viewBox="0 0 340 118" style={S('width:100%;height:118px;display:block')}>
            {v.circadian.bars.map((b, i) => <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={b.fill} rx="1.5" />)}
            {v.circadian.labels.map((l, i) => <text key={i} x={l.x} y="116" fill="#7D8FA3" textAnchor="middle" style={S(`font-family:${MONO};font-size:8px`)}>{l.text}</text>)}
          </svg>
        ) : <span style={S(`font-family:${PLEX};font-size:12px;color:#7D8FA3;padding:14px 0`)}>Not enough heart-rate samples for an hourly profile.</span>}
        <span style={S(`font-family:${PLEX};font-size:12px;color:#7D8FA3;line-height:1.5`)}>{v.circadian.note}</span>
      </div>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 14px 13px;display:flex;flex-direction:column;gap:10px')}>
        <div style={S('display:flex;align-items:baseline;justify-content:space-between')}>{cap('ECG · representative')}<span style={S(`font-family:${MONO};font-size:10px;color:#5BC98B`)}>SINUS RHYTHM</span></div>
        <canvas ref={v.ecgRef} style={S('width:100%;height:126px;display:block;border-radius:6px;background:#12090B')} />
        <span style={S(`font-family:${PLEX};font-size:12px;color:#7D8FA3;line-height:1.5`)}>{isReal ? 'Representative trace. Apple exports ECG voltage as CSVs inside the archive; parsing those is not in this build yet.' : 'Representative PQRST trace on clinical grid paper.'}</span>
      </div>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 14px 12px;display:flex;flex-direction:column;gap:10px')}>
        {cap('HR recovery · 60 s post-effort')}
        <svg viewBox="0 0 340 96" style={S('width:100%;height:96px;display:block')}>
          <path d={v.hrr.path} fill="none" stroke="#4CC2D6" strokeWidth="1.6" />
          <line x1="0" y1={v.hrr.thresholdY} x2="340" y2={v.hrr.thresholdY} stroke="#E05252" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
        </svg>
        <span style={S(`font-family:${PLEX};font-size:12px;color:#7D8FA3;line-height:1.5`)}>{v.hrr.note}</span>
      </div>
    </div>
  );
}

function Explore({ v }) {
  return (
    <div style={S('display:flex;flex-direction:column;gap:14px')}>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 16px;display:flex;flex-direction:column;gap:10px')}>
        <div style={S('display:flex;align-items:baseline;justify-content:space-between')}>{cap('Lag')}<span style={S(`font-family:${MONO};font-size:13px;color:#4CC2D6`)}>{v.explore.lagLabel}</span></div>
        <input type="range" min="0" max="4" step="1" value={v.explore.lag} onChange={v.setLag} style={S('width:100%;accent-color:#4CC2D6')} />
        <span style={S(`font-family:${PLEX};font-size:12px;color:#7D8FA3;line-height:1.5`)}>Rows are predictors shifted back {v.explore.lagLabel}; columns are today.</span>
      </div>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 12px 12px;overflow-x:auto')}>
        <div style={S('display:grid;grid-template-columns:52px repeat(6, 1fr);gap:3px;min-width:320px')}>
          {v.explore.cells.map((c, i) => <div key={i} style={S(`height:34px;display:flex;align-items:center;justify-content:${c.justify};border-radius:3px;background:${c.bg};font-family:${MONO};font-size:${c.size};color:${c.fg};padding:0 3px;text-align:center;line-height:1.15`)}>{c.text}</div>)}
        </div>
      </div>
      <div style={S('background:#161C24;border:1px solid #232C38;border-left:2px solid #4CC2D6;border-radius:14px;padding:15px 16px;display:flex;flex-direction:column;gap:7px')}>
        {cap('Strongest relationship at this lag')}
        <span style={S(`font-family:${GEIST};font-size:15px;font-weight:500;line-height:1.4`)}>{v.explore.finding}</span>
        <span style={S(`font-family:${MONO};font-size:10px;color:#7D8FA3`)}>r = {v.explore.findingR} · n = {v.explore.findingN} days · Pearson, listwise</span>
      </div>
    </div>
  );
}

function Ribbon({ v }) {
  return (
    <div style={S('display:flex;flex-direction:column;gap:14px')}>
      <div style={S('display:flex;flex-wrap:wrap;gap:6px')}>
        {v.ribbonChips.map((m, i) => <span key={i} onClick={m.onClick} style={S(`font-family:${MONO};font-size:10px;padding:6px 9px;border-radius:7px;cursor:pointer;background:${m.bg};color:${m.fg};border:1px solid ${m.border}`)}>{m.label}</span>)}
      </div>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 14px 12px;display:flex;flex-direction:column;gap:10px')}>
        <canvas ref={v.tallRibbonRef} onMouseMove={v.onRibbonMove} onMouseLeave={v.onRibbonLeave} style={S('width:100%;height:118px;display:block;border-radius:4px;cursor:crosshair')} />
        <div style={S(`display:flex;justify-content:space-between;font-family:${MONO};font-size:9px;color:#7D8FA3`)}>{v.ribbon.ticks.map((t, i) => <span key={i}>{t.label}</span>)}</div>
      </div>
      <div style={S(`background:#161C24;border:1px solid ${v.scrub.border};border-radius:14px;padding:15px 16px;display:flex;flex-direction:column;gap:11px`)}>
        <div style={S('display:flex;align-items:baseline;justify-content:space-between')}><span style={S(`font-family:${MONO};font-size:11px`)}>{v.scrub.date}</span><span style={S(`font-family:${MONO};font-size:9px;color:#7D8FA3`)}>{v.scrub.hint}</span></div>
        <div style={S('display:grid;grid-template-columns:1fr 1fr 1fr;gap:11px')}>
          {v.scrub.stats.map((s, i) => <div key={i} style={S('display:flex;flex-direction:column;gap:2px')}><span style={S(`font-family:${MONO};font-size:8px;letter-spacing:0.12em;color:#7D8FA3;text-transform:uppercase`)}>{s.label}</span><span style={S(`font-family:${MONO};font-size:15px;color:${s.color};font-weight:500`)}>{s.value}</span></div>)}
        </div>
      </div>
    </div>
  );
}

function Workouts({ v }) {
  const w = v.workout;
  return (
    <div style={S('display:flex;flex-direction:column;gap:14px')}>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:13px 14px 10px;display:flex;flex-direction:column;gap:8px')}>
        <div style={S(`display:grid;grid-template-columns:1.4fr 1.5fr 0.9fr 1.1fr 0.9fr;gap:6px;font-family:${MONO};font-size:8px;letter-spacing:0.14em;color:#7D8FA3;text-transform:uppercase;padding-bottom:7px;border-bottom:1px solid #232C38`)}>
          <span>Date</span><span>Type</span><span style={S('text-align:right')}>Min</span><span style={S('text-align:right')}>HR</span><span style={S('text-align:right')}>Str</span>
        </div>
        {v.woList.map((wo, i) => (
          <div key={i} onClick={wo.onClick} style={S(`display:grid;grid-template-columns:1.4fr 1.5fr 0.9fr 1.1fr 0.9fr;gap:6px;align-items:center;font-family:${MONO};font-size:10px;padding:7px 6px;margin:0 -6px;border-radius:7px;cursor:pointer;background:${wo.bg};border:1px solid ${wo.border}`)}>
            <span>{wo.date}</span><span style={S(`color:${wo.typeColor}`)}>{wo.type}</span><span style={S('color:#7D8FA3;text-align:right')}>{wo.dur}</span><span style={S('color:#7D8FA3;text-align:right')}>{wo.hr}</span><span style={S('text-align:right')}>{wo.strain}</span>
          </div>
        ))}
      </div>
      <div style={S('background:#161C24;border:1px solid #4CC2D6;border-radius:14px;padding:15px 14px 13px;display:flex;flex-direction:column;gap:13px')}>
        <div style={S('display:flex;align-items:baseline;justify-content:space-between')}><span style={S(`font-family:${GEIST};font-size:15px;font-weight:600`)}>{w.title}</span><span style={S(`font-family:${MONO};font-size:9px;color:#7D8FA3`)}>DETAIL</span></div>
        <div style={S('display:grid;grid-template-columns:1fr 1fr 1fr;gap:11px')}>
          {w.stats.map((s, i) => <div key={i} style={S('display:flex;flex-direction:column;gap:2px')}><span style={S(`font-family:${MONO};font-size:8px;letter-spacing:0.12em;color:#7D8FA3;text-transform:uppercase`)}>{s.label}</span><span style={S(`font-family:${MONO};font-size:14px;font-weight:500`)}>{s.value}</span></div>)}
        </div>
        <svg viewBox="0 0 340 150" style={S('width:100%;height:150px;display:block')}>
          {w.zoneShade.map((z, i) => <rect key={i} x="26" y={z.y} width="314" height={z.h} fill={z.fill} opacity="0.55" />)}
          <path d={w.hrPath} fill="none" stroke="#E6EDF3" strokeWidth="1.5" strokeLinejoin="round" />
          {w.zoneAxis.map((a, i) => <text key={i} x="0" y={a.y} fill="#7D8FA3" style={S(`font-family:${MONO};font-size:8px`)}>{a.text}</text>)}
        </svg>
        <div style={S('display:flex;flex-direction:column;gap:6px;border-top:1px solid #232C38;padding-top:11px')}>
          {w.zones.map((z, i) => (
            <div key={i} style={S('display:flex;align-items:center;gap:9px')}>
              <span style={S(`font-family:${MONO};font-size:9px;color:#7D8FA3;flex:0 0 78px`)}>{z.name}</span>
              <div style={S('flex:1 1 auto;height:9px;background:#0B0F14;border-radius:2px;overflow:hidden')}><div style={S(`width:${z.pct}%;height:100%;background:${z.color}`)} /></div>
              <span style={S(`font-family:${MONO};font-size:9px;flex:0 0 34px;text-align:right`)}>{z.min}</span>
            </div>
          ))}
        </div>
        <span style={S(`font-family:${PLEX};font-size:11.5px;color:#7D8FA3;line-height:1.5`)}>{w.cadNote} · {w.driftNote}</span>
      </div>
    </div>
  );
}

function Week({ v }) {
  const wk = v.week;
  return (
    <div style={S('display:flex;flex-direction:column;gap:14px')}>
      <div style={S('display:grid;grid-template-columns:1fr 1fr;gap:10px')}>
        {wk.totals.map((t, i) => <div key={i} style={S('background:#161C24;border:1px solid #232C38;border-radius:12px;padding:12px 13px;display:flex;flex-direction:column;gap:4px')}><span style={S(`font-family:${MONO};font-size:8px;letter-spacing:0.14em;color:#7D8FA3;text-transform:uppercase`)}>{t.label}</span><span style={S(`font-family:${MONO};font-size:19px;font-weight:700;color:${t.color};letter-spacing:-0.02em`)}>{t.value}</span></div>)}
      </div>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 14px 12px;display:flex;flex-direction:column;gap:11px')}>
        <div style={S('display:flex;align-items:center;justify-content:space-between')}>{cap('Strain vs recovery')}<div style={S(`display:flex;gap:12px;font-family:${MONO};font-size:9px`)}><span style={S('color:#5BC98B')}>▮ RECOVERY</span><span style={S('color:#4CC2D6')}>▮ STRAIN</span></div></div>
        <svg viewBox="0 0 340 116" style={S('width:100%;height:116px;display:block')}>
          {wk.bars.map((b, i) => <g key={i}><rect x={b.x} y={b.rY} width="14" height={b.rH} fill={b.rFill} rx="2" /><rect x={b.sx} y={b.sY} width="14" height={b.sH} fill="#4CC2D6" rx="2" /><text x={b.lx} y="112" fill="#7D8FA3" textAnchor="middle" style={S(`font-family:${MONO};font-size:8.5px`)}>{b.label}</text></g>)}
        </svg>
        <span style={S(`font-family:${PLEX};font-size:12px;color:#7D8FA3;line-height:1.5`)}>{wk.verdict}</span>
      </div>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:15px 14px 13px;display:flex;flex-direction:column;gap:11px')}>
        {cap('Time in zone · 7 days')}
        <div style={S('display:flex;height:12px;border-radius:3px;overflow:hidden')}>{wk.zones.map((z, i) => <div key={i} style={S(`width:${z.width}%;background:${z.color}`)} />)}</div>
        <div style={S('display:grid;grid-template-columns:1fr 1fr 1fr 1fr 1fr;gap:6px')}>
          {wk.zones.map((z, i) => <div key={i} style={S('display:flex;flex-direction:column;gap:2px')}><span style={S(`font-family:${MONO};font-size:9px;color:${z.color}`)}>{z.name}</span><span style={S(`font-family:${MONO};font-size:11px`)}>{z.min}</span><span style={S(`font-family:${MONO};font-size:8px;color:#7D8FA3`)}>{z.pct}%</span></div>)}
        </div>
      </div>
      <div style={S('background:#161C24;border:1px solid #232C38;border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:9px')}>
        {cap('Against the 4-week average')}
        {wk.compare.map((c, i) => <div key={i} style={S(`display:flex;align-items:baseline;justify-content:space-between;font-family:${MONO};font-size:11px;border-bottom:1px solid #232C38;padding-bottom:6px`)}><span style={S('color:#7D8FA3')}>{c.label}</span><span style={S(`color:${c.color}`)}>{c.value}</span></div>)}
      </div>
    </div>
  );
}
