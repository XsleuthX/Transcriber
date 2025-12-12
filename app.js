
import { parseSRT, parseVTT, parseAuto, toSRT } from './srt.js';

/* DOM */
const fileInput   = document.getElementById('fileInput');
const srtInput    = document.getElementById('srtInput');
const player      = document.getElementById('player');
const transcriptEl= document.getElementById('transcript');
const statusEl    = document.getElementById('status');
const btnExport   = document.getElementById('btnExport');
const btnExportVtt= document.getElementById('btnExportVtt');
const lineTpl     = document.getElementById('lineTpl');
const fpsSelect   = document.getElementById('fpsSelect');
const tcPanel     = document.getElementById('tcPanel');
const tcFps       = document.getElementById('tcFps');
const overlayEl   = document.getElementById('captionOverlay');

/* State */
let entries = []; // [{ start, end, text, orig }]
let initialEntries = []; // the pristine cues as imported (never mutated)
let fps = 25;

/* Drag & scroll suppression */
let dragSrcIndex = -1;
let suppressAutoScrollUntil = 0;

// NEW: manual selection hold to prevent timeupdate from stealing highlight
let manualSelectIndex = -1;
let manualHoldUntil = 0;

const nowMs = () => performance.now();

function holdManualSelection(index, ms = 2000) {
  manualSelectIndex = index;
  manualHoldUntil = nowMs() + ms;
}
function clearManualSelection() {
  manualSelectIndex = -1;
  manualHoldUntil = 0;
}

// Focus an element but keep the transcript panel’s scroll position
function focusNoScroll(el) {
  try {
    el?.focus({ preventScroll: true });
  } catch {
    const y = transcriptEl.scrollTop, x = transcriptEl.scrollLeft;
    el?.focus();
    transcriptEl.scrollTo(x, y);
  }
}

/* Utils */
const pad2 = n => String(n).padStart(2,'0');
const getFPS = () => parseInt(fpsSelect?.value ?? 30, 10) || 30;
const secToFrames = (s, f=getFPS()) => Math.max(0, Math.round(s * f));
const framesToSec = (fr, f=getFPS()) => Math.max(0, fr / f);

/* ---------- Selection & caret helpers (for contentEditable) ---------- */
function getCaretOffset(el){
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0);
  const preRange = range.cloneRange();
  preRange.selectNodeContents(el);
  preRange.setEnd(range.endContainer, range.endOffset);
  return preRange.toString().length;
}
function setCaretOffset(el, offset){
  const range = document.createRange();
  const sel = window.getSelection();
  let remaining = offset;
  // Walk down text nodes to place caret
  function walk(node){
    if (node.nodeType === Node.TEXT_NODE){
      const len = node.textContent.length;
      if (remaining <= len){
        range.setStart(node, Math.max(0, remaining));
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        return true;
      } else {
        remaining -= len;
      }
    } else {
      for (let i=0;i<node.childNodes.length;i++){
        if (walk(node.childNodes[i])) return true;
      }
    }
    return false;
  }
  walk(el);
}
function insertPlainTextAtCursor(text){
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  // move caret after inserted node
  const newRange = document.createRange();
  newRange.setStart(node, node.textContent.length);
  newRange.collapse(true);
  sel.removeAllRanges();
  sel.addRange(newRange);
}

