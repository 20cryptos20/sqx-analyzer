// SQX Analyzer v4 — Main Logic
// All processing happens locally, files never leave the user's machine

// ═══════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════
const strategies = [null, null, null];
let activeStrat  = 0;
let chartReg     = {};
const SLOT_COLORS = ['#f59e0b','#38bdf8','#a78bfa'];

const DEFAULT_WEIGHTS = {
  oos_rdd:30, cv:20, rdd_min:15, is_rdd:15,
  degradation:10, full_np:5, pct_pos:5
};
const WEIGHT_LABELS = {
  oos_rdd:'RetDD OOS', cv:'Planitud (CV)', rdd_min:'RDD mín periodo',
  is_rdd:'RetDD IS', degradation:'Degradación IS→OOS',
  full_np:'NP Full', pct_pos:'% Periodos pos'
};
let weights = {...DEFAULT_WEIGHTS};

// ═══════════════════════════════════════════
// BINARY DECODE
// ═══════════════════════════════════════════
function decodeStats(b64) {
  try {
    const raw = Uint8Array.from(atob(b64), c=>c.charCodeAt(0));
    const dv  = new DataView(raw.buffer);
    let pos = 6;
    const e = {};
    while (pos < raw.length - 5) {
      const t=raw[pos++], k=raw[pos++];
      let v;
      if      (t===0x03){if(pos+4>raw.length)break;v=dv.getFloat32(pos,false);pos+=4}
      else if (t===0x01){if(pos+4>raw.length)break;v=dv.getInt32(pos,false);pos+=4}
      else if (t===0x04){pos+=8;continue}
      else continue;
      if(!e[k])e[k]=[];e[k].push([t,v]);
    }
    return e;
  } catch{return{}}
}
function gs(e,k){
  if(!e[k])return 0;
  const fl=e[k].filter(([t])=>t===0x03), it=e[k].filter(([t])=>t===0x01);
  if(fl.length)return fl[0][1]; if(it.length)return it[0][1]; return 0;
}

// ═══════════════════════════════════════════
// PARSE SQX
// ═══════════════════════════════════════════
async function parseSQX(arrayBuffer, filename) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const sf  = zip.file('settings.xml') || zip.file('lastSettings.xml');
  if (!sf) throw new Error('No settings.xml encontrado');
  const xml  = await sf.async('string');
  const doc  = new DOMParser().parseFromString(xml, 'application/xml');
  const runs = doc.querySelectorAll('RunResult');
  if (!runs.length) throw new Error('Sin runs en el archivo');

  const rg = doc.querySelector('[ResultName]');
  const rawName = rg ? rg.getAttribute('ResultName') : filename;
  const meta = extractMeta(rawName, runs[0], doc);

  const allRuns = [];
  for (const run of runs) {
    const oosPct = parseInt(run.getAttribute('param1'));
    const nRuns  = parseInt(run.getAttribute('param2'));
    const name   = run.getAttribute('resultName');

    const isEl  = run.querySelector('stats > SQStats');
    const oosEl = run.querySelector('statsOOS > SQStats');
    const sIs   = isEl  && isEl.textContent  ? decodeStats(isEl.textContent.trim())  : {};
    const sOos  = oosEl && oosEl.textContent ? decodeStats(oosEl.textContent.trim()) : {};

    const periods = [];
    for (const p of run.querySelectorAll('Periods > WalkForwardPeriod')) {
      if (p.getAttribute('futurePeriod')==='true') continue;
      const rf  = parseInt(p.getAttribute('runFrom'))/1000;
      const rt  = parseInt(p.getAttribute('runTo'))/1000;
      const of_ = parseInt(p.getAttribute('optimizeFrom'))/1000;
      const params = p.getAttribute('testParameters')||'';
      const rsEl  = p.querySelector('RunStats > stats > SQStats');
      const osEl_ = p.querySelector('OptimizationStats > stats > SQStats');
      const ps  = rsEl  && rsEl.textContent  && rsEl.textContent.trim()  ? decodeStats(rsEl.textContent.trim())  : {};
      const pis = osEl_ && osEl_.textContent && osEl_.textContent.trim() ? decodeStats(osEl_.textContent.trim()) : {};
      periods.push({
        from: tsDate(rf), to: tsDate(rt), is_from: tsDate(of_),
        np: gs(ps,0x0a), rdd: gs(ps,0x1d), pf: gs(ps,0x14),
        wr: gs(ps,0x0b), dd: gs(ps,0x21),
        is_np: gs(pis,0x0a), is_rdd: gs(pis,0x1d), params,
      });
    }

    const pnps  = periods.map(p=>p.np);
    const prdds = periods.map(p=>p.rdd).filter(v=>v>0);
    const mean  = pnps.length ? pnps.reduce((a,b)=>a+b,0)/pnps.length : 0;
    const variance = pnps.length ? pnps.reduce((a,b)=>a+(b-mean)**2,0)/pnps.length : 0;
    const cv    = mean!==0 ? Math.sqrt(variance)/Math.abs(mean) : 99;
    const pctPos= pnps.length ? pnps.filter(v=>v>0).length/pnps.length*100 : 0;
    const rddMin= prdds.length ? Math.min(...prdds) : 0;
    const isRdd = gs(sIs,0x1d), oosRdd = gs(sOos,0x1d);
    const degr  = isRdd>0 ? (isRdd-oosRdd)/isRdd*100 : 0;

    allRuns.push({
      name, oosPct, nRuns,
      is_rdd: isRdd,    is_np:  gs(sIs,0x0a),
      is_pf:  gs(sIs,0x14),  is_wr:  gs(sIs,0x0b), is_sh: gs(sIs,0x0c),
      oos_rdd: oosRdd,  oos_np: gs(sOos,0x0a),
      oos_pf:  gs(sOos,0x14), oos_wr: gs(sOos,0x0b),
      oos_dd:  gs(sOos,0x21), oos_sh: gs(sOos,0x0c),
      full_rdd: gs(sIs,0x19)||0,  // exact value stored in binary = SQ Overview RetDD
      full_np: gs(sIs,0x0a)+gs(sOos,0x0a),
      cv: +cv.toFixed(3), pct_pos: +pctPos.toFixed(1),
      rdd_min: +rddMin.toFixed(2), degradation: +degr.toFixed(1),
      periods,
    });
  }
  return {filename, meta, runs: allRuns};
}

function tsDate(e) {
  if (!e||isNaN(e)) return '—';
  try { return new Date(e*1000).toISOString().slice(0,7); } catch { return '—'; }
}

function extractMeta(rawName, firstRun, doc) {
  // Try to read symbol and TF directly from XML (most reliable)
  let pair = '—', tf = '—';
  
  // Method 1: read directly from XML using getElementsByTagName (more reliable than querySelector with XML)
  if (doc) {
    // Try <Symbol uSymbol="USDJPY">
    const symEls = doc.getElementsByTagName('Symbol');
    for (const el of symEls) {
      const u = el.getAttribute('uSymbol');
      if (u && u.length > 0) { pair = u; break; }
    }
    // Try <Chart timeframe="H4" symbol="USDJPY_UTC2">
    const chartEls = doc.getElementsByTagName('Chart');
    for (const el of chartEls) {
      const t = el.getAttribute('timeframe');
      if (t && t.length > 0) { tf = t; }
      if (pair === '—') {
        const sym = el.getAttribute('symbol') || '';
        const m = sym.match(/^([A-Z0-9]+?)(?:_UTC|_|$)/);
        if (m && m[1].length >= 3) pair = m[1];
      }
      if (pair !== '—' && tf !== '—') break;
    }
    // Also try <WFSymbol> attribute on RunResult
    if (pair === '—') {
      const rr = doc.querySelector('RunResult');
      if (rr) {
        const wp = rr.getAttribute('wfSymbol') || rr.getAttribute('WFSymbol') || '';
        if (wp) { const m = wp.match(/^([A-Z0-9]+?)(?:_|$)/); if(m) pair=m[1]; }
      }
    }
  }

  // Method 2: fallback from filename/resultName
  if (pair === '—') {
    const pairM = rawName.match(/(XAUUSD|BTCUSD|XAGUSD|[A-Z]{6}|US30|NAS100|SP500|DAX|GOLD)/i);
    if (pairM) pair = pairM[1].toUpperCase();
  }
  if (tf === '—') {
    const tfM = rawName.match(/[_\s](H\d+|M\d+|D1|W1)[_\s]/i) ||
                rawName.match(/(H4|H1|M15|M5|M30|D1)/i);
    if (tfM) tf = tfM[1].toUpperCase();
  }

  let dateRange = '—';
  if (firstRun) {
    const ps = [...firstRun.querySelectorAll('Periods > WalkForwardPeriod')]
      .filter(p=>p.getAttribute('futurePeriod')!=='true');
    if (ps.length) {
      const f_ = parseInt(ps[0].getAttribute('optimizeFrom'))/1000;
      const l_ = parseInt(ps[ps.length-1].getAttribute('runTo'))/1000;
      dateRange = `${tsDate(f_)} → ${tsDate(l_)}`;
    }
  }
  return {pair, tf, dateRange, name: rawName};
}

