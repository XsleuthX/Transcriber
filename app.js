
import { parseSRT, parseVTT, parseAuto, toSRT } from './srt.js';

/* DOM */
const fileInput   = document.getElementById('fileInput');
const srtInput    = document.getElementById('srtInput'); // legacy (kept for compatibility)
const player      = document.getElementById('player');
const transcriptEl= document.getElementById('transcript');
// Dual Sub UI (robust injection)
const singleWrap  = document.getElementById('transcriptSingleWrap');

// Lock state (per column)
let lockedA = false;
let lockedB = false;

function ensureDualSubDOM(){
  // If the HTML template doesn't include Dual Sub controls (older index.html),
  // inject them into the Transcript panel so the feature always appears.
  const existingToggle = document.getElementById('subsMode');
  const existingDualWrap = document.getElementById('dualWrap');
  if (existingToggle && existingDualWrap) return;

  // Find transcript panel container
  const transcriptPanel =
    document.querySelector('.transcript-panel') ||
    (transcriptEl ? transcriptEl.closest('section') : null) ||
    (singleWrap ? singleWrap.closest('section') : null);

  if (!transcriptPanel) return;

  // Ensure header controls
  const head = transcriptPanel.querySelector('.section-head') || transcriptPanel.querySelector('header');
  if (head && !document.getElementById('subsMode')){
    let controls = head.querySelector('.tcontrols');
    if (!controls){
      controls = document.createElement('div');
      controls.className = 'tcontrols';
      head.appendChild(controls);
    }
    const lab = document.createElement('label');
    lab.className = 'subs-mode-label';
    lab.innerHTML = `
      <span class="subs-label">SUBS</span>
      <select id="subsMode" class="subs-mode">
        <option value="A">Sub A</option>
        <option value="B">Sub B</option>
        <option value="DUAL">Dual Sub</option>
      </select>
    `;
    controls.appendChild(lab);
  }

  // Ensure dualWrap structure
  if (!document.getElementById('dualWrap') && transcriptPanel){
    const wrap = document.createElement('div');
    wrap.id = 'dualWrap';
    wrap.className = 'dual-wrap';
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="dual-col">
        <div class="dual-bar">
          <div class="dual-title">SRT A (Original)</div>
          <div class="dual-actions">
            <button class="btn btn-sm lock-btn" id="btnLockA" type="button" title="Lock/unlock SRT A">Lock</button>
            <button class="btn btn-sm" id="btnImportA" type="button">Import SRT/VTT</button>
            <input id="srtInputA" type="file" accept=".srt,.vtt" hidden>
          </div>
        </div>
        <div id="transcriptA" class="transcript transcript-a" role="list"></div>
      </div>

      <div class="dual-col">
        <div class="dual-bar">
          <div class="dual-title">SRT B (Translation)</div>
          <div class="dual-actions">
            <button class="btn btn-sm lock-btn" id="btnLockB" type="button" title="Lock/unlock SRT B">Lock</button>
            <button class="btn btn-sm" id="btnImportB" type="button">Import SRT/VTT</button>
            <input id="srtInputB" type="file" accept=".srt,.vtt" hidden>
          </div>
        </div>
        <div id="transcriptBHost" class="transcript-b-host"></div>
      </div>
    `;
    // Insert dual wrap after single wrap so it lives in the Transcript panel.
    if (singleWrap && singleWrap.parentElement){
      singleWrap.parentElement.appendChild(wrap);
    } else {
      transcriptPanel.appendChild(wrap);
    }
  }
}

ensureDualSubDOM();

// Track which transcript column was last interacted with (controls overlay source)
function wireActiveTrackListeners(){
  const aEl = document.getElementById('transcript');
  const bEl = document.getElementById('transcriptB');
  if (aEl && !aEl.__activeTrackBound){
    aEl.addEventListener('pointerdown', () => { activeOverlayTrack = (subsMode==='B') ? 'B' : 'A'; }, true);
    aEl.addEventListener('focusin', () => { activeOverlayTrack = (subsMode==='B') ? 'B' : 'A'; }, true);
    aEl.__activeTrackBound = true;
  }
  if (bEl && !bEl.__activeTrackBound){
    bEl.addEventListener('pointerdown', () => { activeOverlayTrack = 'B'; }, true);
    bEl.addEventListener('focusin', () => { activeOverlayTrack = 'B'; }, true);
    bEl.__activeTrackBound = true;
  }
}
wireActiveTrackListeners();


function ensureSingleSubBar(){
  const wrap = document.getElementById('transcriptSingleWrap');
  if (!wrap) return;
  let bar = document.getElementById('singleSubBar');
  if (!bar){
    bar = document.createElement('div');
    bar.id = 'singleSubBar';
    bar.className = 'dual-bar single-sub-bar';
    bar.innerHTML = `
      <div class="dual-title" id="singleSubTitle">SRT A (Original)</div>
      <div class="dual-actions">
        <button class="btn btn-sm lock-btn" id="btnLockSingle" type="button">Lock</button>
      </div>`;
    wrap.insertBefore(bar, wrap.firstChild);
  }
}
ensureSingleSubBar();


// Wire Dual column import + lock buttons (A/B)
(function initSubColumnControls(){
  const btnImportA = document.getElementById('btnImportA');
  const btnImportB = document.getElementById('btnImportB');
  const srtInputAEl = document.getElementById('srtInputA');
  const srtInputBEl = document.getElementById('srtInputB');
  const btnLockA = document.getElementById('btnLockA');
  const btnLockB = document.getElementById('btnLockB');
  const btnLockSingle = document.getElementById('btnLockSingle');
  const singleTitle = document.getElementById('singleSubTitle');

  const refreshLockUI = () => {
    if (btnLockA) btnLockA.textContent = lockedA ? 'Unlock' : 'Lock';
    if (btnLockB) btnLockB.textContent = lockedB ? 'Unlock' : 'Lock';
    if (btnLockSingle){
      const mode = (document.getElementById('subsMode')?.value || 'A');
      const isB = (mode === 'B');
      const locked = isB ? lockedB : lockedA;
      btnLockSingle.textContent = locked ? 'Unlock' : 'Lock';
    }
  };

  const refreshSingleTitle = () => {
    const mode = (document.getElementById('subsMode')?.value || 'A');
    if (!singleTitle) return;
    if (mode === 'B') singleTitle.textContent = 'SRT B (Translation)';
    else singleTitle.textContent = 'SRT A (Original)';
  };

  if (btnImportA && srtInputAEl){
    btnImportA.addEventListener('click', () => srtInputAEl.click());
  }
  if (btnImportB && srtInputBEl){
    btnImportB.addEventListener('click', () => srtInputBEl.click());
  }

  if (btnLockA){
    btnLockA.addEventListener('click', () => {
      lockedA = !lockedA;
      refreshLockUI();
      renderTranscript();
      if (document.getElementById('subsMode')?.value === 'DUAL') renderTranscriptB();
    });
  }
  if (btnLockB){
    btnLockB.addEventListener('click', () => {
      lockedB = !lockedB;
      refreshLockUI();
      applyLockState('B');
      if (document.getElementById('subsMode')?.value === 'DUAL') {
        renderTranscriptB(document.getElementById('transcriptB'));
      }
    });
  }
  if (btnLockSingle){
    btnLockSingle.addEventListener('click', () => {
      const mode = (document.getElementById('subsMode')?.value || 'A');
      if (mode === 'B') lockedB = !lockedB;
      else lockedA = !lockedA;
      refreshLockUI();
      if (mode === 'B') renderTranscriptB();
      else renderTranscript();
    });
  }

  // Keep single title/lock aligned with mode
  const modeSel = document.getElementById('subsMode');
  if (modeSel){
    modeSel.addEventListener('change', () => { refreshSingleTitle(); refreshLockUI(); });
    refreshSingleTitle();
  }
  refreshLockUI();
})();
const dualToggle  = document.getElementById('subsMode');
const dualWrap    = document.getElementById('dualWrap');
const transcriptAEl = document.getElementById('transcriptA');
const transcriptBHost = document.getElementById('transcriptBHost');
const srtInputA   = document.getElementById('srtInputA') || document.getElementById('srtInput');
const srtInputB   = document.getElementById('srtInputB');

const statusEl    = document.getElementById('status');
const btnExport   = document.getElementById('btnExport');
const btnExportVtt= document.getElementById('btnExportVtt');
const lineTpl     = document.getElementById('lineTpl');
const fpsSelect   = document.getElementById('fpsSelect');
const tcPanel     = document.getElementById('tcPanel');
const tcFps       = document.getElementById('tcFps');
const overlayEl   = document.getElementById('captionOverlay');

/* State */
let entries = []; // SRT A (Original) [{ start, end, text, orig }]
let entriesB = []; // SRT B (Translation) [{ start, end, text }]
let activeOverlayTrack = 'A'; // 'A' or 'B' depending on last active transcript column
function isTrackLocked(t){ return (t==='B') ? lockedB : lockedA; }
// Apply lock state to current DOM without forcing a full re-render (prevents UI lag)
function applyLockState(panel){
  const locked = (panel === 'B') ? lockedB : lockedA;
  const el = (panel === 'B') ? ((subsMode==='B') ? transcriptEl : (document.getElementById('transcriptB') || transcriptEl)) : transcriptEl;
  if (!el) return;
  el.classList.toggle('column-locked', locked);
  // Disable editing affordances
  el.querySelectorAll('.caption .text').forEach(t => { try{ t.contentEditable = (!locked).toString(); }catch(_e){} });
  el.querySelectorAll('input, textarea, select, button').forEach(inp => {
    // keep the lock button itself clickable
    if (inp && inp.id && (inp.id === 'btnLockA' || inp.id === 'btnLockB' || inp.id === 'btnLockSingle')) return;
    if (inp instanceof HTMLButtonElement && inp.classList.contains('stamp')) return; // allow stamp highlight
    try{ inp.disabled = locked; }catch(_e){}
  });
}
function applyAllLocks(){ applyLockState('A'); applyLockState('B'); }


let initialEntries = []; // pristine cues for SRT A (never mutated)
let initialEntriesB = []; // pristine cues for SRT B (never mutated)

let fps = 25;

/* Drag & scroll suppression */
let dragSrcIndex = -1;
let suppressAutoScrollUntil = 0;

// Track last active rows to avoid full re-scan each timeupdate
let lastActiveIdxA = -1;
let lastActiveIdxB = -1;

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

/* ---------- Dual Sub helpers ---------- */
let isDualMode = false;

function setDualMode(on){
  isDualMode = !!on;
  if (dualWrap) dualWrap.hidden = !isDualMode;

  // In dual mode, we want:
  // - transcriptEl (original) moved into the left column container (#transcriptA)
  // - a separate translation list (#transcriptB) rendered into the right column host (#transcriptBHost)
  try{
    if (isDualMode){
      if (transcriptAEl && transcriptEl && transcriptEl.parentElement !== transcriptAEl){
        transcriptAEl.appendChild(transcriptEl);
      }
      const existingB = document.getElementById('transcriptB');
      if (existingB){ try{ bindCopyHandler(existingB); }catch(_e){} }
      if (transcriptBHost && !existingB){
        const b = document.createElement('div');
        b.id = 'transcriptB';
        b.className = 'transcript transcript-b';
        b.setAttribute('role','list');
        transcriptBHost.appendChild(b);
        try{ bindCopyHandler(b); }catch(_e){}
      }
    } else {
      if (singleWrap && transcriptEl && transcriptEl.parentElement !== singleWrap){
        singleWrap.appendChild(transcriptEl);
      }
    }
  }catch(_e){}
}


// SUBS mode: A / B / DUAL
let subsMode = 'A'; // default

function setDualBadges(on){
  if (!on){
    document.querySelector('#dualWrap .dual-col:first-child .dual-title')?.classList.remove('has-badge');
    document.querySelector('#dualWrap .dual-col:last-child .dual-title')?.classList.remove('has-badge');
    return;
  }
  const aTitle = document.querySelector('#dualWrap .dual-col:first-child .dual-title');
  const bTitle = document.querySelector('#dualWrap .dual-col:last-child .dual-title');
  if (aTitle){ aTitle.innerHTML = 'SRT A (Original) <span class="sub-badge original">original</span>'; }
  if (bTitle){ bTitle.innerHTML = 'SRT B (Translation) <span class="sub-badge translation">translation</span>'; }
}

function syncDualScroll(){
  const bEl = document.getElementById('transcriptB');
  if (!bEl) return;
  let lock = false;
  const sync = (src, dst) => {
    if (lock) return;
    lock = true;
    dst.scrollTop = src.scrollTop;
    lock = false;
  };
  transcriptEl.addEventListener('scroll', () => { if (isDualMode) sync(transcriptEl, bEl); }, { passive:true });
  bEl.addEventListener('scroll', () => { if (isDualMode) sync(bEl, transcriptEl); }, { passive:true });
}

function renderBySubsMode(){
  // Always keep transcriptEl bound to Sub A (entries) when dual.
  if (subsMode === 'DUAL'){
    setDualMode(true);
    if (singleWrap) singleWrap.style.display = 'none';
    if (dualWrap){ dualWrap.hidden = false; dualWrap.style.display = ''; }
    renderTranscript();        // Sub A
    renderTranscriptB();       // Sub B
    // Note: we intentionally do NOT sync scroll positions between A/B.
    // Both columns follow the video playhead independently.
    transcriptEl.dataset.panel = 'A';
    const bEl = document.getElementById('transcriptB');
    if (bEl) bEl.dataset.panel = 'B';    applyAllLocks();
    return;
  }

  // Single panel modes
  setDualMode(false);
  // Hard-deactivate dual UI so it never affects layout
  if (dualWrap){
    dualWrap.hidden = true;
    dualWrap.style.display = 'none';
  }
  if (singleWrap) singleWrap.style.display = '';
  // Ensure transcriptEl is back inside singleWrap
  try{
    if (singleWrap && transcriptEl && transcriptEl.parentElement !== singleWrap){
      singleWrap.appendChild(transcriptEl);
    }
  }catch(_e){}

  if (subsMode === 'A'){
    renderTranscript();              // Sub A in transcriptEl
  } else {
    renderTranscriptB(transcriptEl); // Sub B in transcriptEl
  }
  transcriptEl.dataset.panel = (subsMode === 'B') ? 'B' : 'A';
  const bEl2 = document.getElementById('transcriptB');
  if (bEl2) bEl2.dataset.panel = 'B';
  applyAllLocks();
}

// Insert virtual placeholder spacers in Dual Sub mode so rows align by matching timecodes.
// This does NOT mutate A/B data; it only inserts/removes lightweight DOM spacers.
function applySubsMode(mode){
  subsMode = mode || 'A';
  const sel = document.getElementById('subsMode');
  if (sel && sel.value !== subsMode) sel.value = subsMode;
  // In single modes, overlay should default to the visible track
  if (subsMode === 'A') activeOverlayTrack = 'A';
  if (subsMode === 'B') activeOverlayTrack = 'B';
  renderBySubsMode();
  wireActiveTrackListeners();
}
function renderTranscriptB(targetEl=null){
  const bEl = targetEl || ((subsMode==='B') ? transcriptEl : document.getElementById('transcriptB'));
  if (!bEl) return;
  const st = bEl.scrollTop; // keep scroll
  bEl.innerHTML=''; 

  const f = getFPS();
  const safeDuration = isFinite(player?.duration) ? player.duration : (entriesB.at(-1)?.end ?? 0);
  const durFrames = secToFrames(safeDuration, f);

  entriesB.forEach((e, i) => {
    const node = lineTpl.content.firstElementChild.cloneNode(true);
    node.dataset.index = i;
    node.dataset.key = tcKey(e.start, e.end);
    node.draggable = true;

    const locked = isTrackLocked('B');
    if (locked) node.classList.add('is-locked');


    const header = node.querySelector('.stamp');
    header.textContent = `[${fmtTC(e.start, f)}]`;
    header.onclick = () => { player.currentTime = Math.max(0, e.start) + 0.001; player.play(); };

    // Verification badge (from Align-To-SRT verification)
    if (e.verifyScore != null){
      const b = document.createElement('span');
      b.className = 'vbadge ' + (e.verifyOk ? 'ok' : 'bad');
      b.textContent = `${Math.round(Number(e.verifyScore) * 100)}%`;
      header.appendChild(b);
    }

    // AI Check badge (misalignment hints based on overlap)
    if (e.aiWarn){
      const b2 = document.createElement('span');
      const label = (e.aiWarn === 'multi') ? 'MULTI' : (e.aiWarn === 'none') ? 'NO' : (e.aiWarn === 'match') ? 'MATCH' : (e.aiWarn === 'check') ? 'CHECK' : (e.aiWarn === 'low') ? 'LOW' : (e.aiWarn === 'high') ? 'HIGH' : 'DRIFT';
      b2.className = 'abdg ' + e.aiWarn;
      b2.title = e.aiDetail || '';
      b2.textContent = label;
      header.appendChild(b2);
    }

    const textEl = node.querySelector('.text');
    textEl.textContent = e.text || '';
    textEl.setAttribute('contenteditable', 'true'); // ensure editable
    // Seek and select on click; also highlight on focus
    textEl.addEventListener('mousedown', () => {
      const startT = Math.max(0, entriesB[i].start) + 0.001;
      try { player.currentTime = startT; } catch {}
      holdManualSelection(i, 2000);
      selectRowIn('B', i, { scroll: false });
    });
    textEl.addEventListener('focus', () => {
      holdManualSelection(i, 60000);
      selectRowIn('B', i, { scroll: false });
    });


    // --- 1) Force paste as plain text (strip source formatting) ---
    textEl.addEventListener('paste', (ev) => {
      ev.preventDefault();
      const clip = ev.clipboardData || window.clipboardData;
      const txt = clip ? (clip.getData('text/plain') || '') : '';
      insertPlainTextAtCursor(txt);
      // update model
      entriesB[i].text = textEl.textContent;
    });


    // --- 2) Enter to split caption at caret ---
    textEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey){
        if (locked) return;
        ev.preventDefault();
        const caret = getCaretOffset(textEl);
        const full  = textEl.textContent || '';
        const left  = full.slice(0, caret).trimEnd();
        const right = full.slice(caret).trimStart();

        // Snapshot original timing
        const origStart = entriesB[i].start;
        const origEnd   = entriesB[i].end;
        const hasNext   = (i + 1) < entriesB.length;
        const nextIn    = hasNext ? entriesB[i+1].start : origEnd;

        const f = getFPS();
        const startF = secToFrames(origStart, f);
        const endF   = secToFrames(origEnd,   f);
        let midF = Math.floor((startF + endF) / 2);

        // Ensure valid durations (at least 1 frame if possible)
        if (midF <= startF) midF = startF + 1;

        const midSec = framesToSec(midF, f);

        // Apply text updates
        entriesB[i].text = left;

        // 1) Rule: keep IN; set OUT to midpoint
        entriesB[i].end = midSec;

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

        const st = bEl.scrollTop;
        entriesB.splice(i+1, 0, newCap);
        activeOverlayTrack = 'B';
        renderTranscriptB(bEl);
        bEl.scrollTop = st;
        applyLockState('B');
        if (subsMode === 'DUAL')
        suppressAutoScrollUntil = nowMs() + 800;
        holdManualSelection(i+1, 2000);
        selectRowIn('B', i+1, { scroll:false });
        const newTxt = bEl.querySelector(`[data-index="${i+1}"] .text`);
        if (newTxt){
          focusNoScroll(newTxt);
          setCaretOffset(newTxt, 0);
        }
      }
    });
    textEl.addEventListener('blur', clearManualSelection);
    textEl.addEventListener('input',           ev => { entriesB[i].text = ev.currentTarget.textContent; });
    textEl.addEventListener('compositionend',  ev => { entriesB[i].text = ev.currentTarget.textContent; });

    // context menu
    node.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showContextMenuAtEvent(ev, i, 'B');
    });

    const meta = document.createElement('div');
    meta.className = 'caption-meta';
    meta.innerHTML = `
      <span class="timepill in-pill"  id="in-pill-b-${i}"  title="Drag or type; ←/→ to nudge">${fmtTC(e.start, f)}</span>
      <span class="arrow">→</span>
      <span class="timepill out-pill" id="out-pill-b-${i}" title="Drag or type; ←/→ to nudge">${fmtTC(e.end, f)}</span>
      <span class="len-pill" id="len-pill-b-${i}" title="Duration (SS:FF)">${formatDurationSF(Math.max(e.end - e.start, 0), f)}</span>
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

    bEl.appendChild(node);

    // pills
    const inPill  = node.querySelector(`#in-pill-b-${i}`);
    const outPill = node.querySelector(`#out-pill-b-${i}`);
    enablePillEditing(inPill, i, true,  durFrames);
    enablePillEditing(outPill,i, false, durFrames);
    attachDragToPill(inPill,  i, true,  durFrames);
    attachDragToPill(outPill, i, false, durFrames);
  });

  bEl.scrollTop = st; // restore 

}

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