/* ---------- Timecode helpers ---------- */
function formatTimecodeFromSeconds(sec, f=getFPS()){
  const totalFrames  = Math.max(0, Math.round(sec * f));
  const frames = totalFrames % f;
  const totalSeconds = Math.floor(totalFrames / f);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}:${pad2(frames)}`;
}
function formatDurationSF(sec, f=getFPS()){
  if (sec < 0) sec = 0;
  const totalFrames = Math.round(sec * f);
  const frames = totalFrames % f;
  const seconds = Math.floor(totalFrames / f);
  return `${String(seconds).padStart(2,'0')}:${pad2(frames)}`;
}
function parseTimecodeToSeconds(text, f=getFPS()){
  if (!text) return null;
  const parts = text.trim().split(':').map(x => x.trim());
  if (parts.some(p => p === '' || isNaN(+p))) return null;
  let hh=0, mm=0, ss=0, ff=0;
  if (parts.length === 4) [hh,mm,ss,ff] = parts.map(Number);
  else if (parts.length === 3) [mm,ss,ff] = parts.map(Number);
  else if (parts.length === 2) [ss,ff] = parts.map(Number);
  else return null;
  return Math.max(0, (hh*3600 + mm*60 + ss) + (ff / f));
}

/* ---------- Exports ---------- */
function buildVTT(items) {
  const toVttTime = (t) => {
    t = Math.max(0, t);
    const hh = Math.floor(t / 3600);
    const mm = Math.floor((t % 3600) / 60);
    const ss = Math.floor(t % 60);
    const mmm = Math.round((t - Math.floor(t)) * 1000);
    const z = (n, w=2) => String(n).padStart(w, '0');
    return `${z(hh)}:${z(mm)}:${z(ss)}.${String(mmm).padStart(3,'0')}`;
  };
  let out = 'WEBVTT\\n\\n';
  items.forEach((seg) => {
    out += `${toVttTime(seg.start)} --> ${toVttTime(seg.end)}\\n${(seg.text||'').trim()}\\n\\n`;
  });
  return out;
}
function download(filename, text, mime='text/plain') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
}
const suggestBaseName = () => window.currentBaseName || 'captions';

/* ---------- Common UI helpers ---------- */
function selectRow(index, {scroll=true} = {}){
  for (const el of transcriptEl.children) el.classList.remove('active');
  const row = transcriptEl.querySelector(`[data-index="${index}"]`);
  if (row){
    row.classList.add('active');
    if (scroll) row.scrollIntoView({ block:'nearest', behavior:'smooth' });
  }
}
function clearDropClasses(){
  [...transcriptEl.children].forEach(el => el.classList.remove('drop-before','drop-after','dragging'));
}

function flushEditsFromDOM() {
  [...transcriptEl.children].forEach(row => {
    const i = +row.dataset.index;
    const t = row.querySelector('.text');
    if (entries[i] && t) {
      entries[i].text = t.textContent;  // capture latest edits
    }
  });
}

/* ---------- Render transcript ---------- */
function renderTranscript(){
  const st = transcriptEl.scrollTop; // keep scroll
  transcriptEl.innerHTML='';

  const f = getFPS();
  const safeDuration = isFinite(player?.duration) ? player.duration : (entries.at(-1)?.end ?? 0);
  const durFrames = secToFrames(safeDuration, f);

  entries.forEach((e, i) => {
    const node = lineTpl.content.firstElementChild.cloneNode(true);
    node.dataset.index = i;
    node.draggable = true;

    const header = node.querySelector('.stamp');
    header.textContent = `[${fmtTC(e.start, f)}]`;
    header.onclick = () => { player.currentTime = Math.max(0, e.start) + 0.001; player.play(); };

    const textEl = node.querySelector('.text');
    textEl.textContent = e.text || '';
    textEl.setAttribute('contenteditable', 'true'); // ensure editable
    // Seek and select on click; also highlight on focus
    textEl.addEventListener('mousedown', () => {
      const startT = Math.max(0, entries[i].start) + 0.001;
      try { player.currentTime = startT; } catch {}
      holdManualSelection(i, 2000);
      selectRow(i, { scroll: false });
    });
    textEl.addEventListener('focus', () => {
      holdManualSelection(i, 60000);
      selectRow(i, { scroll: false });
    });


    // --- 1) Force paste as plain text (strip source formatting) ---
    textEl.addEventListener('paste', (ev) => {
      ev.preventDefault();
      const clip = ev.clipboardData || window.clipboardData;
      const txt = clip ? (clip.getData('text/plain') || '') : '';
      insertPlainTextAtCursor(txt);
      // update model
      entries[i].text = textEl.textContent;
    });


    // --- 2) Enter to split caption at caret ---
    textEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey){
        ev.preventDefault();
        const caret = getCaretOffset(textEl);
        const full  = textEl.textContent || '';
        const left  = full.slice(0, caret).trimEnd();
        const right = full.slice(caret).trimStart();

        // Snapshot original timing
        const origStart = entries[i].start;
        const origEnd   = entries[i].end;
        const hasNext   = (i + 1) < entries.length;
        const nextIn    = hasNext ? entries[i+1].start : origEnd;

        const f = getFPS();
        const startF = secToFrames(origStart, f);
        const endF   = secToFrames(origEnd,   f);
        let midF = Math.floor((startF + endF) / 2);

        // Ensure valid durations (at least 1 frame if possible)
        if (midF <= startF) midF = startF + 1;

        const midSec = framesToSec(midF, f);

        // Apply text updates
        entries[i].text = left;

        // 1) Rule: keep IN; set OUT to midpoint
        entries[i].end = midSec;

        // 2) New cue: IN = midpoint; OUT = next line's IN (or original OUT if no next)
        let newStart = midSec;
        let newEnd   = hasNext ? nextIn : origEnd;
        if (newEnd <= newStart) newEnd = newStart + (1 / f);

        const newCap = {
          start: newStart,
          end:   newEnd,
          text:  right,
          orig:  { start: newStart, end: newEnd, text: right },
          origIndex: null,
          isNew: true
        };

        const st = transcriptEl.scrollTop;
        entries.splice(i+1, 0, newCap);
        renderTranscript();
        transcriptEl.scrollTop = st;

        suppressAutoScrollUntil = nowMs() + 800;
        holdManualSelection(i+1, 2000);
        selectRow(i+1, { scroll:false });
        const newTxt = transcriptEl.querySelector(`[data-index="${i+1}"] .text`);
        if (newTxt){
          focusNoScroll(newTxt);
          setCaretOffset(newTxt, 0);
        }
      }
    });
    textEl.addEventListener('blur', clearManualSelection);
    textEl.addEventListener('input',           ev => { entries[i].text = ev.currentTarget.textContent; });
    textEl.addEventListener('compositionend',  ev => { entries[i].text = ev.currentTarget.textContent; });

    // context menu
    node.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showContextMenu(ev.clientX, ev.clientY, i);
    });

    const meta = document.createElement('div');
    meta.className = 'caption-meta';
    meta.innerHTML = `
      <span class="timepill in-pill"  id="in-pill-${i}"  title="Drag or type; ←/→ to nudge">${fmtTC(e.start, f)}</span>
      <span class="arrow">→</span>
      <span class="timepill out-pill" id="out-pill-${i}" title="Drag or type; ←/→ to nudge">${formatTimecodeFromSeconds(e.end, f)}</span>
      <span class="len-pill" id="len-pill-${i}" title="Duration (SS:FF)">${formatDurationSF(Math.max(e.end - e.start, 0), f)}</span>
    `;
    node.appendChild(meta);

    /* Drag & drop reorder */
    node.addEventListener('dragstart', (ev) => {
      dragSrcIndex = i;
      node.classList.add('dragging');
      ev.dataTransfer.effectAllowed = 'move';
      const img = new Image(); img.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
      ev.dataTransfer.setDragImage(img,0,0);
    });
    node.addEventListener('dragend', () => { clearDropClasses(); dragSrcIndex=-1; });
    node.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      const rect = node.getBoundingClientRect();
      const before = ev.clientY < (rect.top + rect.height/2);
      node.classList.toggle('drop-before', before);
      node.classList.toggle('drop-after', !before);
    });
    node.addEventListener('dragleave', () => { node.classList.remove('drop-before','drop-after'); });
    node.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const rect = node.getBoundingClientRect();
      const before = ev.clientY < (rect.top + rect.height/2);
      performReorder(dragSrcIndex, i, before ? 'before' : 'after');
    });

    transcriptEl.appendChild(node);

    // pills
    const inPill  = node.querySelector(`#in-pill-${i}`);
    const outPill = node.querySelector(`#out-pill-${i}`);
    enablePillEditing(inPill, i, true,  durFrames);
    enablePillEditing(outPill,i, false, durFrames);
    attachDragToPill(inPill,  i, true,  durFrames);
    attachDragToPill(outPill, i, false, durFrames);
  });

  transcriptEl.scrollTop = st; // restore
}