// ═══════════════════════════════════════════
// SCORING
// ═══════════════════════════════════════════
function norm(vals, invert=false) {
  const mn=Math.min(...vals), mx=Math.max(...vals);
  if (mx===mn) return vals.map(()=>0.5);
  const n = vals.map(v=>(v-mn)/(mx-mn));
  return invert ? n.map(v=>1-v) : n;
}

function computeScores(runs) {
  const total = Object.values(weights).reduce((a,b)=>a+b,0)||1;
  const nOos  = norm(runs.map(r=>r.oos_rdd));
  const nCv   = norm(runs.map(r=>r.cv),   true);
  const nRddm = norm(runs.map(r=>r.rdd_min));
  const nPos  = norm(runs.map(r=>r.pct_pos));
  const nIs   = norm(runs.map(r=>r.is_rdd));
  const nDeg  = norm(runs.map(r=>r.degradation), true);
  const nNp   = norm(runs.map(r=>r.full_np));
  return runs.map((_,i)=>Math.round(
    (nOos[i]*weights.oos_rdd + nCv[i]*weights.cv + nRddm[i]*weights.rdd_min +
     nPos[i]*weights.pct_pos + nIs[i]*weights.is_rdd + nDeg[i]*weights.degradation +
     nNp[i]*weights.full_np) / total * 100
  ));
}

function getZoneInfo(runs) {
  const oosList  = [...new Set(runs.map(r=>r.oosPct))].sort((a,b)=>a-b);
  const runsList = [...new Set(runs.map(r=>r.nRuns))].sort((a,b)=>a-b);
  const getR = (nr,op) => runs.find(r=>r.nRuns===nr&&r.oosPct===op);

  // Threshold from non-border runs
  const nonBorder = runs.filter(r=>
    r.nRuns!==runsList[0]&&r.nRuns!==runsList[runsList.length-1]&&
    r.oosPct!==oosList[0]&&r.oosPct!==oosList[oosList.length-1]);
  const rdds = nonBorder.map(r=>r.oos_rdd).sort((a,b)=>a-b);
  const threshold = rdds.length ? rdds[Math.floor(rdds.length*0.35)] : 0;

  // Step 1: find all valid 2x2 zones
  const allZoneCells=new Set(), zoneScores={};
  for(let ri=0;ri<runsList.length-1;ri++) {
    for(let oi=0;oi<oosList.length-1;oi++) {
      const cells=[getR(runsList[ri],oosList[oi]),getR(runsList[ri],oosList[oi+1]),
                   getR(runsList[ri+1],oosList[oi]),getR(runsList[ri+1],oosList[oi+1])];
      if(cells.some(c=>!c)) continue;
      if(!cells.every(c=>c.oos_rdd>=threshold)) continue;
      const avg=cells.reduce((s,c)=>s+c.oos_rdd,0)/4;
      cells.forEach(c=>{allZoneCells.add(c.name);if(!zoneScores[c.name]||avg>zoneScores[c.name])zoneScores[c.name]=avg;});
    }
  }

  // Step 2: a run is "selectable" only if it has valid neighbors
  // in ALL 4 directions (up, down, left, right) that are also in a valid zone.
  // This ensures the run is truly central, not on the edge of a 2x2 block.
  const zoneValid = new Set();
  for(const r of runs) {
    const ri = runsList.indexOf(r.nRuns);
    const oi = oosList.indexOf(r.oosPct);
    // Must not be on any border of the matrix
    if(ri===0||ri===runsList.length-1||oi===0||oi===oosList.length-1) continue;
    // Must itself be in a valid zone
    if(!allZoneCells.has(r.name)) continue;
    // All 4 direct neighbors must also be in a valid zone
    const neighbors = [
      getR(runsList[ri-1], oosList[oi]),  // up
      getR(runsList[ri+1], oosList[oi]),  // down
      getR(runsList[ri],   oosList[oi-1]),// left
      getR(runsList[ri],   oosList[oi+1]),// right
    ];
    if(neighbors.some(n=>!n||!allZoneCells.has(n.name))) continue;
    zoneValid.add(r.name);
  }

  // If no run passes the strict 4-neighbor test, progressively relax:
  // Fallback 1: non-border runs that are in any valid 2x2 zone
  // Fallback 2: any non-border run (no zone constraint)
  let finalValid = zoneValid;
  if (finalValid.size === 0) {
    finalValid = new Set([...allZoneCells].filter(name => {
      const r = runs.find(x=>x.name===name);
      if(!r) return false;
      const ri=runsList.indexOf(r.nRuns), oi=oosList.indexOf(r.oosPct);
      return ri>0&&ri<runsList.length-1&&oi>0&&oi<oosList.length-1;
    }));
  }
  if (finalValid.size === 0) {
    // Last resort: any non-border run
    runs.filter(r => {
      const ri=runsList.indexOf(r.nRuns), oi=oosList.indexOf(r.oosPct);
      return ri>0&&ri<runsList.length-1&&oi>0&&oi<oosList.length-1;
    }).forEach(r => finalValid.add(r.name));
  }

  return {zoneValid:finalValid, allZoneCells, zoneScores, threshold, oosList, runsList};
}

function getBest(runs) {
  const scores = computeScores(runs);
  const zone   = getZoneInfo(runs);
  const zRuns  = runs.filter(r=>zone.zoneValid.has(r.name));
  let bi = -1;
  if(zRuns.length>0) {
    zRuns.forEach(r=>{const i=runs.indexOf(r);if(bi===-1||scores[i]>scores[bi])bi=i;});
  } else {
    scores.forEach((s,i)=>{if(bi===-1||s>scores[bi])bi=i;});
  }
  return {run:runs[bi],score:scores[bi],scores,zone,hasZone:zRuns.length>0};
}