async function saveTextFile(defaultName, text, mime='text/plain;charset=utf-8') {
  // Prefer File System Access API (Chrome/Edge) so user can pick filename + folder.
  if (window.showSaveFilePicker) {
    try {
      const ext = (defaultName.split('.').pop() || '').toLowerCase();
      const pickerOpts = {
        suggestedName: defaultName,
        types: [{
          description: ext ? ext.toUpperCase() : 'Text',
          accept: { [mime.split(';')[0]]: ext ? ['.' + ext] : ['.txt'] }
        }]
      };
      const handle = await window.showSaveFilePicker(pickerOpts);
      const writable = await handle.createWritable();
      await writable.write(new Blob([text], { type: mime }));
      await writable.close();
      return;
    } catch (e) {
      // User cancelled or API failed; fall back to normal download.
      console.warn('showSaveFilePicker failed, falling back to download()', e);
    }
  }

  // Fallback: prompt for filename; browser will download to default Downloads folder.
  const name = prompt('Save as filename:', defaultName);
  if (!name) return;
  download(name, text, mime);
}

const suggestBaseName = () => window.currentBaseName || 'captions';

/* ---------- Common UI helpers ---------- */
function selectRowIn(panel, index, {scroll=true} = {}) {
  // panel: 'A' or 'B'
  const aEl = transcriptEl;
  const bEl = document.getElementById('transcriptB');
  // clear both if present
  if (aEl) [...aEl.children].forEach(el => el.classList.remove('active'));
  if (bEl) [...bEl.children].forEach(el => el.classList.remove('active'));

  const target = (panel === 'B')
    ? (subsMode === 'B' ? transcriptEl : bEl)
    : transcriptEl;

  if (!target) return;

  const row = target.querySelector(`[data-index="${index}"]`);
  if (row){
    row.classList.add('active');
    if (scroll){
      scrollRowToCenter(getScrollContainerFor(target), row);
    }
  }
}