function performReorder(srcIndex, targetIndex, pos){
  flushEditsFromDOM();               // sync edits
  if (srcIndex < 0 || targetIndex < 0 || srcIndex === targetIndex) { clearDropClasses(); return; }
  const st = transcriptEl.scrollTop;
  const item = entries.splice(srcIndex, 1)[0];
  let newIndex = targetIndex + (pos === 'after' ? 1 : 0);
  if (srcIndex < newIndex) newIndex--;
  entries.splice(newIndex, 0, item);
  clearDropClasses();
  renderTranscript();
  transcriptEl.scrollTop = st;
  suppressAutoScrollUntil = nowMs() + 400;
  selectRow(newIndex, {scroll:false});
}

/* ---------- Pill editing ---------- */
function enablePillEditing(pillEl, index, isIn, durFrames){
  if (!pillEl) return;
  pillEl.tabIndex = 0;
  pillEl.setAttribute('role','textbox');
  pillEl.setAttribute('aria-label', isIn ? 'In timecode' : 'Out timecode');
  pillEl.contentEditable = 'true';

  let original = pillEl.textContent;
  
  pillEl.addEventListener('focus', () => {
    holdManualSelection(index, 60_000);
    selectRow(index, { scroll: false });
  });
  pillEl.addEventListener('blur', clearManualSelection);

  pillEl.addEventListener('keydown', (e) => {
    const f = getFPS();
    const step = (e.ctrlKey ? 10 : e.shiftKey ? 5 : 1);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'){
      e.preventDefault();
      let frames = secToFrames((isIn ? entries[index].start : entries[index].end), f);
      frames += (e.key === 'ArrowRight' ? +step : -step);
      commitFrames(index, isIn, frames, durFrames);
      return;
    }
    if (e.key === 'Enter'){ e.preventDefault(); pillEl.blur(); return; }
    if (e.key === 'Escape'){ e.preventDefault(); pillEl.textContent = original; pillEl.blur(); return; }
  });

  pillEl.addEventListener('blur', () => {
    const f = getFPS();
    const parsed = parseDisplayedTcToSeconds(pillEl.textContent, f);
    if (parsed == null){ pillEl.textContent = original; return; }
    const frames = secToFrames(parsed, f);
    commitFrames(index, isIn, frames, durFrames);
  });
}