// ═══════════════════════════════════════════
// FLAGS
// ═══════════════════════════════════════════
function computeFlags(run) {
  const f=[];
  const add=(ok,title,desc)=>f.push({ok,title,desc});
  const {oos_rdd,degradation,cv,rdd_min,pct_pos,oos_pf,is_rdd,is_wr,oos_wr}=run;

  add(oos_rdd>=4.5?'ok':oos_rdd>=3?'warn':'bad',`RetDD OOS: ${oos_rdd.toFixed(2)}`,
    oos_rdd>=4.5?'Excelente ratio retorno/drawdown fuera de muestra.':
    oos_rdd>=3?'Aceptable. Por encima de 3.0 pero margen limitado.':
    'Bajo. El retorno OOS no cubre suficientemente el drawdown.');
  add(degradation<10?'ok':degradation<25?'warn':'bad',`Degradación IS→OOS: ${degradation.toFixed(1)}%`,
    degradation<10?'Degradación mínima. Los parámetros generalizan muy bien.':
    degradation<25?'Degradación moderada. Normal en WF pero vigilar en live.':
    'Degradación alta — riesgo de sobreajuste al periodo de optimización.');
  add(cv<0.6?'ok':cv<0.85?'warn':'bad',`Planitud CV: ${cv.toFixed(3)}`,
    cv<0.6?'Periodos OOS muy homogéneos. Resultados consistentes entre años.':
    cv<0.85?'Variabilidad moderada. Un año puede destacar sobre otros.':
    'Alta variabilidad. Un año puntual podría distorsionar el resultado global.');
  add(rdd_min>=2?'ok':rdd_min>=1?'warn':'bad',`RDD mínimo periódico: ${rdd_min.toFixed(2)}`,
    rdd_min>=2?'El peor periodo OOS tiene RetDD ≥ 2. Solidez en todos los entornos.':
    rdd_min>=1?'El peor periodo cubre el drawdown pero con poca holgura.':
    'En alguna ventana OOS el drawdown superó al beneficio.');
  add(pct_pos===100?'ok':pct_pos>=83?'warn':'bad',`Periodos positivos: ${pct_pos.toFixed(0)}%`,
    pct_pos===100?'Todos los periodos OOS son positivos.':
    pct_pos>=83?'Mayoría positivos. Alguna ventana con pérdida neta.':
    'Varios periodos OOS negativos. Estrategia inconsistente.');
  add(oos_pf>=3?'ok':oos_pf>=2?'warn':'bad',`Profit Factor OOS: ${oos_pf.toFixed(2)}`,
    oos_pf>=3?'Excelente. Por cada pérdida se generan más de 3 de ganancia.':
    oos_pf>=2?'Aceptable. Margen limitado ante costes reales de trading.':
    'Bajo. Con slippage y comisiones el PF podría caer por debajo de 1.');
  add(is_rdd>=3?'ok':is_rdd>=2?'warn':'bad',`RetDD IS: ${is_rdd.toFixed(2)}`,
    is_rdd>=3?'Buen ajuste en datos de entrenamiento.':
    is_rdd>=2?'IS aceptable. Si OOS es similar indica consistencia real.':
    'IS bajo — el optimizador no encontró ajuste fuerte en histórico.');
  const wrDiff=Math.abs(is_wr-oos_wr)*100;
  add(wrDiff<5?'ok':wrDiff<10?'warn':'bad',`Consistencia WR IS/OOS: Δ${wrDiff.toFixed(1)}%`,
    wrDiff<5?'Win Rate muy consistente entre IS y OOS.':
    wrDiff<10?'Diferencia moderada. Normal pero vigilar en live.':
    'Gran diferencia de WR. Posible sobreajuste o cambio de régimen.');
  return f;
}

// ═══════════════════════════════════════════
// ACCOUNT SUITABILITY
// ═══════════════════════════════════════════
function computeAccount(run) {
  const {oos_dd:dd,oos_pf:pf,oos_rdd:rdd,cv,rdd_min,pct_pos,degradation:degr}=run;
  const hard=dd>20||rdd<1.5||pf<1.5||pct_pos<50;
  const soft=!hard&&(dd>15||rdd<2||cv>1.2);

  const pScore=([2*(rdd>=3)+1*(rdd>=2&&rdd<3),2*(dd<=15)+1*(dd<=25&&dd>15),2*(pf>=2.5)+1*(pf>=2&&pf<2.5),1*(cv<=0.9),1*(rdd_min>=1)]).reduce((a,b)=>a+b,0);
  const pOk=pScore>=6?'g':pScore>=4?'a':'r';

  const prFails=[];
  if(dd>8)   prFails.push(`DD ${dd.toFixed(1)}% > 8%`);
  if(pf<2)   prFails.push(`PF ${pf.toFixed(2)} insuficiente`);
  if(rdd<2.5)prFails.push(`RetDD ${rdd.toFixed(2)} bajo para challenge`);
  if(degr>35)prFails.push(`Degradación ${degr.toFixed(1)}% alta`);
  const prScore=2*(dd<=8)+2*(pf>=2)+2*(rdd>=2.5)+1*(degr<35)+1*(cv<=1)+1*(rdd_min>=0.8);
  const prOk=prScore>=7?'g':prScore>=5?'a':'r';

  const darFails=[];
  if(dd>12)  darFails.push(`DD ${dd.toFixed(1)}% penaliza D-Score`);
  if(cv>0.8) darFails.push(`CV ${cv.toFixed(3)} inconsistente`);
  if(rdd<3)  darFails.push(`RetDD ${rdd.toFixed(2)} bajo para Darwin`);
  if(degr>25)darFails.push(`Degradación ${degr.toFixed(1)}%`);
  const darScore=2*(dd<=12)+2*(cv<=0.8)+2*(rdd>=3)+1*(pf>=2.5)+1*(pct_pos>=83)+1*(degr<25)+1*(rdd_min>=1);
  const darOk=darScore>=8?'g':darScore>=5?'a':'r';

  const discardReasons=[];
  if(hard){
    if(dd>20)      discardReasons.push(`DD ${dd.toFixed(1)}% excesivo`);
    if(rdd<1.5)    discardReasons.push(`RetDD ${rdd.toFixed(2)} — retorno no cubre drawdown`);
    if(pf<1.5)     discardReasons.push(`PF ${pf.toFixed(2)} insuficiente ante costes`);
    if(pct_pos<50) discardReasons.push(`${pct_pos.toFixed(0)}% periodos positivos`);
  }

  return {
    propia: {ok:pOk,score:pScore,max:8,
      msg:pOk==='g'?'Apta — buen ratio riesgo/retorno para capital propio.':
          pOk==='a'?'Viable con gestión de riesgo conservadora.':'Drawdown o consistencia insuficientes.',
      fails:[]},
    prop:   {ok:prOk,score:prScore,max:9,
      msg:prOk==='g'?'Apta para challenge de prop firm. Cumple márgenes de seguridad.':
          prOk==='a'?`Posible con sizing reducido. Puntos: ${prFails.join(' · ')}`:
                     `NO recomendada para prop firm: ${prFails.join(' · ')}`,
      fails:prFails},
    darwin: {ok:darOk,score:darScore,max:10,
      msg:darOk==='g'?'Excelente para Darwinex. CV bajo y DD controlado puntúan en D-Score.':
          darOk==='a'?`Viable en Darwin con historial largo. Mejorar: ${darFails.join(' · ')}`:
                      `Perfil no óptimo para Darwin: ${darFails.join(' · ')}`,
      fails:darFails},
    discard:{level:hard?'hard':soft?'soft':'none', reasons:discardReasons},
  };
}

// ═══════════════════════════════════════════
// CONSECUTIVE
// ═══════════════════════════════════════════
function computeConsec(run) {
  const nps=run.periods.map(p=>p.np);
  let maxPos=0,maxNeg=0,cPos=0,cNeg=0;
  nps.forEach(np=>{
    if(np>0){cPos++;cNeg=0;maxPos=Math.max(maxPos,cPos);}
    else if(np<0){cNeg++;cPos=0;maxNeg=Math.max(maxNeg,cNeg);}
    else{cPos=cNeg=0;}
  });
  const wr=run.oos_wr, lr=Math.max(1-wr,0.001);
  const n=Math.max(run.periods.length*5,20);
  const expLoss=Math.max(1,Math.ceil(Math.abs(Math.log(1/n)/Math.log(lr))));
  return {maxPos,maxNeg,expLoss,propSafe:expLoss*1.0<=4,wr};
}