function selectRow(index, {scroll=true} = {}) {
  // Backwards-compatible: pick based on current mode/active track
  const panel = (subsMode === 'B') ? 'B' : (activeOverlayTrack === 'B' ? 'B' : 'A');
  selectRowIn(panel, index, {scroll});
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
    node.dataset.key = tcKey(e.start, e.end);
    node.draggable = true;

    const locked = isTrackLocked('A');
    if (locked) node.classList.add('is-locked');


    const header = node.querySelector('.stamp');
    header.textContent = `[${fmtTC(e.start, f)}]`;
    header.onclick = () => { player.currentTime = Math.max(0, e.start) + 0.001; player.play(); };

    // Verification badge (from Align-To-SRT verification)
    if (e.verifyScore != null){
      const b = document.createElement('span');
      b.className = 'vbadge ' + (e.verifyOk ? 'ok' : 'bad');
      b.textContent = `${Math.round(Number(e.verifyScore) * 100)}%`;
      header.appendChild(b);
    }

    // AI Check badge (misalignment hints based on overlap)
    if (e.aiWarn){
      const b2 = document.createElement('span');
      const label = (e.aiWarn === 'multi') ? 'MULTI' : (e.aiWarn === 'none') ? 'NO' : (e.aiWarn === 'match') ? 'MATCH' : (e.aiWarn === 'check') ? 'CHECK' : (e.aiWarn === 'low') ? 'LOW' : (e.aiWarn === 'high') ? 'HIGH' : 'DRIFT';
      b2.className = 'abdg ' + e.aiWarn;
      b2.title = e.aiDetail || '';
      b2.textContent = label;
      header.appendChild(b2);
    }

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
        if (locked) return;
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
        if (subsMode === 'DUAL')
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
      showContextMenuAtEvent(ev, i, 'A');
    });

    const meta = document.createElement('div');
    meta.className = 'caption-meta';
    meta.innerHTML = `
      <span class="timepill in-pill"  id="in-pill-${i}"  title="Drag or type; ←/→ to nudge">${fmtTC(e.start, f)}</span>
      <span class="arrow">→</span>
      <span class="timepill out-pill" id="out-pill-${i}" title="Drag or type; ←/→ to nudge">${fmtTC(e.end, f)}</span>
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

  if (isTxtMode) { try { updateTxtBox(); } catch {} }

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
  if (inPill)  inPill.textContent  = formatTimecodeFromSeconds(e.start, f);
  if (outPill) outPill.textContent = formatTimecodeFromSeconds(e.end,   f);
  if (lenPill) lenPill.textContent = formatDurationSF(Math.max(e.end - e.start, 0), f);
}

/* ---------- Overlay ---------- */
function getActiveIndex(t, track=activeOverlayTrack){
  const list = (track === 'B') ? entriesB : entries;
  for (let i=0;i<list.length;i++){
    const e = list[i];
    if (t >= e.start && t <= e.end) return i;
  }
  return -1;
}
function updateOverlay(idx, track=activeOverlayTrack){
  if (!overlayEl) return;
  if (idx < 0) { overlayEl.style.opacity='0'; overlayEl.textContent=''; return; }
    const list = (track === 'B') ? entriesB : entries;
  overlayEl.textContent = ((list[idx]?.text) || '').trim();
  overlayEl.style.opacity = '1';
}

/* ---------- Player timeupdate ---------- */

function scrollRowToCenter(container, row){
  if (!container || !row) return;
  const contRect = container.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const ch = container.clientHeight || contRect.height || 0;
  // rowTop relative to container scroll content
  const rowTop = (rowRect.top - contRect.top) + container.scrollTop;
  const target = rowTop - (ch / 2 - rowRect.height / 2);
  const max = Math.max(0, container.scrollHeight - ch);
  container.scrollTop = Math.max(0, Math.min(max, target));
}

function getScrollContainerFor(el){
  let cur = el;
  while (cur && cur !== document.body && cur !== document.documentElement){
    const cs = getComputedStyle(cur);
    const oy = cs.overflowY;
    if (oy === 'auto' || oy === 'scroll') return cur;
    cur = cur.parentElement;
  }
  return el;
}


function setActiveRow(container, idx, track){
  if (!container) return;
  const lastIdx = (track === 'B') ? lastActiveIdxB : lastActiveIdxA;
  if (lastIdx === idx) return;
  // clear previous
  if (lastIdx >= 0 && container.children[lastIdx]) {
    container.children[lastIdx].classList.remove('active');
  }
  // set current
  if (idx >= 0 && container.children[idx]) {
    container.children[idx].classList.add('active');
  }
  if (track === 'B') lastActiveIdxB = idx; else lastActiveIdxA = idx;
}

player.addEventListener('timeupdate', () => {
  const t = player.currentTime;
  const now = nowMs();

  // Overlay: forced in single modes, follows last interaction in dual
  if (subsMode === 'A') activeOverlayTrack = 'A';
  else if (subsMode === 'B') activeOverlayTrack = 'B';

  const overlayIdx = getActiveIndex(t, activeOverlayTrack);
  updateOverlay(overlayIdx, activeOverlayTrack);

  if (isTxtMode) return;

  // If user manually selected a row recently, don't auto-scroll over them
  if (manualSelectIndex >= 0 && now < manualHoldUntil) return;

  const idxA = getActiveIndex(t, 'A');
  const idxB = getActiveIndex(t, 'B');

  if (subsMode === 'DUAL') {
    const aList = transcriptEl;
    const bList = document.getElementById('transcriptB');
    setActiveRow(aList, idxA, 'A');
    setActiveRow(bList, idxB, 'B');

    if (now > suppressAutoScrollUntil) {
      if (idxA >= 0 && aList && aList.children[idxA]) scrollRowToCenter(getScrollContainerFor(aList), aList.children[idxA]);
      const bScroll = (typeof transcriptBHost !== 'undefined' && transcriptBHost) ? transcriptBHost : getScrollContainerFor(bList);
      if (idxB >= 0 && bList && bList.children[idxB]) scrollRowToCenter(bScroll, bList.children[idxB]);
    }
    return;
  }

  // Single mode: center the active row in the visible panel
  if (subsMode === 'A') {
    setActiveRow(transcriptEl, idxA, 'A');
    if (now > suppressAutoScrollUntil && idxA >= 0 && transcriptEl.children[idxA]) {
      scrollRowToCenter(getScrollContainerFor(transcriptEl), transcriptEl.children[idxA]);
    }
  } else { // subsMode === 'B'
    setActiveRow(transcriptEl, idxB, 'B');
    if (now > suppressAutoScrollUntil && idxB >= 0 && transcriptEl.children[idxB]) {
      scrollRowToCenter(getScrollContainerFor(transcriptEl), transcriptEl.children[idxB]);
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



async function importToAFromFile(f){
  if (!f) return;
  const text = await f.text();
  const name = (f.name || '').toLowerCase();
  const parsed =
    name.endsWith('.vtt') ? parseVTT(text) :
    name.endsWith('.srt') ? parseSRT(text) :
    parseAuto(text);

  // Sub A (Original) is the default target for imports/transcribe/align-to-audio.
  initialEntries = parsed.map((e, idx) => ({
    start: e.start,
    end:   e.end,
    text:  e.text,
    index: idx,
  }));
  entries = parsed.map((e, idx) => ({
    start: e.start,
    end:   e.end,
    text:  e.text,
    orig:  { start: e.start, end: e.end, text: e.text },
    origIndex: idx,
  }));

  // Do NOT auto-touch Sub B on import (keep it as-is).
  if (!entriesB?.length){
    entriesB = parsed.map((e) => ({ start:e.start, end:e.end, text:'' }));
    initialEntriesB = entriesB.map((e) => ({ start:e.start, end:e.end, text:e.text }));
  }

  window.currentBaseName = (f.name || 'captions').replace(/\.(srt|vtt)$/i,'');
  renderBySubsMode();
}

async function importToBFromFile(f){
  if (!f) return;
  const text = await f.text();
  const name = (f.name || '').toLowerCase();
  const parsed =
    name.endsWith('.vtt') ? parseVTT(text) :
    name.endsWith('.srt') ? parseSRT(text) :
    parseAuto(text);

  // Sub B (Translation) import affects ONLY B.
  if (entries?.length){
    const n = Math.max(entries.length, parsed.length);
    entriesB = [];
    for (let i=0;i<n;i++){
      const a = entries[i];
      const p = parsed[i];
      const start = a ? a.start : (p ? p.start : ((entriesB[i-1]?.end ?? 0) + 0.01));
      const end   = a ? a.end   : (p ? p.end   : (start + 0.9));
      entriesB.push({ start, end, text: (p?.text ?? '') });
    }
  } else {
    entriesB = parsed.map((e) => ({ start:e.start, end:e.end, text:e.text }));
  }

  initialEntriesB = entriesB.map((e) => ({ start:e.start, end:e.end, text:e.text }));
  renderBySubsMode();
}

// Wire inputs
srtInput?.addEventListener('change', async () => {
  const f = srtInput?.files?.[0];
  if (!f) return;
  await importToAFromFile(f); // ALWAYS goes to Sub A (Original)
});

srtInputA?.addEventListener('change', async () => {
  const f = srtInputA?.files?.[0];
  if (!f) return;
  await importToAFromFile(f); // Sub A (Original)
});

srtInputB?.addEventListener('change', async () => {
  const f = srtInputB?.files?.[0];
  if (!f) return;
  await importToBFromFile(f);
});

/* ---------- Exports ---------- */
btnExport.addEventListener('click', async () => {
  flushEditsFromDOM();

  // Export should respect which transcript panel is active:
  // - Sub A selected -> export from SRT A (entries)
  // - Sub B selected -> export from SRT B (entriesB)
  const src = (subsMode === 'B') ? entriesB : entries;
  if (!src.length) { alert('No transcript to export.'); return; }

  const items = useSourceTc
    ? src.map(e => ({...e, start: e.start + sourceTcSec, end: e.end + sourceTcSec}))
    : src;

  const srt = toSRT(items);
  await saveTextFile(suggestBaseName() + '.srt', srt, 'text/plain;charset=utf-8');
});
if (btnExportVtt){
  btnExportVtt.addEventListener('click', async () => {
  flushEditsFromDOM();

  const src = (subsMode === 'B') ? entriesB : entries;
  if (!src.length) { alert('No transcript to export.'); return; }

  const items = useSourceTc
    ? src.map(e => ({...e, start: e.start + sourceTcSec, end: e.end + sourceTcSec}))
    : src;

  const vtt = toVTT(items);
  await saveTextFile(suggestBaseName() + '.vtt', vtt, 'text/vtt;charset=utf-8');
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
  const btnPushUp = document.createElement('button'); btnPushUp.textContent = 'Push Up';
  const btnPushDn = document.createElement('button'); btnPushDn.textContent = 'Push Down';
  const sep       = document.createElement('div');    sep.className='ctx-sep';
  const btnAdd    = document.createElement('button'); btnAdd.textContent    = 'Add Caption';

  btnDelete.addEventListener('click', () => {
    if (ctxIndex < 0) return;
    if (__ctxTrack === 'A') flushEditsFromDOM();
    const list = (__ctxTrack === 'B') ? entriesB : entries;
    const el = (__ctxTrack === 'B') ? (document.getElementById('transcriptB') || transcriptEl) : transcriptEl;
    const st = el.scrollTop;
    list.splice(ctxIndex, 1);
    hideContextMenu();
    if (__ctxTrack === 'B') renderTranscriptB(); else renderTranscript();
    el.scrollTop = st;
    if (__ctxTrack === 'A') selectRow(Math.min(ctxIndex, list.length-1), {scroll:false});
  });

  btnReset.addEventListener('click', () => {
    if (ctxIndex < 0) return;
    if (__ctxTrack === 'A') flushEditsFromDOM?.();

    const list = (__ctxTrack === 'B') ? entriesB : entries;
    const base = (__ctxTrack === 'B') ? initialEntriesB : initialEntries;

    const row = list[ctxIndex];
    if (!row) { hideContextMenu(); return; }

    // Restore from pristine snapshot if available, else from per-row orig
    const snap = base[ctxIndex];
    if (snap){
      row.start = snap.start;
      row.end   = snap.end;
      row.text  = snap.text;
    } else if (row.orig){
      row.start = row.orig.start;
      row.end   = row.orig.end;
      row.text  = row.orig.text;
    } else {
      row.text = row.text ?? '';
    }

    hideContextMenu();
    if (__ctxTrack === 'B') renderTranscriptB(); else { renderTranscript(); try{ selectRow(ctxIndex, {scroll:false}); }catch{} }
  });


  btnPushUp.addEventListener('click', () => {
    if (ctxIndex < 0) return;
    if (__ctxTrack === 'A') flushEditsFromDOM();
    const list = (__ctxTrack === 'B') ? entriesB : entries;
    const el = (__ctxTrack === 'B') ? (document.getElementById('transcriptB') || transcriptEl) : transcriptEl;
    if (ctxIndex <= 0) { hideContextMenu(); return; }
    const st = el.scrollTop;
    for (let i = ctxIndex - 1; i < list.length - 1; i++){
      list[i].text = list[i+1].text ?? '';
    }
    if (list.length) list[list.length - 1].text = '';
    hideContextMenu();
    if (__ctxTrack === 'B') renderTranscriptB(); else renderTranscript();
    el.scrollTop = st;
    if (__ctxTrack === 'A') selectRow(Math.max(0, ctxIndex - 1), {scroll:false});
  });

  btnPushDn.addEventListener('click', () => {
    if (ctxIndex < 0) return;
    if (__ctxTrack === 'A') flushEditsFromDOM();
    const list = (__ctxTrack === 'B') ? entriesB : entries;
    const el = (__ctxTrack === 'B') ? (document.getElementById('transcriptB') || transcriptEl) : transcriptEl;
    if (ctxIndex >= list.length - 1) { hideContextMenu(); return; }
    const st = el.scrollTop;
    for (let i = list.length - 1; i >= ctxIndex + 1; i--){
      list[i].text = list[i-1].text ?? '';
    }
    list[ctxIndex].text = '';
    hideContextMenu();
    if (__ctxTrack === 'B') renderTranscriptB(); else renderTranscript();
    el.scrollTop = st;
    if (__ctxTrack === 'A') selectRow(Math.min(list.length - 1, ctxIndex + 1), {scroll:false});
  });

  btnAdd.addEventListener('click', () => {
    if (ctxIndex < 0) return;
    const f = getFPS();
    const list = (__ctxTrack === 'B') ? entriesB : entries;
    const el = (__ctxTrack === 'B') ? (document.getElementById('transcriptB') || transcriptEl) : transcriptEl;

    const here = list[ctxIndex];
    const start = (here?.end ?? 0);
    let end = start + 1.0;

    const next = list[ctxIndex + 1];
    if (next && end >= next.start) {
      end = Math.max(start + (1 / f), next.start - (1 / f));
      if (end < start) end = start + (1 / f);
    }

    const newCap = { start, end, text: '' };
    const st = el.scrollTop;
    const newIndex = ctxIndex + 1;
    list.splice(newIndex, 0, newCap);
    hideContextMenu();
    if (__ctxTrack === 'B') renderTranscriptB(); else renderTranscript();
    el.scrollTop = st;
    if (__ctxTrack === 'A'){
      suppressAutoScrollUntil = nowMs() + 800;
      holdManualSelection(newIndex, 2000);
      try{ selectRow(newIndex, { scroll:false }); }catch{}
      const t = transcriptEl.querySelector(`[data-index="${newIndex}"] .text`);
      focusNoScroll(t);
    } else {
      const bEl = document.getElementById('transcriptB');
      const t = bEl?.querySelector(`[data-index="${newIndex}"] .text`);
      focusNoScroll(t);
    }
  });

  ctxMenu.append(btnDelete, btnReset, btnPushUp, btnPushDn, sep, btnAdd);
  document.body.appendChild(ctxMenu);

  window.addEventListener('click', hideContextMenu);
  window.addEventListener('scroll', hideContextMenu, true);
  window.addEventListener('resize', hideContextMenu);
  return ctxMenu;
}

// Track-aware context menu routing (A = Original, B = Translation)
let __ctxTrack = 'A';
function showContextMenuAtEvent(ev, index, track='A'){
  if (isTrackLocked(track)) return;
  __ctxTrack = track;
  const x = ev.pageX ?? (ev.clientX + window.scrollX);
  const y = ev.pageY ?? (ev.clientY + window.scrollY);
  showContextMenu(x, y, index);
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
    const panel = document.querySelector('.transcript-panel');
    const head = panel ? (panel.querySelector('.section-head') || panel.querySelector('header')) : null;
    if (head && head.parentElement){
      head.parentElement.insertBefore(bar, head.nextSibling);
    } else {
      const parent = transcriptEl?.parentElement || document.body;
      parent.insertBefore(bar, transcriptEl);
    }
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
let sourceTcSec = 0;
let useSourceTc = false;
const fmtTC = (sec, f=getFPS()) => formatTimecodeFromSeconds(Math.max(0, sec + (useSourceTc ? sourceTcSec : 0)), f);
const tcKey = (startSec, endSec) => `${Math.round(startSec*1000)}|${Math.round(endSec*1000)}`;
function parseDisplayedTcToSeconds(text, f=getFPS()){
  const s = parseTimecodeToSeconds(text, f);
  if (s == null) return null;
  return Math.max(0, s - (useSourceTc ? sourceTcSec : 0));
}
function ensureTcOriginBar(){
  if (document.getElementById('tcOriginBar')) return;
  const bar = document.createElement('div');
  bar.id = 'tcOriginBar';
  bar.style.cssText = 'margin-top:8px;padding:8px;display:flex;gap:12px;align-items:center;background:#0e1116;border:1px solid rgba(255,255,255,.06);border-radius:10px;color:#fff;font-size:13px';
  bar.innerHTML = `
    <label style="display:flex;align-items:center;gap:6px">
      Source TC (HH:MM:SS:FF):
      <input id="srcTcInput" type="text" placeholder="10:51:54:18" style="width:140px;background:#131720;color:#fff;border:1px solid #2a2f3a;border-radius:6px;padding:6px 8px;height:32px">
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
    const f = getFPS();
    const s = parseTimecodeToSeconds(inp.value, f);
    sourceTcSec = s != null ? s : 0;
    useSourceTc = chk.checked;
    renderTranscript();
  };
  inp.addEventListener('change', apply);
  inp.addEventListener('blur', apply);
  chk.addEventListener('change', apply);
}