function attachDragToPill(pillEl, index, isIn, durFrames){
  if (!pillEl) return;
  pillEl.style.cursor = 'ew-resize';

  let startX = 0, startF = 0, spanF = 0, wPx = 1;

  const onMove = (e) => {
    const dx = e.clientX - startX;
    const deltaF = Math.round((dx / wPx) * spanF);
    const targetF = startF + deltaF;
    commitFrames(index, isIn, targetF, durFrames, true);
  };
  const onUp = (e) => {
    pillEl.releasePointerCapture?.(e.pointerId);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  pillEl.addEventListener('pointerdown', (e) => {
    const row = pillEl.closest('[data-index]');
    const r = row.getBoundingClientRect();
    startX = e.clientX;
    wPx = Math.max(1, r.width);
    const [minF, maxF] = allowedRangeFrames(index, isIn, 0|durFrames);
    spanF = Math.max(1, maxF - minF);
    startF = secToFrames((isIn ? entries[index].start : entries[index].end), getFPS());
    pillEl.setPointerCapture?.(e.pointerId);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once:true });
  });
}

function allowedRangeFrames(index, isIn, durFrames){
  const f = getFPS();
  const startF = secToFrames(entries[index].start, f);
  const endF   = secToFrames(entries[index].end,   f);
  if (isIn){
    const minF = 0;
    const maxF = Math.max(endF - 1, 0);
    return [minF, maxF];
  } else {
    const minF = startF + 1;
    const maxF = Math.max(durFrames, minF);
    return [minF, maxF];
  }
}

function commitFrames(index, isIn, newF, durFrames){
  const f = getFPS();
  const [minF, maxF] = allowedRangeFrames(index, isIn, durFrames);
  let valF = Math.min(Math.max(newF, minF), maxF);

  if (isIn){
    const outF = secToFrames(entries[index].end, f);
    if (valF >= outF) valF = outF - 1;
    entries[index].start = framesToSec(valF, f);
  } else {
    const inF = secToFrames(entries[index].start, f);
    if (valF <= inF) valF = inF + 1;
    entries[index].end = framesToSec(valF, f);
  }

  if (!player.paused) player.pause();
  player.currentTime = isIn ? entries[index].start : entries[index].end;

  updateRowUI(index);
  const active = getActiveIndex(player.currentTime);
  updateOverlay(active);
}

function updateRowUI(index){
  const f = getFPS();
  const row = transcriptEl.querySelector(`[data-index="${index}"]`);
  if (!row) return;
  const e = entries[index];
  const header = row.querySelector('.stamp');
  if (header) header.textContent = `[${fmtTC(e.start, f)}]`;
  const inPill  = row.querySelector(`#in-pill-${index}`);
  const outPill = row.querySelector(`#out-pill-${index}`);
  const lenPill = row.querySelector(`#len-pill-${index}`);
  if (inPill)  inPill.textContent  = fmtTC(e.start, f);
  if (outPill) outPill.textContent = fmtTC(e.end,   f);
  if (lenPill) lenPill.textContent = formatDurationSF(Math.max(e.end - e.start, 0), f);
}