// ═══════════════════════════════════════════
// FILE LOADING
// ═══════════════════════════════════════════
async function loadFiles() {
  if (window.electronAPI) {
    const files = await window.electronAPI.openFiles();
    for (const f of files) {
      const buf = new Uint8Array(f.buffer).buffer;
      await addStrategy(buf, f.name);
    }
  } else {
    // Fallback: file input for web mode
    const inp = document.createElement('input');
    inp.type='file'; inp.accept='.sqx'; inp.multiple=true;
    inp.onchange = async () => {
      for (const f of inp.files) {
        const buf = await f.arrayBuffer();
        await addStrategy(buf, f.name);
      }
    };
    inp.click();
  }
}

async function addStrategy(buf, name) {
  const slot = strategies.findIndex(s=>s===null);
  if (slot<0) { alert('Máximo 3 estrategias. Elimina una primero.'); return; }
  try {
    const data = await parseSQX(buf, name);
    strategies[slot] = data;
    activeStrat = slot;
    renderAll();
  } catch(e) {
    alert(`Error procesando ${name}: ${e.message}`);
  }
}

function removeStrategy(idx) {
  strategies[idx] = null;
  if (activeStrat===idx) activeStrat=strategies.findIndex(s=>s!==null);
  if (activeStrat<0) activeStrat=0;
  renderAll();
}

async function exportPDF() {
  if (window.electronAPI) {
    await window.electronAPI.printToPDF();
  } else {
    window.print();
  }
}

// ═══════════════════════════════════════════
// RENDER ALL
// ═══════════════════════════════════════════
function renderAll() {
  const loaded = strategies.filter(Boolean);
  const hasData = loaded.length>0;
  document.getElementById('empty').style.display     = hasData?'none':'flex';
  document.getElementById('dashboard').style.display = hasData?'block':'none';
  document.getElementById('btn-pdf').style.display   = hasData?'inline-block':'none';
  document.getElementById('hdr-status').textContent  = hasData?`${loaded.length} estrategia(s) cargada(s)`:'Sin datos cargados';

  if (!hasData) { renderSlots(); return; }
  if (strategies[activeStrat]===null) activeStrat=strategies.findIndex(s=>s!==null);

  renderSlots();
  renderStratTabs();
  renderStratView(activeStrat);
  if (loaded.length>=2) renderComparison();
  else document.getElementById('compare-section').style.display='none';
}

// ═══════════════════════════════════════════
// SLOTS
// ═══════════════════════════════════════════
function renderSlots() {
  const el = document.getElementById('slots');
  el.innerHTML = strategies.map((s,i)=>{
    if (!s) return `<div class="slot" onclick="if(event.target.tagName!=='BUTTON')loadFiles()" id="slot-${i}">
      <div class="slot-num">${['①','②','③'][i]}</div>
      <div class="slot-hint">Click o botón superior</div>
    </div>`;
    const best = getBest(s.runs);
    return `<div class="slot loaded" id="slot-${i}" onclick="setActive(${i})">
      <button class="slot-remove" onclick="event.stopPropagation();removeStrategy(${i})">✕</button>
      <div class="slot-name"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${SLOT_COLORS[i]};margin-right:5px;vertical-align:middle"></span>${s.meta.name.slice(0,28)}</div>
      <div class="slot-meta">${s.meta.pair} · ${s.meta.tf} · ${s.runs.length} runs</div>
      <div class="slot-best">★ ${best.run.name}</div>
    </div>`;
  }).join('');
}

function setActive(idx) {
  activeStrat = idx;
  renderStratTabs();
  renderStratView(idx);
}

// ═══════════════════════════════════════════
// STRATEGY TABS
// ═══════════════════════════════════════════
function renderStratTabs() {
  const loaded = strategies.filter(Boolean);
  const el = document.getElementById('strat-tabs');
  let html = strategies.map((s,i)=>!s?'':
    `<button class="stab ${i===activeStrat?'active':''}" onclick="setActive(${i})">
      <span class="dot" style="background:${SLOT_COLORS[i]}"></span>${s.meta.pair} · ${s.meta.tf}
    </button>`).join('');
  if (loaded.length>=2)
    html += `<button class="stab ${activeStrat===-1?'active':''}" onclick="showCompare()" id="cmp-tab">⚖️ Comparar</button>`;
  el.innerHTML = html;
}

function showCompare() {
  document.getElementById('strat-view').style.display='none';
  document.getElementById('compare-section').style.display='block';
  document.querySelectorAll('.stab').forEach(b=>b.classList.remove('active'));
  const cmpTab = document.getElementById('cmp-tab');
  if (cmpTab) cmpTab.classList.add('active');
}

// ═══════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════
const C={g:'cg',a:'ca',r:'cr',b:'cb',p:'cp'};
const FMT={
  g:'#00d97e',a:'#f59e0b',r:'#f87171',b:'#38bdf8',p:'#a78bfa'
};
function cVal(v,good,ok,inv=false){
  if(inv)return v<=good?'g':v<=ok?'a':'r';
  return v>=good?'g':v>=ok?'a':'r';
}
function mc(lbl,val,c,sub='',topCls=''){
  return `<div class="mc ${topCls}"><div class="ml">${lbl}</div><div class="mv ${C[c]||''}">${val}</div>${sub?`<div class="ms">${sub}</div>`:''}</div>`;
}
function flagHtml(f){
  const cls={ok:'flag-ok',warn:'flag-warn',bad:'flag-bad'}[f.ok];
  const ic={ok:'✅',warn:'⚠️',bad:'🚨'}[f.ok];
  return `<div class="flag ${cls}"><div class="flag-icon">${ic}</div><div><div class="flag-title">${f.title}</div><div class="flag-desc">${f.desc}</div></div></div>`;
}
function acctCard(label,icon,detail,data){
  const cls={g:'acct-g',a:'acct-a',r:'acct-r'}[data.ok];
  const col=FMT[data.ok];
  const ic={g:'✅',a:'⚠️',r:'🚨'}[data.ok];
  const fails=data.fails&&data.fails.length?`<div class="acct-fails">${data.fails.map(f=>`⚡ ${f}`).join('<br>')}</div>`:'';
  return `<div class="acct-card ${cls}">
    <div class="acct-header">
      <span class="acct-icon">${icon}</span>
      <div><div class="acct-title" style="color:${col}">${ic} ${label}</div><div class="acct-detail">${detail}</div></div>
      <div class="acct-score" style="color:${col}">${data.score}/${data.max}</div>
    </div>
    <div class="acct-msg">${data.msg}</div>${fails}
  </div>`;
}

// ═══════════════════════════════════════════
// STRATEGY VIEW
// ═══════════════════════════════════════════
let hmMetric='score', rankSort='score';