/* ---------- Copy with timecodes ---------- */
function getRowIndexFromNode(node){
  if (!node) return -1;
  let el = (node.nodeType === Node.ELEMENT_NODE) ? node : node.parentElement;
  while (el && el !== document){
    if (el.hasAttribute && el.hasAttribute('data-index')){
      return parseInt(el.getAttribute('data-index'), 10);
    }
    el = el.parentElement;
  }
  return -1;
}
function buildCopyPayload(sel){
  const f = getFPS();
  if (!sel || sel.rangeCount === 0) return '';
  const range = sel.getRangeAt(0);
  const startIdx = getRowIndexFromNode(range.startContainer);
  const endIdx   = getRowIndexFromNode(range.endContainer);
  if (startIdx < 0 || endIdx < 0) return '';
  const [from, to] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
  const blocks = [];
  for (let i = from; i <= to; i++){
    const e = entries[i];
    if (!e) continue;
    let txt = e.text || '';
    const rowEl = transcriptEl.querySelector(`[data-index="${i}"]`);
    const textEl = rowEl ? rowEl.querySelector('.text') : null;
    if (textEl && (i === startIdx || i === endIdx)){
      const full = textEl.textContent || '';
      const computeOffset = (container, offset) => {
        const r = document.createRange();
        r.setStart(textEl, 0);
        r.setEnd(container, offset);
        return r.toString().length;
      };
      if (i === startIdx){
        const startOff = computeOffset(range.startContainer, range.startOffset);
        txt = full.slice(startOff);
      }
      if (i === endIdx){
        const endOff = computeOffset(range.endContainer, range.endOffset);
        if (i === startIdx){
          const startOff = computeOffset(range.startContainer, range.startOffset);
          txt = full.slice(startOff, endOff);
        } else {
          txt = full.slice(0, endOff);
        }
      }
    }
    const inTc  = (typeof fmtTC==='function' ? fmtTC(e.start, f) : formatTimecodeFromSeconds(e.start, f));
    const outTc = (typeof fmtTC==='function' ? fmtTC(e.end, f)   : formatTimecodeFromSeconds(e.end,   f));
    blocks.push(`${inTc} --> ${outTc}\n${txt}`.trimEnd());
  }
  return blocks.join('\\n\\n');
}
function selectionIsInside(el, cls){
  if (!el) return false;
  const n = el.nodeType === 3 ? el.parentElement : el; // text node -> element
  return !!(n && n.closest && n.closest(cls));
}
function shouldInterceptCopy(sel){
  if (!sel || sel.rangeCount === 0) return false;
  // If selection touches caption-meta, do NOT intercept (allow normal copy).
  const a = sel.anchorNode;
  const f = sel.focusNode;
  if (selectionIsInside(a, '.caption-meta') || selectionIsInside(f, '.caption-meta')) return false;
  // Intercept only when selection originates inside .text (or spans within .text blocks).
  const inTextA = selectionIsInside(a, '.text');
  const inTextF = selectionIsInside(f, '.text');
  return inTextA || inTextF;
}
function bindCopyHandler(el){
  if (!el || el._copyBound) return;
  el._copyBound = true;
  el.addEventListener('copy', (ev) => {
    const sel = window.getSelection();
    if (!shouldInterceptCopy(sel)) return; // default copy
    const payload = buildCopyPayload(sel);
    if (payload){
      ev.preventDefault();
      if (ev.clipboardData){
        ev.clipboardData.setData('text/plain', payload);
        const html = `<pre>${payload.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`;
        ev.clipboardData.setData('text/html', html);
      } else if (window.clipboardData){
        window.clipboardData.setData('Text', payload);
      }
    }
  });
}
// Bind for the main transcript element (reused in Sub A and Sub B single modes)
bindCopyHandler(transcriptEl);