/* ---------- Overlay ---------- */
function getActiveIndex(t){
  for (let i=0;i<entries.length;i++){
    const e = entries[i];
    if (t >= e.start && t <= e.end) return i;
  }
  return -1;
}
function updateOverlay(idx){
  if (!overlayEl) return;
  if (idx < 0) { overlayEl.style.opacity='0'; overlayEl.textContent=''; return; }
  overlayEl.textContent = (entries[idx].text || '').trim();
  overlayEl.style.opacity = '1';
}

/* ---------- Player timeupdate ---------- */
player.addEventListener('timeupdate', () => {
  const t = player.currentTime;
  const now = nowMs();

  // Keep overlay in sync
  const activeIdx = getActiveIndex(t);
  updateOverlay(activeIdx);

  // If user just added/focused a row, keep that row highlighted & do not auto-scroll
  if (manualSelectIndex >= 0 && now < manualHoldUntil) {
    for (const el of transcriptEl.children) el.classList.remove('active');
    const row = transcriptEl.children[manualSelectIndex];
    if (row) row.classList.add('active');
    return; // stop here to avoid jump
  }

  // Normal highlight + (optional) auto-scroll
  for (const el of transcriptEl.children) el.classList.remove('active');
  if (activeIdx >= 0) {
    const el = transcriptEl.children[activeIdx];
    el.classList.add('active');
    if (now > suppressAutoScrollUntil) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
});


/* ---------- Live timecode ---------- */
function updateLiveTimecode(){
  const t = player?.currentTime || 0;
  tcPanel.textContent = fmtTC(t, getFPS());
  const p = tcPanel.parentElement;
  if (p && !p.classList.contains('tc-centered')) p.classList.add('tc-centered');
  requestAnimationFrame(updateLiveTimecode);
}

/* ---------- Imports ---------- */
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  if (!f) return;
  player.src = URL.createObjectURL(f);
  statusEl.textContent = `Loaded: ${f.name} (${Math.round(f.size/1024/1024)} MB)`;
  entries = []; renderTranscript();
});


srtInput.addEventListener('change', async () => {
  const f = srtInput.files[0];
  if (!f) return;

  const text = await f.text();
  const name = (f.name || '').toLowerCase();
  const parsed =
    name.endsWith('.vtt') ? parseVTT(text) :
    name.endsWith('.srt') ? parseSRT(text) :
    parseAuto(text);

  // IMPORTANT: use (e, idx) — not just (e)
  initialEntries = parsed.map((e, idx) => ({
    start: e.start,
    end:   e.end,
    text:  e.text,
    index: idx,         // stable pointer to the original cue
  }));

  entries = parsed.map((e, idx) => ({
    start: e.start,
    end:   e.end,
    text:  e.text,
    orig:  { start: e.start, end: e.end, text: e.text }, // snapshot
    origIndex: idx,                                      // pointer into initialEntries
  }));

  renderTranscript();
  statusEl.textContent = `Imported ${entries.length} captions from ${f.name}`;
});

/* ---------- Exports ---------- */
btnExport.addEventListener('click', () => {
  flushEditsFromDOM(); 
  if (!entries.length) { alert('No transcript to export.'); return; }
  const srt = toSRT(useSourceTc ? entries.map(e => ({...e, start: e.start + sourceTcSec, end: e.end + sourceTcSec})) : entries);
  download(suggestBaseName() + '.srt', srt, 'text/plain;charset=utf-8');
});
if (btnExportVtt){
  btnExportVtt.addEventListener('click', () => {
    flushEditsFromDOM(); 
    const vtt = buildVTT(useSourceTc ? entries.map(e => ({...e, start: e.start + sourceTcSec, end: e.end + sourceTcSec})) : entries);
    download(suggestBaseName() + '.vtt', vtt, 'text/vtt');
  });
}

/* ---------- FPS ---------- */
fpsSelect.addEventListener('change', () => {
  fps = parseInt(fpsSelect.value, 10) || 30;
  tcFps.textContent = fps;
  renderTranscript();
});
player.addEventListener('loadedmetadata', renderTranscript);