function renderStratView(idx) {
  document.getElementById('strat-view').style.display='block';
  document.getElementById('compare-section').style.display='none';
  const s = strategies[idx]; if (!s) return;

  // Destroy old charts
  Object.values(chartReg).forEach(c=>{try{c.destroy()}catch{}});
  chartReg={};

  const {runs,meta} = s;
  const {run:best,score:bestScore,scores,zone,hasZone} = getBest(runs);
  const zoneRddAvg = zone.zoneScores[best.name]||best.oos_rdd;
  const flags  = computeFlags(best);
  const acct   = computeAccount(best);
  const cons   = computeConsec(best);
  const nOk    = flags.filter(f=>f.ok==='ok').length;
  const nWarn  = flags.filter(f=>f.ok==='warn').length;
  const nBad   = flags.filter(f=>f.ok==='bad').length;

  // Verdict
  let vCls,vIcon,vTitle,vSub;
  if(nBad>=3){vCls='v-bad';vIcon='🚨';vTitle='Estrategia con riesgos significativos';vSub=`${nBad} flags críticos. Revisar antes de operar.`;}
  else if(nBad>=1){vCls='v-warn';vIcon='⚠️';vTitle='Estrategia con puntos a revisar';vSub=`${nBad} crítico(s), ${nWarn} advertencia(s).`;}
  else if(nWarn>=3){vCls='v-warn';vIcon='⚠️';vTitle='Estrategia aceptable con matices';vSub=`${nWarn} advertencias a monitorizar.`;}
  else{vCls='v-ok';vIcon='✅';vTitle='Estrategia robusta — apta para live';vSub=`${nOk}/8 checks en verde.`;}

  const zoneLine = hasZone
    ? `<span class="rec-zone zone-ok">✓ Zona 2×2 estable · RetDD zona ${zoneRddAvg.toFixed(2)} · Umbral ${zone.threshold.toFixed(2)}</span>`
    : `<span class="rec-zone zone-warn">⚠ Sin zona 2×2 válida — selección por score puro</span>`;

  const worstP = best.periods.length ? best.periods.reduce((w,p)=>p.rdd>0&&p.rdd<(w.rdd||99)?p:w,{rdd:99}) : null;

  const el = document.getElementById('strat-view');
  el.innerHTML = `
    <!-- META -->
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">
      <div class="mc"><div class="ml">Estrategia</div><div style="font-size:12px;font-family:var(--mono);font-weight:500;line-height:1.4">${meta.name.slice(0,50)}</div><div class="ms">${meta.dateRange}</div></div>
      <div class="mc"><div class="ml">Instrumento · Timeframe</div><div class="mv ca">${meta.pair} · ${meta.tf}</div><div class="ms">${runs.length} combinaciones WF</div></div>
      <div class="mc"><div class="ml">Veredicto</div><div style="font-size:12px;font-family:var(--mono)">${vIcon} ${vTitle.split('—')[0]}</div><div class="ms">${nOk}/8 checks ✅</div></div>
    </div>

    <!-- VERDICT -->
    <div class="verdict ${vCls}"><div class="v-icon">${vIcon}</div><div><div class="v-title">${vTitle}</div><div class="v-sub">${vSub}</div></div></div>

    <!-- RECOMMENDATION -->
    <div class="rec-card">
      <div class="rec-badge">★ RUN RECOMENDADO · SCORE ${bestScore}/100</div>
      <div class="rec-name">${best.name}</div>
      <div class="rec-sub">RetDD FULL <strong style="color:var(--green)">${best.full_rdd.toFixed(2)}</strong> · OOS ${best.oos_rdd.toFixed(2)} · IS ${best.is_rdd.toFixed(2)} · CV ${best.cv.toFixed(3)} · RDD mín ${best.rdd_min.toFixed(2)} · Degr ${best.degradation.toFixed(1)}%</div>
      ${zoneLine}
    </div>

    <!-- RETDD TRIAD -->
    <div class="rdd-grid">
      <div class="rdd-card primary"><div class="rdd-lbl">RetDD Full (IS+OOS)</div><div class="rdd-val ${cVal(best.full_rdd,5,3)?C[cVal(best.full_rdd,5,3)]:'cg'}">${best.full_rdd>0?best.full_rdd.toFixed(2):'—'}</div><div class="rdd-sub">equiv. Overview SQ</div></div>
      <div class="rdd-card"><div class="rdd-lbl">RetDD OOS</div><div class="rdd-val ${C[cVal(best.oos_rdd,4.5,3)]}">${best.oos_rdd.toFixed(2)}</div><div class="rdd-sub">out-of-sample</div></div>
      <div class="rdd-card"><div class="rdd-lbl">RetDD IS</div><div class="rdd-val cb">${best.is_rdd.toFixed(2)}</div><div class="rdd-sub">in-sample</div></div>
      <div class="rdd-card"><div class="rdd-lbl">RetDD Zona 2×2</div><div class="rdd-val ca">${zoneRddAvg.toFixed(2)}</div><div class="rdd-sub">media 4 celdas vecinas</div></div>
    </div>

    <!-- METRICS -->
    <div class="section"><div class="sec-head"><h2>Métricas IS · OOS · Full</h2><div class="sec-line"></div></div>
    <div class="metrics-grid">
      ${mc('NP OOS','$'+best.oos_np.toLocaleString('es',{maximumFractionDigits:0}),cVal(best.oos_np,1000,0),'out-of-sample','oos-top')}
      ${mc('NP Full','$'+best.full_np.toLocaleString('es',{maximumFractionDigits:0}),'p','IS + OOS','full-top')}
      ${mc('PF OOS',best.oos_pf.toFixed(2),cVal(best.oos_pf,3,2),'out-of-sample','oos-top')}
      ${mc('WR OOS',(best.oos_wr*100).toFixed(0)+'%',cVal(best.oos_wr*100,65,55),'out-of-sample','oos-top')}
      ${mc('Sharpe OOS',best.oos_sh.toFixed(2),cVal(best.oos_sh,1.5,1),'out-of-sample','oos-top')}
      ${mc('Max DD OOS',best.oos_dd.toFixed(2)+'%',cVal(best.oos_dd,0,8,true),'out-of-sample','risk-top')}
      ${mc('CV Planitud',best.cv.toFixed(3),cVal(best.cv,0,0.85,true),'menor = más plano','risk-top')}
      ${mc('RDD mín',best.rdd_min.toFixed(2),cVal(best.rdd_min,2,1),'peor ventana OOS','risk-top')}
      ${mc('Degradación',best.degradation.toFixed(1)+'%',cVal(best.degradation,0,25,true),'IS→OOS RetDD','risk-top')}
      ${mc('% Periodos+',best.pct_pos.toFixed(0)+'%',cVal(best.pct_pos,100,83),'OOS positivos','oos-top')}
      ${mc('RetDD IS',best.is_rdd.toFixed(2),cVal(best.is_rdd,4,2.5),'in-sample','is-top')}
      ${mc('NP IS','$'+best.is_np.toLocaleString('es',{maximumFractionDigits:0}),'b','in-sample','is-top')}
    </div></div>

    <!-- FLAGS -->
    <div class="section"><div class="sec-head"><h2>Risk flags — run recomendado</h2><div class="sec-line"></div></div>
    <div class="flags-grid">${flags.map(flagHtml).join('')}</div></div>

    <!-- HEATMAP -->
    <div class="section"><div class="sec-head"><h2>WF Matrix Heatmap</h2><div class="sec-line"></div>
      <div class="tab-pills" id="hm-pills-${idx}">
        ${['score','oos_rdd','full_rdd','cv','rdd_min','oos_pf','degradation'].map(m=>`
        <button class="tab-pill ${hmMetric===m?'active':''}" onclick="changeHM('${m}',${idx})">${{score:'Score',oos_rdd:'RetDD OOS',full_rdd:'RetDD Full',cv:'CV',rdd_min:'RDD mín',oos_pf:'PF OOS',degradation:'Degr%'}[m]}</button>`).join('')}
      </div>
    </div>
    <div class="hm-wrap"><div id="hm-${idx}"></div></div>
    <div style="font-size:10px;color:var(--t2);font-family:var(--mono);margin-top:4px">★ = Run recomendado · Borde punteado = en zona 2×2 válida</div>
    </div>

    <!-- RANK TABLE -->
    <div class="section"><div class="sec-head"><h2>Ranking completo — ${runs.length} runs</h2><div class="sec-line"></div>
      <div class="tab-pills" id="rank-pills-${idx}">
        ${['score','oos_rdd','full_rdd','is_rdd','cv','rdd_min','degradation'].map(m=>`
        <button class="tab-pill ${rankSort===m?'active':''}" onclick="changeSort('${m}',${idx})">${{score:'Score',oos_rdd:'RetDD OOS',full_rdd:'RetDD Full',is_rdd:'RetDD IS',cv:'CV ↑',rdd_min:'RDD mín',degradation:'Degr%'}[m]}</button>`).join('')}
      </div>
    </div>
    <div class="tbl-wrap" id="tbl-${idx}"></div></div>

    <!-- PERIODS -->
    <div class="section"><div class="sec-head"><h2>Periodos OOS — run recomendado</h2><div class="sec-line"></div></div>
    <div id="periods-${idx}">${renderPeriods(best)}</div>
    <div class="info-pill" style="margin-top:8px">ℹ Parámetros último periodo activo: <strong style="color:var(--amber)">${best.periods[best.periods.length-1]?.params||'—'}</strong></div>
    </div>

    <!-- CHARTS -->
    <div class="section"><div class="sec-head"><h2>Análisis visual</h2><div class="sec-line"></div></div>
    <div class="charts-2col">
      <div class="chart-box"><div class="chart-title">RetDD OOS vs Planitud (CV)</div><div style="position:relative;height:240px"><canvas id="sc-${idx}"></canvas></div></div>
      <div class="chart-box"><div class="chart-title">Score compuesto — top 15 runs</div><div style="position:relative;height:240px"><canvas id="bar-${idx}"></canvas></div></div>
    </div></div>

    <!-- ACCOUNT -->
    <div class="section"><div class="sec-head"><h2>Idoneidad por tipo de cuenta</h2><div class="sec-line"></div></div>
    ${acct.discard.level==='hard'?`<div class="discard-box"><strong style="color:var(--red);font-size:15px">🚫 ESTRATEGIA DESCARTABLE</strong><br><span style="color:var(--t1);font-size:12px">${acct.discard.reasons.join(' · ')}</span></div>`:''}
    ${acct.discard.level==='soft'?`<div class="verdict v-warn" style="margin-bottom:10px"><div class="v-icon">⚠️</div><div><div class="v-title">Usar con precaución</div><div class="v-sub">Métricas borderline. Solo capital propio tolerante al riesgo.</div></div></div>`:''}
    <div class="tl-bar">
      <span style="font-size:11px;font-family:var(--mono);color:var(--t2)">IDONEIDAD:</span>
      ${[['Capital Propio',acct.propia],['Prop Firm',acct.prop],['Darwin',acct.darwin]].map(([lbl,a])=>
        `<div class="tl-item"><div class="tl-dot" style="background:${FMT[a.ok]}"></div><span style="color:${FMT[a.ok]}">${lbl}</span></div>`).join('')}
      ${acct.discard.level==='hard'?`<span style="margin-left:auto;font-size:11px;font-family:var(--mono);color:var(--red);font-weight:600">🚫 DESCARTAR</span>`:''}
    </div>
    <div class="acct-grid">
      ${acctCard('Capital Propio','💼','Sin restricciones externas',acct.propia)}
      ${acctCard('Prop Firm','🏢','FTMO, MyFF, etc.',acct.prop)}
      ${acctCard('Darwin / Darwinex','🧬','D-Score: consistencia y DD',acct.darwin)}
    </div></div>

    <!-- CONSECUTIVE -->
    <div class="section"><div class="sec-head"><h2>Rachas consecutivas</h2><div class="sec-line"></div></div>
    <div class="consec-grid">
      ${mc('Max consec positivos',String(cons.maxPos),'g','periodos OOS seguidos en verde')}
      ${mc('Max consec negativos',String(cons.maxNeg),cons.maxNeg>=2?'r':'a','periodos OOS seguidos en rojo')}
      ${mc('Pérd. consec. estimadas',String(cons.expLoss),cons.expLoss>=5?'r':cons.expLoss>=3?'a':'g',`trades (WR ${(cons.wr*100).toFixed(0)}%)`)}
      ${mc('Impacto DD racha',`${(cons.expLoss*1).toFixed(1)}%`,cons.propSafe?'g':'r','con 1% riesgo/trade · '+(cons.propSafe?'✓ seguro prop':'✗ revisar sizing'))}
    </div>
    <div class="info-pill" style="margin-top:8px">ℹ Con límite de DD diario del 5% en prop firm, son tolerables ${Math.floor(5/1)} pérdidas consecutivas con 1% riesgo, o ${Math.floor(5/0.5)} con 0.5% riesgo.</div>
    </div>

    <!-- REASONING -->
    <div class="section"><div class="sec-head"><h2>¿Por qué este run?</h2><div class="sec-line"></div></div>
    <div class="reason-grid" id="reasons-${idx}"></div></div>

    <div class="disclaimer">⚠ AVISO: Este análisis se basa exclusivamente en datos históricos (backtest). Los resultados pasados no garantizan rendimientos futuros. Toda estrategia debe validarse con paper trading antes de operar con capital real. Herramienta desarrollada para uso educativo en comunidades de traders algorítmicos.</div>
  `;

  // Render dynamic parts
  renderHM(idx, runs, scores, zone, best);
  renderRankTable(idx, runs, scores, best);
  renderCharts(idx, runs, scores, best);
  renderReasons(idx, runs, scores, best, zone);
}