/* ---------- View Mode: SRT / TXT (Single Text Area) ---------- */
let isTxtMode = false;
let txtBoxEl = null;

function ensureTxtBox(){
  if (txtBoxEl && document.body.contains(txtBoxEl)) return txtBoxEl;
  txtBoxEl = document.getElementById('txtBigBox');
  if (txtBoxEl) return txtBoxEl;

  txtBoxEl = document.createElement('textarea');
  txtBoxEl.id = 'txtBigBox';
  txtBoxEl.spellcheck = false;
  txtBoxEl.readOnly = true;
  txtBoxEl.style.cssText = `
    width:100%;
    min-height:420px;
    resize:vertical;
    background:#0e1116;
    color:#e9edf1;
    border:1px solid rgba(255,255,255,.08);
    border-radius:12px;
    padding:12px;
    font-size:14px;
    line-height:1.5;
    box-sizing:border-box;
    margin-top:10px;
    white-space:pre;
  `;

  const parent = transcriptEl?.parentElement || document.body;
  parent.insertBefore(txtBoxEl, transcriptEl);

  return txtBoxEl;
}

function updateTxtBox(){
  if (!isTxtMode) return;
  const box = ensureTxtBox();
  // Join cues line-by-line (no blank lines), preserve any internal line breaks
  const text = entries.map(e => String(e?.text ?? '').replace(/\r\n/g, "\n").trimEnd()).join("\n");
  box.value = text;
}

/** Build timecoded payload for the currently selected range in TXT box.
 *  If nothing is selected, copy all cues with timecodes.
 */
function buildTimecodedPayloadFromTxtSelection(){
  const f = getFPS();
  const box = ensureTxtBox();
  const a0 = box.selectionStart ?? 0;
  const b0 = box.selectionEnd ?? 0;
  const selStart = Math.min(a0, b0);
  const selEnd   = Math.max(a0, b0);

  // Map offsets to cues by reconstructing the same joined string offsets
  const blocks = [];
  let pos = 0;

  const hasSelection = selEnd > selStart;

  for (let i=0; i<entries.length; i++){
    const e = entries[i];
    const t = String(e?.text ?? '').replace(/\r\n/g, "\n").trimEnd();
    const start = pos;
    const end   = start + t.length;

    const include = !hasSelection || (Math.min(selEnd, end) > Math.max(selStart, start));
    if (include){
      let sliceText = t;
      if (hasSelection){
        const a = Math.max(selStart, start);
        const b = Math.min(selEnd, end);
        const relA = Math.max(0, a - start);
        const relB = Math.max(relA, b - start);
        sliceText = t.slice(relA, relB);
      }
      const inTc  = (typeof fmtTC === 'function') ? fmtTC(e.start, f) : formatTimecodeFromSeconds(e.start, f);
      const outTc = (typeof fmtTC === 'function') ? fmtTC(e.end,   f) : formatTimecodeFromSeconds(e.end,   f);
      blocks.push(`${inTc} --> ${outTc}\n${sliceText}`.trimEnd());
    }

    pos = end + 1; // + "\n"
  }

  return blocks.join("\n\n");
}