/* ---------- Context menu (Delete / Reset / Add Caption) ---------- */
let ctxMenu = null;
let ctxIndex = -1;
function ensureContextMenu(){
  if (ctxMenu) return ctxMenu;
  const style = document.createElement('style');
  style.textContent = `
    .ctx-menu{position:fixed;z-index:9999;background:#101317;border:1px solid #2a2f3a;
      box-shadow:0 10px 30px rgba(0,0,0,.45);border-radius:8px;overflow:hidden;min-width:160px}
    .ctx-menu button{display:block;width:100%;text-align:left;padding:8px 12px;font-size:13px;
      background:transparent;border:0;color:#e9edf1;cursor:pointer}
    .ctx-menu button:hover{background:#19202a}
    .ctx-sep{height:1px;background:#232a36;margin:4px 0}
    /* Drag & Drop visuals */
    #transcript .line.dragging{ opacity:.5 }
    #transcript .line.drop-before{ box-shadow: inset 0 6px 0 0 #2a86ff; }
    #transcript .line.drop-after { box-shadow: inset 0 -6px 0 0 #2a86ff; }
  `;
  document.head.appendChild(style);

  ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';
  ctxMenu.style.display = 'none';

  const btnDelete = document.createElement('button'); btnDelete.textContent = 'Delete';
  const btnReset  = document.createElement('button'); btnReset.textContent  = 'Reset';
  const sep       = document.createElement('div');    sep.className='ctx-sep';
  const btnAdd    = document.createElement('button'); btnAdd.textContent    = 'Add Caption';

  btnDelete.addEventListener('click', () => {
    flushEditsFromDOM(); 
    if (ctxIndex>=0){
      const st = transcriptEl.scrollTop;
      entries.splice(ctxIndex,1);
      hideContextMenu();
      renderTranscript();
      transcriptEl.scrollTop = st;
      selectRow(Math.min(ctxIndex, entries.length-1), {scroll:false});
    }
  });

  btnReset.addEventListener('click', () => {
    if (ctxIndex < 0) return;
    flushEditsFromDOM?.();
  
    const row = entries[ctxIndex];
    if (!row) return;
  
    if (row.origIndex != null && initialEntries[row.origIndex]) {
      const o = initialEntries[row.origIndex];
      row.start = o.start;
      row.end   = o.end;
      row.text  = o.text;
    } else if (row.orig) {
      row.start = row.orig.start;
      row.end   = row.orig.end;
      row.text  = row.orig.text;
    } else {
      // brand-new caption: pick your policy
      row.text = '';
    }
  
    updateRowUI(ctxIndex);
    selectRow(ctxIndex, { scroll: false });
  
    const active = getActiveIndex(player.currentTime);
    if (active === ctxIndex) updateOverlay(active);
  
    hideContextMenu();
  });

  btnAdd.addEventListener('click', () => {
    if (ctxIndex < 0) return;
  
    const f = getFPS();
    const here = entries[ctxIndex];
    const start = here.end;
    let end = start + 1.0;
  
    // constrain to next caption if overlapping
    const next = entries[ctxIndex + 1];
    if (next && end >= next.start) {
      end = Math.max(start + (1 / f), next.start - (1 / f));
      if (end < start) end = start + (1 / f);
    }
  
    const newCap = {start, end, text: '',
    orig: { start, end, text: '' }, // optional snapshot
    origIndex: null,                // <-- new cue, no origin in import
    isNew: true
  };

    const st = transcriptEl.scrollTop;
    const newIndex = ctxIndex + 1;
  
    entries.splice(newIndex, 0, newCap);
    hideContextMenu();
  
    // Re-render but preserve scroll
    renderTranscript();
    transcriptEl.scrollTop = st;
  
    // Prevent timeupdate from auto-scrolling right after insert
    suppressAutoScrollUntil = nowMs() + 800;
  
    // Hold manual highlight on the new row and focus its text field without scrolling
    holdManualSelection(newIndex, 2000);
    selectRow(newIndex, { scroll: false });
    const txt = transcriptEl.querySelector(`[data-index="${newIndex}"] .text`);
    focusNoScroll(txt);
  });

  ctxMenu.append(btnDelete, btnReset, sep, btnAdd);
  document.body.appendChild(ctxMenu);

  window.addEventListener('click', hideContextMenu);
  window.addEventListener('scroll', hideContextMenu, true);
  window.addEventListener('resize', hideContextMenu);
  return ctxMenu;
}
function showContextMenu(x,y,index){
  ensureContextMenu();
  ctxIndex = index;
  ctxMenu.style.left = x+'px';
  ctxMenu.style.top  = y+'px';
  ctxMenu.style.display = 'block';
}
function hideContextMenu(){ if (ctxMenu){ ctxMenu.style.display='none'; ctxIndex=-1; }}