// ═══════════════════════════════════════════
// PERIODS
// ═══════════════════════════════════════════
function renderPeriods(best) {
  if (!best.periods.length) return '<div style="color:var(--t2);font-size:11px">Sin datos de periodos</div>';
  const maxNP = Math.max(...best.periods.map(p=>Math.abs(p.np)));
  return best.periods.map(p=>{
    const pos=p.np>=0, bw=Math.round(Math.abs(p.np)/maxNP*100);
    const rc=p.rdd>=2?'cg':p.rdd>=1?'ca':'cr';
    return `<div class="period-row">
      <span style="color:var(--t2)">${p.from}→${p.to}</span>
      <span style="color:${pos?'var(--green)':'var(--red)'};font-weight:600">${pos?'+':''}$${Math.round(p.np).toLocaleString()}</span>
      <span class="${rc}">RDD ${p.rdd.toFixed(2)}</span>
      <span style="color:var(--t1)">PF ${p.pf.toFixed(2)}</span>
      <span style="color:var(--t1)">WR ${Math.round(p.wr*100)}%</span>
      <div class="pbar-wrap"><div class="pbar" style="width:${bw}%;background:${pos?'var(--green)':'var(--red)'}"></div></div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════
// HEATMAP
// ═══════════════════════════════════════════
function changeHM(metric, idx) {
  hmMetric = metric;
  document.querySelectorAll(`#hm-pills-${idx} .tab-pill`).forEach(b=>b.classList.remove('active'));
  event.target.classList.add('active');
  const s = strategies[idx]; if(!s) return;
  const {run:best,scores,zone} = getBest(s.runs);
  renderHM(idx, s.runs, scores, zone, best);
}

function renderHM(idx, runs, scores, zone, best) {
  const el = document.getElementById(`hm-${idx}`); if(!el) return;
  const oosList  = [...new Set(runs.map(r=>r.oosPct))].sort((a,b)=>a-b);
  const runsList = [...new Set(runs.map(r=>r.nRuns))].sort((a,b)=>a-b);
  const scMap    = Object.fromEntries(runs.map((r,i)=>[r.name,scores[i]]));
  const getVal   = (r) => hmMetric==='score'?scMap[r.name]:r[hmMetric]||0;
  const allVals  = runs.map(getVal);
  const mn=Math.min(...allVals), mx=Math.max(...allVals);
  const normalize = v => mx===mn?0.5:(v-mn)/(mx-mn);

  function cellBg(v){
    let t=normalize(v);
    if(['cv','degradation','oos_dd'].includes(hmMetric)) t=1-t;
    const lerp=(a,b,t)=>Math.round(a+(b-a)*t);
    return `rgb(${lerp(30,0,t)},${lerp(30,180,t)},${lerp(30,80,t)})`;
  }

  let html = `<div class="hm-grid" style="grid-template-columns:50px repeat(${oosList.length},62px)">
    <div class="hm-lbl"></div>${oosList.map(o=>`<div class="hm-lbl">${o}%</div>`).join('')}`;

  runsList.forEach(nr=>{
    html+=`<div class="hm-rlbl">${nr}r</div>`;
    oosList.forEach(op=>{
      const r=runs.find(x=>x.nRuns===nr&&x.oosPct===op);
      if(!r){html+=`<div class="hm-cell"></div>`;return;}
      const v=getVal(r), bg=cellBg(v);
      const isWin=r.name===best.name;
      const inZone=zone.allZoneCells&&zone.allZoneCells.has(r.name)||zone.zoneValid.has(r.name);
      const isCentral=zone.zoneValid.has(r.name)&&!isWin;
      const fmt=hmMetric==='score'?scMap[r.name]:
                hmMetric==='cv'||hmMetric==='degradation'?v.toFixed(2):v.toFixed(2);
      const outline=isWin?'outline:2.5px solid var(--green)':isCentral?'outline:1.5px solid rgba(0,217,126,.5)':inZone?'outline:1px dashed rgba(0,217,126,.25)':'';
      html+=`<div class="hm-cell" style="background:${bg};${outline}" title="${r.name}: ${fmt}">
        ${fmt}${isWin?'<div class="star">★</div>':''}
      </div>`;
    });
  });
  html+='</div>';
  el.innerHTML=html;
}

// ═══════════════════════════════════════════
// RANK TABLE
// ═══════════════════════════════════════════
function changeSort(key, idx) {
  rankSort = key;
  document.querySelectorAll(`#rank-pills-${idx} .tab-pill`).forEach(b=>b.classList.remove('active'));
  event.target.classList.add('active');
  const s=strategies[idx]; if(!s) return;
  const {run:best,scores}=getBest(s.runs);
  renderRankTable(idx, s.runs, scores, best);
}

function renderRankTable(idx, runs, scores, best) {
  const el=document.getElementById(`tbl-${idx}`); if(!el) return;
  const asc=['cv','degradation'].includes(rankSort);
  const sorted=[...runs].map((r,i)=>({...r,_s:scores[i]}))
    .sort((a,b)=>rankSort==='score'?b._s-a._s:asc?a[rankSort]-b[rankSort]:b[rankSort]-a[rankSort]);
  const maxS=Math.max(...scores);
  el.innerHTML=`<table>
    <thead><tr>
      <th style="text-align:left">#</th><th style="text-align:left">Run</th>
      <th>Score</th><th>RetDD Full</th><th>RetDD IS</th><th>RetDD OOS</th>
      <th>Degr%</th><th>CV</th><th>RDD mín</th><th>NP Full</th><th>PF OOS</th><th>WR OOS</th>
    </tr></thead>
    <tbody>${sorted.slice(0,20).map((r,i)=>{
      const isW=r.name===best.name;
      const cvC=r.cv<0.7?'cg':r.cv<0.9?'ca':'cr';
      const rmC=r.rdd_min>=2?'cg':r.rdd_min>=1?'ca':'cr';
      const dC =r.degradation<20?'cg':r.degradation<40?'ca':'cr';
      const frC=r.full_rdd>=5?'cg':r.full_rdd>=3?'ca':'cr';
      const bw =Math.round(r._s/maxS*60);
      return `<tr class="${isW?'winner':''}">
        <td style="color:var(--t2)">${i+1}</td>
        <td>${isW?'★ ':''}<strong>${r.name}</strong></td>
        <td><span class="ca">${r._s}</span><span class="sbar" style="width:${bw}px"></span></td>
        <td class="${frC}"><strong>${r.full_rdd>0?r.full_rdd.toFixed(2):'—'}</strong></td>
        <td class="cb">${r.is_rdd.toFixed(2)}</td>
        <td class="cg">${r.oos_rdd.toFixed(2)}</td>
        <td class="${dC}">${r.degradation.toFixed(1)}%</td>
        <td class="${cvC}">${r.cv.toFixed(3)}</td>
        <td class="${rmC}">${r.rdd_min.toFixed(2)}</td>
        <td>$${Math.round(r.full_np).toLocaleString()}</td>
        <td>${r.oos_pf.toFixed(2)}</td>
        <td>${(r.oos_wr*100).toFixed(0)}%</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

// ═══════════════════════════════════════════
// CHARTS
// ═══════════════════════════════════════════
function renderCharts(idx, runs, scores, best) {
  // Scatter
  const scEl=document.getElementById(`sc-${idx}`); if(!scEl) return;
  const scData=runs.map((r,i)=>({x:r.cv,y:r.oos_rdd,label:r.name,s:scores[i],isBest:r.name===best.name}));
  chartReg[`sc-${idx}`]=new Chart(scEl,{
    type:'scatter',
    data:{datasets:[
      {label:'Runs',data:scData.filter(d=>!d.isBest).map(d=>({x:d.x,y:d.y})),
        backgroundColor:'rgba(100,130,160,.5)',pointRadius:4},
      {label:'★',data:scData.filter(d=>d.isBest).map(d=>({x:d.x,y:d.y})),
        backgroundColor:'#00d97e',pointRadius:9,pointStyle:'star'},
    ]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>{
        const d=scData.find(x=>Math.abs(x.x-c.raw.x)<0.001&&Math.abs(x.y-c.raw.y)<0.001);
        return d?`${d.label} | Score:${d.s} RDD:${d.y.toFixed(2)} CV:${d.x.toFixed(3)}`:'';
      }}}},
      scales:{
        x:{reverse:true,title:{display:true,text:'← CV (más plano)',color:'#475569',font:{size:10}},
          ticks:{color:'#475569'},grid:{color:'rgba(255,255,255,.04)'}},
        y:{title:{display:true,text:'RetDD OOS ↑',color:'#475569',font:{size:10}},
          ticks:{color:'#475569'},grid:{color:'rgba(255,255,255,.04)'}},
      }
    }
  });

  // Bar chart top 15
  const barEl=document.getElementById(`bar-${idx}`); if(!barEl) return;
  const sorted=[...runs].map((r,i)=>({r,s:scores[i]})).sort((a,b)=>b.s-a.s).slice(0,15);
  chartReg[`bar-${idx}`]=new Chart(barEl,{
    type:'bar',
    data:{
      labels:sorted.map(x=>x.r.name.replace('WF: ','').replace(' % OOS','%')),
      datasets:[{
        data:sorted.map(x=>x.s),
        backgroundColor:sorted.map(x=>x.r.name===best.name?'rgba(0,217,126,.8)':'rgba(100,130,160,.4)'),
        borderRadius:3,
      }]
    },
    options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',
      plugins:{legend:{display:false}},
      scales:{
        x:{ticks:{color:'#475569',font:{size:9}},grid:{color:'rgba(255,255,255,.04)'}},
        y:{ticks:{color:'#94a3b8',font:{size:9}},grid:{display:false}},
      }
    }
  });
}

