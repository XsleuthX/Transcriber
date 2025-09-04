// srt.js — ESM parsers for SRT & VTT
// Exports: parseSRT, parseVTT, parseAuto, toSRT
function hhmmssToSec(str) {
  const s = str.trim().replace(',', '.');
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3) return NaN;
  let h=0, m=0, rest='0';
  if (parts.length === 3) { [h,m,rest] = parts; } else { [m,rest] = parts; }
  const sec = parseFloat(rest);
  if (Number.isNaN(sec)) return NaN;
  h = parseInt(h||0, 10) || 0;
  m = parseInt(m||0, 10) || 0;
  return h*3600 + m*60 + sec;
}
const TIME_RE_SRT = /(\d{1,2}:\d{2}:\d{2}[,\.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,\.]\d{1,3})/;
const TIME_RE_VTT = /(\d{1,2}:\d{2}(?::\d{2})?\.\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?\.\d{1,3})/;

export function parseSRT(text) {
  const blocks = text.replace(/\r/g,'').split(/\n{2,}/);
  const items = [];
  for (let b of blocks) {
    const lines = b.split('\n').filter(Boolean);
    if (!lines.length) continue;
    if (/^\d+$/.test(lines[0])) lines.shift();
    if (!lines.length) continue;
    const m = lines[0].match(TIME_RE_SRT);
    if (!m) continue;
    const start = hhmmssToSec(m[1]);
    const end   = hhmmssToSec(m[2]);
    const cueText = lines.slice(1).join('\n').trim();
    if (!Number.isNaN(start) && !Number.isNaN(end)) items.push({ start, end, text: cueText });
  }
  return items;
}

export function parseVTT(text) {
  const src = text.replace(/\r/g,'').split('\n');
  const items = [];
  let i=0;
  if (/^\s*WEBVTT/i.test(src[0]||'')) i++;
  while (i < src.length) {
    while (i < src.length && (!src[i].trim() || /^NOTE\b/.test(src[i]))) i++;
    if (i < src.length && !TIME_RE_VTT.test(src[i])) i++;
    if (i >= src.length) break;
    const m = src[i].match(TIME_RE_VTT);
    if (!m) { i++; continue; }
    const start = hhmmssToSec(m[1]);
    const end   = hhmmssToSec(m[2]);
    i++;
    const textLines = [];
    while (i < src.length && src[i].trim()) { textLines.push(src[i]); i++; }
    const cueText = textLines.join('\n').trim();
    items.push({ start, end, text: cueText });
    while (i < src.length && !src[i].trim()) i++;
  }
  return items;
}

export function parseAuto(text) {
  if (/^\s*WEBVTT/i.test(text)) return parseVTT(text);
  if (text.match(/-->/) && /,/.test(text)) {
    const srt = parseSRT(text);
    if (srt.length) return srt;
  }
  const vtt = parseVTT(text);
  if (vtt.length) return vtt;
  return parseSRT(text);
}

function toSrtTime(t) {
  t = Math.max(0, t);
  const hh = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = Math.floor(t % 60);
  const mmm = Math.round((t - Math.floor(t)) * 1000);
  const z = (n, w=2) => String(n).padStart(w, '0');
  return `${z(hh)}:${z(mm)}:${z(ss)},${String(mmm).padStart(3,'0')}`;
}

export function toSRT(items) {
  let out = '';
  items.forEach((seg, idx) => {
    out += `${idx+1}\n${toSrtTime(seg.start)} --> ${toSrtTime(seg.end)}\n${(seg.text||'').trim()}\n\n`;
  });
  return out.trim() + '\n';
}