async function copyTextToClipboard(payload){
  if (!payload) return;
  try {
    await navigator.clipboard.writeText(payload);
  } catch {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = payload;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function ensureViewModeBar(){
  if (document.getElementById('viewModeBar')) return;

  // Styles once
  if (!document.getElementById('viewModeStyle')){
    const st = document.createElement('style');
    st.id = 'viewModeStyle';
    st.textContent = `
      .seg-toggle { display:inline-flex; background:#0e1116; border:1px solid rgba(255,255,255,.08); border-radius:10px; overflow:hidden }
      .seg-toggle .seg{ background:transparent; color:#e9edf1; border:0; padding:8px 12px; cursor:pointer; font-size:13px }
      .seg-toggle .seg.active{ background:#1a2230 }
      .txt-tools{ display:flex; gap:8px; align-items:center; }
      .txt-tools .btn{ height:34px; }
    `;
    document.head.appendChild(st);
  }

  const bar = document.createElement('div');
  bar.id = 'viewModeBar';
  bar.style.cssText = 'margin-top:8px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;';
  bar.innerHTML = `
    <div class="seg-toggle" role="group" aria-label="View Mode">
      <button id="btnModeSrt" class="seg active" type="button">SRT</button>
      <button id="btnModeTxt" class="seg" type="button">TXT</button>
    </div>
    <div class="txt-tools" id="txtTools" style="display:none">
      <button class="btn btn-outline" id="btnCopyTc" type="button">Copy with timecodes</button>
      <span style="opacity:.7;font-size:12px">Select text in the big box to copy a range (or copy all)</span>
    </div>
  `;

  // Insert under the Source TC bar if present, otherwise under the timecode panel container
  const anchorEl =
    document.getElementById('tcOriginBar') ||
    tcPanel?.parentElement ||
    player?.parentElement ||
    document.body;

  anchorEl.insertAdjacentElement('afterend', bar);

  const btnSrt = bar.querySelector('#btnModeSrt');
  const btnTxt = bar.querySelector('#btnModeTxt');
  const txtTools = bar.querySelector('#txtTools');
  const btnCopyTc = bar.querySelector('#btnCopyTc');

  const apply = () => {
    btnSrt.classList.toggle('active', !isTxtMode);
    btnTxt.classList.toggle('active',  isTxtMode);

    if (isTxtMode){
      ensureTxtBox();
      updateTxtBox();
      if (transcriptEl) transcriptEl.style.display = 'none';
      if (txtBoxEl) txtBoxEl.style.display = 'block';
      if (txtTools) txtTools.style.display = 'flex';
    } else {
      if (transcriptEl) transcriptEl.style.display = '';
      if (txtBoxEl) txtBoxEl.style.display = 'none';
      if (txtTools) txtTools.style.display = 'none';
    }
  };

  btnSrt.addEventListener('click', () => { isTxtMode = false; apply(); });
  btnTxt.addEventListener('click', () => { isTxtMode = true;  apply(); });

  btnCopyTc.addEventListener('click', async () => {
    // Ensure latest edits are captured before building payload
    try { flushEditsFromDOM(); } catch {}
    const payload = buildTimecodedPayloadFromTxtSelection();
    await copyTextToClipboard(payload);
  });

  apply();
}


/* ---------- Local Backend (faster-whisper) Integration ---------- */
const API_BASE = (window.API_BASE || 'http://127.0.0.1:8000');
// Global rerender() helper (used by AI Check and some UI ops)
window.rerender = function rerender(){
  try{
    if (typeof renderBySubsMode === 'function') renderBySubsMode();
    else if (typeof applySubsMode === 'function'){
      const mode = document.getElementById('subsMode')?.value || 'A';
      applySubsMode(mode);
    }
    if (typeof applyAllLocks === 'function') applyAllLocks();
    else if (typeof refreshLockUI === 'function') refreshLockUI();
  }catch(e){
    console.error('rerender() failed:', e);
  }
};


// app.js may not have a setStatus() helper. Provide a safe one for the whisper integration.
function setStatusSafe(message){
  try{
    if (typeof statusEl !== 'undefined' && statusEl){
      statusEl.textContent = String(message);
      return;
    }
  }catch(_e){}
  const el = document.getElementById('statusText') || document.getElementById('status') || document.getElementById('statusPill');
  if (el) el.textContent = String(message);
}

// Keep backward-compat with earlier patches that called setStatus(...)
function setStatus(a, b){
  // allow setStatus("Ready") or setStatus("ok","Ready")
  const msg = (typeof b === 'string') ? b : a;
  setStatusSafe(msg);
}

let __progTimer = null;
function progressStart(label){
  const bar  = document.getElementById('whisperProgBar');
  const txt  = document.getElementById('whisperProgTxt');
  if (bar) bar.style.width = "0%";
  if (txt) txt.textContent = "0%";
  if (label) setStatusSafe(label);
}
function progressDone(ok=true){
  const bar  = document.getElementById('whisperProgBar');
  const txt  = document.getElementById('whisperProgTxt');
  if (__progTimer) { clearInterval(__progTimer); __progTimer = null; }
  if (bar && txt){
    bar.style.width = "100%";
    txt.textContent = "100%";
    setTimeout(() => {
      bar.style.width = "0%";
      txt.textContent = "0%";
    }, 900);
  }

// Alias for older/newer code paths
function progressEnd(ok=true){
  return progressDone(ok);
}

}

async function pollJob(jobId){
  const url = `${API_BASE}/api/job/${jobId}`;
  while (true){
    const res = await fetch(url, {method:'GET'});
    if (!res.ok){
      const t = await res.text().catch(()=> '');
      throw new Error(`Job status HTTP ${res.status} ${t}`);
    }
    const st = await res.json();
    const p = Math.max(0, Math.min(1, Number(st.progress ?? 0)));
    const bar = document.getElementById('whisperProgBar');
    const txt = document.getElementById('whisperProgTxt');
    if (bar) bar.style.width = (p*100).toFixed(1) + "%";
    if (txt) txt.textContent = Math.round(p*100) + "%";
    if (st.message) setStatusSafe(st.message);

    if (st.done){
      if (st.error) throw new Error(st.error);
      return st;
    }
    await new Promise(r => setTimeout(r, 350));
  }
}

async function fetchJobResult(jobId){
  const res = await fetch(`${API_BASE}/api/job/${jobId}/result`, {method:'GET'});
  if (!res.ok){
    const t = await res.text().catch(()=> '');
    throw new Error(`Job result HTTP ${res.status} ${t}`);
  }
  return await res.json();
}


function ensureWhisperBar(){
  if (document.getElementById('whisperBar')) return;

  if (!document.getElementById('whisperBarStyle')){
    const st = document.createElement('style');
    st.id = 'whisperBarStyle';
    st.textContent = `
      .whisperbar{
        margin-top:8px; padding:10px; display:flex; flex-wrap:wrap; gap:10px; align-items:center;
        background:#0e1116; border:1px solid rgba(255,255,255,.06); border-radius:10px; color:#fff;
      }
      .whisperbar .ui-dark-input{ height:35px; }
      .whisperbar textarea{
        width:100%; min-height:140px; resize:vertical;
        background:#0e1116; color:#e9edf1; border:1px solid rgba(255,255,255,.08);
        border-radius:12px; padding:10px; font-size:13px; line-height:1.5;
      }
      .whisperbar .row2{ width:100%; display:flex; gap:10px; flex-wrap:wrap; align-items:flex-start; }
      .whisperbar .muted{ opacity:.75; font-size:12px; }
      .vbadge{ display:inline-block; margin-left:8px; padding:2px 8px; border-radius:999px; font-size:11px; line-height:1.6; border:1px solid rgba(255,255,255,.18); opacity:.95 }
      .vbadge.ok{ background:rgba(46,204,113,.18); }
      .vbadge.bad{ background:rgba(255,99,71,.18); }
      .abdg{ display:inline-block; margin-left:6px; padding:2px 7px; border-radius:999px; font-size:10px; line-height:1.6; border:1px solid rgba(255,255,255,.18); opacity:.95 }
      .abdg.multi{ background:rgba(255,193,7,.22); }
      .abdg.none{ background:rgba(255,99,71,.22); }
      .abdg.drift{ background:rgba(52,152,219,.22); }
    `;
    document.head.appendChild(st);
  }

  const bar = document.createElement('div');
  bar.id = 'whisperBar';
  bar.className = 'whisperbar';

  bar.innerHTML = `
    <button class="btn btn-gold" id="btnTranscribe" type="button">Transcribe</button>
    <button class="btn btn-outline" id="btnAnalyze" type="button">Align-To-Audio</button>
    <button class="btn btn-outline" id="btnAlignSrt" type="button">Align-To-SRT</button>
    <button class="btn btn-outline" id="btnAICheck" type="button">AI Check</button>
    <select id="aiCheckMode" class="ai-mode">
      <option value="semantic" selected>Semantic</option>
      <option value="anchor">Anchor Drift</option>
    </select>
    <div id="aiAnchorFilters" class="ai-filters" title="Anchor filters (used in Anchor Drift mode)">
      <label><input type="checkbox" id="aiFNum" checked>Num</label>
      <label><input type="checkbox" id="aiFAcr" checked>Acr</label>
      <!-- handles/hashtags filter removed -->
      <label><input type="checkbox" id="aiFKey" checked>Key</label>
      <button class="btn btn-mini" id="btnKeyTerms" type="button" title="Set custom key terms for Anchor Drift">Key Terms…</button>
      <span class="muted" id="keyTermsBadge" style="margin-left:2px;"></span>
    </div>
    <span class="muted">Backend: <span id="apiBaseLbl"></span></span>
    <div style="flex:1; min-width:220px; display:flex; align-items:center; gap:8px;">
      <div id="whisperProgWrap" style="flex:1; height:8px; background:rgba(255,255,255,.10); border-radius:999px; overflow:hidden; border:1px solid rgba(255,255,255,.08);">
        <div id="whisperProgBar" style="height:100%; width:0%; background:rgba(255,215,0,.9);"></div>
      </div>
      <span class="muted" id="whisperProgTxt">0%</span>
    </div>

    <div class="row2">
      <textarea id="alignSrtText" placeholder="Paste subtitle lines here (one line per cue)…"></textarea>
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <label class="muted" style="display:flex;align-items:center;gap:6px">
          Model
          <input id="whisperModel" class="ui-dark-input" type="text" value="large-v3" style="width:120px">
        </label>
        <label class="muted" style="display:flex;align-items:center;gap:6px">
          Device
          <select id="whisperDevice" class="ui-dark-select">
            <option value="auto" selected>auto</option>
            <option value="cuda">cuda</option>
            <option value="cpu">cpu</option>
          </select>
        </label>
        <label class="muted" style="display:flex;align-items:center;gap:6px">
          Compute
          <select id="whisperCompute" class="ui-dark-select">
            <option value="auto" selected>auto</option>
            <option value="float16">float16</option>
            <option value="int8_float16">int8_float16</option>
            <option value="int8">int8</option>
          </select>
        </label>
        <label class="muted" style="display:flex;align-items:center;gap:6px">
          Language
          <select id="whisperLang" class="ui-dark-select">
            <option value="auto" selected>auto</option>
            <option value="zh">zh</option>
            <option value="en">en</option>
            <option value="ja">ja</option>
            <option value="ko">ko</option>
            <option value="fr">fr</option>
            <option value="de">de</option>
            <option value="es">es</option>
          </select>
        </label>
      </div>
    </div>
  `;

  const anchorEl =
    document.getElementById('viewModeBar') ||
    document.getElementById('tcOriginBar') ||
    tcPanel?.parentElement ||
    player?.parentElement ||
    document.body;

  anchorEl.insertAdjacentElement('afterend', bar);

  document.getElementById('apiBaseLbl').textContent = API_BASE

  // Show anchor filters only in Anchor Drift mode
  const _aiModeEl = document.getElementById('aiCheckMode');
  const _aiFiltEl = document.getElementById('aiAnchorFilters');
  const _syncAiFilterVis = () => {
    if (!_aiFiltEl) return;
    const m = (_aiModeEl?.value || 'semantic').toLowerCase();
    _aiFiltEl.style.display = (m === 'anchor') ? 'flex' : 'none';
  };
  _aiModeEl?.addEventListener('change', _syncAiFilterVis);
  _syncAiFilterVis();;

  // Key Terms modal
  ensureKeyTermsModal();
  const _ktBtn = document.getElementById('btnKeyTerms');
  const _ktBadge = document.getElementById('keyTermsBadge');
  const refreshKtBadge = () => {
    const kt = loadKeyTerms();
    const n = (kt.en.length + kt.zh.length);
    if (_ktBadge) _ktBadge.textContent = n ? `(${n})` : '';
  };
  refreshKtBadge();
  _ktBtn?.addEventListener('click', () => {
    openKeyTermsModal({ onSave: refreshKtBadge });
  });

  document.getElementById('btnTranscribe').addEventListener('click', () => {
    transcribeWithBackend().catch(err => {
      console.error(err);
      alert('Transcribe failed: ' + (err?.message || err));
    });
  });

  document.getElementById('btnAnalyze').addEventListener('click', () => {
    analyzeAlignWithBackend().catch(err => {
      console.error(err);
      alert('Align-To-Audio failed: ' + (err?.message || err));
    });
  });

  document.getElementById('btnAlignSrt').addEventListener('click', () => {
    alignToSrtMappingOnly().catch(err => {
      console.error(err);
      alert('Align-To-SRT failed: ' + (err?.message || err));
    });
  });

  document.getElementById('btnAICheck').addEventListener('click', () => {
    aiCheckAlignment().catch(err => {
      console.error(err);
      alert('AI Check failed: ' + (err?.message || err));
    });
  });

}

// -----------------------------
// Key Terms (AI Check - Anchor Drift)
// -----------------------------
const KEYTERMS_LS_KEY = 'ai_key_terms_v1';

function parseTerms(text){
  if (!text) return [];
  return String(text)
    .split(/[\n,;，；]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .slice(0, 200);
}

function loadKeyTerms(){
  try{
    const raw = localStorage.getItem(KEYTERMS_LS_KEY);
    if (!raw) return { en: [], zh: [], rawEn: '', rawZh: '' };
    const obj = JSON.parse(raw);
    const rawEn = String(obj?.rawEn || '');
    const rawZh = String(obj?.rawZh || '');
    return { en: parseTerms(rawEn), zh: parseTerms(rawZh), rawEn, rawZh };
  }catch{
    return { en: [], zh: [], rawEn: '', rawZh: '' };
  }
}

function saveKeyTerms(rawEn, rawZh){
  const payload = { rawEn: String(rawEn||''), rawZh: String(rawZh||''), savedAt: Date.now() };
  localStorage.setItem(KEYTERMS_LS_KEY, JSON.stringify(payload));
}

function ensureKeyTermsModal(){
  if (document.getElementById('keyTermsModal')) return;
  const wrap = document.createElement('div');
  wrap.id = 'keyTermsModal';
  wrap.className = 'modal-overlay hidden';
  wrap.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="ktTitle">
      <div class="modal-head">
        <div>
          <div id="ktTitle" class="modal-title">AI Check Key Terms</div>
          <div class="modal-sub">Used by <b>Anchor Drift</b> mode to catch drift around names, topics, places, products, jargon, etc.</div>
        </div>
        <button class="btn btn-outline btn-mini" id="ktClose" type="button" aria-label="Close">✕</button>
      </div>

      <div class="modal-body">
        <div class="kt-grid">
          <div>
            <label class="muted">English key terms (comma or new line separated)</label>
            <textarea id="ktEn" class="ui-dark-textarea" placeholder="e.g.\nOpenAI\nTeLEOS-2\nSingapore\nIMF\nGDP"></textarea>
          </div>
          <div>
            <label class="muted">中文关键词（逗号或换行分隔）</label>
            <textarea id="ktZh" class="ui-dark-textarea" placeholder="例如：\n卫星\n火箭\n新加坡\n通胀\n选举"></textarea>
          </div>
        </div>
        <div class="muted" style="margin-top:10px; line-height:1.5;">
          Tip: If you want 1-to-1 mapping, put the <i>same number of lines</i> in both boxes (line 1 EN ↔ line 1 中文, etc.).
        </div>
      </div>

      <div class="modal-foot">
        <button class="btn btn-outline" id="ktClear" type="button">Clear</button>
        <div style="flex:1"></div>
        <button class="btn btn-gold" id="ktSave" type="button">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  // basic close behaviors
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) closeKeyTermsModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !wrap.classList.contains('hidden')) closeKeyTermsModal();
  });
}