// ═══════════════════════════════════════════
// REASONING
// ═══════════════════════════════════════════
function renderReasons(idx, runs, scores, best, zone) {
  const el=document.getElementById(`reasons-${idx}`); if(!el) return;
  const byRdd  = [...runs].sort((a,b)=>b.oos_rdd-a.oos_rdd);
  const rddRank= byRdd.indexOf(best)+1;
  const topRdd = byRdd[0];
  const isTop  = best.name===topRdd.name;
  const worstP = best.periods.length?best.periods.reduce((w,p)=>p.rdd>0&&p.rdd<(w.rdd||99)?p:w,{rdd:99}):null;

  const items=[
    [best.full_rdd>=5?'ok':best.full_rdd>=3?'warn':'bad',
     `RetDD Full ${best.full_rdd.toFixed(2)} — valor exacto del Overview de SQ`,
     `Con NP total (IS+OOS) $${Math.round(best.full_np).toLocaleString()}. Es el número que verías en SQ al seleccionar este run.`],
    [rddRank<=3?'ok':'warn',
     `RetDD OOS ${best.oos_rdd.toFixed(2)} — puesto #${rddRank} de ${runs.length}`,
     `${rddRank<=3?'Top '+rddRank+' en RetDD fuera de muestra.':'No el mayor RetDD pero compensado por mejor planitud y consistencia.'} ${runs.filter(r=>r.oos_rdd>best.oos_rdd).length} runs con mayor RetDD OOS.`],
    [best.cv<0.7?'ok':best.cv<0.9?'warn':'bad',
     `Planitud CV ${best.cv.toFixed(3)}`,
     best.cv<0.7?'CV bajo — periodos OOS homogéneos. Los parámetros funcionan en distintos regímenes de mercado.':'CV moderado. Hay variabilidad entre periodos pero dentro de rango aceptable.'],
    [best.rdd_min>=1?'ok':best.rdd_min>=0.5?'warn':'bad',
     `RDD mínimo periódico ${best.rdd_min.toFixed(2)}`,
     worstP?`Peor periodo (${worstP.from}→${worstP.to}, RDD ${worstP.rdd.toFixed(2)}). ${best.rdd_min>=1?'Incluso en la peor ventana la estrategia es rentable en relación a su drawdown.':'Atención: en esa ventana el drawdown superó al beneficio.'}`:'Sin datos de periodos.'],
    [best.degradation<15?'ok':best.degradation<30?'warn':'bad',
     `Degradación IS→OOS ${best.degradation.toFixed(1)}%`,
     best.degradation<15?'Degradación mínima — los parámetros generalizan muy bien fuera de muestra.':best.degradation<30?'Degradación moderada — parte de la ventaja IS se pierde en OOS.':'Degradación elevada — revisar si el run está sobreajustado.'],
    [isTop?'ok':'warn',
     isTop?'Coincide con el mayor RetDD puro — sin trade-off':`RetDD máximo: ${topRdd.oos_rdd.toFixed(2)} (${topRdd.name})`,
     isTop?'El run recomendado es simultáneamente el de mayor RetDD OOS y mejor equilibrio. No hay trade-off.':`El run con mayor RetDD puro es ${topRdd.name}. Se descartó por CV ${topRdd.cv.toFixed(3)} — menos plano que el recomendado.`],
  ];

  el.innerHTML=items.map(([cls,title,desc])=>{
    const border={ok:'var(--green)',warn:'var(--amber)',bad:'var(--red)'}[cls];
    return `<div class="reason-item ri-${cls}"><div class="ri-title">${title}</div><div class="ri-desc">${desc}</div></div>`;
  }).join('');
}