/* ---------- Style controls (dark) & Find/Replace ---------- */
function ensureStyleControls(){
  let bar = document.getElementById('videoStyleBar');
  if (!bar){
    const style = document.createElement('style');
    style.textContent = `
      .tc-centered{ display:flex; justify-content:center; align-items:center; gap:.75rem; text-align:center; }
      .stylebar{ margin-top:8px; padding:8px; display:flex; flex-wrap:wrap; gap:12px;
        align-items:center; background:#0e1116; border:1px solid rgba(255,255,255,.06);
        border-radius:10px; color:#fff; }
      .stylebar label{ display:flex; align-items:center; gap:6px; font-size:12px; opacity:.9 }
      .ui-dark-input, .ui-dark-select, .ui-dark-color{
        background:#131720; color:#fff; border:1px solid #2a2f3a; border-radius:6px; padding:6px 8px; height:35px;
      }
      .ui-dark-color{ padding:0; height:35px; width:44px; }
      #transcriptFindBar{ display:flex; gap:8px; align-items:center; padding:8px; border-bottom:1px solid rgba(255,255,255,.07); }
      #transcriptFindBar input[type="text"]{ min-width:180px }
      
      .btn{ background:#1f2a3a; color:#e9edf1; border:1px solid #2a3647; padding:6px 10px; border-radius:6px; cursor:pointer }
      .btn:hover{ background:#263243 }
      .muted{ opacity:.7 }
      .btn{
      appearance:none; border:1px solid var(--line); background:var(--bg-elev);
      color:var(--ink); padding:8px 12px; border-radius:12px; cursor:pointer;
      transition: transform .06s ease, box-shadow .2s ease, border-color .2s ease;
      }
      .btn:hover{ transform: translateY(-1px); box-shadow: var(--shadow); }
      .btn-ghost{ background:linear-gradient(180deg, #0e1115, #0b0d11); height: 35px;}
      .btn-outline{ background:transparent; height: 35px;}
      .btn-gold{
       border:none;
       background: linear-gradient(180deg, var(--gold-2), var(--gold));
       color:#111315; font-weight:600; height: 35px;
      }
    `;
    document.head.appendChild(style);

    bar = document.createElement('div');
    bar.id = 'videoStyleBar';
    bar.className = 'stylebar';
    bar.innerHTML = `
      <label>Caption Size <input id="capSize" class="ui-dark-input" type="number" min="10" max="96" value="28"></label>
      <label>Family 
        <select id="capFamily" class="ui-dark-select">
          <option>System</option><option>Inter</option><option>Roboto</option><option>Helvetica</option>
          <option>Arial</option><option>Georgia</option><option>Times New Roman</option>
          <option>Fira Sans</option>
          <option>Monaco</option>
          <option>Courier New</option>
          <option>SimSun</option>
          <option>仿宋</option>
          <option>微软雅黑</option>
          <option>新宋体</option>
          <option>楷体</option>
          <option>等线</option>
          <option>黑体</option>
          <option>Noto Sans SC</option>
        </select>
      </label>
      <label>Color <input id="capColor" class="ui-dark-color" type="color" value="#ffffff"></label>
    `;
    const tcContainer = tcPanel?.parentElement || player.parentElement || document.body;
    tcContainer.insertAdjacentElement('afterend', bar);
  }
  const size   = bar.querySelector('#capSize');
  const family = bar.querySelector('#capFamily');
  const color  = bar.querySelector('#capColor');
  const apply = ()=>{
    if (!overlayEl) return;
    overlayEl.style.fontSize = size.value + 'px';
    overlayEl.style.fontFamily = (family.value==='System')
      ? "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
      : family.value + ", sans-serif";
    overlayEl.style.color = color.value;
  };
  size.addEventListener('input', apply);
  family.addEventListener('change', apply);
  color.addEventListener('input', apply);
  apply();
}