let _ktOnSaveCb = null;
function openKeyTermsModal(opts={}){
  const wrap = document.getElementById('keyTermsModal');
  if (!wrap) return;
  _ktOnSaveCb = (typeof opts.onSave === 'function') ? opts.onSave : null;

  const kt = loadKeyTerms();
  const enEl = document.getElementById('ktEn');
  const zhEl = document.getElementById('ktZh');
  if (enEl) enEl.value = kt.rawEn || '';
  if (zhEl) zhEl.value = kt.rawZh || '';

  // wire buttons (idempotent)
  const closeBtn = document.getElementById('ktClose');
  const saveBtn = document.getElementById('ktSave');
  const clearBtn = document.getElementById('ktClear');
  closeBtn && (closeBtn.onclick = () => closeKeyTermsModal());
  clearBtn && (clearBtn.onclick = () => {
    if (enEl) enEl.value = '';
    if (zhEl) zhEl.value = '';
  });
  saveBtn && (saveBtn.onclick = () => {
    saveKeyTerms(enEl?.value || '', zhEl?.value || '');
    closeKeyTermsModal();
    if (_ktOnSaveCb) _ktOnSaveCb();
  });

  wrap.classList.remove('hidden');
  setTimeout(() => { enEl?.focus?.(); }, 50);
}

function closeKeyTermsModal(){
  const wrap = document.getElementById('keyTermsModal');
  if (!wrap) return;
  wrap.classList.add('hidden');
}

function getLoadedMediaFile(){
  const f = fileInput?.files?.[0];
  if (!f){
    alert('Load a video/audio file first.');
    return null;
  }
  return f;
}

function getWhisperSettings(){
  const model = document.getElementById('whisperModel')?.value?.trim() || 'large-v3';
  const device = document.getElementById('whisperDevice')?.value || 'auto';
  const compute = document.getElementById('whisperCompute')?.value || 'auto';
  const language = document.getElementById('whisperLang')?.value || 'auto';
  return { model, device, compute, language };
}

async function transcribeWithBackend(){  try {

  const media = getLoadedMediaFile();
  if (!media) return;

  const { model, device, compute, language } = getWhisperSettings();
  progressStart('Transcribing…');

  const fd = new FormData();
  fd.append('media', media, media.name);
  fd.append('model', model);
  fd.append('device', device);
  fd.append('compute_type', compute);
  fd.append('language', language);
  fd.append('word_timestamps', 'true');
  fd.append('vad_filter', 'true');

  const res = await fetch(`${API_BASE}/api/transcribe_start`, { method:'POST', body: fd });
  if (!res.ok){
    const msg = await res.text().catch(()=> '');
    throw new Error(`HTTP ${res.status} ${msg}`);
  }
  const startResp = await res.json();
  const jobId = startResp?.job_id;
  if (!jobId) throw new Error('No job_id returned');
  await pollJob(jobId);
  const data = await fetchJobResult(jobId);

  const srtText = data?.srt || '';
  if (!srtText.trim()){
    setStatus('No SRT returned');
    return;
  }

  const parsed = parseSRT(srtText);

  // Sub A (Original) receives Transcribe output by default.
  initialEntries = parsed.map((e, idx) => ({ start:e.start, end:e.end, text:e.text, index:idx }));
  entries = parsed.map((e, idx) => ({
    start:e.start, end:e.end, text:e.text,
    orig:{ start:e.start, end:e.end, text:e.text }, origIndex: idx
  }));

  // Keep Sub B (Translation) untouched; if empty, create an aligned empty track.
  if (!entriesB?.length){
    entriesB = parsed.map((e) => ({ start:e.start, end:e.end, text:'' }));
    initialEntriesB = entriesB.map((e) => ({ start:e.start, end:e.end, text:e.text }));
  }
  renderTranscript();
  if (isDualMode) renderTranscriptB();
  progressDone(true);

  const box = document.getElementById('alignSrtText');
  if (box && !box.value.trim()) box.value = srtText;

  statusEl.textContent = `Transcribed ${entries.length} captions (model: ${data?.model || model})`;
  setStatus('Ready');
  } finally {
    // If an error happened, the caller alert will fire; still stop the progress animation.
    progressDone(false);
  }
}

async function analyzeAlignWithBackend(){  try {

  const media = getLoadedMediaFile();
  if (!media) return;

  const srtText = document.getElementById('alignSrtText')?.value || '';
  if (!srtText.trim()){
    alert('Paste SRT text to align first.');
    return;
  }

  const { model, device, compute, language } = getWhisperSettings();
  progressStart('Analyzing & aligning…');

  const fd = new FormData();
  fd.append('media', media, media.name);
  fd.append('text', srtText);
  fd.append('model', model);
  fd.append('device', device);
  fd.append('compute_type', compute);
  fd.append('language', language);
  fd.append('word_timestamps', 'true');
  fd.append('vad_filter', 'true');

  const res = await fetch(`${API_BASE}/api/align_start`, { method:'POST', body: fd });
  if (!res.ok){
    const msg = await res.text().catch(()=> '');
    throw new Error(`HTTP ${res.status} ${msg}`);
  }
  const startResp = await res.json();
  const jobId = startResp?.job_id;
  if (!jobId) throw new Error('No job_id returned');
  await pollJob(jobId);
  const data = await fetchJobResult(jobId);

  const alignedSrt = data?.aligned_srt || '';
  if (!alignedSrt.trim()){
    setStatus('No aligned SRT returned');
    return;
  }

  const parsed = parseSRT(alignedSrt);

  // Sub A (Original) receives Align-To-Audio output by default.
  initialEntries = parsed.map((e, idx) => ({ start:e.start, end:e.end, text:e.text, index:idx }));
  entries = parsed.map((e, idx) => ({
    start:e.start, end:e.end, text:e.text,
    orig:{ start:e.start, end:e.end, text:e.text }, origIndex: idx
  }));

  // Keep Sub B (Translation) untouched; if empty, create an aligned empty track.
  if (!entriesB?.length){
    entriesB = parsed.map((e) => ({ start:e.start, end:e.end, text:'' }));
    initialEntriesB = entriesB.map((e) => ({ start:e.start, end:e.end, text:e.text }));
  }
  renderTranscript();
  if (isDualMode) renderTranscriptB();
  progressDone(true);

  document.getElementById('alignSrtText').value = alignedSrt;

  const low = (data?.stats?.low_confidence ?? 0);
  const total = (data?.stats?.total ?? entries.length);
  statusEl.textContent = `Aligned ${entries.length} captions (low confidence: ${low}/${total})`;
  setStatus('Ready');

  const firstLow = data?.first_low_index;
  if (typeof firstLow === 'number' && firstLow >= 0){
    suppressAutoScrollUntil = nowMs() + 800;
    holdManualSelection(firstLow, 4000);
    selectRow(firstLow, {scroll:true});
  }
  } finally {
    // If an error happened, the caller alert will fire; still stop the progress animation.
    progressDone(false);
  }
}


async function verifySrtWithBackend(srtText){
  const media = getLoadedMediaFile();
  if (!media) return null;
  const { model, device, compute, language } = getWhisperSettings();

  const fd = new FormData();
  fd.append('media', media, media.name);
  fd.append('srt', srtText);
  fd.append('model', model);
  fd.append('device', device);
  fd.append('compute_type', compute);
  fd.append('language', language); // auto by default; dropdown overrides
  fd.append('word_timestamps', 'true');
  fd.append('vad_filter', 'true');

  const res = await fetch(`${API_BASE}/api/verify_srt_start`, { method:'POST', body: fd });
  if (!res.ok){
    const msg = await res.text().catch(()=> '');
    throw new Error(`HTTP ${res.status} ${msg}`);
  }
  const startResp = await res.json();
  const jobId = startResp?.job_id;
  if (!jobId) throw new Error('No job_id returned');
  await pollJob(jobId);
  return await fetchJobResult(jobId);
}