// ═══════════════════════════════════════════
// COMPARISON
// ═══════════════════════════════════════════
function renderComparison() {
  const loaded=strategies.map((s,i)=>s?{s,i}:null).filter(Boolean);
  const section=document.getElementById('compare-section');
  section.style.display='none'; // shown when user clicks tab

  const bests=loaded.map(({s,i})=>{
    const b=getBest(s.runs);
    return {run:b.run,score:b.score,meta:s.meta,color:SLOT_COLORS[i]};
  });

  const metrics=[
    {k:'full_rdd',l:'RetDD FULL',h:true,f:v=>v.toFixed(2)},
    {k:'oos_rdd', l:'RetDD OOS', h:true,f:v=>v.toFixed(2)},
    {k:'is_rdd',  l:'RetDD IS',  h:true,f:v=>v.toFixed(2)},
    {k:'degradation',l:'Degradación%',h:false,f:v=>v.toFixed(1)+'%'},
    {k:'cv',      l:'CV Planitud',h:false,f:v=>v.toFixed(3)},
    {k:'rdd_min', l:'RDD mín',   h:true,f:v=>v.toFixed(2)},
    {k:'pct_pos', l:'% Periodos+',h:true,f:v=>v.toFixed(0)+'%'},
    {k:'full_np', l:'NP Full',   h:true,f:v=>'$'+Math.round(v).toLocaleString()},
    {k:'oos_pf',  l:'PF OOS',    h:true,f:v=>v.toFixed(2)},
    {k:'oos_wr',  l:'WR OOS',    h:true,f:v=>(v*100).toFixed(0)+'%'},
    {k:'oos_dd',  l:'Max DD OOS',h:false,f:v=>v.toFixed(2)+'%'},
  ];

  const wins=bests.map(()=>0);
  metrics.forEach(m=>{
    const vals=bests.map(b=>b.run[m.k]);
    const best_=m.h?Math.max(...vals):Math.min(...vals);
    vals.forEach((v,i)=>{if(Math.abs(v-best_)<0.001)wins[i]++;});
  });
  const ow=wins.indexOf(Math.max(...wins));

  const cols=bests.length;
  let html=`<div style="margin-bottom:16px;padding:12px 16px;background:var(--bg2);border:1px solid var(--b0);border-radius:var(--r2);display:flex;align-items:center;gap:10px">
    <span style="font-size:18px">🏆</span>
    <div>
      <div style="font-size:12px;font-family:var(--mono);font-weight:600;color:${bests[ow].color}">${bests[ow].meta.name.slice(0,40)} — ${bests[ow].run.name}</div>
      <div style="font-size:10px;color:var(--t2);font-family:var(--mono);margin-top:2px">Gana ${wins[ow]} de ${metrics.length} métricas</div>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:130px ${bests.map(()=>'1fr').join(' ')};gap:8px">
    <div style="padding:8px 0;font-size:9px;font-family:var(--mono);color:var(--t3);text-transform:uppercase">Métrica</div>
    ${bests.map((b,i)=>`<div style="background:var(--bg2);border:1px solid ${i===ow?'rgba(0,217,126,.25)':' var(--b0)'};border-radius:var(--r2);padding:10px 14px">
      <div style="font-size:11px;font-family:var(--mono);font-weight:600;color:${b.color}">${i===ow?'🏆 ':''}${b.meta.pair} · ${b.meta.tf}</div>
      <div style="font-size:10px;color:var(--t2);font-family:var(--mono)">${b.run.name.replace('WF: ','')}</div>
    </div>`).join('')}
    <!-- Score -->
    <div style="padding:7px 0;font-size:10px;font-family:var(--mono);color:var(--amber);font-weight:600;border-top:1px solid var(--b1)">SCORE</div>
    ${bests.map((b,i)=>`<div style="display:flex;align-items:center;justify-content:center;padding:7px;border-top:1px solid var(--b1)">
      <span style="font-size:18px;font-family:var(--mono);font-weight:700;color:${i===ow?'var(--green)':'var(--t1)'}">${b.score}</span>
    </div>`).join('')}
    ${metrics.map(m=>{
      const vals=bests.map(b=>b.run[m.k]);
      const bv=m.h?Math.max(...vals):Math.min(...vals);
      return `<div style="padding:6px 0;font-size:10px;font-family:var(--mono);color:var(--t2);border-bottom:1px solid var(--b0)">${m.l}</div>
        ${bests.map((b,i)=>{
          const v=b.run[m.k], isW=Math.abs(v-bv)<0.001;
          return `<div style="display:flex;align-items:center;justify-content:center;padding:6px;border-bottom:1px solid var(--b0)">
            <span style="font-family:var(--mono);font-size:11px;color:${isW?'var(--green)':'var(--t2)'};font-weight:${isW?'600':'400'}">${m.f(v)}${isW?' ★':''}</span>
          </div>`;
        }).join('')}`;
    }).join('')}
  </div>`;

  section.innerHTML=html;
}

// ═══════════════════════════════════════════
// WEIGHTS PANEL
// ═══════════════════════════════════════════
function initWeightsPanel() {
  const el=document.getElementById('weights-panel');
  el.innerHTML=Object.keys(weights).map(k=>`
    <div class="wrow">
      <div class="wlabel"><span>${WEIGHT_LABELS[k]}</span><span class="wval" id="wv-${k}">${weights[k]}%</span></div>
      <input type="range" min="0" max="50" value="${weights[k]}" oninput="updateWeight('${k}',this.value)">
    </div>`).join('');
}

function updateWeight(k,v) {
  weights[k]=parseInt(v);
  document.getElementById(`wv-${k}`).textContent=v+'%';
  renderAll();
}
function resetWeights() {
  weights={...DEFAULT_WEIGHTS};
  initWeightsPanel();
  renderAll();
}

// ═══════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════
initWeightsPanel();
renderSlots();
