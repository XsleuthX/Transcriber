// Minimal SRT/VTT helpers (ES module)
export function parseSRT(text){
  const norm = (text || '').replace(/\r\n/g,'\n').replace(/\r/g,'\n').trim();
  if (!norm) return [];
  const blocks = norm.split(/\n{2,}/);
  const out = [];
  for (const b of blocks){
    const lines = b.split('\n').filter(Boolean);
    if (lines.length < 2) continue;
    let i = 0;
    // optional numeric index
    if (/^\d+$/.test(lines[0].trim())) i = 1;
    const tc = lines[i]?.trim() || '';
    const m = tc.match(/(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/);
    if (!m) continue;
    const start = srtTimeToSec(m[1]);
    const end   = srtTimeToSec(m[2]);
    const body = lines.slice(i+1).join('\n').trim();
    out.push({ start, end, text: body });
  }
  return out;
}

export function parseVTT(text){
  const norm = (text || '').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  const lines = norm.split('\n');
  const out = [];
  let i=0;
  // skip WEBVTT header
  if (lines[i]?.startsWith('WEBVTT')) i++;
  for (; i<lines.length; i++){
    const line = lines[i].trim();
    if (!line) continue;
    // time line
    const m = line.match(/(\d{2}:\d{2}:\d{2}\.\d{3}|\d{1,2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3}|\d{1,2}:\d{2}\.\d{3})/);
    if (!m) continue;
    const start = vttTimeToSec(m[1]);
    const end = vttTimeToSec(m[2]);
    const bodyLines = [];
    i++;
    for (; i<lines.length; i++){
      const t = lines[i];
      if (!t.trim()) break;
      bodyLines.push(t);
    }
    out.push({ start, end, text: bodyLines.join('\n').trim() });
  }
  return out;
}

export function parseAuto(text){
  // Heuristic: WEBVTT header => VTT, else SRT
  const t = (text || '').trim();
  if (/^WEBVTT/i.test(t)) return parseVTT(t);
  return parseSRT(t);
}

export function toSRT(items){
  const z = (n, w=2) => String(n).padStart(w,'0');
  const toTime = (sec) => {
    sec = Math.max(0, Number(sec) || 0);
    const hh = Math.floor(sec/3600);
    const mm = Math.floor((sec%3600)/60);
    const ss = Math.floor(sec%60);
    const ms = Math.round((sec - Math.floor(sec))*1000);
    return `${z(hh)}:${z(mm)}:${z(ss)},${String(ms).padStart(3,'0')}`;
  };
  let out = '';
  (items||[]).forEach((c, idx) => {
    out += `${idx+1}\n${toTime(c.start)} --> ${toTime(c.end)}\n${(c.text||'').trim()}\n\n`;
  });
  return out.trimEnd();
}

function srtTimeToSec(s){
  const m = s.replace(',', '.').match(/(\d{2}):(\d{2}):(\d{2})\.(\d{3})/);
  if (!m) return 0;
  return (+m[1])*3600 + (+m[2])*60 + (+m[3]) + (+m[4])/1000;
}
function vttTimeToSec(s){
  // HH:MM:SS.mmm or MM:SS.mmm
  const parts = s.split(':');
  let hh=0, mm=0, rest='';
  if (parts.length===3){ hh=+parts[0]; mm=+parts[1]; rest=parts[2]; }
  else { mm=+parts[0]; rest=parts[1]; }
  const [ss, ms] = rest.split('.');
  return hh*3600 + mm*60 + (+ss) + (+ms)/1000;
}