function applyVerifyScoresToEntries(scores){
  if (!Array.isArray(scores)) return;
  // scores: [{index:1-based, score:0..1, ok:boolean}]
  const byIdx = new Map(scores.map(s => [Number(s.index), s]));
  for (let i=0;i<entries.length;i++){
    const s = byIdx.get(i+1);
    entries[i].verifyScore = s ? Number(s.score) : null;
    entries[i].verifyOk = s ? !!s.ok : true;
  }
}


async function aiCheckAlignment(){
  const mode = (document.getElementById('aiCheckMode')?.value || 'semantic').toLowerCase();

  if (!entries?.length){
    alert('No SRT A cues loaded. Import/Transcribe/Align-To-Audio first (goes to Sub A).');
    return;
  }
  if (!entriesB?.length){
    alert('No SRT B cues loaded. Use Align-To-SRT or import into Sub B first.');
    return;
  }

  // clear previous badges
  for (const e of entries){ delete e.aiWarn; delete e.aiDetail; }
  for (const e of entriesB){ delete e.aiWarn; delete e.aiDetail; }

  const payloadBase = {
    cuesA: entries.map(e => ({ start: Number(e.start||0), end: Number(e.end||0), text: String(e.text||'') })),
    cuesB: entriesB.map(e => ({ start: Number(e.start||0), end: Number(e.end||0), text: String(e.text||'') })),
  };

  try{
    if (mode === 'anchor'){
      statusEl.textContent = 'AI Check: anchor drift (numbers/entities/keywords)…';
      progressStart('AI Check…');

      // user-provided key terms (optional)
      const kt = loadKeyTerms();

      const payload = Object.assign({}, payloadBase, {
        // knobs (can be tuned later / exposed to UI)
        max_index_delta: 12,
        low_risk_delta: 1,
        high_risk_delta: 2,
        // anchor filters
        use_numbers: (document.getElementById('aiFNum')?.checked ?? true),
        use_acronyms: (document.getElementById('aiFAcr')?.checked ?? true),
        // handles/hashtags anchors removed
        use_keyterms: (document.getElementById('aiFKey')?.checked ?? true),
        key_terms_en: kt?.en || [],
        key_terms_zh: kt?.zh || []
      });

      const res = await fetch(`${API_BASE}/api/ai_check_anchor_drift`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json().catch(() => ({}));
      progressDone(true);

      if (!res.ok || !data?.ok){
        const msg = data?.detail || data?.message || ('HTTP ' + res.status);
        alert('AI Check failed: ' + msg);
        return;
      }

      // Apply per-line anchor pairing result (labels: MATCH / +1 Drift / >1 Drift / NO ANCHOR / NO MATCH)
      const summary = data.summary || null;
      if (summary){
        statusEl.textContent = `AI Check (Anchor): match ${(summary.match_rate*100).toFixed(1)}% | drift ${(summary.drift_rate*100).toFixed(1)}% (anchored ${summary.total_anchored})`;
      }

      for (const r of (data.per_line || [])){
        const a = entries[r.a_index];
        if (!a) continue;

        const label = String(r.label || '').trim();
        const delta = Number(r.delta ?? 0);
        const anchor = r.anchor ? String(r.anchor) : '';
        const bIdx = (typeof r.b_index === 'number') ? r.b_index : null;
        const spec = (typeof r.spec === 'number') ? r.spec : null;

        if (label === 'MATCH'){
          a.aiWarn = 'match';
          a.aiDetail = `MATCH` + (anchor?` (anchor: ${anchor})`:'');
        } else if (label === '+1 Drift'){
          a.aiWarn = 'low';
          a.aiDetail = `+1 Drift: B${delta>=0?'+':''}${delta}` + (anchor?` (anchor: ${anchor})`:'');
        } else if (label === '>1 Drift'){
          a.aiWarn = 'high';
          a.aiDetail = `>1 Drift: B${delta>=0?'+':''}${delta}` + (anchor?` (anchor: ${anchor})`:'');
        } else if (label === 'NO ANCHOR'){
          // No badge when no anchor applies
          continue;
        } else if (label === 'NO MATCH'){
          // No badge when no match applies
          continue;
        } else {
          a.aiWarn = 'check';
          a.aiDetail = label || 'CHECK';
        }

        if (spec != null){
          a.aiDetail += ` [spec ${(spec).toFixed(2)}]`;
        }

        if (bIdx != null && entriesB[bIdx]){
          const b = entriesB[bIdx];
          // mirror the label onto the matched B row
          if (a.aiWarn === 'high') { b.aiWarn = 'high'; }
          else if (a.aiWarn === 'low') { b.aiWarn = 'low'; }
          else if (a.aiWarn === 'match') { b.aiWarn = 'match'; }
          else { b.aiWarn = a.aiWarn; }
          b.aiDetail = a.aiDetail;
        }
      }

renderBySubsMode();
      if (typeof applyAllLocks === 'function') applyAllLocks();
      const wr = data?.summary?.worst_run;
      if (wr && wr.length >= 2){
        statusEl.textContent = `AI Check (Anchor): highest-risk run A${wr.start+1}–A${wr.end+1} (len ${wr.length})`;
      } else {
        statusEl.textContent = 'AI Check (Anchor): no >1 drift runs detected.';
      }
      return;
    }

    // --- semantic/hybrid check (existing) ---
    const payload = Object.assign({}, payloadBase, {
      model_name: (window.AI_SEMANTIC_MODEL || 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'),
      device: (window.AI_SEMANTIC_DEVICE || 'auto'),
      batch_size: 64
    });

    statusEl.textContent = 'AI Check: semantic compare A ↔ B…';
    progressStart('AI Check…');

    const res = await fetch(`${API_BASE}/api/ai_check_semantic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    progressDone(true);

    if (!res.ok || !data?.ok){
      const msg = data?.detail || data?.message || ('HTTP ' + res.status);
      alert('AI Check failed: ' + msg);
      return;
    }

    const matchedB = new Set();
    for (const r of (data.resultsA || [])){
      const a = entries[r.a_index];
      if (!a) continue;

      const bIdx = (typeof r.b_index === 'number') ? r.b_index : null;
      const label = String(r.label || '').toUpperCase();
      const sim = Number(r.similarity ?? 0);
      const score = Number(r.match_score ?? 0);
      const reasons = Array.isArray(r.reasons) ? r.reasons : [];

      const rs = reasons.length ? (' | ' + reasons.join(',')) : '';
      const note = `score ${(score*100).toFixed(0)}% | sim ${(sim*100).toFixed(0)}%`;

      if (label === 'MATCH'){
        a.aiWarn = 'match';
        a.aiDetail = 'MATCH: ' + note + rs;
      } else if (label === 'MISS'){
        a.aiWarn = 'none';
        a.aiDetail = 'MISS: ' + note + rs;
      } else {
        a.aiWarn = 'check';
        a.aiDetail = 'CHECK: ' + note + rs;
      }

      if (bIdx != null){
        matchedB.add(bIdx);
        const b = entriesB[bIdx];
        if (b){
          b.aiWarn = a.aiWarn;
          b.aiDetail = a.aiDetail;
        }
      }
    }

    renderBySubsMode();
    if (typeof applyAllLocks === 'function') applyAllLocks();
    statusEl.textContent = `AI Check: done (${(data.resultsA||[]).length} lines).`;
  } catch (err){
    progressDone(false);
    console.error(err);
    alert('AI Check failed: ' + (err?.message || err));
  }
}




async function alignToSrtMappingOnly(){
  // Align-To-SRT:
  // - SRT A (Original) lives in `entries` and is NEVER modified here.
  // - We write the aligned/mapped lines into SRT B (Translation) `entriesB`,
  //   matching A by index and inheriting A timings.

  if (!entries?.length){
    alert('No SRT cues in Sub A (Original). Import/Transcribe/Align-To-Audio first.');
    return;
  }

  flushEditsFromDOM(); // flush A edits only (Sub A uses transcriptEl)

  const raw = document.getElementById('alignSrtText')?.value ?? '';
  const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(s => s.length > 0);
  if (!lines.length){
    alert('Paste subtitle lines first.');
    return;
  }

  const n = Math.max(entries.length, lines.length);

  const out = [];
  for (let i=0;i<n;i++){
    const a = entries[i];
    const start = a ? a.start : ((out[i-1]?.end ?? 0) + 0.01);
    const end   = a ? a.end   : (start + 0.9);
    out.push({ start, end, text: lines[i] ?? '' });
  }

  entriesB = out;
  initialEntriesB = entriesB.map((e) => ({ start:e.start, end:e.end, text:e.text }));

  // Badge headers (Original/Translation)
  setDualBadges(true);

  // Re-render depending on view mode
  renderBySubsMode();
  statusEl.textContent = `Mapped ${lines.length} line(s) into Sub B (Translation). Sub A (Original) unchanged.`;
}



/* ---------- Resizable center divider ---------- */
function setupCenterDivider(){
  const wrap = document.querySelector('main.wrap') || document.querySelector('.wrap');
  const divider = document.getElementById('panelDivider');
  const videoPanel = document.querySelector('.video-panel');
  if (!wrap || !divider || !videoPanel) return;

  // Restore previous split
  const saved = localStorage.getItem('panelSplitPx');
  if (saved && /^[0-9]+$/.test(saved)){
    wrap.style.setProperty('--videoW', `${saved}px`);
  }

  let dragging = false;
  let startX = 0;
  let startW = 0;
  const MIN_PX = 320;

  divider.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = videoPanel.getBoundingClientRect().width;
    document.body.classList.add('resizing');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const wrapW = wrap.getBoundingClientRect().width;
    const maxW = Math.max(MIN_PX, wrapW - MIN_PX);
    const newW = Math.max(MIN_PX, Math.min(startW + dx, maxW));
    wrap.style.setProperty('--videoW', `${newW}px`);
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('resizing');
    const w = Math.round(videoPanel.getBoundingClientRect().width);
    localStorage.setItem('panelSplitPx', String(w));
  });
}


/* ---------- Init ---------- */
function init(){
  tcFps.textContent = fps;
  requestAnimationFrame(updateLiveTimecode);

  // SUBS dropdown (default: Sub A).
  const subsSel = document.getElementById('subsMode');
  if (subsSel){
    subsSel.value = 'A';
    subsSel.addEventListener('change', () => applySubsMode(subsSel.value));
  }
  applySubsMode('A');

  ensureContextMenu();
  ensureStyleControls();
  ensureFindReplaceBar();
  ensureTcOriginBar();
  ensureViewModeBar();
  ensureWhisperBar();
  setupCenterDivider();
}
init();