function ensureFindReplaceBar(){
  let bar = document.getElementById('transcriptFindBar');
  if (!bar){
    bar = document.createElement('div');
    bar.id = 'transcriptFindBar';
    const parent = transcriptEl.parentElement || document.body;
    parent.insertBefore(bar, transcriptEl);
    bar.innerHTML = `
      <input id="frFind" class="ui-dark-input" type="text" placeholder="Find text…">
      <input id="frReplace" class="ui-dark-input" type="text" placeholder="Replace with…">
      <span class="muted"><label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="frCase"> Case </label></span class>
      <span class="muted"><label style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="frWhole"> Whole word </label></span class>
      <button class="btn" id="frDo">Replace All</button>
      <span id="frCount" class="muted"></span>
    `;
  }
  const findInp = bar.querySelector('#frFind');
  const repInp  = bar.querySelector('#frReplace');
  const cbCase  = bar.querySelector('#frCase');
  const cbWhole = bar.querySelector('#frWhole');
  const btn     = bar.querySelector('#frDo');
  const countEl = bar.querySelector('#frCount');

  const countMatches = () => {
    const q = findInp.value;
    if (!q) { countEl.textContent = ''; return; }
    const { re } = buildSearchRegex(q, cbCase.checked, cbWhole.checked);
    let c = 0;
    entries.forEach(e => {
      const m = (e.text || '').match(re);
      if (m) c += m.length;
    });
    countEl.textContent = c ? `${c} match(es)` : 'No matches';
  };
  [findInp, cbCase, cbWhole].forEach(el => el.addEventListener('input', countMatches));
  btn.addEventListener('click', () => {
    const q = findInp.value;
    if (!q) return;
    const replacement = repInp.value ?? '';
    const { re } = buildSearchRegex(q, cbCase.checked, cbWhole.checked);
    entries.forEach(e => { e.text = (e.text || '').replace(re, replacement); });
    renderTranscript();
    countMatches();
    const idx = getActiveIndex(player.currentTime);
    updateOverlay(idx);
  });
  countMatches();
}
function buildSearchRegex(q, isCase, whole){
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = whole ? `\\b${escaped}\\b` : escaped;
  const flags = isCase ? 'g' : 'gi';
  return { re: new RegExp(pattern, flags) };
}

/* ---------- Timecode Origin (Source TC) ---------- */
let sourceTcSec = 0;         // seconds equivalent of source HH:MM:SS:FF
let useSourceTc = false;     // toggle for source-based display/export

const fmtTC = (sec, f=getFPS()) => formatTimecodeFromSeconds(Math.max(0, sec + (useSourceTc ? sourceTcSec : 0)), f);

function parseDisplayedTcToSeconds(text, f=getFPS()){
  const base = parseTimecodeToSeconds(text, f);
  if (base == null) return null;
  return Math.max(0, base - (useSourceTc ? sourceTcSec : 0));
}

function ensureTcOriginBar(){
  if (document.getElementById('tcOriginBar')) return;
  const bar = document.createElement('div');
  bar.id = 'tcOriginBar';
  bar.className = 'stylebar'; // reuse dark bar styling if present
  bar.innerHTML = `
    <label>Source TC (HH:MM:SS:FF)
      <input id="srcTcInput" class="ui-dark-input" type="text" placeholder="10:51:54:18" style="width:140px">
    </label>
    <label style="display:flex;align-items:center;gap:6px">
      <input id="useSrcTcToggle" type="checkbox">
      Use source timecode for display/export
    </label>
  `;
  const anchor = tcPanel?.parentElement || player?.parentElement || document.body;
  anchor.insertAdjacentElement('afterend', bar);

  const inp = bar.querySelector('#srcTcInput');
  const chk = bar.querySelector('#useSrcTcToggle');

  const apply = () => {
    const s = parseTimecodeToSeconds(inp.value, getFPS());
    sourceTcSec = (s != null) ? s : 0;
    useSourceTc = chk.checked;
    renderTranscript();
  };

  inp.addEventListener('change', apply);
  inp.addEventListener('blur', apply);
  chk.addEventListener('change', apply);
}

/* ---------- Init ---------- */
function init(){
  tcFps.textContent = fps;
  requestAnimationFrame(updateLiveTimecode);
  ensureContextMenu();
  ensureStyleControls();
  ensureFindReplaceBar();
  ensureTcOriginBar();
}
init();
