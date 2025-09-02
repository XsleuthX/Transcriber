export function parseSRT(text) {
  const lines = text.replace(/\r/g,'').split('\n');
  const entries = [];
  let i=0;
  function parseStamp(stamp){
    const vtt = stamp.replace(',', '.').replace(' --> ', ' ');
    const [a,b] = vtt.split(/\s+/);
    const toSec = t => {
      const [hh,mm,ss] = t.split(':'); const [s,ms='0'] = ss.split('.');
      return (+hh)*3600 + (+mm)*60 + (+s) + (+ms)/1000;
    };
    return [toSec(a), toSec(b)];
  }
  while (i < lines.length) {
    if (!lines[i].trim() || /^\d+$/.test(lines[i].trim()) || /^WEBVTT/i.test(lines[i])) { i++; continue; }
    if (lines[i].includes('-->')) {
      const [t0,t1] = parseStamp(lines[i].trim());
      i++;
      let text='';
      while (i<lines.length && lines[i].trim()) { text += (text?'\n':'') + lines[i]; i++; }
      entries.push({ start:t0, end:t1, text:text.trim() });
    } else i++;
  }
  return entries;
}

export function toSRT(entries) {
  let out='';
  const pad2 = n => String(n).padStart(2,'0');
  const pad3 = n => String(n).padStart(3,'0');
  entries.forEach((e, idx)=>{
    const st = e.start, en = e.end;
    const h1 = Math.floor(st/3600), m1 = Math.floor((st%3600)/60), s1 = Math.floor(st%60), ms1 = Math.round((st*1000)%1000);
    const h2 = Math.floor(en/3600), m2 = Math.floor((en%3600)/60), s2 = Math.floor(en%60), ms2 = Math.round((en*1000)%1000);
    out += `${idx+1}\n` +
           `${pad2(h1)}:${pad2(m1)}:${pad2(s1)},${pad3(ms1)} --> ${pad2(h2)}:${pad2(m2)}:${pad2(s2)},${pad3(ms2)}\n` +
           `${(e.text||'').trim()}\n\n`;
  });
  return out;
}
