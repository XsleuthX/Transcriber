
import { parseSRT, parseVTT, parseAuto, toSRT } from './srt.js';

/* DOM */
const fileInput   = document.getElementById('fileInput');
const srtInput    = document.getElementById('srtInput'); // legacy (kept for compatibility)
const player      = document.getElementById('player');
let lastLoadedVideoFile = null;
let currentMediaSource = { type: 'local', file: null, cacheId: null }; // local | youtube | drive; local/drive may include cacheId
let VIEW_ONLY_SESSION = false;
let EDITOR_SHARED_SESSION = false;
let CURRENT_SHARE_SESSION_ID = null;
let COLLAB_SESSION_ID = null;
let COLLAB_USER_ID = null;
let COLLAB_USER_LABEL = null;
let COLLAB_USER_COLOR = '#4f8cff';
let COLLAB_USERS = [];
let COLLAB_REMOTE_CUES = {};
let COLLAB_REMOTE_CARETS = {};
let COLLAB_REMOTE_TXT = {};
let COLLAB_REMOTE_STORY = {};
let COLLAB_STORY_LOCKS = {};
let COLLAB_STORY_LAST_CURSOR_MS = 0;
let COLLAB_STORY_LOCKED_CARD_ID = '';
let COLLAB_STORY_LOCK_LAST_SEND_MS = 0;
let COLLAB_STORY_AWARENESS_TIMER = null;
let COLLAB_STORY_DEFERRED_ROWS = null;
let COLLAB_STORY_DEFERRED_TIMER = null;
let COLLAB_REMOTE_LOCKS = {};
let COLLAB_COMMENTS = {};
let COLLAB_COMMENT_POPOVER = null;
let COLLAB_TXT_TYPING = {};
let COLLAB_FOLLOW_USER_ID = '';
let COLLAB_PLAYHEAD_LAST_SEND_MS = 0;
let COLLAB_LAST_REMOTE_PLAYHEAD_MS = 0;
let COLLAB_PROFILE_POPOVER_OPEN = false;
let COLLAB_REVISION = 0;
let COLLAB_TIMER = null;
let COLLAB_LAST_HASH = '';
let COLLAB_APPLYING = false;
let COLLAB_WS = null;
let COLLAB_WS_CONNECTED = false;
let COLLAB_WS_TIMER = null;
let COLLAB_WS_RECONNECT_TIMER = null;
let COLLAB_WS_RECONNECT_ATTEMPTS = 0;
let COLLAB_WS_LAST_SEND_MS = 0;
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
      if (isTxtMode && typeof renderTxtBySubsMode === 'function') renderTxtBySubsMode();
      else {
        renderTranscript();
        if (document.getElementById('subsMode')?.value === 'DUAL') renderTranscriptB();
      }
    });
  }
  if (btnLockB){
    btnLockB.addEventListener('click', () => {
      lockedB = !lockedB;
      refreshLockUI();
      if (isTxtMode && typeof renderTxtBySubsMode === 'function') renderTxtBySubsMode();
      else {
        applyLockState('B');
        if (document.getElementById('subsMode')?.value === 'DUAL') {
          renderTranscriptB(document.getElementById('transcriptB'));
        }
      }
    });
  }
  if (btnLockSingle){
    btnLockSingle.addEventListener('click', () => {
      const mode = (document.getElementById('subsMode')?.value || 'A');
      if (mode === 'B') lockedB = !lockedB;
      else lockedA = !lockedA;
      refreshLockUI();
      if (isTxtMode && typeof renderTxtBySubsMode === 'function') renderTxtBySubsMode();
      else if (mode === 'B') renderTranscriptB();
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
  if (isTxtMode && typeof renderTxtBySubsMode === 'function'){
    renderTxtBySubsMode();
    try{ storyRetryPendingStoryRelinksAfterCueLoad?.({ render:isStoryMode }); }catch(_e){}
    return;
  }
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
    try{ storyRetryPendingStoryRelinksAfterCueLoad?.({ render:isStoryMode }); }catch(_e){}
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
  try{ storyRetryPendingStoryRelinksAfterCueLoad?.({ render:isStoryMode }); }catch(_e){}
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
    header.onclick = () => { seekMediaTo(Math.max(0, e.start) + 0.001, { play: true }); };

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
      seekMediaTo(startT, { play: false });
      holdManualSelection(i, 2000);
      selectRowIn('B', i, { scroll: false });
      sendCollabActiveCue('B', i);
    });
    textEl.addEventListener('focus', () => {
      holdManualSelection(i, 60000);
      selectRowIn('B', i, { scroll: false });
      sendCollabActiveCue('B', i);
      if (!isCueRemoteLocked('B', i)) sendCollabCueLock('B', i);
      try{ sendCollabCaret('B', i, getCaretOffset(textEl)); }catch(_e){}
    });
    textEl.addEventListener('blur', () => { sendCollabCueUnlock('B', i); });
    textEl.addEventListener('keyup', () => { try{ sendCollabCaret('B', i, getCaretOffset(textEl)); }catch(_e){} });


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
  try{ applyCollabCueAwareness(); }catch(_e){}

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
    header.onclick = () => { seekMediaTo(Math.max(0, e.start) + 0.001, { play: true }); };

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
      seekMediaTo(startT, { play: false });
      holdManualSelection(i, 2000);
      selectRow(i, { scroll: false });
      sendCollabActiveCue('A', i);
    });
    textEl.addEventListener('focus', () => {
      holdManualSelection(i, 60000);
      selectRow(i, { scroll: false });
      sendCollabActiveCue('A', i);
      if (!isCueRemoteLocked('A', i)) sendCollabCueLock('A', i);
      try{ sendCollabCaret('A', i, getCaretOffset(textEl)); }catch(_e){}
    });
    textEl.addEventListener('blur', () => { sendCollabCueUnlock('A', i); });
    textEl.addEventListener('keyup', () => { try{ sendCollabCaret('A', i, getCaretOffset(textEl)); }catch(_e){} });


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
  try{ applyCollabCueAwareness(); }catch(_e){}

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

  pauseMedia();
  seekMediaTo(isIn ? entries[index].start : entries[index].end, { play: false });

  updateRowUI(index);
  const seekT = isIn ? entries[index].start : entries[index].end;
  const active = getActiveIndex(getMediaCurrentTime());
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
  overlayEl.textContent = wrapSubtitleTextByChars(((list[idx]?.text) || '').trim(), getCaptionMaxChars());
  overlayEl.style.whiteSpace = 'pre-line';
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

function handleMediaTimeUpdate(t){
  t = Math.max(0, Number(t) || 0);
  const now = nowMs();

  // Overlay: forced in single modes, follows last interaction in dual
  if (subsMode === 'A') activeOverlayTrack = 'A';
  else if (subsMode === 'B') activeOverlayTrack = 'B';

  const overlayIdx = getActiveIndex(t, activeOverlayTrack);
  updateOverlay(overlayIdx, activeOverlayTrack);

  if (isTimelineMode){ try{ updateTimelinePlayhead(t); }catch(_e){} return; }
  if (isStoryMode){ try{ updateStoryPlaybackActiveState(t); }catch(_e){} return; }
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
}

player.addEventListener('timeupdate', () => {
  handleMediaTimeUpdate(player.currentTime);
});


/* ---------- Live timecode ---------- */
function updateLiveTimecode(){
  const t = (typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : (player?.currentTime || 0);
  tcPanel.textContent = fmtTC(t, getFPS());
  const p = tcPanel.parentElement;
  if (p && !p.classList.contains('tc-centered')) p.classList.add('tc-centered');
  requestAnimationFrame(updateLiveTimecode);
}

/* ---------- Imports ---------- */
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  lastLoadedVideoFile = f || null;
  if (!f) return;
  activateLocalMedia(f);
  // Auto-apply source TC when enabled (best-effort via filename; user can override in Source TC panel).
  const uiToggle = document.getElementById('toggleSourceTc');
  if (uiToggle && uiToggle.checked) {
    const tc = guessSourceTimecodeFromFilename((lastLoadedVideoFile||{}).name) || (document.getElementById('srcTcInput')?.value || '00:00:00:00');
    try { syncSourceTcUI(true, tc); } catch(_e) {}
  } else {
    try { syncSourceTcUI(false, document.getElementById('srcTcInput')?.value || '00:00:00:00'); } catch(_e) {}
  }

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
  try{ storyRetryPendingStoryRelinksAfterCueLoad?.({ render:isStoryMode, commit:true }); }catch(_e){}
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
  try{ storyRetryPendingStoryRelinksAfterCueLoad?.({ render:isStoryMode, commit:true }); }catch(_e){}
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
  const fontOptions = `
    <option>System</option><option>Inter</option><option>Roboto</option><option>Helvetica</option>
    <option>Arial</option><option>Georgia</option><option>Times New Roman</option>
    <option>Fira Sans</option><option>Monaco</option><option>Courier New</option>
    <option>SimSun</option><option>仿宋</option><option>微软雅黑</option>
    <option>新宋体</option><option>楷体</option><option>等线</option>
    <option>黑体</option><option>Noto Sans SC</option>`;

  if (!bar){
    const style = document.createElement('style');
    style.textContent = `
      .tc-centered{ display:flex; justify-content:center; align-items:center; gap:.75rem; text-align:center; }
      .stylebar{ margin-top:8px; padding:10px; display:block; width:100%; max-width:100%; overflow:visible; background:#0e1116; border:1px solid rgba(255,255,255,.06); border-radius:10px; color:#fff; box-sizing:border-box; }
      .font-settings-grid{ display:grid; grid-template-columns:minmax(300px,1fr) minmax(300px,1fr); gap:14px; align-items:start; width:100%; max-width:100%; }
      .font-settings-col{ display:flex; flex-direction:column; gap:10px; min-width:0; max-width:100%; padding:12px; border:1px solid rgba(255,255,255,.08); border-radius:12px; background:rgba(255,255,255,.035); overflow:hidden; box-sizing:border-box; }
      .font-settings-title{ font-size:12px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--ink-dim); }
      .stylebar label{ display:grid; grid-template-columns:78px minmax(0,1fr); align-items:center; gap:10px; font-size:12px; opacity:.9; width:100%; min-width:0; max-width:100%; box-sizing:border-box; }
      .stylebar label span{ min-width:0; overflow-wrap:anywhere; }
      .ui-dark-input, .ui-dark-select, .ui-dark-color{
        background:#131720; color:#fff; border:1px solid #2a2f3a; border-radius:6px; padding:6px 8px; height:35px; box-sizing:border-box;
      }
      .ui-dark-input, .ui-dark-select{ width:100%; min-width:0; max-width:100%; }
      .ui-dark-color{ padding:0; height:35px; width:44px; max-width:100%; justify-self:start; }
      #transcriptFindBar{ display:flex; gap:8px; align-items:center; padding:8px; border-bottom:1px solid rgba(255,255,255,.07); }
      #transcriptFindBar input[type="text"]{ min-width:180px }
      .text,.txt-line{ font-size:var(--cue-font-size, 14px); font-family:var(--cue-font-family, inherit); color:var(--cue-color, var(--ink)); }
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
      @media (max-width: 780px){ .font-settings-grid{ grid-template-columns:1fr; } }
    `;
    document.head.appendChild(style);

    bar = document.createElement('div');
    bar.id = 'videoStyleBar';
    bar.className = 'stylebar';
    bar.innerHTML = `
      <div class="font-settings-grid">
        <div class="font-settings-col" id="captionFontColumn">
          <div class="font-settings-title">Captions</div>
          <label><span>Size</span><input id="capSize" class="ui-dark-input" type="number" min="10" max="96" value="28"></label>
          <label><span>Family</span><select id="capFamily" class="ui-dark-select">${fontOptions}</select></label>
          <label><span>Color</span><input id="capColor" class="ui-dark-color" type="color" value="#ffffff"></label>
        </div>
        <div class="font-settings-col" id="cueFontColumn">
          <div class="font-settings-title">Cues</div>
          <label><span>Size</span><input id="cueSize" class="ui-dark-input" type="number" min="10" max="40" value="14"></label>
          <label><span>Family</span><select id="cueFamily" class="ui-dark-select">${fontOptions}</select></label>
          <label><span>Color</span><input id="cueColor" class="ui-dark-color" type="color" value="#e7ecf3"></label>
        </div>
      </div>
    `;
    const tcContainer = tcPanel?.parentElement || player.parentElement || document.body;
    tcContainer.insertAdjacentElement('afterend', bar);
  }
  const fontValue = (val) => (val === 'System')
      ? "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
      : `${val}, Inter, system-ui, sans-serif`;

  const size   = bar.querySelector('#capSize');
  const family = bar.querySelector('#capFamily');
  const color  = bar.querySelector('#capColor');
  const cueSize = bar.querySelector('#cueSize');
  const cueFamily = bar.querySelector('#cueFamily');
  const cueColor = bar.querySelector('#cueColor');

  let hasSavedFontSettings = false;
  try{ hasSavedFontSettings = !!localStorage.getItem('fontSettingsV1'); }catch(_e){}
  if (!hasSavedFontSettings && cueColor && document.body.classList.contains('theme-light')) cueColor.value = '#151922';

  try{
    const saved = JSON.parse(localStorage.getItem('fontSettingsV1') || '{}');
    if (saved.capSize && size) size.value = saved.capSize;
    if (saved.capFamily && family) family.value = saved.capFamily;
    if (saved.capColor && color) color.value = saved.capColor;
    if (saved.cueSize && cueSize) cueSize.value = saved.cueSize;
    if (saved.cueFamily && cueFamily) cueFamily.value = saved.cueFamily;
    if (saved.cueColor && cueColor) cueColor.value = saved.cueColor;
  }catch(_e){}

  try{
    if (cueColor && document.body.classList.contains('theme-light')){
      const v = String(cueColor.value || '').trim().toLowerCase();
      if (['#e7ecf3','#e9edf1','#dfe6ee','#f1f5f9','#ffffff'].includes(v)) cueColor.value = '#151922';
    }
  }catch(_e){}

  const apply = ()=>{
    if (overlayEl){
      overlayEl.style.fontSize = (size?.value || 28) + 'px';
      overlayEl.style.fontFamily = fontValue(family?.value || 'System');
      overlayEl.style.color = color?.value || '#ffffff';
    }
    const root = document.documentElement;
    root.style.setProperty('--cue-font-size', (cueSize?.value || 14) + 'px');
    root.style.setProperty('--cue-font-family', fontValue(cueFamily?.value || 'System'));
    root.style.setProperty('--cue-color', cueColor?.value || 'var(--ink)');
    try{
      localStorage.setItem('fontSettingsV1', JSON.stringify({
        capSize:size?.value || '28', capFamily:family?.value || 'System', capColor:color?.value || '#ffffff',
        cueSize:cueSize?.value || '14', cueFamily:cueFamily?.value || 'System', cueColor:cueColor?.value || '#e7ecf3'
      }));
    }catch(_e){}
  };
  [size, color, cueSize, cueColor].forEach(el => el?.addEventListener('input', apply));
  [family, cueFamily].forEach(el => el?.addEventListener('change', apply));
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
function guessSourceTimecodeFromFilename(name){
  const n = String(name || '');
  const m1 = n.match(/(\d{2})[:\-_.](\d{2})[:\-_.](\d{2})[:\-_.](\d{2})/);
  if (m1) return `${m1[1]}:${m1[2]}:${m1[3]}:${m1[4]}`;
  const m2 = n.match(/(?:TC)?(\d{2})(\d{2})(\d{2})(\d{2})(?!\d)/);
  if (m2) return `${m2[1]}:${m2[2]}:${m2[3]}:${m2[4]}`;
  return null;
}
async function fetchSourceTimecodeFromBackend(file){
  if (!file) return null;
  try{
    const fd = new FormData();
    fd.append('file', file, file.name || 'video');
    const res = await fetch(`${API_BASE}/api/timecode`, { method: 'POST', body: fd });
    if (!res.ok){
      const t = await res.text().catch(()=> '');
      throw new Error((t && String(t).trim()) ? String(t).trim() : ('HTTP ' + res.status));
    }
    const j = await res.json();
    return j || null;
  }catch(e){
    console.warn('timecode fetch failed', e);
    try{ if (typeof statusEl!=='undefined' && statusEl) statusEl.textContent = 'Source TC fetch failed: ' + (e && e.message ? e.message : e); }catch(_e){}
    return null;
  }
}

function syncSourceTcUI(enable, tcStr){
  // Always update globals, even if the Source TC panel isn't mounted yet.
  const f = getFPS();
  const tc = (typeof tcStr === 'string' && tcStr.trim()) ? tcStr.trim() : '00:00:00:00';
  const s = parseTimecodeToSeconds(tc, f);
  sourceTcSec = (s != null) ? s : 0;
  useSourceTc = !!enable;

  // Best-effort: sync the Source TC panel controls if present.
  const chk = document.getElementById('useSrcTcToggle');
  const inp = document.getElementById('srcTcInput');
  if (chk) chk.checked = !!enable;
  if (inp) inp.value = tc;

  renderTranscript();
}
function setupVideoSourceTcToggle(){
  const uiToggle = document.getElementById('toggleSourceTc');
  if (!uiToggle || uiToggle.__bound) return;
  uiToggle.__bound = true;
  // Make sure Source TC panel exists so toggles stay in sync.
  try{ ensureTcOriginBar(); }catch(_e){}

  const syncFromPanel = () => {
    const chk = document.getElementById('useSrcTcToggle');
    if (!chk) return;
    uiToggle.checked = !!chk.checked;
  };

  uiToggle.addEventListener('change', async () => {
    const on = !!uiToggle.checked;
    if (!on){
      syncSourceTcUI(false, '00:00:00:00');
      return;
    }

    // Prefer real metadata via backend + ffprobe
    let tc = null;
    let fpsFromMeta = null;
    const meta = await fetchSourceTimecodeFromBackend(lastLoadedVideoFile);
    if (meta){
      tc = meta.timecode || null;
      fpsFromMeta = meta.fps || null;
      try{
        if (typeof statusEl!=='undefined' && statusEl){
          statusEl.textContent = tc ? (`Source TC: ${tc} (${meta.source || 'meta'})`) : 'No source timecode found in metadata.';
        }
      }catch(_e){}
    }

    // Fallback: keep user-entered value or filename guess
    const inp = document.getElementById('srcTcInput');
    if (!tc && inp && inp.value && inp.value.trim()) tc = inp.value.trim();
    if (!tc && lastLoadedVideoFile) tc = guessSourceTimecodeFromFilename(lastLoadedVideoFile.name);

    // If metadata gave fps close to your fps setting, update displayed fps label only (optional).
    // We keep app's fps setting as user-controlled; source TC is offset only.
    syncSourceTcUI(true, tc || '00:00:00:00');
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t && t.id === 'useSrcTcToggle') syncFromPanel();
  });

  syncFromPanel();
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
  const tcMini = document.getElementById('tcSrcMini');
  const anchor = tcMini || tcPanel?.parentElement || player?.parentElement || document.body;
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

  // Determine which transcript column the selection is in.
  const aRoot = document.getElementById('transcript') || transcriptEl;
  const bRoot = document.getElementById('transcriptB');
  const inB =
    (bRoot && (bRoot.contains(range.startContainer) || bRoot.contains(range.endContainer))) ||
    selectionIsInside(range.startContainer, '#transcriptB') ||
    selectionIsInside(range.endContainer, '#transcriptB');

  const listEl = inB ? bRoot : aRoot;
  const listEntries = inB ? (Array.isArray(entriesB) ? entriesB : []) : (Array.isArray(entries) ? entries : []);

  const startIdx = getRowIndexFromNode(range.startContainer);
  const endIdx   = getRowIndexFromNode(range.endContainer);
  if (startIdx < 0 || endIdx < 0) return '';
  const [from, to] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];

  const blocks = [];
  for (let i = from; i <= to; i++){
    const e = listEntries[i];
    if (!e) continue;

    let txt = e.text || '';
    const rowEl = listEl ? listEl.querySelector(`[data-index="${i}"]`) : null;
    const textEl = rowEl ? rowEl.querySelector('.text') : null;

    // If selection starts/ends mid-line, preserve partial selection for the boundary rows.
    if (textEl && (i === startIdx || i === endIdx)){
      const full = textEl.textContent || '';
      const computeOffset = (container, offset) => {
        const r = document.createRange();
        r.setStart(textEl, 0);
        r.setEnd(container, offset);
        return r.toString().length;
      };
      let startOff = 0;
      let endOff = full.length;

      if (i === startIdx){
        try{ startOff = computeOffset(range.startContainer, range.startOffset); }catch(_e){}
      }
      if (i === endIdx){
        try{ endOff = computeOffset(range.endContainer, range.endOffset); }catch(_e){}
      }
      txt = full.slice(Math.min(startOff, full.length), Math.max(0, Math.min(endOff, full.length)));
    }

    const inTc  = (typeof fmtTC==='function' ? fmtTC(e.start, f) : formatTimecodeFromSeconds(e.start, f));
    const outTc = (typeof fmtTC==='function' ? fmtTC(e.end, f)   : formatTimecodeFromSeconds(e.end,   f));
    blocks.push(`${inTc} --> ${outTc}\n${(txt||'').trimEnd()}`.trimEnd());
  }
  return blocks.join('\n\n');
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
        try{
          const cuePayload = buildCueClipboardPayloadFromDomSelection(sel);
          if (cuePayload) ev.clipboardData.setData('application/x-transcriber-cues', JSON.stringify(cuePayload));
        }catch(_e){}
      } else if (window.clipboardData){
        window.clipboardData.setData('Text', payload);
      }
    }
  });
}
// Bind for the main transcript element (reused in Sub A and Sub B single modes)
bindCopyHandler(transcriptEl);


/* ---------- View Mode: SRT / TXT (Cue-aware Script Editor) ---------- */
let isTxtMode = true;
let isTimelineMode = false;
let isStoryMode = false;
let txtBoxEl = null;
let txtDualWrapEl = null;
let txtBoxAEl = null;
let txtBoxBEl = null;
let txtCtxMenu = null;
let txtCtxIndex = -1;
let txtCtxTrack = 'A';
let txtTimePopover = null;
let __txtIdSeq = 1;

function makeCueId(){
  try{ return crypto.randomUUID(); }catch(_e){ return 'cue_' + Date.now().toString(36) + '_' + (__txtIdSeq++); }
}
function ensureCueIds(list=entries){
  (list || []).forEach(e => { if (e && !e.id) e.id = makeCueId(); });
}
function getCueList(track='A'){
  return (track === 'B') ? entriesB : entries;
}
function getCueIndexById(cueId, track='A'){
  const list = getCueList(track);
  return list.findIndex(e => String(e?.id || '') === String(cueId || ''));
}
function getTxtSingleTrack(){ return (subsMode === 'B') ? 'B' : 'A'; }
function normalizeTxtTrack(track){ return (track === 'B') ? 'B' : 'A'; }
function normalizeTxtCueText(text){
  // TXT mode presents one editable paragraph per subtitle cue.
  // Internal newlines from SRT imports are flattened so Enter can mean “split cue”.
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\n+/g, ' ').trimEnd();
}
function getTxtLineElFromNode(node){
  if (!node) return null;
  const el = (node.nodeType === Node.ELEMENT_NODE) ? node : node.parentElement;
  return el?.closest?.('.txt-line') || null;
}
function getTxtCueElFromNode(node){
  if (!node) return null;
  const el = (node.nodeType === Node.ELEMENT_NODE) ? node : node.parentElement;
  return el?.closest?.('.txt-cue') || null;
}
function getTxtEditorElFromNode(node){
  if (!node) return null;
  const el = (node.nodeType === Node.ELEMENT_NODE) ? node : node.parentElement;
  return el?.closest?.('.txt-script-editor') || null;
}
function getTxtBoxForTrack(track='A'){
  const t = normalizeTxtTrack(track);
  if (subsMode === 'DUAL') return t === 'B' ? txtBoxBEl : txtBoxAEl;
  return txtBoxEl;
}
function getTxtVisibleBoxes(){
  const out = [];
  if (txtBoxEl && txtBoxEl.style.display !== 'none') out.push(txtBoxEl);
  if (txtBoxAEl && txtBoxAEl.style.display !== 'none') out.push(txtBoxAEl);
  if (txtBoxBEl && txtBoxBEl.style.display !== 'none') out.push(txtBoxBEl);
  return out;
}
function getTxtSelectionInfo(){
  const sel = window.getSelection();
  const activeLine = document.activeElement?.closest?.('.txt-line') ? document.activeElement : null;
  const line = activeLine || (sel && sel.rangeCount ? getTxtLineElFromNode(sel.anchorNode) : null);
  const cueEl = line ? line.closest('.txt-cue') : (sel && sel.rangeCount ? getTxtCueElFromNode(sel.anchorNode) : null);
  const index = cueEl ? Number(cueEl.dataset.index || -1) : -1;
  const track = normalizeTxtTrack(cueEl?.dataset.track || getTxtEditorElFromNode(cueEl || line)?.dataset.track || getTxtSingleTrack());
  let caret = 0;
  try{ if (line) caret = getCaretOffset(line); }catch(_e){}

  let selectionStartIndex = index;
  let selectionEndIndex = index;
  let hasSelection = false;
  try{
    if (sel && sel.rangeCount && !sel.isCollapsed){
      const aCue = getTxtCueElFromNode(sel.anchorNode);
      const fCue = getTxtCueElFromNode(sel.focusNode);
      const aBox = getTxtEditorElFromNode(sel.anchorNode);
      const fBox = getTxtEditorElFromNode(sel.focusNode);
      if (aCue && fCue && aBox === fBox){
        const aTrack = normalizeTxtTrack(aCue.dataset.track || aBox?.dataset.track || track);
        const fTrack = normalizeTxtTrack(fCue.dataset.track || fBox?.dataset.track || track);
        if (aTrack === fTrack){
          const ai = Number(aCue.dataset.index || 0);
          const fi = Number(fCue.dataset.index || 0);
          selectionStartIndex = Math.min(ai, fi);
          selectionEndIndex = Math.max(ai, fi);
          hasSelection = true;
        }
      }
    }
  }catch(_e){}

  return {
    line,
    cueEl,
    index,
    caret,
    track,
    box:getTxtEditorElFromNode(cueEl || line),
    selection_start_index: selectionStartIndex,
    selection_end_index: selectionEndIndex,
    has_selection: hasSelection,
  };
}
function setTxtCueFocus(index, caretOffset=0, track='A'){
  const box = getTxtBoxForTrack(track) || ensureTxtBox();
  const row = box?.querySelector?.(`.txt-cue[data-index="${index}"][data-track="${normalizeTxtTrack(track)}"]`) || box?.querySelector?.(`.txt-cue[data-index="${index}"]`);
  const line = row?.querySelector('.txt-line');
  if (!line) return;
  const boxForFocus = getTxtBoxForTrack(track) || line.closest('.txt-script-editor');
  focusNoScroll(boxForFocus || line);
  try{ setCaretOffset(line, Math.max(0, Math.min(Number(caretOffset||0), (line.textContent || '').length))); }catch(_e){}
}
function notifyTxtCueEdit(index, { structural=false, track='A' } = {}){
  track = normalizeTxtTrack(track);
  const list = getCueList(track);
  if (index >= 0 && list[index]){
    activeOverlayTrack = track;
    holdManualSelection(index, structural ? 1800 : 1200);
    updateOverlay(index, track);
    try{ sendCollabActiveCue(track, index); }catch(_e){}
  }
  try{ scheduleCollabPush?.(); }catch(_e){}
  try{ sendCollabTxtCursor(); }catch(_e){}
  try{ sendCollabTxtTyping(); }catch(_e){}
  try{ maybeSendCollabStateOverWebSocket?.({ force: !!structural }); }catch(_e){}
  try{ applyTxtCollabAwareness(); }catch(_e){}
}
function allowedTxtSplitFrame(cue, caretOffset, fullText){
  const f = getFPS();
  const startF = secToFrames(cue.start, f);
  const endF = Math.max(startF + 2, secToFrames(cue.end, f));
  const minF = startF + 1;
  const maxF = endF - 1;
  const playT = (typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : (player?.currentTime || 0);
  let splitF = null;

  if (Number.isFinite(playT) && playT > cue.start && playT < cue.end){
    splitF = secToFrames(playT, f);
  }
  if (splitF == null || splitF < minF || splitF > maxF){
    const len = Math.max(1, String(fullText || '').length);
    const ratio = Math.max(0.08, Math.min(0.92, Number(caretOffset || 0) / len));
    splitF = Math.round(startF + (endF - startF) * ratio);
  }
  splitF = Math.max(minF, Math.min(maxF, splitF));
  return splitF;
}
function renderTxtAfterStructure(track, focusIndex, caretOffset=0){
  renderTxtBySubsMode({ focusTrack:track, focusIndex, caretOffset });
}
function splitTxtCue(index, caretOffset, track='A'){
  track = normalizeTxtTrack(track);
  const list = getCueList(track);
  ensureCueIds(list);
  const cue = list[index];
  if (!cue || isTrackLocked(track) || VIEW_ONLY_SESSION) return;
  const box = getTxtBoxForTrack(track) || ensureTxtBox();
  const line = box.querySelector(`.txt-cue[data-index="${index}"][data-track="${track}"] .txt-line`);
  const full = String(line?.textContent ?? cue.text ?? '');
  const caret = Math.max(0, Math.min(Number(caretOffset || 0), full.length));
  const left = full.slice(0, caret).trimEnd();
  const right = full.slice(caret).trimStart();
  const f = getFPS();
  const splitF = allowedTxtSplitFrame(cue, caret, full);
  const splitSec = framesToSec(splitF, f);
  const originalEnd = Math.max(cue.end, splitSec + (1 / f));

  cue.text = left;
  cue.end = splitSec;

  const newCue = {
    id: makeCueId(),
    start: splitSec,
    end: originalEnd,
    text: right,
    orig: { start: splitSec, end: originalEnd, text: right },
    origIndex: null,
    isNew: true,
  };
  list.splice(index + 1, 0, newCue);
  renderTxtAfterStructure(track, index + 1, 0);
  suppressAutoScrollUntil = nowMs() + 800;
  notifyTxtCueEdit(index + 1, { structural:true, track });
}
function joinCueText(a, b){
  const left = String(a || '').trimEnd();
  const right = String(b || '').trimStart();
  if (!left) return right;
  if (!right) return left;
  return left + ' ' + right;
}
function mergeTxtCueWithPrevious(index, track='A'){
  track = normalizeTxtTrack(track);
  const list = getCueList(track);
  ensureCueIds(list);
  if (index <= 0 || !list[index] || isTrackLocked(track) || VIEW_ONLY_SESSION) return;
  const prev = list[index - 1];
  const cur = list[index];
  const focusOffset = String(prev.text || '').trimEnd().length + (String(prev.text || '').trim() && String(cur.text || '').trim() ? 1 : 0);
  prev.text = joinCueText(prev.text, cur.text);
  prev.end = Math.max(prev.end, cur.end);
  list.splice(index, 1);
  renderTxtAfterStructure(track, index - 1, focusOffset);
  notifyTxtCueEdit(index - 1, { structural:true, track });
}
function mergeTxtCueWithNext(index, track='A'){
  track = normalizeTxtTrack(track);
  const list = getCueList(track);
  ensureCueIds(list);
  if (index < 0 || index >= list.length - 1 || !list[index] || isTrackLocked(track) || VIEW_ONLY_SESSION) return;
  const cur = list[index];
  const next = list[index + 1];
  const focusOffset = String(cur.text || '').trimEnd().length + (String(cur.text || '').trim() && String(next.text || '').trim() ? 1 : 0);
  cur.text = joinCueText(cur.text, next.text);
  cur.end = Math.max(cur.end, next.end);
  list.splice(index + 1, 1);
  renderTxtAfterStructure(track, index, focusOffset);
  notifyTxtCueEdit(index, { structural:true, track });
}
function pushTxtCueUp(index, track='A'){
  track = normalizeTxtTrack(track);
  const list = getCueList(track);
  if (index <= 0 || index >= list.length || isTrackLocked(track) || VIEW_ONLY_SESSION) return;
  syncTxtBoxToEntries();
  for (let i = index - 1; i < list.length - 1; i++) list[i].text = list[i + 1].text ?? '';
  list[list.length - 1].text = '';
  renderTxtAfterStructure(track, index - 1, (list[index - 1]?.text || '').length);
  notifyTxtCueEdit(index - 1, { structural:true, track });
}
function pushTxtCueDown(index, track='A'){
  track = normalizeTxtTrack(track);
  const list = getCueList(track);
  if (index < 0 || index >= list.length - 1 || isTrackLocked(track) || VIEW_ONLY_SESSION) return;
  syncTxtBoxToEntries();
  for (let i = list.length - 1; i >= index + 1; i--) list[i].text = list[i - 1].text ?? '';
  list[index].text = '';
  renderTxtAfterStructure(track, index + 1, (list[index + 1]?.text || '').length);
  notifyTxtCueEdit(index + 1, { structural:true, track });
}
function insertTxtCueAfter(index, text='', track='A'){
  // Allow context-menu legacy call shape insertTxtCueAfter(index) and direct calls.
  if (typeof text === 'string' && (text === 'A' || text === 'B')) { track = text; text = ''; }
  track = normalizeTxtTrack(track);
  const list = getCueList(track);
  ensureCueIds(list);
  if (isTrackLocked(track) || VIEW_ONLY_SESSION) return;
  const f = getFPS();
  const here = list[index];
  const next = list[index + 1];
  const start = here ? here.end : (list.at(-1)?.end || 0);
  let end = start + 1.0;
  if (next && end >= next.start) end = Math.max(start + (1 / f), next.start - (1 / f));
  const newIndex = Math.max(0, Math.min(list.length, index + 1));
  list.splice(newIndex, 0, {
    id: makeCueId(), start, end, text:String(text || ''),
    orig:{ start, end, text:String(text || '') }, origIndex:null, isNew:true,
  });
  renderTxtAfterStructure(track, newIndex, 0);
  notifyTxtCueEdit(newIndex, { structural:true, track });
}
function deleteTxtCue(index, track='A'){
  track = normalizeTxtTrack(track);
  const list = getCueList(track);
  if (index < 0 || index >= list.length || isTrackLocked(track) || VIEW_ONLY_SESSION) return;
  list.splice(index, 1);
  const focusIndex = Math.max(0, Math.min(index, list.length - 1));
  renderTxtAfterStructure(track, focusIndex, (list[focusIndex]?.text || '').length);
  notifyTxtCueEdit(focusIndex, { structural:true, track });
}
function splitTxtCueByPastedLines(index, caretOffset, pastedText, track='A'){
  track = normalizeTxtTrack(track);
  const list = getCueList(track);
  ensureCueIds(list);
  const cue = list[index];
  if (!cue || isTrackLocked(track) || VIEW_ONLY_SESSION) return false;
  const normalized = String(pastedText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rawLines = normalized.split('\n');
  if (rawLines.length <= 1) return false;
  const box = getTxtBoxForTrack(track) || ensureTxtBox();
  const line = box.querySelector(`.txt-cue[data-index="${index}"][data-track="${track}"] .txt-line`);
  const full = String(line?.textContent ?? cue.text ?? '');
  const caret = Math.max(0, Math.min(Number(caretOffset || 0), full.length));
  const before = full.slice(0, caret);
  const after = full.slice(caret);
  const parts = rawLines.map(x => x.trim()).filter((x, ix, arr) => x || ix === 0 || ix === arr.length - 1);
  if (!parts.length) return false;
  parts[0] = (before + parts[0]).trimEnd();
  parts[parts.length - 1] = (parts[parts.length - 1] + after).trimStart();

  const start = Number(cue.start || 0);
  const end = Math.max(start + (1 / getFPS()), Number(cue.end || 0));
  const totalChars = Math.max(1, parts.reduce((sum, part) => sum + Math.max(1, part.length), 0));
  const f = getFPS();
  let curF = secToFrames(start, f);
  const endF = Math.max(curF + parts.length, secToFrames(end, f));
  const created = [];

  for (let n = 0; n < parts.length; n++){
    const isLast = n === parts.length - 1;
    const weight = Math.max(1, parts[n].length) / totalChars;
    let nextF = isLast ? endF : Math.round(curF + Math.max(1, (endF - secToFrames(start, f)) * weight));
    nextF = Math.max(curF + 1, Math.min(endF - (parts.length - n - 1), nextF));
    const s = framesToSec(curF, f);
    const e = framesToSec(nextF, f);
    created.push({ id: n === 0 ? cue.id : makeCueId(), start:s, end:e, text:parts[n], orig:{start:s,end:e,text:parts[n]}, origIndex:n === 0 ? cue.origIndex : null, isNew:n !== 0 });
    curF = nextF;
  }
  list.splice(index, 1, ...created);
  const focusIndex = index + created.length - 1;
  renderTxtAfterStructure(track, focusIndex, (list[focusIndex]?.text || '').length);
  notifyTxtCueEdit(focusIndex, { structural:true, track });
  return true;
}


function bindTxtEditorHost(box){
  if (!box || box.__txtHostBound) return;
  box.__txtHostBound = true;
  box.addEventListener('mousedown', (ev) => {
    const cueEl = getTxtCueElFromNode(ev.target);
    const track = normalizeTxtTrack(cueEl?.dataset.track || box.dataset.track || getTxtSingleTrack());
    const index = cueEl ? Number(cueEl.dataset.index || -1) : -1;
    if (index >= 0){
      activeOverlayTrack = track;
      holdManualSelection(index, 1500);
      const cue = getCueList(track)[index];
      if (cue){
        seekMediaTo(Math.max(0, cue.start || 0) + 0.001, { play:false });
        updateOverlay(index, track);
      }
      try{ sendCollabActiveCue(track, index); }catch(_e){}
    }
  });
  if (!document.__txtCollabSelectionBound){
    document.__txtCollabSelectionBound = true;
    document.addEventListener('selectionchange', () => {
      if (!isTxtMode || !COLLAB_SESSION_ID || VIEW_ONLY_SESSION) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      const box = getTxtEditorElFromNode(sel.anchorNode) || getTxtEditorElFromNode(sel.focusNode);
      if (!box) return;
      if (document.__txtCollabSelectionRaf) return;
      document.__txtCollabSelectionRaf = requestAnimationFrame(() => {
        document.__txtCollabSelectionRaf = 0;
        try{ sendCollabTxtCursor(); }catch(_e){}
        try{ applyTxtCollabAwareness(); }catch(_e){}
      });
    });
  }
  box.addEventListener('focusin', (ev) => {
    const line = getTxtLineElFromNode(ev.target) || getTxtLineElFromNode(window.getSelection()?.anchorNode);
    const cueEl = line?.closest?.('.txt-cue');
    const track = normalizeTxtTrack(cueEl?.dataset.track || box.dataset.track || getTxtSingleTrack());
    const index = cueEl ? Number(cueEl.dataset.index || -1) : -1;
    if (index >= 0){
      activeOverlayTrack = track;
      holdManualSelection(index, 60000);
      try{ sendCollabActiveCue(track, index); }catch(_e){}
      if (!isCueRemoteLocked(track, index)) try{ sendCollabCueLock(track, index); }catch(_e){}
      try{ sendCollabTxtCursor(); }catch(_e){}
    }
  });
  box.addEventListener('focusout', (ev) => {
    const cueEl = getTxtCueElFromNode(ev.target) || getTxtCueElFromNode(window.getSelection()?.anchorNode);
    const track = normalizeTxtTrack(cueEl?.dataset.track || box.dataset.track || getTxtSingleTrack());
    const index = cueEl ? Number(cueEl.dataset.index || -1) : -1;
    if (index >= 0) try{ sendCollabCueUnlock(track, index); }catch(_e){}
    clearManualSelection();
  });
  box.addEventListener('input', () => {
    const info = getTxtSelectionInfo();
    syncTxtBoxToEntries();
    if (info.index >= 0) notifyTxtCueEdit(info.index, { track: info.track });
  });
  box.addEventListener('keyup', () => {
    const info = getTxtSelectionInfo();
    if (info.line && info.index >= 0){
      try{ sendCollabCaret(info.track, info.index, getCaretOffset(info.line)); }catch(_e){}
    }
    try{ sendCollabTxtCursor(); }catch(_e){}
    try{ applyTxtCollabAwareness(); }catch(_e){}
  });
  box.addEventListener('mouseup', () => {
    try{ sendCollabTxtCursor(); }catch(_e){}
    try{ applyTxtCollabAwareness(); }catch(_e){}
  });
  box.addEventListener('pointerup', () => {
    try{ sendCollabTxtCursor(); }catch(_e){}
    try{ applyTxtCollabAwareness(); }catch(_e){}
  });
  box.addEventListener('paste', (ev) => {
    if (isTrackLocked(normalizeTxtTrack(box.dataset.track || getTxtSingleTrack())) || VIEW_ONLY_SESSION) return;
    const info = getTxtSelectionInfo();
    if (!info.line || info.index < 0) return;
    const clip = ev.clipboardData || window.clipboardData;
    const txt = clip ? (clip.getData('text/plain') || '') : '';
    ev.preventDefault();
    ev.__txtHandled = true;
    const range = getTxtSelectionRangeDetails();

    // Cross-cue paste is structural. Remove selected text in the data model first,
    // re-render to protect cue wrappers, then insert/split at the restored caret.
    if (range?.hasSelection && range.from !== range.to){
      const target = deleteTxtSelectionRange(range, { render:true }) || { track:info.track, from:info.index, startOffset:info.caret };
      const targetIndex = target.from;
      const targetTrack = target.track;
      const caret = target.startOffset || 0;
      if (txt.includes('\n') || txt.includes('\r')){
        splitTxtCueByPastedLines(targetIndex, caret, txt, targetTrack);
      } else {
        setTxtCueFocus(targetIndex, caret, targetTrack);
        insertPlainTextAtCursor(txt);
        syncTxtBoxToEntries();
        notifyTxtCueEdit(targetIndex, { track: targetTrack });
      }
      return;
    }

    // Single-cue paste can use the browser selection inside that cue, but we
    // still force plain text and convert multi-line paste into cue splits.
    if (range?.hasSelection && range.from === range.to){
      try{ document.execCommand('insertText', false, ''); }catch(_e){}
    }
    const nextInfo = getTxtSelectionInfo();
    const targetIndex = nextInfo.index >= 0 ? nextInfo.index : info.index;
    const targetTrack = nextInfo.track || info.track;
    const caret = nextInfo.line ? getCaretOffset(nextInfo.line) : info.caret;
    if (txt.includes('\n') || txt.includes('\r')){
      splitTxtCueByPastedLines(targetIndex, caret, txt, targetTrack);
    } else {
      insertPlainTextAtCursor(txt);
      syncTxtBoxToEntries();
      notifyTxtCueEdit(targetIndex, { track: targetTrack });
    }
  });
  box.addEventListener('copy', (ev) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const details = getTxtSelectionRangeDetails();
    if (!details) return;
    const payload = buildPlainTxtPayloadFromSelection(details);
    if (!payload) return;
    ev.preventDefault();
    ev.clipboardData?.setData('text/plain', payload);
    ev.clipboardData?.setData('text/html', `<pre>${payload.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`);
    try{
      const cuePayload = buildCueClipboardPayloadFromTxtSelection(details);
      if (cuePayload) ev.clipboardData?.setData('application/x-transcriber-cues', JSON.stringify(cuePayload));
    }catch(_e){}
  });
  box.addEventListener('keydown', (ev) => {
    if (ev.__txtHandled) return;
    const info = getTxtSelectionInfo();
    if (!info.line || info.index < 0) return;
    const track = info.track;
    const locked = isTrackLocked(track) || VIEW_ONLY_SESSION;
    const details = getTxtSelectionRangeDetails();

    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a'){
      const first = box.querySelector('.txt-cue .txt-line');
      const last = Array.from(box.querySelectorAll('.txt-cue .txt-line')).at(-1);
      if (first && last){
        ev.preventDefault();
        const range = document.createRange();
        range.setStart(first, 0);
        range.setEnd(last, last.childNodes.length || 0);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      return;
    }
    if (locked) return;

    if ((ev.key === 'Backspace' || ev.key === 'Delete') && details?.hasSelection && details.from !== details.to){
      ev.preventDefault();
      ev.__txtHandled = true;
      deleteTxtSelectionRange(details, { render:true });
      return;
    }
    if (ev.key === 'Enter' && details?.hasSelection && details.from !== details.to){
      ev.preventDefault();
      ev.__txtHandled = true;
      const next = deleteTxtSelectionRange(details, { render:false }) || details;
      renderTxtAfterStructure(next.track, next.from, next.startOffset || 0);
      splitTxtCue(next.from, next.startOffset || 0, next.track);
      return;
    }

    const caret = info.caret;
    const full = info.line.textContent || '';
    const collapsed = !details || !details.hasSelection;
    if ((ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) || ev.key === 'F4'){
      ev.preventDefault();
      ev.__txtHandled = true;
      seekTxtLineToCue({ play:false });
      return;
    }
    if (ev.key === 'Enter' && !ev.shiftKey){
      ev.preventDefault();
      ev.__txtHandled = true;
      splitTxtCue(info.index, caret, track);
      return;
    }
    if (ev.key === 'Backspace' && collapsed && caret <= 0){
      ev.preventDefault();
      ev.__txtHandled = true;
      mergeTxtCueWithPrevious(info.index, track);
      return;
    }
    if (ev.key === 'Delete' && collapsed && caret >= full.length){
      ev.preventDefault();
      ev.__txtHandled = true;
      mergeTxtCueWithNext(info.index, track);
      return;
    }
    if (ev.altKey && ev.key === 'ArrowUp'){
      ev.preventDefault();
      ev.__txtHandled = true;
      pushTxtCueUp(info.index, track);
      return;
    }
    if (ev.altKey && ev.key === 'ArrowDown'){
      ev.preventDefault();
      ev.__txtHandled = true;
      pushTxtCueDown(info.index, track);
      return;
    }
  });
}

function getTxtOffsetWithinLine(line, container, offset, fallbackEnd=false){
  const textLen = String(line?.textContent || '').length;
  if (!line || !container || !line.contains(container)) return fallbackEnd ? textLen : 0;
  try{
    const r = document.createRange();
    r.selectNodeContents(line);
    r.setEnd(container, offset);
    return Math.max(0, Math.min(textLen, r.toString().length));
  }catch(_e){
    return fallbackEnd ? textLen : 0;
  }
}

function getTxtSelectionRangeDetails(){
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const startCue = getTxtCueElFromNode(range.startContainer);
  const endCue = getTxtCueElFromNode(range.endContainer);
  if (!startCue || !endCue) return null;
  const startTrack = normalizeTxtTrack(startCue.dataset.track || getTxtSingleTrack());
  const endTrack = normalizeTxtTrack(endCue.dataset.track || getTxtSingleTrack());
  if (startTrack !== endTrack) return null;
  const startLine = startCue.querySelector('.txt-line');
  const endLine = endCue.querySelector('.txt-line');
  const from = Number(startCue.dataset.index || 0);
  const to = Number(endCue.dataset.index || 0);
  const startOffset = getTxtOffsetWithinLine(startLine, range.startContainer, range.startOffset, false);
  const endOffset = getTxtOffsetWithinLine(endLine, range.endContainer, range.endOffset, true);
  return {
    track:startTrack,
    from:Math.min(from, to),
    to:Math.max(from, to),
    startIndex:from,
    endIndex:to,
    startOffset: from <= to ? startOffset : endOffset,
    endOffset: from <= to ? endOffset : startOffset,
    hasSelection: !sel.isCollapsed,
    range,
  };
}

function buildPlainTxtPayloadFromSelection(details=null){
  details = details || getTxtSelectionRangeDetails();
  if (!details) return '';
  const list = getCueList(details.track);
  const out = [];
  for (let i = details.from; i <= details.to; i++){
    const text = String(list[i]?.text ?? '');
    if (i === details.from && i === details.to){
      out.push(text.slice(details.startOffset, details.endOffset));
    } else if (i === details.from){
      out.push(text.slice(details.startOffset));
    } else if (i === details.to){
      out.push(text.slice(0, details.endOffset));
    } else {
      out.push(text);
    }
  }
  return out.join('\n');
}

function deleteTxtSelectionRange(details=null, { render=true } = {}){
  details = details || getTxtSelectionRangeDetails();
  if (!details || !details.hasSelection) return null;
  const track = normalizeTxtTrack(details.track);
  const list = getCueList(track);
  if (isTrackLocked(track) || VIEW_ONLY_SESSION) return null;
  syncTxtBoxToEntries();
  if (details.from === details.to){
    const cur = list[details.from];
    if (!cur) return null;
    const text = String(cur.text || '');
    cur.text = text.slice(0, details.startOffset) + text.slice(details.endOffset);
  } else {
    const first = list[details.from];
    const last = list[details.to];
    if (first) first.text = String(first.text || '').slice(0, details.startOffset);
    for (let i = details.from + 1; i < details.to; i++){
      if (list[i]) list[i].text = '';
    }
    if (last) last.text = String(last.text || '').slice(details.endOffset);
  }
  if (render) renderTxtAfterStructure(track, details.from, details.startOffset);
  notifyTxtCueEdit(details.from, { structural:true, track });
  return { track, from:details.from, to:details.to, startOffset:details.startOffset };
}

function ensureTxtBox(){
  if (txtBoxEl && document.body.contains(txtBoxEl)) return txtBoxEl;
  txtBoxEl = document.getElementById('txtBigBox');
  if (txtBoxEl) return txtBoxEl;

  txtBoxEl = document.createElement('div');
  txtBoxEl.id = 'txtBigBox';
  txtBoxEl.className = 'txt-script-editor';
  txtBoxEl.setAttribute('role', 'list');
  txtBoxEl.setAttribute('aria-label', 'Cue-aware TXT script editor');

  const parent = singleWrap || transcriptEl?.parentElement || document.body;
  parent.insertBefore(txtBoxEl, transcriptEl || null);
  txtBoxEl.addEventListener('scroll', () => applyTxtCollabAwareness());
  bindTxtEditorHost(txtBoxEl);
  return txtBoxEl;
}
function ensureTxtDualWrap(){
  if (txtDualWrapEl && document.body.contains(txtDualWrapEl)) return txtDualWrapEl;
  txtDualWrapEl = document.getElementById('txtDualWrap');
  if (!txtDualWrapEl){
    txtDualWrapEl = document.createElement('div');
    txtDualWrapEl.id = 'txtDualWrap';
    txtDualWrapEl.className = 'txt-dual-wrap';
    txtDualWrapEl.hidden = true;
    txtDualWrapEl.innerHTML = `
      <div class="dual-col txt-dual-col">
        <div class="dual-bar"><div class="dual-title">Transcript A (Original)</div></div>
        <div id="txtBoxA" class="txt-script-editor txt-script-editor-dual" role="list" aria-label="Sub A Transcript Mode script editor"></div>
      </div>
      <div class="dual-col txt-dual-col">
        <div class="dual-bar"><div class="dual-title">Transcript B (Translation)</div></div>
        <div id="txtBoxB" class="txt-script-editor txt-script-editor-dual" role="list" aria-label="Sub B Transcript Mode script editor"></div>
      </div>
    `;
    const panel = document.querySelector('.transcript-panel') || singleWrap?.parentElement || document.body;
    const insertAfter = dualWrap || singleWrap || transcriptEl;
    if (insertAfter && insertAfter.parentElement) insertAfter.parentElement.insertBefore(txtDualWrapEl, insertAfter.nextSibling);
    else panel.appendChild(txtDualWrapEl);
  }
  txtBoxAEl = document.getElementById('txtBoxA');
  txtBoxBEl = document.getElementById('txtBoxB');
  [txtBoxAEl, txtBoxBEl].forEach(box => {
    if (box && !box.__txtScrollBound){
      box.__txtScrollBound = true;
      box.addEventListener('scroll', () => applyTxtCollabAwareness());
    }
    bindTxtEditorHost(box);
  });
  return txtDualWrapEl;
}
function renderTxtCueRows(track='A', box, { focusIndex=null, focusCueId=null, caretOffset=0 } = {}){
  track = normalizeTxtTrack(track);
  if (!box) return;
  const list = getCueList(track);
  ensureCueIds(list);
  const st = box.scrollTop || 0;
  const f = getFPS();
  const locked = isTrackLocked(track) || VIEW_ONLY_SESSION;
  box.dataset.track = track;
  box.contentEditable = (!locked).toString();
  box.spellcheck = false;
  box.classList.toggle('is-locked', !!locked);
  bindTxtEditorHost(box);
  box.innerHTML = '';

  list.forEach((e, i) => {
    const row = document.createElement('div');
    row.className = 'txt-cue';
    row.dataset.index = String(i);
    row.dataset.track = track;
    row.dataset.cueId = String(e.id || '');
    row.setAttribute('role', 'listitem');

    const time = document.createElement('button');
    time.type = 'button';
    time.className = 'txt-time';
    time.title = 'Edit In/Out timecode';
    time.setAttribute('contenteditable', 'false');
    time.setAttribute('draggable', 'false');
    time.textContent = fmtTC(e.start, f);
    time.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      activeOverlayTrack = track;
      holdManualSelection(i, 1200);
      seekMediaTo(Math.max(0, e.start) + 0.001, { play:false });
      updateOverlay(i, track);
      try{ sendCollabActiveCue(track, i); }catch(_e){}
      showTxtTimePopover(ev, track, i);
    });

    const line = document.createElement('div');
    line.className = 'txt-line';
    line.removeAttribute('contenteditable');
    line.spellcheck = false;
    line.textContent = normalizeTxtCueText(e.text);

    line.addEventListener('mousedown', () => {
      activeOverlayTrack = track;
      holdManualSelection(i, 1500);
      const cue = getCueList(track)[i];
      seekMediaTo(Math.max(0, cue?.start || 0) + 0.001, { play:false });
      updateOverlay(i, track);
      try{ sendCollabActiveCue(track, i); }catch(_e){}
    });
    line.addEventListener('focus', () => {
      activeOverlayTrack = track;
      holdManualSelection(i, 60000);
      try{ sendCollabActiveCue(track, i); }catch(_e){}
      if (!isCueRemoteLocked(track, i)) try{ sendCollabCueLock(track, i); }catch(_e){}
      try{ sendCollabCaret(track, i, getCaretOffset(line)); }catch(_e){}
      try{ sendCollabTxtCursor(); }catch(_e){}
    });
    line.addEventListener('blur', () => { try{ sendCollabCueUnlock(track, i); }catch(_e){}; clearManualSelection(); });
    line.addEventListener('input', () => {
      const curList = getCueList(track);
      if (curList[i]) curList[i].text = line.textContent || '';
      notifyTxtCueEdit(i, { track });
    });
    line.addEventListener('keyup', () => {
      try{ sendCollabCaret(track, i, getCaretOffset(line)); }catch(_e){}
      try{ sendCollabTxtCursor(); }catch(_e){}
      try{ applyTxtCollabAwareness(); }catch(_e){}
    });
    line.addEventListener('paste', (ev) => {
      if (ev.__txtHandled) return;
      if (locked) return;
      const clip = ev.clipboardData || window.clipboardData;
      const txt = clip ? (clip.getData('text/plain') || '') : '';
      if (txt.includes('\n') || txt.includes('\r')){
        ev.preventDefault();
        const caret = getCaretOffset(line);
        splitTxtCueByPastedLines(i, caret, txt, track);
      } else {
        ev.preventDefault();
        insertPlainTextAtCursor(txt);
        const curList = getCueList(track);
        if (curList[i]) curList[i].text = line.textContent || '';
        notifyTxtCueEdit(i, { track });
      }
    });
    line.addEventListener('keydown', (ev) => {
      if (ev.__txtHandled) return;
      if (locked) return;
      const caret = getCaretOffset(line);
      const full = line.textContent || '';
      const collapsed = (() => {
        const sel = window.getSelection();
        return !sel || sel.rangeCount === 0 || sel.isCollapsed;
      })();

      if ((ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) || ev.key === 'F4'){
        ev.preventDefault();
        seekTxtLineToCue({ play:false });
        return;
      }
      if (ev.key === 'Enter' && !ev.shiftKey){
        ev.preventDefault();
        splitTxtCue(i, caret, track);
        return;
      }
      if (ev.key === 'Backspace' && collapsed && caret <= 0){
        ev.preventDefault();
        mergeTxtCueWithPrevious(i, track);
        return;
      }
      if (ev.key === 'Delete' && collapsed && caret >= full.length){
        ev.preventDefault();
        mergeTxtCueWithNext(i, track);
        return;
      }
      if (ev.altKey && ev.key === 'ArrowUp'){
        ev.preventDefault();
        pushTxtCueUp(i, track);
        return;
      }
      if (ev.altKey && ev.key === 'ArrowDown'){
        ev.preventDefault();
        pushTxtCueDown(i, track);
        return;
      }
    });

    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      showTxtContextMenu(ev, i, track);
    });

    row.append(time, line);
    box.appendChild(row);
  });

  box.scrollTop = st;
  let targetIndex = focusIndex;
  if (targetIndex == null && focusCueId) targetIndex = getCueIndexById(focusCueId, track);
  if (targetIndex != null && targetIndex >= 0) setTxtCueFocus(targetIndex, caretOffset, track);
}
function renderTxtScriptEditor(opts={}){
  // Backwards-compatible wrapper used by older calls.
  const track = normalizeTxtTrack(opts.track || opts.focusTrack || getTxtSingleTrack());
  const box = opts.targetBox || getTxtBoxForTrack(track) || ensureTxtBox();
  renderTxtCueRows(track, box, opts);
  try{ applyTxtCollabAwareness(); }catch(_e){}
}
function renderTxtBySubsMode({ focusTrack=null, focusIndex=null, focusCueId=null, caretOffset=0 } = {}){
  if (!isTxtMode) return;
  ensureTxtBox();
  ensureTxtDualWrap();
  const track = normalizeTxtTrack(focusTrack || getTxtSingleTrack());

  if (subsMode === 'DUAL'){
    try{ if (singleWrap) singleWrap.style.display = 'none'; }catch(_e){}
    try{ if (dualWrap){ dualWrap.hidden = true; dualWrap.style.display = 'none'; } }catch(_e){}
    if (txtBoxEl) txtBoxEl.style.display = 'none';
    if (txtDualWrapEl){ txtDualWrapEl.hidden = false; txtDualWrapEl.style.display = ''; }
    renderTxtCueRows('A', txtBoxAEl, { focusIndex: track === 'A' ? focusIndex : null, focusCueId: track === 'A' ? focusCueId : null, caretOffset });
    renderTxtCueRows('B', txtBoxBEl, { focusIndex: track === 'B' ? focusIndex : null, focusCueId: track === 'B' ? focusCueId : null, caretOffset });
    try{ applyAllLocks(); }catch(_e){}
    try{ applyTxtCollabAwareness(); }catch(_e){}
    return;
  }

  setDualMode(false);
  try{ if (singleWrap) singleWrap.style.display = ''; }catch(_e){}
  try{ if (dualWrap){ dualWrap.hidden = true; dualWrap.style.display = 'none'; } }catch(_e){}
  if (txtDualWrapEl){ txtDualWrapEl.hidden = true; txtDualWrapEl.style.display = 'none'; }
  if (transcriptEl) transcriptEl.style.display = 'none';
  if (txtBoxEl) txtBoxEl.style.display = 'block';
  renderTxtCueRows(track, txtBoxEl, { focusIndex, focusCueId, caretOffset });
  try{ applyAllLocks(); }catch(_e){}
  try{ applyTxtCollabAwareness(); }catch(_e){}
}
function updateTxtBox(force=false){
  if (!isTxtMode) return;
  ensureTxtBox();
  const info = getTxtSelectionInfo();
  const list = getCueList(info.track);
  const activeId = info.index >= 0 ? list[info.index]?.id : null;
  const caret = info.caret || 0;
  if (force || !txtBoxEl.children.length || subsMode === 'DUAL' || document.activeElement?.closest?.('.txt-script-editor') == null){
    renderTxtBySubsMode({ focusTrack:info.track, focusCueId:activeId, caretOffset:caret });
  } else {
    for (const box of getTxtVisibleBoxes()){
      const track = normalizeTxtTrack(box.dataset.track || getTxtSingleTrack());
      const curList = getCueList(track);
      box.querySelectorAll('.txt-cue').forEach(row => {
        const i = Number(row.dataset.index || -1);
        const t = row.querySelector('.txt-time');
        if (t && curList[i]) t.textContent = fmtTC(curList[i].start, getFPS());
      });
    }
  }
  try{ applyTxtCollabAwareness(); }catch(_e){}
}

function getTxtLineIndexAtSelection(){
  const info = getTxtSelectionInfo();
  return Number.isFinite(info.index) ? info.index : -1;
}

function syncTxtBoxToEntries(){
  const boxes = getTxtVisibleBoxes();
  if (!boxes.length && txtBoxEl) boxes.push(txtBoxEl);
  for (const box of boxes){
    box.querySelectorAll('.txt-cue').forEach(row => {
      const i = Number(row.dataset.index || -1);
      const track = normalizeTxtTrack(row.dataset.track || box.dataset.track || getTxtSingleTrack());
      const list = getCueList(track);
      ensureCueIds(list);
      const line = row.querySelector('.txt-line');
      if (i >= 0 && list[i] && line) list[i].text = String(line.textContent || '');
    });
  }
  const info = getTxtSelectionInfo();
  const list = getCueList(info.track);
  if (info.index >= 0 && list[info.index]) updateOverlay(info.index, info.track);
  try{ sendCollabActiveCue(info.track || 'A', info.index); sendCollabTxtCursor(); }catch(_e){}
}

function seekTxtLineToCue({ play=false } = {}){
  const info = getTxtSelectionInfo();
  const list = getCueList(info.track);
  const cue = list[info.index];
  if (!cue) return;
  activeOverlayTrack = info.track;
  holdManualSelection(info.index, 1200);
  seekMediaTo(Math.max(0, cue.start) + 0.001, { play });
  updateOverlay(info.index, info.track);
}

function getTxtSelectedCueRange(){
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const aCue = getTxtCueElFromNode(sel.anchorNode);
  const fCue = getTxtCueElFromNode(sel.focusNode);
  if (!aCue || !fCue) return null;
  const aTrack = normalizeTxtTrack(aCue.dataset.track || getTxtSingleTrack());
  const fTrack = normalizeTxtTrack(fCue.dataset.track || getTxtSingleTrack());
  if (aTrack !== fTrack){
    const a = Number(aCue.dataset.index || 0);
    return { from:a, to:a, track:aTrack, hasSelection:!sel.isCollapsed };
  }
  const a = Number(aCue.dataset.index || 0);
  const b = Number(fCue.dataset.index || 0);
  return { from:Math.min(a,b), to:Math.max(a,b), track:aTrack, hasSelection:!sel.isCollapsed };
}

/** Build timecoded payload for the currently selected range in TXT script editor.
 *  If nothing is selected, copy all cues from the visible/active TXT track.
 */
function buildTimecodedPayloadFromTxtSelection(){
  try{ syncTxtBoxToEntries(); }catch(_e){}
  const f = getFPS();
  const range = getTxtSelectedCueRange();
  const info = getTxtSelectionInfo();
  const track = normalizeTxtTrack(range?.track || info.track || activeOverlayTrack || getTxtSingleTrack());
  const list = getCueList(track);
  const from = range?.hasSelection ? range.from : 0;
  const to = range?.hasSelection ? range.to : list.length - 1;
  const blocks = [];
  for (let i = from; i <= to; i++){
    const e = list[i];
    if (!e) continue;
    const inTc = (typeof fmtTC === 'function') ? fmtTC(e.start, f) : formatTimecodeFromSeconds(e.start, f);
    const outTc = (typeof fmtTC === 'function') ? fmtTC(e.end, f) : formatTimecodeFromSeconds(e.end, f);
    blocks.push(`${inTc} --> ${outTc}\n${String(e.text || '').trimEnd()}`.trimEnd());
  }
  return blocks.join('\n\n');
}

async function copyTextToClipboard(payload){
  if (!payload) return;
  try { await navigator.clipboard.writeText(payload); }
  catch {
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

function ensureTxtTimePopover(){
  if (txtTimePopover) return txtTimePopover;
  const styleId = 'txtTimePopoverStyle';
  if (!document.getElementById(styleId)){
    const st = document.createElement('style');
    st.id = styleId;
    st.textContent = `
      .txt-time-popover{position:fixed;z-index:22000;display:none;width:260px;padding:12px;border:1px solid rgba(255,255,255,.14);border-radius:14px;background:#10151d;color:#e9edf1;box-shadow:0 18px 50px rgba(0,0,0,.42)}
      .txt-time-popover.is-open{display:block}
      .txt-time-popover .tc-pop-title{font-size:12px;font-weight:600;margin-bottom:8px;opacity:.9}
      .txt-time-popover label{display:grid;grid-template-columns:38px 1fr;gap:8px;align-items:center;font-size:12px;margin:7px 0;color:#b7c2d0}
      .txt-time-popover input{width:100%;box-sizing:border-box;background:#0e1116;color:#e9edf1;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:7px 8px;font-variant-numeric:tabular-nums}
      .txt-time-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
      .txt-time-actions button{height:31px;border-radius:9px;border:1px solid rgba(255,255,255,.14);background:#1f2a3a;color:#e9edf1;padding:0 10px;cursor:pointer}
      .txt-time-actions button.primary{background:#2a86ff;border-color:#2a86ff;color:white}
      .txt-time-note{font-size:11px;opacity:.62;margin-top:6px;line-height:1.35}
    `;
    document.head.appendChild(st);
  }
  txtTimePopover = document.createElement('div');
  txtTimePopover.id = 'txtTimePopover';
  txtTimePopover.className = 'txt-time-popover';
  txtTimePopover.innerHTML = `
    <div class="tc-pop-title">Edit cue timecode</div>
    <label><span>In</span><input id="txtTcIn" type="text" placeholder="00:00:00:00"></label>
    <label><span>Out</span><input id="txtTcOut" type="text" placeholder="00:00:00:00"></label>
    <div class="txt-time-note">Uses the current FPS and Source TC display offset.</div>
    <div class="txt-time-actions">
      <button type="button" id="txtTcSeek">Seek</button>
      <button type="button" id="txtTcCancel">Cancel</button>
      <button type="button" class="primary" id="txtTcApply">Apply</button>
    </div>
  `;
  document.body.appendChild(txtTimePopover);
  document.addEventListener('click', (ev) => {
    if (!txtTimePopover.classList.contains('is-open')) return;
    if (txtTimePopover.contains(ev.target) || ev.target?.closest?.('.txt-time')) return;
    hideTxtTimePopover();
  });
  window.addEventListener('resize', hideTxtTimePopover);
  window.addEventListener('scroll', hideTxtTimePopover, true);
  return txtTimePopover;
}
function hideTxtTimePopover(){
  if (txtTimePopover){
    txtTimePopover.classList.remove('is-open');
    txtTimePopover.style.display = 'none';
    txtTimePopover.dataset.track = '';
    txtTimePopover.dataset.index = '';
  }
}
function positionTxtTimePopover(anchor){
  if (!txtTimePopover || !anchor) return;
  const r = anchor.getBoundingClientRect();
  const w = 260;
  const h = 190;
  const left = Math.min(window.innerWidth - w - 10, Math.max(10, r.left));
  const top = Math.min(window.innerHeight - h - 10, Math.max(10, r.bottom + 8));
  txtTimePopover.style.left = left + 'px';
  txtTimePopover.style.top = top + 'px';
}
function showTxtTimePopover(ev, track='A', index=0){
  track = normalizeTxtTrack(track);
  const list = getCueList(track);
  const cue = list[index];
  if (!cue) return;
  const pop = ensureTxtTimePopover();
  pop.dataset.track = track;
  pop.dataset.index = String(index);
  const f = getFPS();
  const inInput = pop.querySelector('#txtTcIn');
  const outInput = pop.querySelector('#txtTcOut');
  if (inInput) inInput.value = fmtTC(cue.start, f);
  if (outInput) outInput.value = fmtTC(cue.end, f);
  const locked = isTrackLocked(track) || VIEW_ONLY_SESSION;
  [inInput, outInput, pop.querySelector('#txtTcApply')].forEach(el => { if (el) el.disabled = !!locked; });

  pop.querySelector('#txtTcSeek').onclick = () => {
    seekMediaTo(Math.max(0, cue.start) + 0.001, { play:false });
    updateOverlay(index, track);
  };
  pop.querySelector('#txtTcCancel').onclick = hideTxtTimePopover;
  pop.querySelector('#txtTcApply').onclick = () => {
    const curIndex = Number(pop.dataset.index || index);
    const curTrack = normalizeTxtTrack(pop.dataset.track || track);
    const curList = getCueList(curTrack);
    const curCue = curList[curIndex];
    if (!curCue || isTrackLocked(curTrack) || VIEW_ONLY_SESSION) return;
    const f2 = getFPS();
    const s = parseDisplayedTcToSeconds(inInput.value, f2);
    const e = parseDisplayedTcToSeconds(outInput.value, f2);
    if (s == null || e == null){ alert('Invalid timecode. Use HH:MM:SS:FF.'); return; }
    const minDur = 1 / f2;
    if (e <= s){ alert('Out timecode must be after In timecode.'); return; }
    curCue.start = Math.max(0, s);
    curCue.end = Math.max(curCue.start + minDur, e);
    hideTxtTimePopover();
    renderTxtBySubsMode({ focusTrack:curTrack, focusIndex:curIndex, caretOffset:0 });
    seekMediaTo(Math.max(0, curCue.start) + 0.001, { play:false });
    notifyTxtCueEdit(curIndex, { structural:true, track:curTrack });
  };

  positionTxtTimePopover(ev.currentTarget || ev.target);
  pop.style.display = 'block';
  pop.classList.add('is-open');
  setTimeout(() => { try{ inInput?.focus({preventScroll:true}); inInput?.select(); }catch(_e){} }, 0);
}

function ensureTxtContextMenu(){
  if (txtCtxMenu) return txtCtxMenu;
  txtCtxMenu = document.createElement('div');
  txtCtxMenu.className = 'ctx-menu txt-ctx-menu';
  txtCtxMenu.style.display = 'none';
  const addBtn = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => { const idx = txtCtxIndex; const tr = txtCtxTrack; hideTxtContextMenu(); fn(idx, tr); });
    txtCtxMenu.appendChild(b);
  };
  addBtn('Split Cue at Caret', (idx, tr) => {
    const info = getTxtSelectionInfo();
    splitTxtCue(idx, info.index === idx && info.track === tr ? info.caret : String(getCueList(tr)[idx]?.text || '').length, tr);
  });
  addBtn('Merge with Previous', mergeTxtCueWithPrevious);
  addBtn('Merge with Next', mergeTxtCueWithNext);
  const sep1 = document.createElement('div'); sep1.className = 'ctx-sep'; txtCtxMenu.appendChild(sep1);
  addBtn('Push Text Up', pushTxtCueUp);
  addBtn('Push Text Down', pushTxtCueDown);
  const sep2 = document.createElement('div'); sep2.className = 'ctx-sep'; txtCtxMenu.appendChild(sep2);
  addBtn('Add Blank Cue Below', (idx, tr) => insertTxtCueAfter(idx, '', tr));
  addBtn('Delete Cue', deleteTxtCue);
  document.body.appendChild(txtCtxMenu);
  window.addEventListener('click', hideTxtContextMenu);
  window.addEventListener('scroll', hideTxtContextMenu, true);
  window.addEventListener('resize', hideTxtContextMenu);
  return txtCtxMenu;
}
function showTxtContextMenu(ev, index, track='A'){
  track = normalizeTxtTrack(track);
  if (isTrackLocked(track) || VIEW_ONLY_SESSION) return;
  ensureContextMenu(); // ensures shared context-menu CSS exists
  ensureTxtContextMenu();
  txtCtxIndex = index;
  txtCtxTrack = track;
  txtCtxMenu.style.left = (ev.pageX ?? ev.clientX + window.scrollX) + 'px';
  txtCtxMenu.style.top = (ev.pageY ?? ev.clientY + window.scrollY) + 'px';
  txtCtxMenu.style.display = 'block';
}
function hideTxtContextMenu(){
  if (txtCtxMenu){ txtCtxMenu.style.display = 'none'; txtCtxIndex = -1; }
}

/* ---------- Timeline Mode: clip selection + export ---------- */
let timelineModeEl = null;
let timelineClips = [];
let timelineSelection = null;
let timelineSelectedClipId = '';
let timelinePxPerSec = 28;
let timelineFitPxPerSec = 28;
let timelineDragState = null;
let timelineRaf = 0;
let __timelineIdSeq = 1;
let COLLAB_TIMELINE_PRESENCE = {};
let COLLAB_TIMELINE_RANGES = {};
let COLLAB_TIMELINE_LOCKS = {};
let COLLAB_TIMELINE_LAST_SEND_MS = 0;
let COLLAB_TIMELINE_STATE_TIMER = null;
let COLLAB_TIMELINE_PRESENCE_TIMER = null;
let timelineAiModalEl = null;
let timelineAiSuggestions = [];
let timelineUndoStack = [];
let timelineConfirmModalEl = null;

function makeTimelineClipId(){ return 'clip_' + Date.now().toString(36) + '_' + (__timelineIdSeq++); }
function getTimelineDuration(){
  const d = (typeof getMediaDuration === 'function') ? Number(getMediaDuration()) : Number(player?.duration || 0);
  return Number.isFinite(d) && d > 0 ? d : Math.max(entries.at(-1)?.end || 0, entriesB.at(-1)?.end || 0, 60);
}
function clampTimelineTime(t){ return Math.max(0, Math.min(getTimelineDuration(), Number(t) || 0)); }
function timelineTimeToPx(t){ return Math.round(clampTimelineTime(t) * timelinePxPerSec); }
function timelinePxToTime(px){ return clampTimelineTime((Number(px) || 0) / Math.max(0.1, timelinePxPerSec)); }
function fmtTimelineTime(sec){
  const f = getFPS();
  if (timelinePxPerSec >= f * 8) return formatTimecodeFromSeconds(sec, f);
  const s = Math.max(0, Number(sec) || 0);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  if (hh > 0) return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
  return `${pad2(mm)}:${pad2(ss)}`;
}
function getTimelineSubtitleSource(){
  if (subsMode === 'B') return { track:'B', list:entriesB || [] };
  return { track:'A', list:entries || [] };
}
function createDefaultTimelineSelection(){
  const t = clampTimelineTime((typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : 0);
  const dur = getTimelineDuration();
  const start = Math.max(0, Math.min(t, dur));
  const end = Math.min(dur, start + Math.max(1, Math.min(8, dur / 10)));
  timelineSelection = { start, end };
}
// Removed earlier Phase 1 duplicate ensureTimelineMode; Phase 2 implementation below is used.
// Removed earlier Phase 1 duplicate bindTimelineMode; Phase 2 implementation below is used.
// Removed earlier Phase 1 duplicate setTimelineZoom; Phase 2 implementation below is used.
function fitTimelineZoom(){
  const scroll = timelineModeEl?.querySelector('#tlScroll');
  const dur = getTimelineDuration();
  const w = Math.max(300, scroll?.clientWidth || 900);
  timelineFitPxPerSec = Math.max(1, Math.min(80, (w - 32) / Math.max(1, dur)));
  setTimelineZoom(timelineFitPxPerSec);
  if (scroll) scroll.scrollLeft = 0;
}
// Removed earlier Phase 1 duplicate showTimelineMode; Phase 2 implementation below is used.
function hideTimelineMode(){
  if (timelineModeEl) timelineModeEl.style.display = 'none';
  if (!isStoryMode) setTranscriptWorkAreaHidden(false);
}
function requestTimelineRender(){
  if (timelineRaf) cancelAnimationFrame(timelineRaf);
  timelineRaf = requestAnimationFrame(() => { timelineRaf = 0; renderTimelineMode(); });
}
// Removed earlier Phase 1 duplicate renderTimelineMode; Phase 2 implementation below is used.
function chooseRulerStep(pxPerSec){
  const targets = [1/getFPS(), 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600];
  for (const step of targets){ if (step * pxPerSec >= 72) return step; }
  return 600;
}
function renderTimelineRuler(ruler, scroll, dur){
  if (!ruler || !scroll) return;
  const viewStart = timelinePxToTime(scroll.scrollLeft - 100);
  const viewEnd = timelinePxToTime(scroll.scrollLeft + scroll.clientWidth + 200);
  const major = chooseRulerStep(timelinePxPerSec);
  const minor = Math.max(1/getFPS(), major / 5);
  let html = '';
  const startMinor = Math.max(0, Math.floor(viewStart / minor) * minor);
  for (let t = startMinor; t <= Math.min(dur, viewEnd) + 0.0001; t += minor){
    const isMajor = Math.abs((t / major) - Math.round(t / major)) < 0.001;
    const left = timelineTimeToPx(t);
    html += `<div class="tl-tick ${isMajor ? 'major' : 'minor'}" style="left:${left}px"><span>${isMajor ? fmtTimelineTime(t) : ''}</span></div>`;
  }
  ruler.innerHTML = html;
}
function renderTimelineSelection(selEl){
  if (!selEl) return;
  if (!timelineSelection){ selEl.hidden = true; return; }
  const a = Math.min(timelineSelection.start, timelineSelection.end);
  const b = Math.max(timelineSelection.start, timelineSelection.end);
  selEl.hidden = false;
  selEl.style.left = timelineTimeToPx(a) + 'px';
  selEl.style.width = Math.max(2, timelineTimeToPx(b) - timelineTimeToPx(a)) + 'px';
  const label = selEl.querySelector('span');
  if (label) label.textContent = `${fmtTimelineTime(a)} → ${fmtTimelineTime(b)}`;
}
// Removed earlier Phase 1 duplicate renderTimelineClips; Phase 2 implementation below is used.
function updateTimelinePlayhead(t){
  if (!timelineModeEl) return;
  const ph = timelineModeEl.querySelector('#tlPlayhead');
  if (ph) ph.style.left = timelineTimeToPx(t) + 'px';
}
function timelinePointerTime(ev){
  const content = timelineModeEl?.querySelector('#tlContent');
  if (!content) return 0;
  const rect = content.getBoundingClientRect();
  return timelinePxToTime(ev.clientX - rect.left);
}
function timelineAutoScrollWhileDragging(ev){
  const scroll = timelineModeEl?.querySelector('#tlScroll');
  if (!scroll || !timelineDragState) return;
  const rect = scroll.getBoundingClientRect();
  const zone = Math.min(220, Math.max(110, rect.width * 0.18));
  let delta = 0;
  if (ev.clientX < rect.left + zone){
    const strength = 1 - Math.max(0, ev.clientX - rect.left) / zone;
    delta = -Math.max(8, Math.round(42 * strength));
  } else if (ev.clientX > rect.right - zone){
    const strength = 1 - Math.max(0, rect.right - ev.clientX) / zone;
    delta = Math.max(8, Math.round(42 * strength));
  }
  if (!delta) return;
  const max = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
  scroll.scrollLeft = Math.max(0, Math.min(max, scroll.scrollLeft + delta));
  // Keep rendering smooth without flooding.
  const now = performance.now();
  if (now - timelineLastAutoScroll > 24){
    timelineLastAutoScroll = now;
    requestTimelineRender();
  }
}
function onTimelineLanePointerDown(ev){
  if (ev.target?.closest?.('.tl-clip')) return;
  ev.preventDefault();
  const lane = ev.currentTarget;
  const start = timelinePointerTime(ev);
  timelineDragState = { kind:'selection', start };
  timelineSelection = { start, end:start };
  timelineLiveSeek(start);
  sendTimelinePresence('selecting', start, { force:true });
  sendTimelineRangePreview(true);
  lane.setPointerCapture?.(ev.pointerId);
  const move = (e) => { if (!timelineDragState) return; timelineAutoScrollWhileDragging(e); const t = snapTimeToFrameValue(timelinePointerTime(e)); timelineSelection.end = t; timelineLiveSeek(t); sendTimelinePresence('selecting', t); sendTimelineRangePreview(true); requestTimelineRender(); };
  const up = (e) => {
    lane.releasePointerCapture?.(e.pointerId);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    const releaseT = snapTimeToFrameValue(timelinePointerTime(e));
    if (timelineSelection){
      const a = Math.min(timelineSelection.start, timelineSelection.end);
      const b = Math.max(timelineSelection.start, timelineSelection.end);
      timelineSelection = { start:a, end:Math.max(a + (1/getFPS()), b) };
      // Keep the playhead at the exact pointer-release location instead of
      // jumping back to the range start after the user finishes selecting.
      seekMediaTo(clampTimelineTime(releaseT), { play:false });
    }
    timelineDragState = null;
    // Keep the finished range visible to collaborators after mouseup.
    // The old behaviour sent active:false here, which made the remote ghost
    // range disappear the moment the user released the mouse.  A finished
    // range is still useful collaboration context, so broadcast it as a
    // persisted selection instead.
    sendTimelinePresence('selected_range', timelineSelection ? timelineSelection.start : null, { force:true });
    sendTimelineRangePreview(true, { status:'selected' });
    requestTimelineRender();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once:true });
}
// Removed earlier Phase 1 duplicate onTimelineClipPointerDown; Phase 2 implementation below is used.
// Removed earlier Phase 1 duplicate addTimelineClipFromSelection; Phase 2 implementation below is used.
// Removed earlier Phase 1 duplicate renderTimelineClipList; Phase 2 implementation below is used.
// Removed earlier Phase 1 duplicate buildRetimedSubtitlePayload; Phase 2 implementation below is used.
async function resolveTimelineSourceForExport(){
  const src = currentMediaSource || {};
  if (src.type === 'local'){
    if (!src.cacheId) await ensureLocalAudioCache();
    const cached = getCurrentLocalCachedSource();
    if (cached?.cacheId) return { type:'local_cached', cache_id:cached.cacheId };
  }
  if (src.type === 'drive' && src.cacheId) return { type:'drive_cached', cache_id:src.cacheId };
  if (src.type === 'shared_local' && src.metadata?.cacheId) return { type:'local_cached', cache_id:src.metadata.cacheId };
  throw new Error('Timeline export currently needs cached local or cached Google Drive media. For a local file, run Transcribe/Align once or let this export cache it first.');
}
// Removed earlier Phase 1 duplicate exportTimelineCut; Phase 2 implementation below is used.

function ensureViewModeBar(){
  if (document.getElementById('viewModeBar')) return;

  if (!document.getElementById('viewModeStyle')){
    const st = document.createElement('style');
    st.id = 'viewModeStyle';
    st.textContent = `
      .seg-toggle { display:inline-flex; background:#0e1116; border:1px solid rgba(255,255,255,.08); border-radius:10px; overflow:hidden }
      .seg-toggle .seg{ background:transparent; color:#e9edf1; border:0; padding:8px 12px; cursor:pointer; font-size:13px }
      .seg-toggle .seg.active{ background:#1a2230 }
      .txt-tools{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
      .txt-tools .btn{ height:34px; }
      #transcriptSingleWrap{ display:flex; flex-direction:column; min-height:0; overflow:hidden; }
      #txtBigBox.txt-script-editor,.txt-script-editor{
        width:100%; flex:1 1 auto; height:100%; min-height:0; max-height:none; overflow:auto;
        background:#0e1116; color:#e9edf1; border:1px solid rgba(255,255,255,.08);
        border-radius:12px; padding:8px 8px 96px; box-sizing:border-box; margin-top:10px;
        font-size:14px; line-height:1.5; user-select:text; -webkit-user-select:text; scroll-padding-bottom:96px;
      }
      .txt-script-editor.is-locked{ cursor:not-allowed; opacity:.82; }
      .txt-dual-wrap{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;min-height:0;flex:1 1 auto;height:auto;overflow:hidden;padding:10px;}
      .txt-dual-col{min-height:0;overflow:hidden;display:flex;flex-direction:column;}
      .txt-script-editor-dual{min-height:0;max-height:none;margin-top:0;}
      .txt-cue{ position:relative; display:grid; grid-template-columns:104px minmax(0,1fr); gap:10px; align-items:start; padding:8px 10px; border-radius:10px; border:1px solid transparent; user-select:text; -webkit-user-select:text; }
      .txt-cue:hover{ background:rgba(255,255,255,.035); border-color:rgba(255,255,255,.06); }
      .txt-cue .txt-time{ position:sticky; left:0; top:0; align-self:start; border:0; background:rgba(255,255,255,.06); color:#9fb7d9; border-radius:999px; padding:3px 8px; font-size:11px; font-variant-numeric:tabular-nums; cursor:pointer; user-select:none; }
      .txt-cue .txt-time:hover{ background:rgba(79,140,255,.20); color:#fff; }
      .txt-line{ min-height:1.5em; outline:0; white-space:pre-wrap; overflow-wrap:anywhere; padding:1px 2px; border-radius:6px; user-select:text; -webkit-user-select:text; font-size:var(--cue-font-size, 14px); font-family:var(--cue-font-family, inherit); color:var(--cue-color, var(--ink)); }
      .txt-line:focus{ background:rgba(79,140,255,.12); box-shadow:0 0 0 1px rgba(79,140,255,.28); }
      .txt-line[contenteditable="false"]{ cursor:not-allowed; opacity:.75; }
      .txt-cue .txt-user-marker{ position:absolute; right:10px; top:7px; left:auto; z-index:5; }
      .txt-help{ opacity:.7; font-size:12px; }
      @media (max-width: 900px){ .txt-dual-wrap{grid-template-columns:1fr;} }
    `;
    document.head.appendChild(st);
  }

  const bar = document.createElement('div');
  bar.id = 'viewModeBar';
  bar.style.cssText = 'margin-top:8px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;';
  bar.innerHTML = `
    <div class="seg-toggle" role="group" aria-label="View Mode">
      <button id="btnModeSrt" class="seg" type="button">Subtitle Mode</button>
      <button id="btnModeTxt" class="seg active" type="button">Transcript Mode</button>
      <button id="btnModeTimeline" class="seg" type="button">Timeline Mode</button>
      <button id="btnModeStory" class="seg" type="button">Story Mode</button>
    </div>
    <div class="txt-tools" id="txtTools" style="display:flex">
      <button class="btn btn-outline" id="btnCopyTc" type="button">Copy with timecodes</button>
      <span class="txt-help">Enter = split cue · Backspace/Delete at edge = merge · Alt+↑/↓ = push text · Click time = edit In/Out</span>
    </div>
  `;

  const anchorEl =
    document.getElementById('tcOriginBar') ||
    tcPanel?.parentElement ||
    player?.parentElement ||
    document.body;

  anchorEl.insertAdjacentElement('afterend', bar);

  const btnSrt = bar.querySelector('#btnModeSrt');
  const btnTxt = bar.querySelector('#btnModeTxt');
  const btnTimeline = bar.querySelector('#btnModeTimeline');
  const btnStory = bar.querySelector('#btnModeStory');
  const txtTools = bar.querySelector('#txtTools');
  const btnCopyTc = bar.querySelector('#btnCopyTc');

  const apply = () => {
    btnSrt.classList.toggle('active', !isTxtMode && !isTimelineMode && !isStoryMode);
    btnTxt.classList.toggle('active',  isTxtMode && !isTimelineMode && !isStoryMode);
    btnTimeline.classList.toggle('active', isTimelineMode);
    if (btnStory) btnStory.classList.toggle('active', isStoryMode);

    if (isTimelineMode){
      try{ syncTxtBoxToEntries(); }catch(_e){}
      hideTxtTimePopover();
      if (txtTools) txtTools.style.display = 'none';
      hideStoryMode();
      showTimelineMode();
      return;
    }

    if (isStoryMode){
      try{ syncTxtBoxToEntries(); }catch(_e){}
      hideTxtTimePopover();
      if (txtTools) txtTools.style.display = 'none';
      hideTimelineMode();
      showStoryMode();
      return;
    }

    hideTimelineMode();
    hideStoryMode();
    setTranscriptWorkAreaHidden(false);
    if (singleWrap) singleWrap.style.display = '';
    if (isTxtMode){
      ensureTxtBox();
      renderTxtBySubsMode();
      if (transcriptEl) transcriptEl.style.display = 'none';
      if (txtTools) txtTools.style.display = 'flex';
    } else {
      hideTxtTimePopover();
      if (txtBoxEl) txtBoxEl.style.display = 'none';
      if (txtDualWrapEl){ txtDualWrapEl.hidden = true; txtDualWrapEl.style.display = 'none'; }
      if (transcriptEl) transcriptEl.style.display = '';
      if (txtTools) txtTools.style.display = 'none';
      renderBySubsMode();
    }
  };

  btnSrt.addEventListener('click', () => { try{ syncTxtBoxToEntries(); }catch(_e){} isTimelineMode = false; isStoryMode = false; isTxtMode = false; apply(); });
  btnTxt.addEventListener('click', () => { try{ flushEditsFromDOM(); }catch(_e){} isTimelineMode = false; isStoryMode = false; isTxtMode = true; apply(); });
  btnTimeline.addEventListener('click', () => { try{ syncTxtBoxToEntries(); }catch(_e){} isTimelineMode = true; isStoryMode = false; isTxtMode = false; apply(); });
  if (btnStory) btnStory.addEventListener('click', () => { try{ syncTxtBoxToEntries(); }catch(_e){} isTimelineMode = false; isStoryMode = true; isTxtMode = false; apply(); });

  btnCopyTc.addEventListener('click', async () => {
    try { syncTxtBoxToEntries(); } catch {}
    const payload = buildTimecodedPayloadFromTxtSelection();
    await copyTextToClipboard(payload);
  });

  apply();
}


/* ---------- Story Mode: editorial assembly rows + live cue/clip cards ---------- */
let storyModeEl = null;
let storyRows = [];
let __storyRowSeq = 1;
let __storyCardSeq = 1;
let storyAddMenuEl = null;
let storyModalEl = null;
let COLLAB_STORY_STATE_TIMER = null;
let storyContextMenuEl = null;
let storyContextCueTarget = null;
let storyActiveSubTrack = 'A';
let storyActiveCardCtx = null;
let storyDraggingRowId = '';
let storySavedRichSelection = null;
let storySelectionToolbarBound = false;
const STORY_LABELS = {
  audio: ['Upsot Dialogue','Natural Sound','Upsot PTC','Mute Audio','Sound FX'],
  shot: ['Main Shot','B-roll','Montage','Interview','PTC','Studio'],
};
const STORY_LABEL_COLORS = {
  audio: '#9fe7c6',
  shot: '#ffd98a',
  generic: '#8fd3ff',
  caption: '#d8b4fe',
};
const STORY_CAPTION_TYPES = ['Name Super','Lower Third','Title Caption','Source Credit','End Credits'];
function makeStoryRowId(){ return 'story_row_' + Date.now().toString(36) + '_' + (__storyRowSeq++); }
function makeStoryCardId(){ return 'story_card_' + Date.now().toString(36) + '_' + (__storyCardSeq++); }
function normalizeStoryTrack(track){ return track === 'B' ? 'B' : 'A'; }
function storyListForTrack(track){ return normalizeStoryTrack(track) === 'B' ? entriesB : entries; }
function storyEnsureCueIds(track='A'){
  ensureCueIds(entries);
  ensureCueIds(entriesB);
  return storyListForTrack(track);
}
function storyCueById(cueId, track='A'){
  const list = storyListForTrack(track);
  return (list || []).find(e => String(e?.id || '') === String(cueId || '')) || null;
}
function storyCueRange(cueRefs=[], track='A'){
  const cues = (cueRefs || []).map(id => storyCueById(id, track)).filter(Boolean);
  if (!cues.length) return null;
  return { start:Math.min(...cues.map(c => Number(c.start || 0))), end:Math.max(...cues.map(c => Number(c.end || 0))), cues };
}
function storyEffectiveTrack(card){
  const wanted = normalizeStoryTrack(storyActiveSubTrack || subsMode || card?.track || 'A');
  const baseTrack = normalizeStoryTrack(card?.track || wanted || 'A');
  if (!card) return wanted;
  if (card?.altCueRefs && Array.isArray(card.altCueRefs[wanted]) && card.altCueRefs[wanted].length) return wanted;
  if (wanted === baseTrack) return baseTrack;

  // For Story/Timeline SUBS toggles, do not keep cue cards pinned to their
  // original track.  Map the card's time range to the requested Sub A/Sub B
  // track, then render that track's cue text when matching cues exist.
  if (card.kind === 'cue' || card.kind === 'clip'){
    let baseRange = null;
    const baseRefs = Array.isArray(card?.cueRefs) ? card.cueRefs : [];
    if (baseRefs.length) baseRange = storyCueRange(baseRefs, baseTrack);
    if (!baseRange && card.start != null && card.end != null) baseRange = { start:Number(card.start), end:Number(card.end) };
    if (baseRange){
      const mapped = storyCueRefsForRange(baseRange.start, baseRange.end, wanted);
      if (mapped.length) return wanted;
    }
  }
  return baseTrack;
}
function storyEffectiveCueRefs(card){
  const t = storyEffectiveTrack(card);
  if (card?.altCueRefs && Array.isArray(card.altCueRefs[t]) && card.altCueRefs[t].length) return card.altCueRefs[t];
  const baseRefs = Array.isArray(card?.cueRefs) ? card.cueRefs : [];
  const baseTrack = normalizeStoryTrack(card?.track || 'A');
  if (!card || t === baseTrack) return baseRefs;

  // Story Cards are created from a source track, usually Sub A.  When the
  // Story/Timeline top SUBS control switches to the other track, derive the
  // matching cue refs by the card's live time range so the same story beat can
  // be viewed in Sub B without duplicating the card.
  let baseRange = null;
  if (baseRefs.length) baseRange = storyCueRange(baseRefs, baseTrack);
  if (!baseRange && card.start != null && card.end != null) baseRange = { start:Number(card.start), end:Number(card.end) };
  if (!baseRange) return baseRefs;

  const mapped = storyCueRefsForRange(baseRange.start, baseRange.end, t);
  return mapped.length ? mapped : baseRefs;
}
function syncStoryTopSubControls(){
  const v = normalizeStoryTrack(storyActiveSubTrack || subsMode || 'A');
  document.querySelectorAll('#storySubModeTop,#timelineSubModeTop').forEach(sel => { if (sel && sel.value !== v) sel.value = v; });
}
function setStoryTimelineSubMode(track){
  storyActiveSubTrack = normalizeStoryTrack(track);
  try{ applySubsMode(storyActiveSubTrack); }catch(_e){ subsMode = storyActiveSubTrack; }
  syncStoryTopSubControls();
  if (isStoryMode) renderStoryAssembly();
  if (isTimelineMode) requestTimelineRender?.();
}
function storyCueOverlapScore(cue, start, end){
  const cs = Number(cue?.start ?? 0), ce = Number(cue?.end ?? 0);
  const s = Number(start ?? 0), e = Number(end ?? 0);
  return Math.max(0, Math.min(ce, e) - Math.max(cs, s));
}
function storyCueRefsForRange(start, end, track='A'){
  const list = storyEnsureCueIds(track) || [];
  const s = Number(start ?? 0), e = Number(end ?? 0);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return [];
  const fps = (typeof getFPS === 'function') ? getFPS() : 25;
  const tol = Math.max(0.001, 0.5 / Math.max(1, fps));
  return list
    .filter(cue => {
      const cs = Number(cue?.start ?? 0), ce = Number(cue?.end ?? 0);
      if (!Number.isFinite(cs) || !Number.isFinite(ce) || ce <= cs) return false;
      // Include cues that truly overlap the clip range, with a tiny frame
      // tolerance so frame-rounded clip In/Out values do not drop boundary cues.
      return Math.min(ce, e + tol) - Math.max(cs, s - tol) > 0.001;
    })
    .map(cue => cue.id)
    .filter(Boolean);
}
function storyCueRefBundleForRange(start, end, preferredTrack=null){
  const preferred = normalizeStoryTrack(preferredTrack || storyActiveSubTrack || subsMode || 'A');
  const refsA = storyCueRefsForRange(start, end, 'A');
  const refsB = storyCueRefsForRange(start, end, 'B');
  let track = preferred;
  let cueRefs = track === 'B' ? refsB : refsA;
  if (!cueRefs.length){
    track = refsB.length > refsA.length ? 'B' : 'A';
    cueRefs = track === 'B' ? refsB : refsA;
  }
  return { track, cueRefs:[...cueRefs], altCueRefs:{ A:[...refsA], B:[...refsB] } };
}
function storyBestTrackForClip(clip){
  const start = storyClipStart(clip);
  const end = storyClipEnd(clip);
  const refsA = storyCueRefsForRange(start, end, 'A');
  const refsB = storyCueRefsForRange(start, end, 'B');
  return refsB.length > refsA.length ? 'B' : 'A';
}
function storyClipById(clipId){
  return (timelineClips || []).find(c => String(c?.id || '') === String(clipId || '')) || null;
}
function storyClipStart(clip){
  return Number(clip?.start ?? clip?.in ?? clip?.inTime ?? clip?.startTime ?? clip?.rangeStart ?? 0);
}
function storyClipEnd(clip){
  return Number(clip?.end ?? clip?.out ?? clip?.outTime ?? clip?.endTime ?? clip?.rangeEnd ?? 0);
}
function storyClipCueRefs(clip, preferredTrack=null){
  if (!clip) return { track: preferredTrack || 'A', cueRefs: [], altCueRefs:{ A:[], B:[] } };
  const start = storyClipStart(clip);
  const end = storyClipEnd(clip);

  // Clip Story Cards should behave like cue Story Cards: the card owns the cue
  // refs that fall inside the clip In/Out window.  Derive by time range first,
  // because Timeline clips usually do not carry explicit cue ids.
  if (Number.isFinite(start) && Number.isFinite(end) && end > start){
    const rangeBundle = storyCueRefBundleForRange(start, end, preferredTrack || clip.track || clip.subtitleTrack || storyActiveSubTrack || subsMode || 'A');
    if (rangeBundle.cueRefs.length || rangeBundle.altCueRefs.A.length || rangeBundle.altCueRefs.B.length) return rangeBundle;
  }

  // Backward compatibility for older Timeline clips that did store cue ids.
  const explicit = clip.cueRefs || clip.cue_ids || clip.cues || clip.cueIds;
  if (Array.isArray(explicit) && explicit.length){
    const track = normalizeStoryTrack(clip.track || clip.subtitleTrack || preferredTrack || 'A');
    const cueRefs = explicit.map(x => String(typeof x === 'object' ? (x.id || x.cueId || '') : x)).filter(Boolean);
    return { track, cueRefs, altCueRefs:{ A:track === 'A' ? [...cueRefs] : [], B:track === 'B' ? [...cueRefs] : [] } };
  }
  const track = normalizeStoryTrack(preferredTrack || clip.track || clip.subtitleTrack || 'A');
  return { track, cueRefs:[], altCueRefs:{ A:[], B:[] } };
}
function storyHasAnyTranscriptCues(){
  try{ ensureCueIds(entries); ensureCueIds(entriesB); }catch(_e){}
  return !!((Array.isArray(entries) && entries.length) || (Array.isArray(entriesB) && entriesB.length));
}
function storyTrackOrder(preferred='A'){
  const first = normalizeStoryTrack(preferred || storyActiveSubTrack || subsMode || 'A');
  return first === 'B' ? ['B','A'] : ['A','B'];
}
function storyValidCueRefsForTrack(refs=[], track='A'){
  const list = storyEnsureCueIds(track) || [];
  const ids = new Set(list.map(e => String(e?.id || '')).filter(Boolean));
  return storyUniqueRefs((refs || []).map(x => String(x || '')).filter(id => ids.has(id)));
}
function storyImportedCardSnapshotText(card){
  if (!card) return '';
  const parts = [];
  if (String(card.body || '').trim()) parts.push(String(card.body || ''));
  if (String(card.bodyHtml || '').trim()) parts.push(storyPlainTextFromRichHtml(card.bodyHtml || ''));
  if (!parts.length && String(card.text || '').trim()) parts.push(String(card.text || ''));
  return parts.join('\n').replace(/\u00a0/g, ' ').trim();
}
function storyCardHasImportLiveHint(card){
  if (!card) return false;
  if (card.kind === 'cue' || card.kind === 'clip' || card.originalKind === 'cue' || card.originalKind === 'clip') return true;
  if (card.clipId) return true;
  const hasRefs = (Array.isArray(card.cueRefs) && card.cueRefs.length)
    || (Array.isArray(card.sourceCueRefs) && card.sourceCueRefs.length)
    || (card.altCueRefs && ((Array.isArray(card.altCueRefs.A) && card.altCueRefs.A.length) || (Array.isArray(card.altCueRefs.B) && card.altCueRefs.B.length)));
  return !!hasRefs;
}
function storyImportedDirectRefCandidates(card, track='A'){
  const refs = [];
  const add = arr => { if (Array.isArray(arr)) arr.forEach(x => { const id = String(x || ''); if (id && !refs.includes(id)) refs.push(id); }); };
  if (card?.altCueRefs && typeof card.altCueRefs === 'object') add(card.altCueRefs[normalizeStoryTrack(track)]);
  add(card?.cueRefs);
  add(card?.sourceCueRefs);
  add(card?.cueIds);
  return refs;
}
function storyTryDirectRelinkForCard(card){
  for (const track of storyTrackOrder(card?.track || storyActiveSubTrack || subsMode || 'A')){
    const candidates = storyImportedDirectRefCandidates(card, track);
    if (!candidates.length) continue;
    const valid = storyValidCueRefsForTrack(candidates, track);
    if (valid.length){
      const altCueRefs = { A:[], B:[] };
      altCueRefs[track] = [...valid];
      const other = track === 'A' ? 'B' : 'A';
      const otherValid = storyValidCueRefsForTrack(storyImportedDirectRefCandidates(card, other), other);
      if (otherValid.length) altCueRefs[other] = otherValid;
      return { method:valid.length === candidates.length ? 'direct' : 'partial-direct', track, cueRefs:valid, altCueRefs };
    }
  }
  return null;
}
function storyTryRangeRelinkForCard(card){
  const start = Number(card?.start);
  const end = Number(card?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const bundle = storyCueRefBundleForRange(start, end, card?.track || storyActiveSubTrack || subsMode || 'A');
  if (!bundle.cueRefs.length && !bundle.altCueRefs.A.length && !bundle.altCueRefs.B.length) return null;
  return { method:'timecode', track:bundle.track, cueRefs:storyUniqueRefs(bundle.cueRefs || []), altCueRefs:{ A:storyUniqueRefs(bundle.altCueRefs.A || []), B:storyUniqueRefs(bundle.altCueRefs.B || []) } };
}
function storyTryTextRelinkForCard(card){
  const raw = storyImportedCardSnapshotText(card);
  const body = storyNormalizeTextForMatch(raw);
  if (body.length < 8) return null;
  const start = Number(card?.start);
  const end = Number(card?.end);
  const hasRange = Number.isFinite(start) && Number.isFinite(end) && end > start;
  let best = null;
  for (const track of storyTrackOrder(card?.track || storyActiveSubTrack || subsMode || 'A')){
    const list = storyEnsureCueIds(track) || [];
    const refs = [];
    let matchedChars = 0;
    list.forEach(cue => {
      const cueText = storyNormalizeTextForMatch(cue?.text || '');
      if (cueText.length < 2) return;
      const exact = body.includes(cueText);
      const reverse = body.length >= 12 && cueText.includes(body);
      if (!exact && !reverse) return;
      if (hasRange){
        const overlap = storyCueOverlapScore(cue, start, end);
        const dur = Math.max(0.001, Number(cue.end || 0) - Number(cue.start || 0));
        // Text matching is allowed outside the saved range, but cues very far
        // from the imported range score lower than cues that also overlap it.
        if (overlap <= 0 && Math.abs(Number(cue.start || 0) - start) > 3 && Math.abs(Number(cue.end || 0) - end) > 3) return;
        matchedChars += cueText.length * (overlap > 0 ? 1.25 : 0.65);
      } else {
        matchedChars += cueText.length;
      }
      refs.push(cue.id);
    });
    const unique = storyUniqueRefs(refs);
    if (!unique.length) continue;
    const coverage = matchedChars / Math.max(1, body.length);
    const ok = unique.length >= 2 || coverage >= 0.28 || (unique.length === 1 && body.length <= 160);
    if (!ok) continue;
    const score = unique.length * 10 + coverage * 20 + (track === normalizeStoryTrack(card?.track || 'A') ? 1 : 0);
    if (!best || score > best.score) best = { method:'text', track, cueRefs:unique, altCueRefs:{ A:track === 'A' ? unique : [], B:track === 'B' ? unique : [] }, score };
  }
  return best ? { method:best.method, track:best.track, cueRefs:best.cueRefs, altCueRefs:best.altCueRefs } : null;
}
function storyApplyRelinkResultToCard(card, result, opts={}){
  if (!card || !result || !Array.isArray(result.cueRefs) || !result.cueRefs.length) return false;
  const originalKind = card.originalKind || card.kind || '';
  const shouldStayClip = originalKind === 'clip' || card.kind === 'clip' || !!card.clipId;
  const snapshotText = storyImportedCardSnapshotText(card);
  const snapshotHtml = String(card.bodyHtml || '').trim();
  card.originalKind = originalKind || (shouldStayClip ? 'clip' : 'cue');
  card.kind = shouldStayClip ? 'clip' : 'cue';
  card.track = normalizeStoryTrack(result.track || card.track || 'A');
  card.cueRefs = storyUniqueRefs(result.cueRefs || []);
  card.sourceCueRefs = [...card.cueRefs];
  const alt = result.altCueRefs || {};
  card.altCueRefs = {
    A:storyUniqueRefs(alt.A || (card.track === 'A' ? card.cueRefs : [])),
    B:storyUniqueRefs(alt.B || (card.track === 'B' ? card.cueRefs : []))
  };
  if (!card.altCueRefs[card.track]?.length) card.altCueRefs[card.track] = [...card.cueRefs];
  const r = storyCueRange(card.cueRefs, card.track);
  if (r){ card.start = Number(r.start); card.end = Number(r.end); }
  if (snapshotText || snapshotHtml){
    card.body = snapshotText;
    card.bodyHtml = storySanitizeRichHtml(snapshotHtml || storyPlainTextToRichHtml(snapshotText));
    // Preserve the imported document text/formatting while still making the card
    // live. Reconcile/delete/split logic uses the restored cue refs underneath.
    card.bodyManual = opts.preserveSnapshotBody !== false;
  } else {
    card.body = '';
    card.bodyHtml = '';
    card.bodyManual = false;
  }
  card.relinkPending = false;
  card.relinkStatus = result.method || 'linked';
  return true;
}
function storyMarkCardAsGenericAfterRelink(card){
  if (!card) return;
  if (card.kind === 'caption') return;
  const snapshotText = storyImportedCardSnapshotText(card);
  const snapshotHtml = String(card.bodyHtml || '').trim();
  card.originalKind = card.originalKind || card.kind || 'generic';
  card.kind = 'generic';
  card.cueRefs = [];
  card.sourceCueRefs = [];
  card.altCueRefs = { A:[], B:[] };
  if (snapshotText || snapshotHtml){
    card.body = snapshotText;
    card.bodyHtml = storySanitizeRichHtml(snapshotHtml || storyPlainTextToRichHtml(snapshotText));
    card.bodyManual = true;
  }
  card.relinkPending = false;
  card.relinkStatus = 'generic';
}
function storyRelinkImportedStoryCard(card, opts={}){
  if (!card || card.kind === 'caption') return { skipped:true };
  if (!storyHasAnyTranscriptCues()){
    card.relinkPending = true;
    card.relinkStatus = 'pending-transcript';
    return { pending:true };
  }
  const liveHint = storyCardHasImportLiveHint(card);
  const direct = storyTryDirectRelinkForCard(card);
  const text = storyTryTextRelinkForCard(card);
  const range = storyTryRangeRelinkForCard(card);
  // For true cue/clip imports, the saved In/Out range is a reliable fallback.
  // For generic document rows, require direct refs or text evidence so a manual
  // timecoded note does not accidentally turn into a live transcript card.
  const result = direct || text || (liveHint ? range : null);
  if (result && result.cueRefs?.length){
    storyApplyRelinkResultToCard(card, result, { preserveSnapshotBody: opts.preserveSnapshotBody !== false });
    return { linked:true, method:result.method };
  }
  storyMarkCardAsGenericAfterRelink(card);
  return { generic:true };
}
function storyRelinkImportedStoryRows(rows=storyRows, opts={}){
  const stats = { linked:0, generic:0, pending:0, skipped:0 };
  (rows || []).forEach(row => (row.cards || []).forEach(card => {
    if (!opts.force && !card?.relinkPending) return;
    const res = storyRelinkImportedStoryCard(card, opts);
    if (res.linked) stats.linked += 1;
    else if (res.generic) stats.generic += 1;
    else if (res.pending) stats.pending += 1;
    else stats.skipped += 1;
  }));
  return stats;
}
function storyRetryPendingStoryRelinksAfterCueLoad(opts={}){
  if (typeof storyRows === 'undefined' || !Array.isArray(storyRows) || !storyRows.length) return null;
  const pending = storyRows.some(row => (row.cards || []).some(card => card?.relinkPending));
  if (!pending || !storyHasAnyTranscriptCues()) return null;
  const stats = storyRelinkImportedStoryRows(storyRows, { force:false, preserveSnapshotBody:true });
  if (opts.render && isStoryMode) renderStoryAssembly();
  if (opts.commit && (stats.linked || stats.generic)) storyCommitSharedState?.(true);
  return stats;
}

function escapeStoryAttr(v){ return escapeHtml(String(v ?? '')).replace(/"/g, '&quot;'); }
function storyNormalizeTextStyle(style={}){
  const src = (style && typeof style === 'object') ? style : {};
  const size = Math.max(10, Math.min(36, Number(src.fontSize || 14) || 14));
  const align = ['left','center','right','justify'].includes(String(src.align || 'left')) ? String(src.align || 'left') : 'left';
  return { bold:!!src.bold, italic:!!src.italic, underline:!!src.underline, fontSize:size, align };
}
function storyCardBodyInlineStyle(card){
  const st = storyNormalizeTextStyle(card?.textStyle || {});
  return `--story-card-font-size:${st.fontSize}px;--story-card-font-weight:${st.bold ? 700 : 400};--story-card-font-style:${st.italic ? 'italic' : 'normal'};--story-card-text-decoration:${st.underline ? 'underline' : 'none'};--story-card-text-align:${st.align};`;
}
function storyPlainTextToRichHtml(text){
  const safe = escapeHtml(String(text ?? ''));
  return safe ? safe.replace(/\r?\n/g, '<br>') : '<br>';
}
function storyPlainTextFromRichHtml(html){
  if (!html) return '';
  try{
    const box = document.createElement('div');
    box.innerHTML = String(html || '');
    return String(box.innerText || box.textContent || '').replace(/\u00a0/g, '');
  }catch(_e){ return String(html || '').replace(/<[^>]+>/g, ''); }
}
function storySanitizeStyle(styleText){
  const allowed = new Set(['font-size','font-family','font-weight','font-style','text-decoration','text-decoration-line','color','background-color','text-align']);
  return String(styleText || '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const i = part.indexOf(':');
    if (i <= 0) return '';
    const prop = part.slice(0, i).trim().toLowerCase();
    let val = part.slice(i + 1).trim();
    if (!allowed.has(prop)) return '';
    if (/url\s*\(/i.test(val) || /javascript:/i.test(val)) return '';
    if (prop === 'font-size'){
      const n = Math.max(8, Math.min(72, parseFloat(val) || 11));
      val = n + 'px';
    }
    return `${prop}:${val}`;
  }).filter(Boolean).join(';');
}
function storySanitizeRichHtml(html){
  if (!html) return '';
  try{
    const box = document.createElement('div');
    box.innerHTML = String(html || '');
    const allowed = new Set(['B','STRONG','I','EM','U','S','STRIKE','DEL','SPAN','BR','DIV','P','A','FONT']);
    const walk = (node) => {
      Array.from(node.childNodes || []).forEach(child => {
        if (child.nodeType === 1){
          if (!allowed.has(child.tagName)){
            const frag = document.createDocumentFragment();
            while (child.firstChild) frag.appendChild(child.firstChild);
            child.replaceWith(frag);
            walk(node);
            return;
          }
          const rawHref = child.getAttribute('href') || '';
          const rawFace = child.getAttribute('face') || '';
          const rawColor = child.getAttribute('color') || '';
          const rawStyleBase = child.getAttribute('style') || child.style?.cssText || '';
          const rawStyle = [rawStyleBase, rawFace ? `font-family:${rawFace}` : '', rawColor ? `color:${rawColor}` : ''].filter(Boolean).join(';');
          Array.from(child.attributes || []).forEach(attr => child.removeAttribute(attr.name));
          if (child.tagName === 'A' && /^(https?:|mailto:)/i.test(rawHref)){
            child.setAttribute('href', rawHref);
            child.setAttribute('target', '_blank');
            child.setAttribute('rel', 'noopener noreferrer');
          }
          const style = storySanitizeStyle(rawStyle);
          if (style) child.setAttribute('style', style);
          walk(child);
        } else if (child.nodeType !== 3){
          child.remove();
        }
      });
    };
    walk(box);
    return box.innerHTML;
  }catch(_e){ return escapeHtml(storyPlainTextFromRichHtml(html)); }
}
function storyRichBodyHtmlForCard(card, text){
  if (card?.bodyManual && card?.bodyHtml) return storySanitizeRichHtml(card.bodyHtml);
  return storyPlainTextToRichHtml(text);
}
function storyGetRichBodyText(editable){
  return String(editable?.innerText || editable?.textContent || '').replace(/\n+$/g, '');
}
function exportStoryJsonPayload(){
  try{ storySyncAllRichBodiesToCards({ commit:false, reconcile:false }); }catch(_e){}
  return {
    type:'transcriber_story_assembly',
    version:2,
    exportedAt:new Date().toISOString(),
    media:getCurrentStoryMediaLabel(),
    activeSubTrack:normalizeStoryTrack(storyActiveSubTrack || subsMode || 'A'),
    storyRows:storyRows.map(cleanStoryRowForShare)
  };
}
function storyApplyTextStyleToCardEl(cardEl, card){
  if (!cardEl || !card) return;
  const css = storyCardBodyInlineStyle(card);
  cardEl.querySelectorAll('.story-card-body,.story-mini-text').forEach(el => {
    css.split(';').filter(Boolean).forEach(pair => { const i = pair.indexOf(':'); if (i > 0) el.style.setProperty(pair.slice(0, i), pair.slice(i + 1)); });
  });
}
function getCurrentStoryMediaLabel(){
  const src = currentMediaSource || {};
  const fileName = src.file?.name || src.filename || src.metadata?.filename || src.metadata?.name || src.metadata?.title || src.url || window.currentBaseName || lastLoadedVideoFile?.name || 'Current media';
  return String(fileName || 'Current media').split(/[\\/]/).pop();
}
function setTranscriptWorkAreaHidden(hidden){
  const panel = document.querySelector('.transcript-panel');
  const head = panel?.querySelector('.section-head');
  if (head) head.style.display = hidden ? 'none' : '';
  const findBar = document.getElementById('transcriptFindBar');
  if (findBar) findBar.style.display = hidden ? 'none' : '';
  const singleBar = document.getElementById('singleSubBar');
  if (singleBar) singleBar.style.display = hidden ? 'none' : '';
}
function createStoryRow(){
  return { id:makeStoryRowId(), cards:[], notes:'', status:'draft' };
}
function ensureStorySeed(){ if (!storyRows.length) storyRows.push(createStoryRow()); }
function storyCommitSharedState(force=false){
  if (!COLLAB_SESSION_ID || VIEW_ONLY_SESSION || COLLAB_APPLYING) return;
  if (COLLAB_STORY_STATE_TIMER) clearTimeout(COLLAB_STORY_STATE_TIMER);
  COLLAB_STORY_STATE_TIMER = setTimeout(() => {
    try{ maybeSendCollabStateOverWebSocket?.({ force: !!force }); }catch(_e){}
  }, force ? 30 : 900);
}
function storyExportRangeForCard(card){
  if (!card) return null;
  try{
    const r = (typeof storyCardRange === 'function' ? storyCardRange(card) : null) || (typeof storyTimelineRangeForCard === 'function' ? storyTimelineRangeForCard(card) : null);
    if (r && Number.isFinite(Number(r.start)) && Number.isFinite(Number(r.end)) && Number(r.end) > Number(r.start)) return { start:Number(r.start), end:Number(r.end) };
  }catch(_e){}
  if (card?.start != null && card?.end != null && Number.isFinite(Number(card.start)) && Number.isFinite(Number(card.end)) && Number(card.end) > Number(card.start)){
    return { start:Number(card.start), end:Number(card.end) };
  }
  return null;
}
function storySnapshotCardBodyHtml(card){
  if (!card) return '';
  try{
    const cardEl = storyFindCardEl?.(storyRows.find(r => (r.cards || []).some(c => c.id === card.id))?.id, card.id);
    const editable = cardEl?.querySelector?.('.story-card-body[data-card-field="body"]');
    if (editable) return storySanitizeRichHtml(editable.innerHTML || '');
  }catch(_e){}
  const bodyHtml = String(card.bodyHtml || '');
  if (bodyHtml.trim()) return storySanitizeRichHtml(bodyHtml);
  const plain = storyTextForCard(card) || card.body || '';
  return storySanitizeRichHtml(storyPlainTextToRichHtml(plain));
}
function storySnapshotCardPlainText(card){
  if (!card) return '';
  try{
    const cardEl = storyFindCardEl?.(storyRows.find(r => (r.cards || []).some(c => c.id === card.id))?.id, card.id);
    const editable = cardEl?.querySelector?.('.story-card-body[data-card-field="body"]');
    if (editable) return storyGetRichBodyText(editable);
  }catch(_e){}
  return String(card.body || storyTextForCard(card) || storyPlainTextFromRichHtml(card.bodyHtml || '') || '');
}
function storySyncAllRichBodiesToCards({ commit=false, reconcile=false } = {}){
  if (!storyModeEl) return;
  storyModeEl.querySelectorAll?.('.story-card-body[data-card-field="body"]').forEach(editable => {
    try{ storySyncRichBodyToCard(editable, { commit, reconcile }); }catch(_e){}
  });
}
function cleanStoryCardForShare(card){
  const range = storyExportRangeForCard(card);
  const bodyHtml = storySnapshotCardBodyHtml(card);
  const bodyText = storySnapshotCardPlainText(card) || storyPlainTextFromRichHtml(bodyHtml || '');
  return {
    id:String(card?.id || makeStoryCardId()), kind:String(card?.kind || 'generic'), title:String(card?.title || ''),
    labelGroup:String(card?.labelGroup || 'shot'), label:String(card?.label || ''), source:String(card?.source || ''),
    start:range ? range.start : (card?.start == null ? null : Number(card.start)),
    end:range ? range.end : (card?.end == null ? null : Number(card.end)),
    inTc:range ? fmtTC(range.start) : '', outTc:range ? fmtTC(range.end) : '',
    cueRefs:Array.isArray(card?.cueRefs) ? card.cueRefs.map(x=>String(x)).filter(Boolean) : [],
    sourceCueRefs:Array.isArray(card?.sourceCueRefs) ? card.sourceCueRefs.map(x=>String(x)).filter(Boolean) : [],
    altCueRefs:(card?.altCueRefs && typeof card.altCueRefs === 'object') ? { A:Array.isArray(card.altCueRefs.A)?card.altCueRefs.A.map(x=>String(x)).filter(Boolean):[], B:Array.isArray(card.altCueRefs.B)?card.altCueRefs.B.map(x=>String(x)).filter(Boolean):[] } : null,
    track:normalizeStoryTrack(card?.track || 'A'), clipId:String(card?.clipId || ''),
    body:String(bodyText || ''), bodyHtml:bodyHtml || storyPlainTextToRichHtml(bodyText || ''), bodyManual:!!card?.bodyManual,
    notes:String(card?.notes || ''), notesOpen:!!card?.notesOpen, editMode:!!card?.editMode,
    bodyWidth:String(card?.bodyWidth || ''), bodyHeight:String(card?.bodyHeight || ''),
    textStyle:storyNormalizeTextStyle(card?.textStyle || {})
  };
}
function cleanStoryRowForShare(row){
  return { id:String(row?.id || makeStoryRowId()), cards:(row?.cards || []).map(cleanStoryCardForShare), notes:String(row?.notes || ''), status:String(row?.status || 'draft') };
}
function storyIsNodeInsideStoryEditor(node=document.activeElement){
  try{ return !!(node && node.closest && node.closest('#storyMode .story-card')); }catch(_e){ return false; }
}
function storySnapshotEditingFocus(){
  const active = document.activeElement;
  if (!storyIsNodeInsideStoryEditor(active)) return null;
  const rowEl = active.closest('.story-row');
  const cardEl = active.closest('.story-card');
  if (!rowEl || !cardEl) return null;
  const snap = { rowId:rowEl.dataset.rowId || '', cardId:cardEl.dataset.cardId || '', field:'', selector:'', start:0, end:0, textOffset:0 };
  if (active.matches?.('.story-card-title')) { snap.field='title'; snap.selector='.story-card-title'; }
  else if (active.matches?.('.story-card-notes')) { snap.field='notes'; snap.selector='.story-card-notes'; }
  else if (active.matches?.('.story-card-body')) { snap.field='body'; snap.selector='.story-card-body[data-card-field="body"]'; }
  else if (active.matches?.('.story-mini-text')) { snap.field='mini'; snap.selector=`.story-mini-cue[data-cue-id="${CSS.escape(active.closest('.story-mini-cue')?.dataset?.cueId || '')}"] .story-mini-text`; snap.cueId = active.closest('.story-mini-cue')?.dataset?.cueId || ''; }
  else return null;
  try{
    if (active.isContentEditable){ snap.textOffset = getCaretOffset(active); }
    else { snap.start = Number(active.selectionStart || 0); snap.end = Number(active.selectionEnd ?? snap.start); }
  }catch(_e){}
  return snap;
}
function storyRestoreEditingFocus(snap){
  if (!snap || !snap.rowId || !snap.cardId) return;
  setTimeout(() => {
    try{
      const cardEl = storyFindCardEl(snap.rowId, snap.cardId);
      const target = cardEl?.querySelector?.(snap.selector || '');
      if (!target || target.getAttribute('contenteditable') === 'false' || target.disabled) return;
      target.focus({ preventScroll:true });
      if (target.isContentEditable){ setCaretOffset(target, Math.max(0, Number(snap.textOffset || 0))); }
      else if (typeof target.setSelectionRange === 'function'){ target.setSelectionRange(Math.max(0, snap.start || 0), Math.max(0, snap.end ?? snap.start ?? 0)); }
    }catch(_e){}
  }, 0);
}
function storyLocalActiveCardCleanSnapshot(){
  const snap = storySnapshotEditingFocus();
  if (!snap?.rowId || !snap?.cardId) return null;
  const { row, card } = storyFindCard(snap.rowId, snap.cardId);
  if (!row || !card) return null;
  try{
    const cardEl = storyFindCardEl(row.id, card.id);
    const body = cardEl?.querySelector?.('.story-card-body[data-card-field="body"]');
    if (body) storySyncRichBodyToCard(body, { commit:false, reconcile:false });
    const notes = cardEl?.querySelector?.('.story-card-notes');
    if (notes) card.notes = notes.value || '';
    const title = cardEl?.querySelector?.('.story-card-title');
    if (title) card.title = title.value || '';
  }catch(_e){}
  return { rowId:row.id, cardId:card.id, card:cleanStoryCardForShare(card), focus:snap };
}
function applySharedStoryRows(rows, opts={}){
  if (!Array.isArray(rows)) return;
  const local = opts.remoteUpdate ? storyLocalActiveCardCleanSnapshot() : null;
  storyRows = rows.map(r => ({
    id:String(r?.id || makeStoryRowId()), notes:String(r?.notes || ''), status:String(r?.status || 'draft'),
    cards:Array.isArray(r?.cards) ? r.cards.map(c => {
      if (local && String(c?.id || '') === local.cardId) return normalizeImportedStoryCard(local.card);
      return normalizeImportedStoryCard(c);
    }) : []
  }));
  if (local && !storyRows.some(r => (r.cards || []).some(c => c.id === local.cardId))){
    const target = storyRows.find(r => r.id === local.rowId) || storyRows[0] || (storyRows.push(createStoryRow()), storyRows[0]);
    target.cards.push(normalizeImportedStoryCard(local.card));
  }
  if (isStoryMode){ ensureStoryMode(); renderStoryAssembly(); if (local?.focus) storyRestoreEditingFocus(local.focus); }
}
function storyParseImportedTime(v){
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  try{ const parsed = parseDisplayedTcToSeconds(String(v), getFPS()); return parsed == null ? null : parsed; }catch(_e){ return null; }
}
function normalizeImportedStoryCard(c={}, opts={}){
  const track = normalizeStoryTrack(c?.track || c?.subtitleTrack || 'A');
  let start = storyParseImportedTime(c?.start ?? c?.in ?? c?.inTime ?? c?.rangeStart ?? c?.timecodeIn ?? c?.inTc);
  let end = storyParseImportedTime(c?.end ?? c?.out ?? c?.outTime ?? c?.rangeEnd ?? c?.timecodeOut ?? c?.outTc);
  if ((start == null || end == null) && typeof c?.timecode === 'string'){
    const parts = c.timecode.split(/-->|→|-/).map(x => x.trim()).filter(Boolean);
    if (parts.length >= 2){ start = storyParseImportedTime(parts[0]); end = storyParseImportedTime(parts[1]); }
  }
  const cueRefs = Array.isArray(c?.cueRefs) ? c.cueRefs.map(x=>String(x)).filter(Boolean)
    : (Array.isArray(c?.cueIds) ? c.cueIds.map(x=>String(x)).filter(Boolean) : []);
  const sourceCueRefs = Array.isArray(c?.sourceCueRefs) && c.sourceCueRefs.length ? c.sourceCueRefs.map(x=>String(x)).filter(Boolean) : [...cueRefs];
  const altCueRefs = (c?.altCueRefs && typeof c.altCueRefs === 'object')
    ? { A:Array.isArray(c.altCueRefs.A)?c.altCueRefs.A.map(x=>String(x)).filter(Boolean):[], B:Array.isArray(c.altCueRefs.B)?c.altCueRefs.B.map(x=>String(x)).filter(Boolean):[] }
    : { A:track === 'A' ? [...cueRefs] : [], B:track === 'B' ? [...cueRefs] : [] };
  let rawBodyHtml = String(c?.bodyHtml || c?.html || c?.richText || '');
  let body = String(c?.body ?? c?.text ?? c?.bodyText ?? storyPlainTextFromRichHtml(rawBodyHtml || '') ?? '');
  if (!rawBodyHtml && body) rawBodyHtml = storyPlainTextToRichHtml(body);
  rawBodyHtml = storySanitizeRichHtml(rawBodyHtml || '');
  if (!body && rawBodyHtml) body = storyPlainTextFromRichHtml(rawBodyHtml);
  const hasSnapshotBody = !!String(rawBodyHtml || body || '').trim();
  return {
    id:String(c?.id || makeStoryCardId()), kind:String(c?.kind || 'generic'), originalKind:String(c?.originalKind || c?.kind || ''), title:String(c?.title || ''),
    labelGroup:String(c?.labelGroup || 'shot'), label:String(c?.label || ''), source:String(c?.source || ''),
    start:start == null ? null : Number(start), end:end == null ? null : Number(end),
    cueRefs, sourceCueRefs, altCueRefs, track, clipId:String(c?.clipId || ''),
    body:String(body || ''), bodyHtml:rawBodyHtml || storyPlainTextToRichHtml(body || ''),
    // Imported JSON should be self-contained: even if the source subtitles have
    // not been loaded yet, Story Cards still display their exported cue text.
    bodyManual: (opts?.forceSnapshotBody && hasSnapshotBody) ? true : !!c?.bodyManual,
    notes:String(c?.notes || ''), notesOpen:!!c?.notesOpen, editMode:!!c?.editMode,
    relinkPending:!!opts?.pendingRelink || !!c?.relinkPending, relinkStatus:String(c?.relinkStatus || (opts?.pendingRelink ? 'pending-import' : '')),
    bodyWidth:String(c?.bodyWidth || ''), bodyHeight:String(c?.bodyHeight || ''),
    textStyle:storyNormalizeTextStyle(c?.textStyle || {})
  };
}
function normalizeImportedStoryRows(raw, opts={}){
  const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.storyRows) ? raw.storyRows : (Array.isArray(raw?.story_rows) ? raw.story_rows : (Array.isArray(raw?.rows) ? raw.rows : [])));
  if (!Array.isArray(rows) || !rows.length) return [];
  return rows.map(r => ({
    id:String(r?.id || makeStoryRowId()),
    notes:String(r?.notes || ''),
    status:String(r?.status || 'draft'),
    cards:Array.isArray(r?.cards) ? r.cards.map(c => normalizeImportedStoryCard(c, opts)) : []
  })).filter(r => Array.isArray(r.cards));
}
function readStoryJsonViaInput(){
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return resolve(null);
      try{
        const text = await file.text();
        resolve({ text, name:file.name });
      }catch(err){ reject(err); }
    }, { once:true });
    document.body.appendChild(input);
    input.click();
  });
}
async function importStoryJsonFile(){
  let picked = null;
  if (window.showOpenFilePicker){
    try{
      const [handle] = await window.showOpenFilePicker({
        multiple:false,
        types:[{ description:'Story JSON', accept:{ 'application/json':['.json'] } }]
      });
      const file = await handle.getFile();
      picked = { text: await file.text(), name:file.name };
    }catch(err){
      if (err?.name === 'AbortError') return;
      console.warn('showOpenFilePicker failed; falling back to input picker.', err);
    }
  }
  if (!picked) picked = await readStoryJsonViaInput();
  if (!picked) return;
  let parsed;
  try{ parsed = JSON.parse(picked.text); }catch(_e){ throw new Error('Invalid JSON file.'); }
  const rows = normalizeImportedStoryRows(parsed, { forceSnapshotBody:true, pendingRelink:true });
  const cardCount = rows.reduce((n,r)=>n+(r.cards?.length||0),0);
  if (!rows.length || !cardCount) throw new Error('No Story Mode rows/cards found in this JSON file.');
  const replace = !storyRows.length || confirm(`Import ${cardCount} Story Card(s) from ${picked.name || 'JSON'}?

OK = Replace current Story Mode
Cancel = Append to current Story Mode`);
  const relinkStats = storyRelinkImportedStoryRows(rows, { force:true, preserveSnapshotBody:true });
  if (replace) storyRows = rows;
  else storyRows.push(...rows);
  ensureStorySeed();
  renderStoryAssembly();
  storyCommitSharedState(true);
  const relinkMsg = relinkStats.pending
    ? ` ${relinkStats.pending} card(s) are pending transcript relink.`
    : ` ${relinkStats.linked} card(s) linked to live cues; ${relinkStats.generic} kept as generic.`;
  setStatusSafe?.(`Imported ${cardCount} Story Card(s) from JSON.${relinkMsg}`);
}
function hideStoryMode(){
  if (storyModeEl) storyModeEl.style.display = 'none';
  hideStoryAddMenu();
  hideStoryModal();
  if (!isTimelineMode) setTranscriptWorkAreaHidden(false);
}
function showStoryMode(){
  ensureStoryMode();
  ensureStorySeed();
  setTranscriptWorkAreaHidden(true);
  if (singleWrap) singleWrap.style.display = 'none';
  if (dualWrap){ dualWrap.hidden = true; dualWrap.style.display = 'none'; }
  if (transcriptEl) transcriptEl.style.display = 'none';
  if (txtBoxEl) txtBoxEl.style.display = 'none';
  if (txtDualWrapEl){ txtDualWrapEl.hidden = true; txtDualWrapEl.style.display = 'none'; }
  const findBar = document.getElementById('transcriptFindBar');
  if (findBar) findBar.style.display = 'none';
  const singleBar = document.getElementById('singleSubBar');
  if (singleBar) singleBar.style.display = 'none';
  storyModeEl.style.display = 'flex';
  storyActiveSubTrack = normalizeStoryTrack(subsMode || storyActiveSubTrack || 'A');
  syncStoryTopSubControls();
  renderStoryAssembly();
}
function ensureStoryMode(){
  if (storyModeEl && document.body.contains(storyModeEl)) return storyModeEl;
  const parent = document.querySelector('.transcript-panel') || document.body;
  storyModeEl = document.createElement('div');
  storyModeEl.id = 'storyMode';
  storyModeEl.className = 'story-mode';
  storyModeEl.style.display = 'none';
  storyModeEl.innerHTML = `
    <div class="story-head">
      <div>
        <div class="story-title">Story Mode</div>
        <div class="story-sub">Build the assembly vertically. Each row is a sequence beat. Story Cards always stack top-to-bottom.</div>
      </div>
      <div class="story-actions">
        <label class="story-sub-top">SUBS <select id="storySubModeTop" class="subs-mode"><option value="A">Sub A</option><option value="B">Sub B</option></select></label>
        <button class="btn btn-outline" id="storyAddFromSelection" type="button">Add Selection</button>
        <button class="btn btn-outline" id="storyAddRow" type="button">Add Row</button>
        <button class="btn btn-gold" id="storyExportTimeline" type="button">Export to Timeline</button>
        <button class="btn btn-outline" id="storyExportGoogleDoc" type="button">Export to Google Doc</button>
        <button class="btn btn-outline" id="storyImportGoogleDoc" type="button">Fetch from Google Doc</button>
        <button class="btn btn-outline" id="storyImportJson" type="button">Import JSON</button>
        <button class="btn btn-outline" id="storyExportJson" type="button">Export JSON</button>
      </div>
    </div>
    <div class="story-help">Tip: select transcript cues, Ctrl+C, then paste here. Cue cards stay live-linked to In / Out timecodes and editable text.</div>
    <div class="story-float-toolbar is-hidden" id="storyFloatToolbar" aria-label="Story text formatting toolbar">
      <select class="story-toolbar-font" data-story-toolbar="fontName" title="Font">
        <option value="Arial">Arial</option><option value="Helvetica">Helvetica</option><option value="Times New Roman">Times New Roman</option><option value="Georgia">Georgia</option><option value="Courier New">Courier New</option>
      </select>
      <span class="story-toolbar-sep"></span>
      <button type="button" data-story-toolbar="font-smaller" title="Decrease font size">−</button>
      <input class="story-toolbar-size" data-story-toolbar="fontSize" type="number" min="8" max="72" step="1" value="11" title="Font size">
      <button type="button" data-story-toolbar="font-larger" title="Increase font size">+</button>
      <span class="story-toolbar-sep"></span>
      <button type="button" data-story-toolbar="bold" title="Bold"><b>B</b></button>
      <button type="button" data-story-toolbar="italic" title="Italic"><i>I</i></button>
      <button type="button" data-story-toolbar="underline" title="Underline"><u>U</u></button>
      <button type="button" data-story-toolbar="strikeThrough" title="Strikethrough"><s>S</s></button>
      <button type="button" data-story-toolbar="removeFormat" title="Clear formatting">Tx</button>
      <label class="story-toolbar-color" title="Text color"><span>A</span><input type="color" data-story-toolbar="foreColor" value="#202124"></label>
      <label class="story-toolbar-color story-toolbar-highlight" title="Highlight color"><span>▰</span><input type="color" data-story-toolbar="hiliteColor" value="#fff475"></label>
      <button type="button" data-story-toolbar="link" title="Insert link">🔗</button>
      <span class="story-toolbar-sep"></span>
      <button type="button" data-story-toolbar="insert-row-above" title="Insert row above current card">Row ↑</button>
      <button type="button" data-story-toolbar="insert-row-below" title="Insert row below current card">Row ↓</button>
    </div>
    <div class="story-assembly" id="storyAssembly" tabindex="0"></div>
  `;
  parent.appendChild(storyModeEl);
  storyModeEl.querySelector('#storyAddRow')?.addEventListener('click', () => { if (VIEW_ONLY_SESSION) return; storyRows.push(createStoryRow()); renderStoryAssembly(); storyCommitSharedState(true); });
  storyModeEl.querySelector('#storyAddFromSelection')?.addEventListener('click', () => { addCurrentSelectionToStory(); });
  storyModeEl.querySelector('#storyExportTimeline')?.addEventListener('click', () => { exportStoryToTimeline(); });
  storyModeEl.querySelector('#storyExportGoogleDoc')?.addEventListener('click', () => { exportStoryToGoogleDocBackup().catch(err => alert('Google Doc export failed: ' + (err?.message || err))); });
  storyModeEl.querySelector('#storyImportGoogleDoc')?.addEventListener('click', () => { fetchStoryFromGoogleDocBackup().catch(err => alert('Google Doc fetch failed: ' + (err?.message || err))); });
  storyModeEl.querySelector('#storySubModeTop')?.addEventListener('change', (ev) => setStoryTimelineSubMode(ev.target.value));
  storyModeEl.querySelector('#storyImportJson')?.addEventListener('click', () => importStoryJsonFile().catch(err => alert('Story JSON import failed: ' + (err?.message || err))));
  storyModeEl.querySelector('#storyExportJson')?.addEventListener('click', async () => {
    const payload = exportStoryJsonPayload();
    await saveTextFile((suggestBaseName?.() || 'story') + '_story_assembly.json', JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  });
  const toolbar = storyModeEl.querySelector('#storyFloatToolbar');
  toolbar?.addEventListener('mousedown', ev => {
    if (ev.target?.matches?.('select,input')) return;
    ev.preventDefault();
  });
  toolbar?.addEventListener('click', onStoryToolbarClick);
  toolbar?.addEventListener('input', onStoryToolbarChange);
  toolbar?.addEventListener('change', onStoryToolbarChange);
  storyInstallSelectionToolbarHandlers();
  const assembly = storyModeEl.querySelector('#storyAssembly');
  assembly?.addEventListener('paste', onStoryPaste);
  assembly?.addEventListener('dragstart', onStoryDragStart);
  assembly?.addEventListener('dragover', ev => {
    const isRowDrag = storyIsRowDragEvent(ev);
    if (isRowDrag){ ev.preventDefault(); storyMarkRowDropTarget(ev); return; }
    ev.preventDefault(); assembly.classList.add('is-drop');
  });
  assembly?.addEventListener('dragleave', ev => { if (!ev.relatedTarget || !assembly.contains(ev.relatedTarget)){ assembly.classList.remove('is-drop'); storyClearRowDropTargets(); } });
  assembly?.addEventListener('drop', ev => { assembly.classList.remove('is-drop'); storyClearRowDropTargets(); onStoryDrop(ev); });
  assembly?.addEventListener('dragend', () => { storyDraggingRowId = ''; storyClearRowDropTargets(); });
  assembly?.addEventListener('input', onStoryInput);
  assembly?.addEventListener('change', onStoryChange);
  assembly?.addEventListener('click', onStoryClick);
  assembly?.addEventListener('contextmenu', onStoryContextMenu);
  assembly?.addEventListener('focusin', onStoryFocusIn);
  assembly?.addEventListener('focusout', ev => storyOnStoryFocusOut(ev));
  assembly?.addEventListener('keyup', onStoryKeyup);
  assembly?.addEventListener('keydown', onStoryKeydown);
  assembly?.addEventListener('pointerdown', ev => {
    const miniText = ev.target?.closest?.('.story-mini-text');
    if (!miniText) return;
    // Let the browser handle caret placement/text selection naturally, but mark
    // this as an active edit target so delayed sync work will not rebuild over it.
    miniText.dataset.editingNow = '1';
  }, true);
  return storyModeEl;
}
function getStoryTargetRowIdFromEvent(ev){ return ev.target?.closest?.('.story-row')?.dataset.rowId || storyDefaultRowId(); }
function getStoryRow(rowId){ return storyRows.find(r => r.id === rowId) || null; }
function storyDefaultRowId(){ ensureStorySeed(); return storyRows[storyRows.length - 1].id; }
function createGenericStoryCard(overrides={}){
  return { id:makeStoryCardId(), kind:'generic', title:'Generic Clip / Assignment', labelGroup:'shot', label:'B-roll', source:'', start:null, end:null, cueRefs:[], track:'A', body:'', notes:'', notesOpen:false, textStyle:storyNormalizeTextStyle(overrides.textStyle || {}), ...overrides };
}
function createCueStoryCard(payload={}){
  const track = normalizeStoryTrack(payload.track || 'A');
  const cueRefs = (payload.cueIds || payload.cueRefs || []).filter(Boolean);
  const source = payload.source || getCurrentStoryMediaLabel();
  return { id:makeStoryCardId(), kind:'cue', title:`${source}`, labelGroup:'shot', label:'Main Shot', track, cueRefs, sourceCueRefs:[...cueRefs], body:'', start:payload.start ?? null, end:payload.end ?? null, notes:'', notesOpen:false, textStyle:storyNormalizeTextStyle(payload.textStyle || {}) };
}
function createClipStoryCard(clip){
  const source = getCurrentStoryMediaLabel();
  const preferredTrack = normalizeStoryTrack(storyActiveSubTrack || subsMode || clip?.track || clip?.subtitleTrack || 'A');
  const resolved = storyClipCueRefs(clip, preferredTrack);
  const track = resolved.track;
  const cueRefs = storyUniqueRefs(resolved.cueRefs || []);
  const altCueRefs = resolved.altCueRefs || { A:track === 'A' ? [...cueRefs] : [], B:track === 'B' ? [...cueRefs] : [] };
  const label = (typeof getTimelineClipDisplayName === 'function') ? getTimelineClipDisplayName(clip, 0) : (clip?.label || 'Timeline Clip');
  const start = storyClipStart(clip);
  const end = storyClipEnd(clip);
  return { id:makeStoryCardId(), kind:'clip', title:(label || source), labelGroup:'shot', label:'Main Shot', source, clipId:String(clip?.id || ''), track, cueRefs, sourceCueRefs:[...cueRefs], altCueRefs:{ A:storyUniqueRefs(altCueRefs.A || []), B:storyUniqueRefs(altCueRefs.B || []) }, start:Number.isFinite(start) ? start : null, end:Number.isFinite(end) ? end : null, body:cueRefs.length ? '' : (label || ''), bodyManual:false, notes:'', notesOpen:false, textStyle:storyNormalizeTextStyle({}) };
}
function createCaptionStoryCard(type='Lower Third', text=''){
  return { id:makeStoryCardId(), kind:'caption', title:type, labelGroup:'caption', label:type, source:'', start:null, end:null, cueRefs:[], track:'A', body:text || '', notes:'', notesOpen:false, textStyle:storyNormalizeTextStyle({}) };
}
function addStoryCardToRow(rowId, card){
  const row = getStoryRow(rowId) || storyRows.at(-1) || (storyRows.push(createStoryRow()), storyRows.at(-1));
  row.cards.push(card);
  renderStoryAssembly();
  storyCommitSharedState(true);
}
function addStoryCardsToRow(rowId, cards){
  const row = getStoryRow(rowId) || storyRows.at(-1) || (storyRows.push(createStoryRow()), storyRows.at(-1));
  const clean = (Array.isArray(cards) ? cards : [cards]).filter(Boolean);
  if (!clean.length) return;
  row.cards.push(...clean);
  renderStoryAssembly();
  storyCommitSharedState(true);
}
function addCuePayloadToStory(payload, rowId=storyDefaultRowId()){
  if (!payload) return;
  const card = createCueStoryCard(payload);
  addStoryCardToRow(rowId, card);
}
function selectedCuePayloadFromSrtDom(){
  const sel = window.getSelection();
  return buildCueClipboardPayloadFromDomSelection(sel);
}
function selectedCuePayloadFromTxtDom(){
  const details = (typeof getTxtSelectionRangeDetails === 'function') ? getTxtSelectionRangeDetails() : null;
  return buildCueClipboardPayloadFromTxtSelection(details);
}
function addCurrentSelectionToStory(){
  try{ if (isTxtMode || document.querySelector('.txt-script-editor:focus-within')) { const p = selectedCuePayloadFromTxtDom(); if (p) return addCuePayloadToStory(p); } }catch(_e){}
  try{ const p = selectedCuePayloadFromSrtDom(); if (p) return addCuePayloadToStory(p); }catch(_e){}
  const t = (typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : 0;
  addStoryCardToRow(storyDefaultRowId(), createGenericStoryCard({ title:getCurrentStoryMediaLabel(), start:t, end:t + 5 }));
}
function storyFindCardEl(rowId, cardId){
  const safeRow = (window.CSS && CSS.escape) ? CSS.escape(String(rowId || '')) : String(rowId || '').replace(/"/g, '\"');
  const safeCard = (window.CSS && CSS.escape) ? CSS.escape(String(cardId || '')) : String(cardId || '').replace(/"/g, '\"');
  return storyModeEl?.querySelector?.(`.story-row[data-row-id="${safeRow}"] .story-card[data-card-id="${safeCard}"]`) || null;
}
function storySetActiveCard(rowId, cardId){
  if (!rowId || !cardId) return;
  storyActiveCardCtx = { rowId:String(rowId), cardId:String(cardId) };
  storyRefreshActiveCardDom();
}
function storyGetActiveCard(){
  if (!storyActiveCardCtx){
    const cardEl = document.activeElement?.closest?.('.story-card');
    const rowEl = cardEl?.closest?.('.story-row');
    if (rowEl && cardEl) storyActiveCardCtx = { rowId:rowEl.dataset.rowId, cardId:cardEl.dataset.cardId };
  }
  const row = getStoryRow(storyActiveCardCtx?.rowId);
  const card = row?.cards?.find(c => c.id === storyActiveCardCtx?.cardId) || null;
  return { row, card, rowId:row?.id || storyActiveCardCtx?.rowId || '', cardId:card?.id || storyActiveCardCtx?.cardId || '' };
}
function storyRefreshActiveCardDom(){
  storyModeEl?.querySelectorAll?.('.story-card.is-active').forEach(el => el.classList.remove('is-active'));
  const { row, card } = storyGetActiveCard();
  if (!row || !card) return;
  const cardEl = storyFindCardEl(row.id, card.id);
  cardEl?.classList.add('is-active');
  storyApplyTextStyleToCardEl(cardEl, card);
}
function storyMutateActiveCardStyle(mutator){
  // Kept for backward compatibility with older JSON/collab states.  The visible
  // toolbar now styles only the selected range in the rich Story Card body.
  const { row, card } = storyGetActiveCard();
  if (!row || !card || VIEW_ONLY_SESSION) return false;
  const st = storyNormalizeTextStyle(card.textStyle || {});
  mutator(st);
  card.textStyle = storyNormalizeTextStyle(st);
  storyApplyTextStyleToCardEl(storyFindCardEl(row.id, card.id), card);
  storyCommitSharedState();
  return true;
}
function storyInsertRowNearActive(where='below'){
  if (VIEW_ONLY_SESSION) return;
  const { row } = storyGetActiveCard();
  const idx = Math.max(0, storyRows.findIndex(r => r.id === row?.id));
  const at = where === 'above' ? idx : idx + 1;
  storyRows.splice(Math.min(Math.max(0, at), storyRows.length), 0, createStoryRow());
  storyHideSelectionToolbar();
  renderStoryAssembly();
  storyCommitSharedState(true);
}
function storySelectionEditableFromNode(node){
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  return el?.closest?.('.story-card-body[contenteditable="true"]') || null;
}
function storySelectionContextFromEditable(editable){
  const cardEl = editable?.closest?.('.story-card');
  const rowEl = editable?.closest?.('.story-row');
  const row = rowEl ? getStoryRow(rowEl.dataset.rowId) : null;
  const card = row && cardEl ? row.cards?.find(c => c.id === cardEl.dataset.cardId) : null;
  return { editable, cardEl, rowEl, row, card, rowId:row?.id || rowEl?.dataset?.rowId || '', cardId:card?.id || cardEl?.dataset?.cardId || '' };
}
function storyGetCurrentRichSelectionContext(){
  const sel = window.getSelection?.();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const editable = storySelectionEditableFromNode(range.commonAncestorContainer) || storySelectionEditableFromNode(sel.anchorNode) || storySelectionEditableFromNode(sel.focusNode);
  if (!editable || !storyModeEl?.contains(editable)) return null;
  if (!editable.contains(sel.anchorNode) || !editable.contains(sel.focusNode)) return null;
  const ctx = storySelectionContextFromEditable(editable);
  if (!ctx.row || !ctx.card) return null;
  return { ...ctx, range };
}
function storyHasSelectionInsideEditable(editable){
  const sel = window.getSelection?.();
  if (!sel || !sel.rangeCount || sel.isCollapsed || !editable) return false;
  return editable.contains(sel.anchorNode) && editable.contains(sel.focusNode);
}
function storySaveCurrentRichSelection(){
  const ctx = storyGetCurrentRichSelectionContext();
  if (!ctx) return null;
  storySavedRichSelection = { rowId:ctx.rowId, cardId:ctx.cardId, range:ctx.range.cloneRange() };
  storySetActiveCard(ctx.rowId, ctx.cardId);
  return storySavedRichSelection;
}
function storyRestoreSavedRichSelection(){
  if (!storySavedRichSelection?.range) return null;
  const cardEl = storyFindCardEl(storySavedRichSelection.rowId, storySavedRichSelection.cardId);
  const editable = cardEl?.querySelector?.('.story-card-body[contenteditable="true"]');
  if (!editable) return null;
  const sel = window.getSelection?.();
  if (!sel) return null;
  try{
    sel.removeAllRanges();
    sel.addRange(storySavedRichSelection.range);
    editable.focus({ preventScroll:true });
    return storySelectionContextFromEditable(editable);
  }catch(_e){ return null; }
}
function storyToolbarPositionNearSelection(){
  const toolbar = storyModeEl?.querySelector?.('#storyFloatToolbar');
  if (!toolbar || !storySavedRichSelection?.range) return;
  let rect = null;
  try{ rect = storySavedRichSelection.range.getBoundingClientRect(); }catch(_e){}
  if (!rect || (!rect.width && !rect.height)){
    const ctx = storyRestoreSavedRichSelection();
    rect = ctx?.editable?.getBoundingClientRect?.() || null;
  }
  if (!rect) return;
  toolbar.classList.remove('is-hidden');
  toolbar.classList.add('is-open');
  const pad = 8;
  const tbRect = toolbar.getBoundingClientRect();
  const width = tbRect.width || 520;
  const height = tbRect.height || 34;
  let left = rect.left + Math.min(Math.max(rect.width / 2, 0), 220) - width / 2;
  let top = rect.top - height - 10;
  if (top < pad) top = rect.bottom + 10;
  left = Math.max(pad, Math.min(left, window.innerWidth - width - pad));
  top = Math.max(pad, Math.min(top, window.innerHeight - height - pad));
  toolbar.style.left = `${Math.round(left)}px`;
  toolbar.style.top = `${Math.round(top)}px`;
}
function storyShowSelectionToolbar(){
  if (!storySaveCurrentRichSelection()) return storyHideSelectionToolbar();
  storyToolbarPositionNearSelection();
}
function storyHideSelectionToolbar(){
  const toolbar = storyModeEl?.querySelector?.('#storyFloatToolbar');
  if (!toolbar) return;
  toolbar.classList.add('is-hidden');
  toolbar.classList.remove('is-open');
}
function storyInstallSelectionToolbarHandlers(){
  if (storySelectionToolbarBound) return;
  storySelectionToolbarBound = true;
  document.addEventListener('selectionchange', () => {
    if (!isStoryMode || !storyModeEl) return;
    const toolbar = storyModeEl.querySelector('#storyFloatToolbar');
    const active = document.activeElement;
    if (toolbar?.contains(active)) return;
    const ctx = storyGetCurrentRichSelectionContext();
    if (ctx) storyShowSelectionToolbar();
    else if (!toolbar?.matches(':hover')) storyHideSelectionToolbar();
  });
  window.addEventListener('resize', () => { if (isStoryMode) storyToolbarPositionNearSelection(); });
  document.addEventListener('scroll', () => { if (isStoryMode) storyToolbarPositionNearSelection(); }, true);
  document.addEventListener('pointerdown', ev => {
    if (!isStoryMode || !storyModeEl) return;
    const toolbar = storyModeEl.querySelector('#storyFloatToolbar');
    if (toolbar?.contains(ev.target)) return;
    if (ev.target?.closest?.('.story-card-body[contenteditable="true"]')) return;
    setTimeout(storyHideSelectionToolbar, 0);
    if (!ev.target?.closest?.('#storyMode .story-card')) storyScheduleDeferredRowsApply(180, { force:true });
  }, true);
}
function storySyncRichBodyToCard(editable, { commit=true, reconcile=true } = {}){
  const ctx = storySelectionContextFromEditable(editable);
  const { row, card, cardEl } = ctx;
  if (!row || !card || !editable) return false;
  storySetActiveCard(row.id, card.id);
  const plain = storyGetRichBodyText(editable);
  card.body = plain;
  card.bodyHtml = storySanitizeRichHtml(editable.innerHTML || '');
  card.bodyManual = true;
  if (reconcile && (card.kind === 'cue' || (card.kind === 'clip' && (card.cueRefs || []).length))){
    const result = storyReconcileCueCardFromBody(row, card, plain);
    if (result.split){
      renderStoryAssembly();
      storyCommitSharedState(true);
      return true;
    }
    storyUpdateCardTimecodeDom(cardEl, card);
  }
  storyRememberTextareaSize(editable);
  if (commit) storyCommitSharedState();
  return true;
}
function storySelectedRangeIsInsideEditable(editable){
  const sel = window.getSelection?.();
  if (!sel || !sel.rangeCount || sel.isCollapsed || !editable) return false;
  return editable.contains(sel.anchorNode) && editable.contains(sel.focusNode);
}
function storyApplyInlineStyleToSelectedText(styleObj={}){
  if (VIEW_ONLY_SESSION) return;
  const ctx = storyRestoreSavedRichSelection();
  if (!ctx?.editable || !storySelectedRangeIsInsideEditable(ctx.editable) || isStoryCardRemoteLocked(ctx.cardId)) return;
  storyHandleFocusForCollab(ctx.editable);
  const sel = window.getSelection?.();
  if (!sel || !sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const span = document.createElement('span');
  Object.entries(styleObj || {}).forEach(([k, v]) => { if (v != null && v !== '') span.style[k] = String(v); });
  try{
    span.appendChild(range.extractContents());
    range.insertNode(span);
    const newRange = document.createRange();
    newRange.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(newRange);
  }catch(err){ console.warn('Story inline style failed:', err); return; }
  storySyncRichBodyToCard(ctx.editable, { commit:true, reconcile:true });
  storySaveCurrentRichSelection();
  storyToolbarPositionNearSelection();
}
function storyClearSelectedTextFormat(){
  if (VIEW_ONLY_SESSION) return;
  const ctx = storyRestoreSavedRichSelection();
  if (!ctx?.editable || isStoryCardRemoteLocked(ctx.cardId)) return;
  storyHandleFocusForCollab(ctx.editable);
  try{ document.execCommand('removeFormat', false, null); }catch(err){ console.warn('Story clear formatting failed:', err); }
  try{ document.execCommand('unlink', false, null); }catch(_e){}
  storySyncRichBodyToCard(ctx.editable, { commit:true, reconcile:true });
  storySaveCurrentRichSelection();
  storyToolbarPositionNearSelection();
}
function storyExecOnSelectedText(cmd, value=null){
  if (VIEW_ONLY_SESSION) return;
  if (cmd === 'fontSize') return storyApplyInlineStyleToSelectedText({ fontSize: Math.max(8, Math.min(72, Number(value) || 11)) + 'px' });
  if (cmd === 'fontName') return storyApplyInlineStyleToSelectedText({ fontFamily: value || 'Arial' });
  if (cmd === 'foreColor') return storyApplyInlineStyleToSelectedText({ color: value || '#202124' });
  if (cmd === 'hiliteColor' || cmd === 'backColor') return storyApplyInlineStyleToSelectedText({ backgroundColor: value || '#fff475' });
  if (cmd === 'removeFormat') return storyClearSelectedTextFormat();
  const ctx = storyRestoreSavedRichSelection();
  if (!ctx?.editable || isStoryCardRemoteLocked(ctx.cardId)) return;
  storyHandleFocusForCollab(ctx.editable);
  try{ document.execCommand('styleWithCSS', false, true); }catch(_e){}
  try{ document.execCommand(cmd, false, value); }catch(err){ console.warn('Story toolbar command failed:', cmd, err); }
  storySyncRichBodyToCard(ctx.editable, { commit:true, reconcile:true });
  storySaveCurrentRichSelection();
  storyToolbarPositionNearSelection();
}
function storyConvertExecFontSizeToPx(editable, px){
  const size = Math.max(8, Math.min(72, Number(px) || 11));
  editable.querySelectorAll('font[size="7"]').forEach(font => {
    const span = document.createElement('span');
    span.style.fontSize = size + 'px';
    span.innerHTML = font.innerHTML;
    font.replaceWith(span);
  });
}
function storyToolbarFontSizeValue(){
  const input = storyModeEl?.querySelector?.('[data-story-toolbar="fontSize"]');
  return Math.max(8, Math.min(72, Number(input?.value || 11) || 11));
}
function onStoryToolbarClick(ev){
  const btn = ev.target?.closest?.('button[data-story-toolbar]');
  if (!btn) return;
  ev.preventDefault();
  const cmd = btn.dataset.storyToolbar;
  if (cmd === 'insert-row-above') return storyInsertRowNearActive('above');
  if (cmd === 'insert-row-below') return storyInsertRowNearActive('below');
  if (cmd === 'bold') return storyExecOnSelectedText('bold');
  if (cmd === 'italic') return storyExecOnSelectedText('italic');
  if (cmd === 'underline') return storyExecOnSelectedText('underline');
  if (cmd === 'strikeThrough') return storyExecOnSelectedText('strikeThrough');
  if (cmd === 'removeFormat') return storyExecOnSelectedText('removeFormat');
  if (cmd === 'link'){
    const url = prompt('Paste link URL');
    if (!url) return;
    return storyExecOnSelectedText('createLink', url);
  }
  if (cmd === 'font-smaller' || cmd === 'font-larger'){
    const input = storyModeEl?.querySelector?.('[data-story-toolbar="fontSize"]');
    const next = Math.max(8, Math.min(72, storyToolbarFontSizeValue() + (cmd === 'font-larger' ? 1 : -1)));
    if (input) input.value = String(next);
    return storyExecOnSelectedText('fontSize', String(next));
  }
}
function onStoryToolbarChange(ev){
  const target = ev.target?.closest?.('[data-story-toolbar]');
  if (!target) return;
  const cmd = target.dataset.storyToolbar;
  if (cmd === 'fontName') return storyExecOnSelectedText('fontName', target.value || 'Arial');
  if (cmd === 'fontSize') return storyExecOnSelectedText('fontSize', String(storyToolbarFontSizeValue()));
  if (cmd === 'foreColor') return storyExecOnSelectedText('foreColor', target.value || '#202124');
  if (cmd === 'hiliteColor'){
    try{ return storyExecOnSelectedText('hiliteColor', target.value || '#fff475'); }
    catch(_e){ return storyExecOnSelectedText('backColor', target.value || '#fff475'); }
  }
}
function storyIsRowDragEvent(ev){
  try{ return !!storyDraggingRowId || Array.from(ev.dataTransfer?.types || []).includes('application/x-transcriber-story-row'); }catch(_e){ return !!storyDraggingRowId; }
}
function storyClearRowDropTargets(){
  storyModeEl?.querySelectorAll?.('.story-row.is-row-drop-target,.story-row.is-row-dragging').forEach(el => el.classList.remove('is-row-drop-target','is-row-dragging'));
}
function storyMarkRowDropTarget(ev){
  storyModeEl?.querySelectorAll?.('.story-row.is-row-drop-target').forEach(el => el.classList.remove('is-row-drop-target'));
  const rowEl = ev.target?.closest?.('.story-row');
  if (rowEl && rowEl.dataset.rowId !== storyDraggingRowId) rowEl.classList.add('is-row-drop-target');
}
function onStoryDragStart(ev){
  const handle = ev.target?.closest?.('.story-row-num[data-story-row-drag]');
  if (!handle || VIEW_ONLY_SESSION) return;
  const rowEl = handle.closest('.story-row');
  if (!rowEl) return;
  storyDraggingRowId = rowEl.dataset.rowId || '';
  rowEl.classList.add('is-row-dragging');
  ev.dataTransfer?.setData?.('application/x-transcriber-story-row', storyDraggingRowId);
  ev.dataTransfer?.setData?.('text/plain', storyDraggingRowId);
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
}
function storyMoveRowBeforeOrAfter(sourceId, targetId, ev){
  if (!sourceId || !targetId || sourceId === targetId) return false;
  const from = storyRows.findIndex(r => r.id === sourceId);
  const to0 = storyRows.findIndex(r => r.id === targetId);
  if (from < 0 || to0 < 0) return false;
  const [row] = storyRows.splice(from, 1);
  let to = storyRows.findIndex(r => r.id === targetId);
  const targetEl = storyModeEl?.querySelector?.(`.story-row[data-row-id="${CSS.escape(targetId)}"]`);
  if (targetEl && ev){
    const rect = targetEl.getBoundingClientRect();
    if (ev.clientY > rect.top + rect.height / 2) to += 1;
  }
  storyRows.splice(Math.max(0, Math.min(to, storyRows.length)), 0, row);
  storyActiveCardCtx = null;
  renderStoryAssembly();
  storyCommitSharedState(true);
  return true;
}
function onStoryPaste(ev){
  const clip = ev.clipboardData || window.clipboardData;
  const custom = clip?.getData?.('application/x-transcriber-cues');
  if (custom){
    try{ const payload = JSON.parse(custom); ev.preventDefault(); addCuePayloadToStory(payload, getStoryTargetRowIdFromEvent(ev)); return; }catch(_e){}
  }
  const txt = clip?.getData?.('text/plain') || '';
  const parsed = parseStoryTimecodedText(txt);
  if (parsed){ ev.preventDefault(); addStoryCardToRow(getStoryTargetRowIdFromEvent(ev), createGenericStoryCard({ title:getCurrentStoryMediaLabel(), labelGroup:'shot', label:'Main Shot', start:parsed.start, end:parsed.end, body:parsed.text })); }
}
function onStoryDrop(ev){
  ev.preventDefault();
  const rowDrag = ev.dataTransfer?.getData?.('application/x-transcriber-story-row') || storyDraggingRowId;
  if (rowDrag){
    const targetRow = ev.target?.closest?.('.story-row')?.dataset?.rowId || '';
    storyDraggingRowId = '';
    if (storyMoveRowBeforeOrAfter(rowDrag, targetRow, ev)) return;
  }
  const custom = ev.dataTransfer?.getData?.('application/x-transcriber-cues');
  if (custom){ try{ addCuePayloadToStory(JSON.parse(custom), getStoryTargetRowIdFromEvent(ev)); return; }catch(_e){} }
}
function parseStoryTimecodedText(txt){
  const m = String(txt || '').match(/(\d{2}:\d{2}:\d{2}:\d{2})\s*(?:-->|→|-)\s*(\d{2}:\d{2}:\d{2}:\d{2})\s*([\s\S]*)/);
  if (!m) return null;
  const start = parseDisplayedTcToSeconds(m[1]);
  const end = parseDisplayedTcToSeconds(m[2]);
  if (start == null || end == null) return null;
  return { start, end, text:(m[3] || '').trim() };
}
function buildCueClipboardPayloadFromDomSelection(sel){
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const bRoot = document.getElementById('transcriptB');
  const inB = (bRoot && (bRoot.contains(range.startContainer) || bRoot.contains(range.endContainer))) || selectionIsInside(range.startContainer, '#transcriptB') || selectionIsInside(range.endContainer, '#transcriptB');
  const track = inB ? 'B' : 'A';
  const listEl = inB ? bRoot : transcriptEl;
  const list = storyEnsureCueIds(track);
  const startIdx = getRowIndexFromNode(range.startContainer);
  const endIdx = getRowIndexFromNode(range.endContainer);
  if (startIdx < 0 || endIdx < 0) return null;
  const from = Math.max(0, Math.min(startIdx, endIdx));
  const to = Math.min(list.length - 1, Math.max(startIdx, endIdx));
  const cueIds = [];
  for (let i=from; i<=to; i++){ if (list[i]){ if (!list[i].id) list[i].id = makeCueId(); cueIds.push(list[i].id); } }
  if (!cueIds.length) return null;
  return { type:'transcriber/cue-selection', cueIds, track, start:list[from]?.start ?? null, end:list[to]?.end ?? null, source:getCurrentStoryMediaLabel() };
}
function buildCueClipboardPayloadFromTxtSelection(details){
  if (!details || details.selectionStartIndex == null || details.selectionEndIndex == null) return null;
  const track = normalizeStoryTrack(details.track || getTxtSingleTrack?.() || 'A');
  const list = storyEnsureCueIds(track);
  const from = Math.max(0, Math.min(Number(details.selectionStartIndex), Number(details.selectionEndIndex)));
  const to = Math.min(list.length - 1, Math.max(Number(details.selectionStartIndex), Number(details.selectionEndIndex)));
  if (from < 0 || to < from) return null;
  const cueIds = [];
  for (let i=from; i<=to; i++){ if (list[i]){ if (!list[i].id) list[i].id = makeCueId(); cueIds.push(list[i].id); } }
  if (!cueIds.length) return null;
  return { type:'transcriber/cue-selection', cueIds, track, start:list[from]?.start ?? null, end:list[to]?.end ?? null, source:getCurrentStoryMediaLabel() };
}
function installStoryClipboardBridge(){
  if (window.__storyClipboardBridgeInstalled) return;
  window.__storyClipboardBridgeInstalled = true;
  document.addEventListener('copy', (ev) => {
    try{
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || !shouldInterceptCopy(sel)) return;
      const payload = buildCueClipboardPayloadFromDomSelection(sel);
      if (!payload) return;
      ev.clipboardData?.setData?.('application/x-transcriber-cues', JSON.stringify(payload));
    }catch(_e){}
  }, true);
  document.addEventListener('dragstart', (ev) => {
    try{
      const row = ev.target?.closest?.('.line');
      if (!row) return;
      const idx = Number(row.dataset.index || -1);
      const track = row.closest('#transcriptB') ? 'B' : 'A';
      const list = storyEnsureCueIds(track);
      if (!list[idx]) return;
      if (!list[idx].id) list[idx].id = makeCueId();
      const payload = { type:'transcriber/cue-selection', cueIds:[list[idx].id], track, start:list[idx].start, end:list[idx].end, source:getCurrentStoryMediaLabel() };
      ev.dataTransfer?.setData?.('application/x-transcriber-cues', JSON.stringify(payload));
    }catch(_e){}
  }, true);
}
installStoryClipboardBridge();
function storyTextForCard(card){
  if (!card) return '';
  if (card.kind === 'cue'){
    if (card.bodyManual) return card.body || storyPlainTextFromRichHtml(card.bodyHtml || '') || '';
    const track = storyEffectiveTrack(card);
    const range = storyCueRange(storyEffectiveCueRefs(card), track);
    return (range?.cues || []).map(c => c.text || '').join('\n');
  }
  if (card.kind === 'clip'){
    storyRefreshClipCardCueLinks(card);
    const clip = storyClipById(card.clipId);
    let refs = storyEffectiveCueRefs(card).filter(Boolean);
    if (!refs.length && clip && !card.bodyManual){
      const resolved = storyClipCueRefs(clip, card.track);
      refs = resolved.cueRefs;
      if (refs.length){ card.track = resolved.track; card.cueRefs = refs; card.sourceCueRefs = [...refs]; card.altCueRefs = resolved.altCueRefs || card.altCueRefs; card.body = ''; card.bodyManual = false; }
    }
    if (refs.length){
      if (card.bodyManual) return card.body || storyPlainTextFromRichHtml(card.bodyHtml || '') || '';
      const range = storyCueRange(refs, storyEffectiveTrack(card));
      return (range?.cues || []).map(c => c.text || '').join('\n');
    }
    return card.body || clip?.label || '';
  }
  return card.body || '';
}
function storyApplyTextareaSizing(root=storyModeEl){
  const scope = root || document;
  scope.querySelectorAll?.('.story-card-body').forEach(el => {
    const row = el.closest('.story-row');
    const cardEl = el.closest('.story-card');
    const card = row && cardEl ? getStoryRow(row.dataset.rowId)?.cards?.find(c => c.id === cardEl.dataset.cardId) : null;
    if (card?.bodyWidth) el.style.width = card.bodyWidth;
    if (card?.bodyHeight) el.style.height = card.bodyHeight;
    else {
      el.style.height = 'auto';
      const minH = el.classList?.contains('story-card-richbody') ? 48 : 118;
      el.style.height = Math.max(minH, el.scrollHeight + 4) + 'px';
    }
  });
}
function storyRememberTextareaSize(el){
  const rowEl = el?.closest?.('.story-row');
  const cardEl = el?.closest?.('.story-card');
  const row = rowEl ? getStoryRow(rowEl.dataset.rowId) : null;
  const card = row && cardEl ? row.cards.find(c => c.id === cardEl.dataset.cardId) : null;
  if (!card) return;
  const rect = el.getBoundingClientRect();
  if (rect.width > 20) card.bodyWidth = Math.round(rect.width) + 'px';
  if (rect.height > 20) card.bodyHeight = Math.round(rect.height) + 'px';
}
function storyBindTextareaResizeRemembering(){
  if (window.__storyTextareaResizeBound) return;
  window.__storyTextareaResizeBound = true;
  document.addEventListener('mouseup', () => {
    document.querySelectorAll('.story-card-body').forEach(el => storyRememberTextareaSize(el));
  }, true);
}
storyBindTextareaResizeRemembering();
function storyInstallCardSelectionStability(){
  if (window.__storyCardSelectionStabilityBound) return;
  window.__storyCardSelectionStabilityBound = true;
  document.addEventListener('pointerdown', ev => {
    const ta = ev.target?.closest?.('.story-card-body');
    if (!ta) return;
    ta.__storyPointerStart = { x: ev.clientX, y: ev.clientY };
    ta.__storySelectingText = false;
  }, true);
  document.addEventListener('pointermove', ev => {
    const ta = ev.target?.closest?.('.story-card-body') || document.activeElement?.closest?.('.story-card-body');
    if (!ta || !ta.__storyPointerStart) return;
    if (Math.abs(ev.clientX - ta.__storyPointerStart.x) + Math.abs(ev.clientY - ta.__storyPointerStart.y) > 6){
      ta.__storySelectingText = true;
    }
  }, true);
  document.addEventListener('pointerup', ev => {
    const ta = ev.target?.closest?.('.story-card-body') || document.activeElement?.closest?.('.story-card-body');
    if (!ta) return;
    setTimeout(() => {
      const selected = storyHasSelectionInsideEditable(ta);
      ta.__storySelectingText = selected ? true : false;
      ta.__storyPointerStart = null;
    }, 0);
  }, true);
}
storyInstallCardSelectionStability();
window.addEventListener('beforeunload', () => { try{ sendStoryCardUnlock(COLLAB_STORY_LOCKED_CARD_ID); }catch(_e){} });
function storyRefreshClipCardCueLinks(card){
  if (!card || card.kind !== 'clip' || card.bodyManual) return;
  const hasAnyRefs = (Array.isArray(card.cueRefs) && card.cueRefs.length)
    || (Array.isArray(card.sourceCueRefs) && card.sourceCueRefs.length)
    || (card.altCueRefs && ((Array.isArray(card.altCueRefs.A) && card.altCueRefs.A.length) || (Array.isArray(card.altCueRefs.B) && card.altCueRefs.B.length)));
  if (hasAnyRefs) return;
  const clip = storyClipById(card.clipId);
  const start = clip ? storyClipStart(clip) : Number(card.start);
  const end = clip ? storyClipEnd(clip) : Number(card.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  const resolved = storyCueRefBundleForRange(start, end, card.track || storyActiveSubTrack || subsMode || 'A');
  if (!resolved.cueRefs.length && !resolved.altCueRefs.A.length && !resolved.altCueRefs.B.length) return;
  card.track = resolved.track;
  card.cueRefs = storyUniqueRefs(resolved.cueRefs || []);
  card.sourceCueRefs = [...card.cueRefs];
  card.altCueRefs = { A:storyUniqueRefs(resolved.altCueRefs.A || []), B:storyUniqueRefs(resolved.altCueRefs.B || []) };
  card.body = '';
}
function storyNormalizeCardsBeforeRender(){
  storyRows.forEach(row => (row.cards || []).forEach(card => {
    card.textStyle = storyNormalizeTextStyle(card.textStyle || {});
    if (card.relinkPending) storyRelinkImportedStoryCard(card, { preserveSnapshotBody:true });
    if (card.kind === 'clip') storyRefreshClipCardCueLinks(card);
    if ((card.kind === 'cue' || card.kind === 'clip') && (!Array.isArray(card.sourceCueRefs) || !card.sourceCueRefs.length) && Array.isArray(card.cueRefs)){
      card.sourceCueRefs = [...card.cueRefs];
    }
  }));
}

function updateStoryPlaybackActiveState(t){
  if (!storyModeEl || !isStoryMode) return;
  const time = Math.max(0, Number(t) || 0);
  // Story Mode used to call renderStoryAssembly() on every media timeupdate.
  // That rebuilt the whole table several times per second, collapsing rich-text
  // selections and making collab markers/buttons flash. Mirror SRT/TXT modes:
  // only toggle lightweight active classes on existing DOM nodes.
  storyModeEl.querySelectorAll('.story-card.story-playhead-active,.story-mini-cue.story-playhead-active').forEach(el => el.classList.remove('story-playhead-active'));
  storyRows.forEach(row => (row.cards || []).forEach(card => {
    if (!card || !(card.kind === 'cue' || card.kind === 'clip')) return;
    const refs = storyEffectiveCueRefs(card);
    const track = storyEffectiveTrack(card);
    let hitCue = null;
    for (const id of refs){
      const cue = storyCueById(id, track);
      if (cue && time >= Number(cue.start || 0) && time <= Number(cue.end || 0)){ hitCue = cue; break; }
    }
    const range = refs.length ? storyCueRange(refs, track) : storyCardPlaybackRange(card);
    const inCard = hitCue || (range && time >= Number(range.start || 0) && time <= Number(range.end || 0));
    if (!inCard) return;
    const cardEl = storyFindCardEl(row.id, card.id);
    if (cardEl) cardEl.classList.add('story-playhead-active');
    if (hitCue && cardEl){
      const cueEl = cardEl.querySelector(`.story-mini-cue[data-cue-id="${CSS.escape(String(hitCue.id || ''))}"]`);
      if (cueEl) cueEl.classList.add('story-playhead-active');
    }
  }));
}

function storySelectionIsInsideMode(){
  try{
    const sel = window.getSelection?.();
    if (!sel || !sel.rangeCount || sel.isCollapsed || !storyModeEl) return false;
    for (let i = 0; i < sel.rangeCount; i++){
      const r = sel.getRangeAt(i);
      if (storyModeEl.contains(r.startContainer) || storyModeEl.contains(r.endContainer)) return true;
    }
  }catch(_e){}
  return false;
}
function storyIsEditingOrSelecting(){
  if (!isStoryMode || !storyModeEl) return false;
  const active = document.activeElement;
  if (active && active.closest && active.closest('#storyMode .story-card')) return true;
  if (storySelectionIsInsideMode()) return true;
  const toolbar = storyModeEl.querySelector('#storyFloatToolbar');
  if (toolbar && !toolbar.classList.contains('is-hidden') && (toolbar.matches(':hover') || toolbar.contains(active))) return true;
  return false;
}
function storyQueueRemoteRows(rows){
  if (!Array.isArray(rows)) return false;
  COLLAB_STORY_DEFERRED_ROWS = rows;
  storyScheduleDeferredRowsApply();
  return true;
}
function storyHasActiveStoryEditFocus(){
  if (!isStoryMode || !storyModeEl) return false;
  const active = document.activeElement;
  return !!(active && active.closest && active.closest('#storyMode .story-card'));
}
function storySyncVisibleStoryEditors({ commit=false } = {}){
  if (!storyModeEl) return;
  try{ storySyncAllRichBodiesToCards({ commit, reconcile:false }); }catch(_e){}
  storyModeEl.querySelectorAll?.('.story-card').forEach(cardEl => {
    const rowEl = cardEl.closest('.story-row');
    const { row, card } = storyFindCard(rowEl?.dataset?.rowId, cardEl.dataset.cardId);
    if (!row || !card) return;
    const title = cardEl.querySelector('.story-card-title');
    const notes = cardEl.querySelector('.story-card-notes');
    if (title) card.title = title.value || '';
    if (notes) card.notes = notes.value || '';
  });
}
function storyOnStoryFocusOut(ev){
  // When focus leaves a Story Card, apply any queued remote Story rows quickly.
  // A text selection can remain inside a blurred contenteditable, so do not use
  // the selection-only guard here; otherwise remote changes can stay queued forever.
  const next = ev?.relatedTarget || null;
  if (next && next.closest && (next.closest('#storyMode .story-card') || next.closest('#storyFloatToolbar'))) return;
  setTimeout(() => {
    if (storyHasActiveStoryEditFocus()) return;
    storySyncVisibleStoryEditors({ commit:false });
    storyScheduleDeferredRowsApply(40, { force:true });
  }, 180);
}
function storyScheduleDeferredRowsApply(delay=900, opts={}){
  if (COLLAB_STORY_DEFERRED_TIMER) clearTimeout(COLLAB_STORY_DEFERRED_TIMER);
  COLLAB_STORY_DEFERRED_TIMER = setTimeout(() => {
    COLLAB_STORY_DEFERRED_TIMER = null;
    storyApplyDeferredRemoteRows(opts);
  }, delay);
}
function storyApplyDeferredRemoteRows(opts={}){
  if (!COLLAB_STORY_DEFERRED_ROWS) return false;
  const force = !!opts.force;
  if (!force && storyIsEditingOrSelecting()){
    storyScheduleDeferredRowsApply(1200);
    return false;
  }
  if (force && storyHasActiveStoryEditFocus()){
    storyScheduleDeferredRowsApply(600, { force:true });
    return false;
  }
  const rows = COLLAB_STORY_DEFERRED_ROWS;
  COLLAB_STORY_DEFERRED_ROWS = null;
  storySyncVisibleStoryEditors({ commit:false });
  applySharedStoryRows(rows, { remoteUpdate:true });
  try{ COLLAB_LAST_HASH = hashSessionState(buildShareSessionState()); }catch(_e){}
  try{ setCollabSyncStatus?.('updated'); }catch(_e){}
  return true;
}
function scheduleApplyStoryCollabAwareness(){
  if (!isStoryMode) return;
  if (COLLAB_STORY_AWARENESS_TIMER) return;
  COLLAB_STORY_AWARENESS_TIMER = requestAnimationFrame(() => {
    COLLAB_STORY_AWARENESS_TIMER = null;
    applyStoryCollabAwareness();
  });
}

function renderStoryAssembly(){
  storyNormalizeCardsBeforeRender();
  const host = storyModeEl?.querySelector('#storyAssembly');
  if (!host) return;
  ensureStorySeed();
  host.innerHTML = storyRows.map((row, idx) => `
    <section class="story-row" data-row-id="${escapeStoryAttr(row.id)}">
      <div class="story-row-num" draggable="${VIEW_ONLY_SESSION ? 'false' : 'true'}" data-story-row-drag="1" title="Drag to reorder this story row">${idx + 1}</div>
      <div class="story-row-main">
        <div class="story-card-stack">
          ${(row.cards || []).map(card => renderStoryCard(row, card)).join('')}
          <button class="story-add-card" data-story-action="open-add-menu" type="button"${VIEW_ONLY_SESSION ? ' disabled' : ''}>+ Cues / Clips / Captions / Cards</button>
        </div>
        <div class="story-row-tools"><button class="btn btn-mini" data-story-action="move-row-up" type="button"${VIEW_ONLY_SESSION ? ' disabled' : ''}>↑ Row</button><button class="btn btn-mini" data-story-action="move-row-down" type="button"${VIEW_ONLY_SESSION ? ' disabled' : ''}>↓ Row</button><button class="btn btn-mini" data-story-action="delete-row" type="button"${VIEW_ONLY_SESSION ? ' disabled' : ''}>Delete Row</button></div>
      </div>
    </section>
  `).join('');
  storyApplyTextareaSizing(host);
  storyRefreshActiveCardDom();
  applyStoryCollabAwareness();
}

function storyRenderMiniTranscript(row, card){
  const refs = storyEffectiveCueRefs(card);
  const track = storyEffectiveTrack(card);
  const cues = refs.map(id => storyCueById(id, track)).filter(Boolean);
  if (!cues.length) return '<div class="story-mini-empty">No linked cues in this card.</div>';
  return `
    <div class="story-mini-transcript" data-story-mini="1">
      <div class="story-mini-head"><span>Mini Transcript · Track ${escapeHtml(track)}</span><button class="btn btn-gold btn-mini" data-story-action="done-mini-transcript" type="button">Done</button></div>
      <div class="story-mini-list">
        ${cues.map((cue, i) => {
          const idx = getCueIndexById(cue.id, track);
          return `<div class="story-mini-cue" data-cue-id="${escapeStoryAttr(cue.id)}" data-cue-index="${idx}" data-track="${escapeStoryAttr(track)}">
            <button class="story-mini-time" data-story-action="edit-mini-time" title="Click to edit cue In / Out" type="button">${fmtTC(cue.start)} → ${fmtTC(cue.end)}</button>
            <div class="story-mini-text" style="${escapeStoryAttr(storyCardBodyInlineStyle(card))}" contenteditable="${VIEW_ONLY_SESSION ? 'false' : 'true'}" tabindex="0" spellcheck="false">${escapeHtml(cue.text || '')}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}
function storyFindCard(rowId, cardId){
  const row = getStoryRow(rowId);
  const card = row?.cards?.find(c => c.id === cardId);
  return { row, card };
}
let __storyMiniSyncTimer = null;
function storyScheduleExternalCueSync(){
  if (__storyMiniSyncTimer) clearTimeout(__storyMiniSyncTimer);
  __storyMiniSyncTimer = setTimeout(() => {
    __storyMiniSyncTimer = null;
    // Do not rebuild other transcript surfaces while the user's caret is inside
    // the Story mini transcript. Rebuilding can steal focus/selection in Chrome.
    if (document.activeElement?.closest?.('.story-mini-text')) return;
    try{ renderBySubsMode?.(); }catch(_e){}
    try{ updateTxtBox?.(); }catch(_e){}
  }, 500);
}
function storyUpdateCueFromMiniText(cueId, track, text){
  const cue = storyCueById(cueId, track);
  if (!cue) return;
  cue.text = String(text ?? '');
  try{ updateOverlay?.(getActiveIndex?.(getMediaCurrentTime?.() || 0, track), track); }catch(_e){}
  // Keep the edit live in data immediately, but avoid immediate full transcript
  // re-render so the mini editor caret/selection remains stable.
  storyScheduleExternalCueSync();
  storyCommitSharedState();
}
function sendCollabStoryCursor(rowId, cardId, cueId='', mode='card', opts={}){
  if (!COLLAB_SESSION_ID || VIEW_ONLY_SESSION || !rowId || !cardId) return;
  const now = Date.now();
  if (!opts.force && now - COLLAB_STORY_LAST_CURSOR_MS < 350) return;
  COLLAB_STORY_LAST_CURSOR_MS = now;
  sendCollabEvent({ type:'story_cursor_update', row_id:rowId, card_id:cardId, cue_id:cueId || '', mode });
}
function sendStoryCardLock(rowId, cardId, action='edit'){
  if (!rowId || !cardId || !COLLAB_SESSION_ID || !COLLAB_USER_ID || VIEW_ONLY_SESSION) return false;
  const now = Date.now();
  if (COLLAB_STORY_LOCKED_CARD_ID === String(cardId) && now - COLLAB_STORY_LOCK_LAST_SEND_MS < 2500) return true;
  COLLAB_STORY_LOCKED_CARD_ID = String(cardId);
  COLLAB_STORY_LOCK_LAST_SEND_MS = now;
  sendCollabEvent({ type:'lock_story_card', row_id:String(rowId), card_id:String(cardId), action:String(action || 'edit') });
  return true;
}
function sendStoryCardUnlock(cardId=COLLAB_STORY_LOCKED_CARD_ID){
  if (!cardId || !COLLAB_SESSION_ID || !COLLAB_USER_ID || VIEW_ONLY_SESSION) return false;
  if (String(cardId) === String(COLLAB_STORY_LOCKED_CARD_ID)) COLLAB_STORY_LOCKED_CARD_ID = '';
  sendCollabEvent({ type:'unlock_story_card', card_id:String(cardId) });
  return true;
}
function getStoryRemoteLock(cardId){
  const lock = COLLAB_STORY_LOCKS ? COLLAB_STORY_LOCKS[String(cardId || '')] : null;
  if (!lock || lock.user_id === COLLAB_USER_ID) return null;
  return lock;
}
function isStoryCardRemoteLocked(cardId){ return !!getStoryRemoteLock(cardId); }
function storyRowHasRemoteLock(row){
  return !!(row && Array.isArray(row.cards) && row.cards.some(c => isStoryCardRemoteLocked(c.id)));
}
function applyStoryLocksFromList(locks){
  COLLAB_STORY_LOCKS = {};
  (locks || []).forEach(l => {
    if (!l || l.user_id === COLLAB_USER_ID) return;
    if (l.kind === 'story_card' || l.card_id){
      COLLAB_STORY_LOCKS[String(l.card_id || '')] = l;
    }
  });
  if (isStoryMode) applyStoryCollabAwareness();
}
function storyHandleFocusForCollab(target, opts={}){
  if (!target || VIEW_ONLY_SESSION) return;
  const cardEl = target.closest?.('.story-card');
  const rowEl = target.closest?.('.story-row');
  if (!cardEl || !rowEl) return;
  const cardId = cardEl.dataset.cardId || '';
  const rowId = rowEl.dataset.rowId || '';
  if (isStoryCardRemoteLocked(cardId)) return;
  storySetActiveCard(rowId, cardId);
  if (COLLAB_STORY_LOCKED_CARD_ID && COLLAB_STORY_LOCKED_CARD_ID !== cardId) sendStoryCardUnlock(COLLAB_STORY_LOCKED_CARD_ID);
  sendStoryCardLock(rowId, cardId, 'edit');
  const mini = target.closest?.('.story-mini-cue');
  sendCollabStoryCursor(rowId, cardId, mini?.dataset?.cueId || '', mini ? 'mini' : 'card', { force: !!opts.force });
}
function storyScheduleUnlockIfBlurred(cardId){
  if (!cardId) return;
  setTimeout(() => {
    const activeCard = document.activeElement?.closest?.('.story-card');
    if (!activeCard || activeCard.dataset.cardId !== String(cardId)){
      sendStoryCardUnlock(cardId);
    }
  }, 450);
}
function applyStoryCollabAwareness(){
  if (!storyModeEl || !isStoryMode) return;
  ensureCollabAwarenessStyle();
  storyModeEl.querySelectorAll('.story-user-marker').forEach(el => el.remove());
  storyModeEl.querySelectorAll('.story-card.story-remote-active,.story-mini-cue.story-remote-active,.story-card.story-remote-locked').forEach(el => {
    el.classList.remove('story-remote-active','story-remote-locked');
    el.style.removeProperty('--collab-color');
  });
  if (!VIEW_ONLY_SESSION){
    storyModeEl.querySelectorAll('.story-card input,.story-card textarea,.story-card select,.story-card button').forEach(el => { try{ el.disabled = false; }catch(_e){} });
    storyModeEl.querySelectorAll('.story-card-body,.story-mini-text').forEach(el => { try{ el.contentEditable = 'true'; }catch(_e){} });
  }
  const now = Date.now();
  for (const [uid, v] of Object.entries(COLLAB_REMOTE_STORY || {})){
    if (!v || now - Number(v.ts || 0) > 15000) delete COLLAB_REMOTE_STORY[uid];
  }
  for (const [cardId, lock] of Object.entries(COLLAB_STORY_LOCKS || {})){
    if (!lock || now - Number(lock.updated_at ? lock.updated_at * 1000 : lock.ts || 0) > 60000) { delete COLLAB_STORY_LOCKS[cardId]; continue; }
    const card = storyModeEl.querySelector(`.story-card[data-card-id="${CSS.escape(String(cardId || ''))}"]`);
    if (!card) continue;
    card.classList.add('story-remote-locked');
    if (!VIEW_ONLY_SESSION){
      card.querySelectorAll('input,textarea,select,button').forEach(el => { try{ if (!el.classList?.contains('story-timecode')) el.disabled = true; }catch(_e){} });
      card.querySelectorAll('.story-card-body,.story-mini-text').forEach(el => { try{ el.contentEditable = 'false'; }catch(_e){} });
    }
    const color = lock.user_color || collabUserColor(lock.user_id);
    card.style.setProperty('--collab-color', color);
    const mark = document.createElement('span');
    mark.className = 'story-user-marker story-lock-marker';
    mark.style.setProperty('--collab-color', color);
    mark.textContent = `${lock.user_label || collabUserName(lock.user_id)} editing`;
    card.appendChild(mark);
  }
  for (const [uid, v] of Object.entries(COLLAB_REMOTE_STORY || {})){
    if (uid === COLLAB_USER_ID || !v) continue;
    const color = collabUserColor(uid);
    const card = storyModeEl.querySelector(`.story-card[data-card-id="${CSS.escape(String(v.card_id || ''))}"]`);
    if (!card) continue;
    const cueId = String(v.cue_id || '');
    const target = cueId ? (card.querySelector(`.story-mini-cue[data-cue-id="${CSS.escape(cueId)}"]`) || card) : card;
    target.classList.add('story-remote-active');
    target.style.setProperty('--collab-color', color);
    const mark = document.createElement('span');
    mark.className = 'story-user-marker';
    mark.style.setProperty('--collab-color', color);
    mark.textContent = v.mode === 'mini' ? `${collabUserName(uid)} editing` : collabUserName(uid);
    target.appendChild(mark);
  }
}
function renderStoryCard(row, card){
  const isCue = card.kind === 'cue';
  const isClip = card.kind === 'clip';
  const isLive = isCue || isClip;
  const effectiveTrack = storyEffectiveTrack(card);
  const effectiveRefs = storyEffectiveCueRefs(card);
  const cueRange = isCue ? storyCueRange(effectiveRefs, effectiveTrack) : null;
  const clip = isClip ? storyClipById(card.clipId) : null;
  const clipCueRange = isClip && effectiveRefs.length ? storyCueRange(effectiveRefs, effectiveTrack) : null;
  const start = cueRange ? cueRange.start : (clipCueRange ? clipCueRange.start : (clip ? storyClipStart(clip) : card.start));
  const end = cueRange ? cueRange.end : (clipCueRange ? clipCueRange.end : (clip ? storyClipEnd(clip) : card.end));
  const tc = (start != null && end != null && Number.isFinite(Number(start)) && Number.isFinite(Number(end))) ? `${fmtTC(start)} → ${fmtTC(end)}` : 'No timecode';
  const text = isCue ? (cueRange?.cues || []).map(c => c.text || '').join('\n') : (isClip ? storyTextForCard(card) : (card.body || ''));
  const labelGroup = STORY_LABELS[card.labelGroup] ? card.labelGroup : 'shot';
  const labelColor = STORY_LABEL_COLORS[labelGroup] || STORY_LABEL_COLORS.generic;
  const groupOptions = Object.keys(STORY_LABELS).map(g => `<option value="${g}" ${g === labelGroup ? 'selected' : ''}>${g === 'audio' ? 'Audio' : 'Shot'}</option>`).join('');
  const labelOptions = (STORY_LABELS[labelGroup] || STORY_LABELS.shot).map(l => `<option value="${escapeStoryAttr(l)}" ${l === card.label ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('');
  const remoteLock = getStoryRemoteLock(card.id);
  const storyLocked = !!VIEW_ONLY_SESSION || !!remoteLock;
  const disabledAttr = storyLocked ? ' disabled' : '';
  const editableAttr = storyLocked ? 'false' : 'true';
  const lockedTitle = remoteLock ? `${escapeStoryAttr(remoteLock.user_label || collabUserName(remoteLock.user_id))} is editing this Story Card` : '';
  const foot = isCue
    ? `${escapeHtml(card.source || getCurrentStoryMediaLabel())} · Live CueRefs: ${effectiveRefs.length} · Track ${escapeHtml(effectiveTrack)}`
    : isClip
      ? `${escapeHtml(card.source || getCurrentStoryMediaLabel())} · Live Timeline Clip${clip ? '' : ' missing'}${effectiveRefs.length ? ` · ${effectiveRefs.length} linked cue(s) · Track ${escapeHtml(effectiveTrack)}` : ''}`
      : card.kind === 'caption'
        ? 'Caption / lower third card'
        : 'Generic editorial card';
  const timeTitle = (card.kind === 'generic' || card.kind === 'caption') ? 'Click to edit In / Out' : 'Click to preview this range';
  return `
    <article class="story-card ${isLive ? 'is-live' : 'is-generic'} ${card.notesOpen ? 'notes-open' : ''} ${remoteLock ? 'story-remote-locked' : ''}" data-card-id="${escapeStoryAttr(card.id)}" ${lockedTitle ? `title="${lockedTitle}"` : ''}>
      <div class="story-card-top">
        <span class="story-live-dot" title="${isLive ? 'Live linked' : 'Manual / placeholder card'}"></span>
        <div class="story-card-labels">${card.kind === 'caption' ? `<span class="story-caption-pill">${escapeHtml(card.label || card.title || 'Lower Third')}</span>` : `<select class="story-label-group" data-card-field="labelGroup"${disabledAttr}>${groupOptions}</select><select class="story-label" data-card-field="label" style="--label-color:${escapeHtml(labelColor)}"${disabledAttr}>${labelOptions}</select>`}</div>
        <div class="story-card-move"><button data-story-action="move-card-up" title="Move card up" type="button"${disabledAttr}>↑</button><button data-story-action="move-card-down" title="Move card down" type="button"${disabledAttr}>↓</button></div><button class="story-card-delete" data-story-action="delete-card" title="Delete card" type="button"${disabledAttr}>×</button>
      </div>
      <div class="story-card-name-row">
        <input class="story-card-title" data-card-field="title" value="${escapeStoryAttr(card.title || '')}" placeholder="Clip / card name"${disabledAttr}>
      </div>
      <div class="story-card-meta">
        <button class="story-timecode" data-story-action="seek-card" title="${escapeStoryAttr(timeTitle)}" type="button">${escapeHtml(tc)}</button>
      </div>
      <div class="story-card-body-shell ${card.editMode ? 'is-mini-editing' : ''}">
        ${card.editMode ? storyRenderMiniTranscript(row, card) : `<div class="story-card-body story-card-richbody" data-card-field="body" contenteditable="${editableAttr}" tabindex="0" spellcheck="true" data-placeholder="Transcript, assignment, VO, graphics, or B-roll instruction" style="${escapeStoryAttr(storyCardBodyInlineStyle(card))}${card.bodyWidth ? `width:${escapeStoryAttr(card.bodyWidth)};` : ''}${card.bodyHeight ? `height:${escapeStoryAttr(card.bodyHeight)};` : ''}">${storyRichBodyHtmlForCard(card, text)}</div>`}
        <button class="story-notes-tab" data-story-action="toggle-card-notes" type="button">Notes</button>
      </div>
      <div class="story-card-notes-wrap" ${card.notesOpen ? '' : 'hidden'}>
        <textarea class="story-card-notes" data-card-field="notes" placeholder="Producer notes / graphics / edit instructions"${disabledAttr}>${escapeHtml(card.notes || '')}</textarea>
      </div>
      <div class="story-card-foot">${foot}</div>
    </article>`;
}

function storyNormalizeTextForMatch(text){
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}
function storyCardRange(card){
  if (!card) return null;
  if ((card.kind === 'cue' || card.kind === 'clip') && storyEffectiveCueRefs(card).length){
    return storyCueRange(storyEffectiveCueRefs(card), storyEffectiveTrack(card));
  }
  const clip = card.kind === 'clip' ? storyClipById(card.clipId) : null;
  if (clip) return { start: storyClipStart(clip), end: storyClipEnd(clip), cues: [] };
  if (card.start != null && card.end != null) return { start: Number(card.start), end: Number(card.end), cues: [] };
  return null;
}
function storyCueTextAppearsInBody(cue, raw, normalizedBody, lines){
  const cueText = storyNormalizeTextForMatch(cue?.text || '');
  if (!cueText) return true;
  if (normalizedBody.includes(cueText)) return true;
  // For users who slightly edit a kept cue, keep it if most words still appear in one line.
  const words = cueText.split(' ').filter(w => w.length > 1);
  if (!words.length) return false;
  return lines.some(line => {
    const hits = words.filter(w => line.includes(w)).length;
    return hits / Math.max(1, words.length) >= 0.65;
  });
}
function storyBaseCueRefsForCard(card, trackOverride=null){
  if (!card || !(card.kind === 'cue' || card.kind === 'clip')) return [];
  const track = normalizeStoryTrack(trackOverride || storyEffectiveTrack(card) || card.track || 'A');
  const baseTrack = normalizeStoryTrack(card.track || 'A');
  if (card.altCueRefs && Array.isArray(card.altCueRefs[track]) && card.altCueRefs[track].length) return [...card.altCueRefs[track]];
  // sourceCueRefs is the durable original selection.  It lets Ctrl+Z restore
  // cue membership when the user brings deleted cue text back into the card.
  if (track === baseTrack && Array.isArray(card.sourceCueRefs) && card.sourceCueRefs.length) return [...card.sourceCueRefs];
  const refs = Array.isArray(card.cueRefs) ? [...card.cueRefs] : [];
  if (track === baseTrack) card.sourceCueRefs = [...refs];
  return refs;
}
function storyCueGroupsFromBody(card, value, trackOverride=null){
  const raw = String(value ?? '');
  const normalizedBody = storyNormalizeTextForMatch(raw);
  const lines = raw.split(/\r?\n/).map(storyNormalizeTextForMatch).filter(Boolean);
  const track = normalizeStoryTrack(trackOverride || storyEffectiveTrack(card) || card?.track || 'A');
  const baseRefs = storyBaseCueRefsForCard(card, track);
  const kept = baseRefs.filter(id => storyCueTextAppearsInBody(storyCueById(id, track), raw, normalizedBody, lines));
  const groups = [];
  let current = [];
  baseRefs.forEach(id => {
    if (kept.includes(id)) current.push(id);
    else if (current.length){ groups.push(current); current = []; }
  });
  if (current.length) groups.push(current);
  return { baseRefs, kept, groups, track };
}
function storyMakeSplitCardFromCueGroup(card, cueRefs){
  const copy = { ...card, id:makeStoryCardId(), cueRefs:[...cueRefs], sourceCueRefs:[...cueRefs], body:'', bodyManual:false, notes:'', notesOpen:false };
  const range = storyCardRange(copy);
  copy.start = range ? range.start : null;
  copy.end = range ? range.end : null;
  return copy;
}
function storyApplyCueGroupsToCard(row, card, groups, trackOverride=null){
  if (!row || !card) return false;
  const idx = row.cards.findIndex(c => c.id === card.id);
  if (idx < 0) return false;
  const cleanGroups = (groups || []).map(g => (g || []).filter(Boolean)).filter(g => g.length);
  const track = normalizeStoryTrack(trackOverride || storyEffectiveTrack(card) || card.track || 'A');
  if (!cleanGroups.length){
    row.cards.splice(idx, 1);
    return true;
  }
  card.track = track;
  card.cueRefs = [...cleanGroups[0]];
  card.sourceCueRefs = [...cleanGroups[0]];
  if (card.altCueRefs && typeof card.altCueRefs === 'object') card.altCueRefs[track] = [...cleanGroups[0]];
  card.body = '';
  card.bodyManual = false;
  const firstRange = storyCardRange(card);
  card.start = firstRange ? firstRange.start : null;
  card.end = firstRange ? firstRange.end : null;
  if (cleanGroups.length > 1){
    const splitCards = cleanGroups.slice(1).map(g => {
      const split = storyMakeSplitCardFromCueGroup(card, g);
      split.track = track;
      if (split.altCueRefs && typeof split.altCueRefs === 'object'){
        split.altCueRefs = { A:[], B:[] };
        split.altCueRefs[track] = [...g];
      }
      return split;
    });
    row.cards.splice(idx + 1, 0, ...splitCards);
  }
  return true;
}
function storyCueRefGroupsAfterRemoving(card, removeCueId, trackOverride=null){
  const track = normalizeStoryTrack(trackOverride || storyEffectiveTrack(card) || card?.track || 'A');
  const effective = storyEffectiveCueRefs(card);
  const refs = effective.length ? [...effective] : storyBaseCueRefsForCard(card, track);
  const groups = [];
  let cur = [];
  refs.forEach(id => {
    if (String(id) === String(removeCueId)){
      if (cur.length){ groups.push(cur); cur = []; }
    } else {
      cur.push(id);
    }
  });
  if (cur.length) groups.push(cur);
  return groups;
}
function storyRemoveCueFromCard(rowId, cardId, cueId, trackOverride=null){
  const { row, card } = storyFindCard(rowId, cardId);
  if (!row || !card || !(card.kind === 'cue' || card.kind === 'clip') || !cueId) return false;
  const track = normalizeStoryTrack(trackOverride || storyEffectiveTrack(card) || card.track || 'A');
  const ok = storyApplyCueGroupsToCard(row, card, storyCueRefGroupsAfterRemoving(card, cueId, track), track);
  if (ok){
    renderStoryAssembly();
    storyCommitSharedState(true);
  }
  return ok;
}
function storyReconcileCueCardFromBody(row, card, value){
  if (!row || !card || !(card.kind === 'cue' || card.kind === 'clip')) return { changed:false, split:false };
  const activeTrack = normalizeStoryTrack(storyEffectiveTrack(card) || card.track || 'A');
  const { baseRefs, kept, groups } = storyCueGroupsFromBody(card, value, activeTrack);
  if (!baseRefs.length) return { changed:false, split:false };

  const oldRefs = storyEffectiveCueRefs(card).length ? [...storyEffectiveCueRefs(card)] : [...(card.cueRefs || [])];
  const changed = JSON.stringify(oldRefs) !== JSON.stringify(kept);

  // If the user deletes cue text from the middle of a live selection, the
  // remaining cue refs become separate contiguous groups.  Story Mode should
  // represent those as separate cards, while leaving the real transcript/SRT
  // untouched.
  if (groups.length > 1){
    if (storyApplyCueGroupsToCard(row, card, groups, activeTrack)){
      return { changed:true, split:true };
    }
  }

  if (changed){
    card.track = activeTrack;
    card.cueRefs = kept;
    // Keep the full sourceCueRefs so browser Ctrl+Z can restore membership if
    // the restored body text contains those cues again.
    card.sourceCueRefs = [...baseRefs];
    if (card.altCueRefs && typeof card.altCueRefs === 'object') card.altCueRefs[activeTrack] = [...kept];
    const range = storyCardRange(card);
    card.start = range ? range.start : null;
    card.end = range ? range.end : null;
    return { changed:true, split:false };
  }
  return { changed:false, split:false };
}
// Backwards-compatible name used by older Story Mode code paths.
function storyPruneCueRefsFromBody(card, value){
  const fakeRow = { cards:[card] };
  return storyReconcileCueCardFromBody(fakeRow, card, value).changed;
}
function storyUpdateCardTimecodeDom(cardEl, card){
  const btn = cardEl?.querySelector?.('.story-timecode');
  if (!btn || !card) return;
  const range = storyCardRange(card);
  if (range && Number.isFinite(Number(range.start)) && Number.isFinite(Number(range.end))) btn.textContent = `${fmtTC(range.start)} → ${fmtTC(range.end)}`;
  else btn.textContent = 'No timecode';
  const foot = cardEl.querySelector('.story-card-foot');
  if (foot && (card.kind === 'cue' || card.kind === 'clip')){
    const count = (card.cueRefs || []).length;
    foot.textContent = card.kind === 'cue'
      ? `${card.source || getCurrentStoryMediaLabel()} · Story selection: ${count} linked cue(s) · Track ${card.track || 'A'}`
      : `${card.source || getCurrentStoryMediaLabel()} · Live Timeline Clip · ${count} linked cue(s) · Track ${card.track || 'A'}`;
  }
}
function onStoryInput(ev){
  const miniText = ev.target.closest?.('.story-mini-text');
  if (miniText){
    const cueEl = miniText.closest('.story-mini-cue');
    const cardEl0 = miniText.closest('.story-card');
    const rowEl0 = miniText.closest('.story-row');
    const cueId = cueEl?.dataset?.cueId || '';
    const track = cueEl?.dataset?.track || 'A';
    const { card } = storyFindCard(rowEl0?.dataset?.rowId, cardEl0?.dataset?.cardId);
    if (card && isStoryCardRemoteLocked(card.id)) return;
    storyHandleFocusForCollab(miniText);
    storyUpdateCueFromMiniText(cueId, track, miniText.textContent || '');
    if (card){ card.bodyManual = false; card.body = ''; storyUpdateCardTimecodeDom(cardEl0, card); }
    sendCollabStoryCursor(rowEl0?.dataset?.rowId, cardEl0?.dataset?.cardId, cueId, 'mini');
    return;
  }
  const richBody = ev.target.closest?.('.story-card-body[data-card-field="body"]');
  const rowEl = ev.target.closest?.('.story-row');
  const cardEl = ev.target.closest?.('.story-card');
  const row = rowEl ? getStoryRow(rowEl.dataset.rowId) : null;
  if (!row || !cardEl) return;
  const card = (row.cards || []).find(c => c.id === cardEl.dataset.cardId);
  if (!card || isStoryCardRemoteLocked(card.id)) return;
  storySetActiveCard(row.id, card.id);
  storyHandleFocusForCollab(ev.target);
  if (richBody){
    if (!card.bodyHeight) { richBody.style.height = 'auto'; richBody.style.height = Math.max(48, richBody.scrollHeight + 4) + 'px'; }
    // Story Mode body edits are assembly edits. They must not mutate the real transcript/subtitle cues.
    storySyncRichBodyToCard(richBody, { commit:true, reconcile:true });
    return;
  }
  const field = ev.target.dataset.cardField;
  if (field === 'title') { card.title = ev.target.value; storyCommitSharedState(); }
  if (field === 'notes') { card.notes = ev.target.value; storyCommitSharedState(); }
}
function updateLiveStoryCueText(card, value){
  const cues = (card.cueRefs || []).map(id => storyCueById(id, card.track)).filter(Boolean);
  if (!cues.length) return;
  const raw = String(value ?? '');
  if (cues.length === 1){
    cues[0].text = raw;
  } else {
    const lines = raw.split(/\r?\n/);
    cues.forEach((cue, i) => { cue.text = (i === cues.length - 1) ? lines.slice(i).join('\n') : (lines[i] ?? ''); });
  }
  if (!isStoryMode && !isTimelineMode){ try{ renderBySubsMode(); }catch(_e){} }
  try{ if (typeof updateTxtBox === 'function' && !isStoryMode && !isTimelineMode) updateTxtBox(); }catch(_e){}
}
function onStoryChange(ev){
  const rowEl = ev.target.closest?.('.story-row');
  const cardEl = ev.target.closest?.('.story-card');
  const row = rowEl ? getStoryRow(rowEl.dataset.rowId) : null;
  if (!row || !cardEl) return;
  const card = (row.cards || []).find(c => c.id === cardEl.dataset.cardId);
  if (!card || isStoryCardRemoteLocked(card.id)) return;
  storySetActiveCard(row.id, card.id);
  storyHandleFocusForCollab(ev.target);
  const field = ev.target.dataset.cardField;
  if (field === 'labelGroup'){
    card.labelGroup = ev.target.value;
    if (!STORY_LABELS[card.labelGroup]) card.labelGroup = 'shot';
    card.label = (STORY_LABELS[card.labelGroup] || STORY_LABELS.shot)[0];
    renderStoryAssembly();
  } else if (field === 'label') card.label = ev.target.value;
  storyCommitSharedState();
}

let MEDIA_RANGE_PREVIEW_STOPPER = null;
function stopMediaRangePreview(){
  try{ if (typeof MEDIA_RANGE_PREVIEW_STOPPER === 'function') MEDIA_RANGE_PREVIEW_STOPPER(); }catch(_e){}
  MEDIA_RANGE_PREVIEW_STOPPER = null;
}
function previewMediaRange(start, end, { label='Preview', onStop=null } = {}){
  const f = (typeof getFPS === 'function') ? getFPS() : 25;
  const s = Math.max(0, Number(start) || 0);
  const e = Math.max(s + (1 / f), Number(end) || 0);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s){ alert('No valid In / Out range to preview.'); return null; }
  stopMediaRangePreview();
  let done = false;
  let timer = null;
  const stopAt = Math.max(s + 0.02, e);
  const finish = ({ pause=true } = {}) => {
    if (done) return;
    done = true;
    if (timer) clearInterval(timer);
    timer = null;
    try{ player?.removeEventListener('timeupdate', check); }catch(_e){}
    try{ player?.removeEventListener('pause', cancelOnly); }catch(_e){}
    try{ player?.removeEventListener('ended', finish); }catch(_e){}
    MEDIA_RANGE_PREVIEW_STOPPER = null;
    if (pause) { try{ pauseMedia?.(); }catch(_e){ try{ player?.pause?.(); }catch(_e2){} } }
    try{ onStop?.(); }catch(_e){}
  };
  const cancelOnly = () => finish({ pause:false });
  function check(){
    const t = (typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : (player?.currentTime || 0);
    if (Number(t) >= stopAt - 0.015){
      finish({ pause:true });
    }
  }
  MEDIA_RANGE_PREVIEW_STOPPER = finish;
  try{ player?.addEventListener('timeupdate', check); player?.addEventListener('pause', cancelOnly, { once:true }); player?.addEventListener('ended', finish, { once:true }); }catch(_e){}
  timer = setInterval(check, 90);
  try{ timelineSetStatus?.(`${label}: ${fmtTimelineTime ? fmtTimelineTime(s) : fmtTC(s)} → ${fmtTimelineTime ? fmtTimelineTime(e) : fmtTC(e)}`); }catch(_e){}
  seekMediaTo(Math.max(0, s) + 0.001, { play:true });
  return finish;
}

let STORY_PREVIEW_STOPPER = null;
function storyCardPlaybackRange(card){
  if (!card) return null;
  if (card.kind === 'cue' || card.kind === 'clip'){
    const refs = storyEffectiveCueRefs(card);
    const track = storyEffectiveTrack(card);
    const range = refs.length ? storyCueRange(refs, track) : null;
    if (range && Number.isFinite(Number(range.start)) && Number.isFinite(Number(range.end))) return range;
  }
  const clip = card.kind === 'clip' ? storyClipById(card.clipId) : null;
  const start = clip ? storyClipStart(clip) : card.start;
  const end = clip ? storyClipEnd(clip) : card.end;
  if (start != null && end != null && Number.isFinite(Number(start)) && Number.isFinite(Number(end)) && Number(end) > Number(start)){
    return { start:Number(start), end:Number(end) };
  }
  return null;
}
function storyPreviewCardRange(card){
  const range = storyCardPlaybackRange(card);
  if (!range) return;
  try{ if (typeof STORY_PREVIEW_STOPPER === 'function') STORY_PREVIEW_STOPPER(); }catch(_e){}
  STORY_PREVIEW_STOPPER = previewMediaRange(range.start, range.end, {
    label:'Story preview',
    onStop: () => { STORY_PREVIEW_STOPPER = null; }
  });
}

let storyCardTimePopover = null;
function storyCanEditCardTimecode(card){
  return !!card && (card.kind === 'generic' || card.kind === 'caption');
}
function ensureStoryCardTimePopover(){
  if (storyCardTimePopover) return storyCardTimePopover;
  ensureTxtTimePopover?.();
  storyCardTimePopover = document.createElement('div');
  storyCardTimePopover.id = 'storyCardTimePopover';
  storyCardTimePopover.className = 'txt-time-popover story-card-time-popover';
  storyCardTimePopover.style.display = 'none';
  storyCardTimePopover.innerHTML = `
    <div class="tc-pop-title">Edit Story Card timecode</div>
    <label><span>In</span><input id="storyCardTcIn" type="text" placeholder="00:00:00:00"></label>
    <label><span>Out</span><input id="storyCardTcOut" type="text" placeholder="00:00:00:00"></label>
    <div class="txt-time-note">Updates this manual Story Card only. Transcript and alignment cues are not changed.</div>
    <div class="txt-time-actions">
      <button type="button" id="storyCardTcSeek">Seek</button>
      <button type="button" id="storyCardTcCancel">Cancel</button>
      <button type="button" class="primary" id="storyCardTcApply">Apply</button>
    </div>`;
  document.body.appendChild(storyCardTimePopover);
  document.addEventListener('click', ev => {
    if (!storyCardTimePopover.classList.contains('is-open')) return;
    if (storyCardTimePopover.contains(ev.target) || ev.target?.closest?.('.story-timecode')) return;
    hideStoryCardTimePopover();
  });
  window.addEventListener('resize', hideStoryCardTimePopover);
  window.addEventListener('scroll', hideStoryCardTimePopover, true);
  return storyCardTimePopover;
}
function hideStoryCardTimePopover(){
  if (!storyCardTimePopover) return;
  try{ if (storyCardTimePopover.__ctx?.cardId) sendStoryCardUnlock(storyCardTimePopover.__ctx.cardId); }catch(_e){}
  storyCardTimePopover.classList.remove('is-open');
  storyCardTimePopover.style.display = 'none';
  storyCardTimePopover.__ctx = null;
}
function positionStoryCardTimePopover(anchor){
  if (!storyCardTimePopover || !anchor) return;
  const r = anchor.getBoundingClientRect();
  const w = 270, h = 190;
  storyCardTimePopover.style.position = 'fixed';
  storyCardTimePopover.style.left = Math.min(window.innerWidth - w - 10, Math.max(10, r.left)) + 'px';
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 10) top = Math.max(10, r.top - h - 8);
  storyCardTimePopover.style.top = top + 'px';
}
function showStoryCardTimePopover(ev, rowId, cardId){
  const { row, card } = storyFindCard(rowId, cardId);
  if (!row || !card || !storyCanEditCardTimecode(card)) return;
  if (isStoryCardRemoteLocked(card.id)){ storyPreviewCardRange(card); return; }
  const pop = ensureStoryCardTimePopover();
  pop.__ctx = { rowId, cardId };
  sendStoryCardLock(rowId, cardId, 'timecode');
  sendCollabStoryCursor(rowId, cardId, '', 'timecode', { force:true });
  const f = getFPS();
  const now = (typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : 0;
  const s = Number.isFinite(Number(card.start)) ? Number(card.start) : now;
  const e = Number.isFinite(Number(card.end)) && Number(card.end) > s ? Number(card.end) : s + 5;
  const inInput = pop.querySelector('#storyCardTcIn');
  const outInput = pop.querySelector('#storyCardTcOut');
  if (inInput) inInput.value = fmtTC(s, f);
  if (outInput) outInput.value = fmtTC(e, f);
  const locked = !!VIEW_ONLY_SESSION || isStoryCardRemoteLocked(card.id);
  [inInput, outInput, pop.querySelector('#storyCardTcApply')].forEach(el => { if (el) el.disabled = locked; });
  pop.querySelector('#storyCardTcSeek').onclick = () => seekMediaTo(Math.max(0, s) + 0.001, { play:false });
  pop.querySelector('#storyCardTcCancel').onclick = hideStoryCardTimePopover;
  pop.querySelector('#storyCardTcApply').onclick = () => {
    const live = pop.__ctx || { rowId, cardId };
    const found = storyFindCard(live.rowId, live.cardId);
    const liveCard = found.card;
    if (!liveCard || !storyCanEditCardTimecode(liveCard) || VIEW_ONLY_SESSION || isStoryCardRemoteLocked(liveCard.id)) return;
    const s2 = parseDisplayedTcToSeconds(inInput.value, f);
    const e2 = parseDisplayedTcToSeconds(outInput.value, f);
    if (s2 == null || e2 == null){ alert('Invalid timecode. Use HH:MM:SS:FF.'); return; }
    if (e2 <= s2){ alert('Out timecode must be after In timecode.'); return; }
    liveCard.start = Math.max(0, s2);
    liveCard.end = Math.max(liveCard.start + (1 / f), e2);
    hideStoryCardTimePopover();
    renderStoryAssembly();
    storyCommitSharedState(true);
    seekMediaTo(Math.max(0, liveCard.start) + 0.001, { play:false });
  };
  const anchor = ev?.target?.closest?.('.story-timecode') || ev?.target || ev?.currentTarget;
  positionStoryCardTimePopover(anchor);
  pop.style.display = 'block';
  pop.classList.add('is-open');
  setTimeout(() => { try{ inInput?.focus({preventScroll:true}); inInput?.select(); }catch(_e){} }, 0);
}

function onStoryClick(ev){
  const action = ev.target.dataset.storyAction;
  const rowEl = ev.target.closest?.('.story-row');
  const cardEl = ev.target.closest?.('.story-card');
  const row = rowEl ? getStoryRow(rowEl.dataset.rowId) : null;
  if (row && cardEl) storySetActiveCard(row.id, cardEl.dataset.cardId);

  // In normal Story Card view, clicking a cue line in the textarea should seek
  // to that cue's exact timecode.  Use the click Y position, not the stale
  // textarea caret, because a normal click may not update selectionStart until
  // after this delegated handler has already run.
  const clickedBody = ev.target?.closest?.('.story-card-body');
  if (clickedBody && row && cardEl){
    const bodyEl = clickedBody;
    const card = row.cards?.find(c => c.id === cardEl.dataset.cardId);
    // Do not run click-to-seek while the user is selecting text. Calling seek
    // can move focus to the video player in some browsers and immediately
    // collapse the rich-text selection/caret.
    const hasTextSelection = storyHasSelectionInsideEditable(bodyEl);
    const wasSelecting = !!bodyEl.__storySelectingText;
    if (card && (card.kind === 'cue' || card.kind === 'clip') && !hasTextSelection && !wasSelecting){
      window.__storyLastContextY = ev.clientY;
      const cueId = storyCueIdFromTextareaLine(bodyEl, card);
      const cue = cueId ? storyCueById(cueId, storyEffectiveTrack(card)) : null;
      if (cue) seekMediaTo(Math.max(0, Number(cue.start || 0)) + 0.001, { play:false });
    }
    if (bodyEl.__storySelectingText) setTimeout(() => { bodyEl.__storySelectingText = false; }, 80);
  }

  const miniCueClicked = ev.target.closest?.('.story-mini-cue');
  if (miniCueClicked && !ev.target.closest?.('.story-mini-time')){
    const inMiniText = ev.target.closest?.('.story-mini-text');
    const sel = window.getSelection?.();
    // If the user is actively selecting text inside the mini transcript, do not
    // treat mouseup/click as a seek action that may collapse the selection.
    if (!(inMiniText && sel && !sel.isCollapsed)){
      const cue = storyCueById(miniCueClicked.dataset.cueId, miniCueClicked.dataset.track || 'A');
      if (cue) seekMediaTo(Math.max(0, Number(cue.start || 0)) + 0.001, { play:false });
    }
  }
  if (!action || !row) return;
  const actionMutates = /^(open-add-menu|move-row-|delete-row|move-card-|delete-card|done-mini-transcript|toggle-card-notes)$/.test(action);
  if (VIEW_ONLY_SESSION && actionMutates) return;
  if (cardEl && isStoryCardRemoteLocked(cardEl.dataset.cardId) && !/^seek/.test(action)) return;
  if (!cardEl && /^(move-row-|delete-row)/.test(action) && storyRowHasRemoteLock(row)) return;
  if (action === 'open-add-menu') { showStoryAddMenu(ev.target, row.id); return; }
  if (action === 'move-row-up') { const i = storyRows.findIndex(r => r.id === row.id); if (i > 0){ [storyRows[i-1], storyRows[i]] = [storyRows[i], storyRows[i-1]]; renderStoryAssembly(); storyCommitSharedState(true); } return; }
  if (action === 'move-row-down') { const i = storyRows.findIndex(r => r.id === row.id); if (i >= 0 && i < storyRows.length - 1){ [storyRows[i+1], storyRows[i]] = [storyRows[i], storyRows[i+1]]; renderStoryAssembly(); storyCommitSharedState(true); } return; }
  if (action === 'delete-row') { storyRows = storyRows.filter(r => r.id !== row.id); renderStoryAssembly(); storyCommitSharedState(true); return; }
  if (action === 'move-card-up' && cardEl){ const i = row.cards.findIndex(c => c.id === cardEl.dataset.cardId); if (i > 0){ [row.cards[i-1], row.cards[i]] = [row.cards[i], row.cards[i-1]]; renderStoryAssembly(); storyCommitSharedState(true); } return; }
  if (action === 'move-card-down' && cardEl){ const i = row.cards.findIndex(c => c.id === cardEl.dataset.cardId); if (i >= 0 && i < row.cards.length - 1){ [row.cards[i+1], row.cards[i]] = [row.cards[i], row.cards[i+1]]; renderStoryAssembly(); storyCommitSharedState(true); } return; }
  if (action === 'delete-card' && cardEl){ row.cards = row.cards.filter(c => c.id !== cardEl.dataset.cardId); renderStoryAssembly(); storyCommitSharedState(true); return; }
  if (action === 'done-mini-transcript' && cardEl){ const card = row.cards.find(c => c.id === cardEl.dataset.cardId); if (card){ card.editMode = false; card.bodyManual = false; card.body = ''; try{ renderBySubsMode?.(); updateTxtBox?.(); }catch(_e){} renderStoryAssembly(); storyCommitSharedState(true); } return; }
  if (action === 'seek-mini-cue' || action === 'edit-mini-time') { const cueEl = ev.target.closest('.story-mini-cue'); const cue = storyCueById(cueEl?.dataset?.cueId, cueEl?.dataset?.track || 'A'); if (action === 'edit-mini-time') { const ctx = storyMiniFindContextFromNode(cueEl); if (ctx) showStoryMiniTimePopover(ev, ctx); } else if (cue) seekMediaTo(Math.max(0, Number(cue.start || 0)) + 0.001, { play:false }); return; }
  if (action === 'toggle-card-notes' && cardEl){ const card = row.cards.find(c => c.id === cardEl.dataset.cardId); if (card){ card.notesOpen = !card.notesOpen; renderStoryAssembly(); storyCommitSharedState(); } return; }
  if (action === 'seek-card' && cardEl){
    const card = row.cards.find(c => c.id === cardEl.dataset.cardId);
    if (storyCanEditCardTimecode(card)) showStoryCardTimePopover(ev, row.id, card.id);
    else storyPreviewCardRange(card);
    return;
  }
}
function showStoryAddMenu(anchor, rowId){
  hideStoryAddMenu();
  storyAddMenuEl = document.createElement('div');
  storyAddMenuEl.className = 'story-add-menu';
  storyAddMenuEl.innerHTML = `
    <button data-kind="cues" type="button">Cues</button>
    <button data-kind="clips" type="button">Clips</button>
    <button data-kind="captions" type="button">Captions</button>
    <button data-kind="cards" type="button">Cards</button>`;
  document.body.appendChild(storyAddMenuEl);
  const r = anchor.getBoundingClientRect();
  storyAddMenuEl.style.left = Math.min(window.innerWidth - 190, r.left) + 'px';
  storyAddMenuEl.style.top = (r.bottom + 6) + 'px';
  storyAddMenuEl.addEventListener('click', (ev) => {
    const kind = ev.target?.dataset?.kind;
    if (!kind) return;
    hideStoryAddMenu();
    if (kind === 'cues') return showStoryCueModal(rowId);
    if (kind === 'clips') return showStoryClipModal(rowId);
    if (kind === 'captions') return showStoryCaptionModal(rowId);
    if (kind === 'cards') return addStoryCardToRow(rowId, createGenericStoryCard());
  });
  setTimeout(() => document.addEventListener('click', hideStoryAddMenu, { once:true }), 0);
}
function hideStoryAddMenu(){ if (storyAddMenuEl){ storyAddMenuEl.remove(); storyAddMenuEl = null; } }
function ensureStoryModal(){
  hideStoryModal();
  storyModalEl = document.createElement('div');
  storyModalEl.className = 'story-modal-overlay';
  document.body.appendChild(storyModalEl);
  return storyModalEl;
}
function hideStoryModal(){ if (storyModalEl){ storyModalEl.remove(); storyModalEl = null; } }
function storyCueFinderUsedMap(track='A'){
  const wanted = normalizeStoryTrack(track || 'A');
  const map = new Map();
  (storyRows || []).forEach((row, rowIndex) => {
    (row?.cards || []).forEach(card => {
      let refs = [];
      if (card?.altCueRefs && Array.isArray(card.altCueRefs[wanted])) refs = refs.concat(card.altCueRefs[wanted]);
      if (normalizeStoryTrack(card?.track || 'A') === wanted && Array.isArray(card?.cueRefs)) refs = refs.concat(card.cueRefs);
      storyUniqueRefs(refs).forEach(id => {
        const key = String(id || '');
        if (!key) return;
        if (!map.has(key)) map.set(key, []);
        const rows = map.get(key);
        const rowNo = rowIndex + 1;
        if (!rows.includes(rowNo)) rows.push(rowNo);
      });
    });
  });
  return map;
}
function storyCueFinderNorm(v){ return String(v ?? '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function storyCueFinderEscapeRegExp(v){ return String(v ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function storyCueFinderHighlightText(text, query){
  const raw = String(text ?? '');
  const q = String(query ?? '').trim();
  if (!q || q.length < 2 || /^[\d:.;,-]+$/.test(q)) return escapeHtml(raw);
  const terms = q.split(/\s+/).filter(t => t.length >= 2).slice(0, 4);
  if (!terms.length) return escapeHtml(raw);
  const re = new RegExp('(' + terms.map(storyCueFinderEscapeRegExp).join('|') + ')', 'ig');
  return escapeHtml(raw).replace(re, '<mark>$1</mark>');
}
function storyCueFinderCurrentRange(kind='range'){
  if (kind === 'near'){
    const t = (typeof getMediaCurrentTime === 'function') ? Number(getMediaCurrentTime()) : 0;
    const center = Number.isFinite(t) ? t : 0;
    return { start:Math.max(0, center - 30), end:center + 30, label:`Playhead ±30s (${fmtTC(Math.max(0, center - 30))} → ${fmtTC(center + 30)})` };
  }
  if (kind === 'selection' && timelineSelection){
    const a = Math.min(Number(timelineSelection.start || 0), Number(timelineSelection.end || 0));
    const b = Math.max(Number(timelineSelection.start || 0), Number(timelineSelection.end || 0));
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) return { start:a, end:b, label:`Selected range (${fmtTC(a)} → ${fmtTC(b)})` };
  }
  if (kind === 'activeCard'){
    const active = storyGetActiveCard?.();
    const range = active?.card ? (storyCardRange(active.card) || storyTimelineRangeForCard?.(active.card) || null) : null;
    if (range && Number(range.end) > Number(range.start)) return { start:Number(range.start), end:Number(range.end), label:`Active card (${fmtTC(range.start)} → ${fmtTC(range.end)})` };
  }
  return null;
}
function storyCueFinderCueOverlaps(cue, range){
  if (!range) return true;
  const cs = Number(cue?.start ?? 0), ce = Number(cue?.end ?? 0);
  if (!Number.isFinite(cs) || !Number.isFinite(ce)) return false;
  return Math.min(ce, Number(range.end)) - Math.max(cs, Number(range.start)) > 0.001;
}
function showStoryCueModal(rowId){
  const modal = ensureStoryModal();
  const state = {
    track: normalizeStoryTrack(storyActiveSubTrack || subsMode || 'A'),
    query: '',
    filter: 'all',
    unusedOnly: false,
    selected: new Set(),
    anchor: -1,
    lastScrollTop: 0,
    rowHeight: 72
  };
  modal.innerHTML = `
    <div class="story-modal-card story-cue-finder-card">
      <div class="story-modal-head story-cue-finder-head">
        <div>
          <strong>Cue Finder</strong>
          <div class="story-modal-sub">${escapeHtml(getCurrentStoryMediaLabel())} · Search, filter, preview, then add cues into this Story Card.</div>
        </div>
        <button class="story-modal-close" type="button" aria-label="Close">×</button>
      </div>
      <div class="story-cue-finder-tools">
        <input class="story-cue-finder-search" type="search" placeholder="Search cue text, cue number, or timecode…" autocomplete="off">
        <label class="story-cue-finder-track">Track <select class="story-cue-finder-track-select"><option value="A">Sub A</option><option value="B">Sub B</option></select></label>
        <button class="story-cue-filter is-active" type="button" data-filter="all">All</button>
        <button class="story-cue-filter" type="button" data-filter="near">Playhead ±30s</button>
        <button class="story-cue-filter" type="button" data-filter="selection">Selected range</button>
        <button class="story-cue-filter" type="button" data-filter="activeCard">Active card</button>
        <label class="story-cue-finder-check"><input type="checkbox" class="story-cue-unused-only"> Unused only</label>
      </div>
      <div class="story-cue-finder-status"></div>
      <div class="story-cue-finder-table-head" aria-hidden="true"><span></span><span>No.</span><span>Timecode</span><span>Cue text</span><span>Used</span><span></span></div>
      <div class="story-cue-finder-viewport" tabindex="0" role="listbox" aria-label="Transcript cues">
        <div class="story-cue-finder-spacer"><div class="story-cue-finder-rows"></div></div>
      </div>
      <div class="story-modal-foot story-cue-finder-foot">
        <span class="story-cue-finder-selected-count">0 selected</span>
        <button class="btn btn-outline story-modal-cancel" type="button">Cancel</button>
        <button class="btn btn-gold story-modal-add" type="button">Add Selected Cues</button>
      </div>
    </div>`;

  const close = () => hideStoryModal();
  modal.querySelector('.story-modal-close').onclick = close;
  modal.querySelector('.story-modal-cancel').onclick = close;
  const searchInput = modal.querySelector('.story-cue-finder-search');
  const trackSelect = modal.querySelector('.story-cue-finder-track-select');
  const unusedOnly = modal.querySelector('.story-cue-unused-only');
  const viewport = modal.querySelector('.story-cue-finder-viewport');
  const spacer = modal.querySelector('.story-cue-finder-spacer');
  const rowsLayer = modal.querySelector('.story-cue-finder-rows');
  const status = modal.querySelector('.story-cue-finder-status');
  const selectedCount = modal.querySelector('.story-cue-finder-selected-count');
  if (trackSelect) trackSelect.value = state.track;

  let currentFiltered = [];
  let renderToken = 0;
  const readAll = () => (storyEnsureCueIds(state.track) || []).map((cue, index) => ({ cue, index, id:String(cue?.id || ''), no:index + 1 }));
  const cueSearchHaystack = (item) => storyCueFinderNorm([
    item.no,
    item.index,
    item.id,
    fmtTC(item.cue?.start ?? 0),
    fmtTC(item.cue?.end ?? 0),
    item.cue?.text || ''
  ].join(' '));
  const computeFiltered = () => {
    const q = storyCueFinderNorm(state.query);
    const used = storyCueFinderUsedMap(state.track);
    const range = state.filter === 'all' ? null : storyCueFinderCurrentRange(state.filter);
    return readAll().filter(item => {
      if (state.unusedOnly && used.has(item.id)) return false;
      if (range && !storyCueFinderCueOverlaps(item.cue, range)) return false;
      if (!q) return true;
      return cueSearchHaystack(item).includes(q);
    });
  };
  const updateFilterButtons = () => {
    modal.querySelectorAll('.story-cue-filter').forEach(btn => btn.classList.toggle('is-active', btn.dataset.filter === state.filter));
  };
  const updateFooter = () => {
    selectedCount.textContent = `${state.selected.size} selected`;
    modal.querySelector('.story-modal-add')?.toggleAttribute('disabled', state.selected.size === 0);
  };
  const renderRows = () => {
    renderToken += 1;
    const token = renderToken;
    currentFiltered = computeFiltered();
    const used = storyCueFinderUsedMap(state.track);
    const activeRange = state.filter === 'all' ? null : storyCueFinderCurrentRange(state.filter);
    const rowH = state.rowHeight;
    const total = currentFiltered.length;
    spacer.style.height = `${Math.max(rowH, total * rowH)}px`;
    const scrollTop = viewport.scrollTop || 0;
    const viewportHeight = viewport.clientHeight || 420;
    const startIx = Math.max(0, Math.floor(scrollTop / rowH) - 8);
    const endIx = Math.min(total, Math.ceil((scrollTop + viewportHeight) / rowH) + 8);
    const visible = currentFiltered.slice(startIx, endIx);
    rowsLayer.innerHTML = visible.map((item, localIx) => {
      const filteredIx = startIx + localIx;
      const cue = item.cue || {};
      const selected = state.selected.has(item.id);
      const usedRows = used.get(item.id) || [];
      const usedLabel = usedRows.length ? `Row ${usedRows.slice(0, 3).join(', ')}${usedRows.length > 3 ? '…' : ''}` : '';
      return `<div class="story-cue-finder-row${selected ? ' is-selected' : ''}" style="transform:translateY(${filteredIx * rowH}px)" data-filter-index="${filteredIx}" data-cue-id="${escapeStoryAttr(item.id)}" role="option" aria-selected="${selected ? 'true' : 'false'}">
        <label class="story-cue-finder-select"><input type="checkbox" ${selected ? 'checked' : ''} aria-label="Select cue ${item.no}"></label>
        <button class="story-cue-finder-no" type="button" title="Seek to cue ${item.no}">${item.no}</button>
        <button class="story-cue-finder-time" type="button" title="Seek to ${fmtTC(cue.start || 0)}">${fmtTC(cue.start || 0)} → ${fmtTC(cue.end || 0)}</button>
        <div class="story-cue-finder-text" title="Click to seek, Shift-click to range select">${storyCueFinderHighlightText(cue.text || '', state.query)}</div>
        <div class="story-cue-finder-used">${usedLabel ? `<button type="button" class="story-cue-used-jump" title="Already used in ${escapeStoryAttr(usedLabel)}">${escapeHtml(usedLabel)}</button>` : '<span class="story-cue-unused-pill">Unused</span>'}</div>
        <div class="story-cue-finder-row-actions"><button class="story-cue-preview-one" type="button" title="Preview this cue">▶</button><button class="story-cue-add-one" type="button" title="Add this cue">Add</button></div>
      </div>`;
    }).join('') || `<div class="story-cue-finder-empty" style="top:0">No cues match this search/filter.</div>`;
    const filterLabel = activeRange?.label || (state.filter === 'all' ? 'All cues' : 'No matching range available');
    status.textContent = `${total} cue(s) · Track ${state.track} · ${filterLabel}${state.unusedOnly ? ' · Unused only' : ''}`;
    if (token === renderToken) updateFooter();
  };
  const scheduleRender = () => requestAnimationFrame(renderRows);
  const getItemFromEvent = (ev) => {
    const row = ev.target?.closest?.('.story-cue-finder-row');
    if (!row) return { row:null, item:null, ix:-1 };
    const ix = Number(row.dataset.filterIndex || -1);
    return { row, item:currentFiltered[ix] || null, ix };
  };
  const setSelectedRange = (fromIx, toIx, additive=false) => {
    if (!additive) state.selected.clear();
    const a = Math.min(fromIx, toIx), b = Math.max(fromIx, toIx);
    for (let i = a; i <= b; i++){
      const id = currentFiltered[i]?.id;
      if (id) state.selected.add(id);
    }
    scheduleRender();
  };
  const toggleItem = (ix, additive=true) => {
    const id = currentFiltered[ix]?.id;
    if (!id) return;
    if (!additive) state.selected.clear();
    if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    state.anchor = ix;
    scheduleRender();
  };
  const selectByClick = (ev, ix) => {
    if (ix < 0) return;
    if (ev.shiftKey && state.anchor >= 0) setSelectedRange(state.anchor, ix, ev.ctrlKey || ev.metaKey);
    else toggleItem(ix, true);
  };

  viewport?.addEventListener('scroll', () => { state.lastScrollTop = viewport.scrollTop || 0; renderRows(); }, { passive:true });
  searchInput?.addEventListener('input', () => { state.query = searchInput.value || ''; viewport.scrollTop = 0; scheduleRender(); });
  trackSelect?.addEventListener('change', () => { state.track = normalizeStoryTrack(trackSelect.value); state.selected.clear(); state.anchor = -1; viewport.scrollTop = 0; updateFilterButtons(); scheduleRender(); });
  unusedOnly?.addEventListener('change', () => { state.unusedOnly = !!unusedOnly.checked; viewport.scrollTop = 0; scheduleRender(); });
  modal.querySelectorAll('.story-cue-filter').forEach(btn => btn.addEventListener('click', () => { state.filter = btn.dataset.filter || 'all'; viewport.scrollTop = 0; updateFilterButtons(); scheduleRender(); }));
  rowsLayer?.addEventListener('click', ev => {
    const { row, item, ix } = getItemFromEvent(ev);
    if (!row || !item) return;
    const cue = item.cue || {};
    if (ev.target?.closest?.('.story-cue-add-one')){
      addCuePayloadToStory({ cueIds:[item.id], track:state.track, start:cue.start ?? null, end:cue.end ?? null, source:getCurrentStoryMediaLabel() }, rowId);
      hideStoryModal();
      return;
    }
    if (ev.target?.closest?.('.story-cue-preview-one')){
      if (typeof previewMediaRange === 'function') previewMediaRange(Number(cue.start || 0), Number(cue.end || cue.start || 0), { label:`Cue ${item.no}` });
      else seekMediaTo(Math.max(0, Number(cue.start || 0)) + 0.001, { play:true });
      return;
    }
    if (ev.target?.closest?.('.story-cue-used-jump')){
      const rows = storyCueFinderUsedMap(state.track).get(item.id) || [];
      if (rows.length){
        const rowEl = storyModeEl?.querySelector?.(`.story-row:nth-child(${rows[0]})`);
        rowEl?.scrollIntoView?.({ behavior:'smooth', block:'center' });
      }
      return;
    }
    if (ev.target?.closest?.('.story-cue-finder-time,.story-cue-finder-no,.story-cue-finder-text')){
      seekMediaTo(Math.max(0, Number(cue.start || 0)) + 0.001, { play:false });
    }
    selectByClick(ev, ix);
  });
  rowsLayer?.addEventListener('change', ev => {
    if (!ev.target?.matches?.('.story-cue-finder-select input')) return;
    const { ix } = getItemFromEvent(ev);
    selectByClick(ev, ix);
  });
  viewport?.addEventListener('keydown', ev => {
    if (ev.key === 'Enter'){
      const ids = currentFiltered.map(item => item.id).filter(id => state.selected.has(id));
      if (ids.length){
        addCuePayloadToStory({ cueIds:ids, track:state.track, source:getCurrentStoryMediaLabel() }, rowId);
        hideStoryModal();
      }
    }
  });
  modal.querySelector('.story-modal-add').onclick = () => {
    const ordered = currentFiltered.map(item => item.id).filter(id => state.selected.has(id));
    const extra = [...state.selected].filter(id => !ordered.includes(id));
    const cueIds = ordered.concat(extra);
    if (!cueIds.length){ alert('Select at least one cue first.'); return; }
    const selectedCues = cueIds.map(id => storyCueById(id, state.track)).filter(Boolean);
    const start = selectedCues.length ? Math.min(...selectedCues.map(c => Number(c.start || 0))) : null;
    const end = selectedCues.length ? Math.max(...selectedCues.map(c => Number(c.end || 0))) : null;
    addCuePayloadToStory({ cueIds, track:state.track, start, end, source:getCurrentStoryMediaLabel() }, rowId);
    hideStoryModal();
  };
  updateFilterButtons();
  renderRows();
  setTimeout(() => searchInput?.focus?.({ preventScroll:true }), 0);
}

function showStoryClipModal(rowId){
  const modal = ensureStoryModal();
  normalizeTimelineClips?.();
  modal.innerHTML = `
    <div class="story-modal-card">
      <div class="story-modal-head"><div><strong>Select Timeline Clips</strong><div class="story-modal-sub">${escapeHtml(getCurrentStoryMediaLabel())}</div></div><button class="story-modal-close" type="button">×</button></div>
      <div class="story-modal-list">
        ${(timelineClips || []).map((clip, i) => `<label class="story-modal-item"><input type="checkbox" value="${escapeStoryAttr(clip.id)}"><span class="story-modal-time">${fmtTC(storyClipStart(clip))} → ${fmtTC(storyClipEnd(clip))}</span><span>${escapeHtml(getTimelineClipDisplayName ? getTimelineClipDisplayName(clip, i) : (clip.label || 'Clip'))}</span></label>`).join('') || '<div class="story-modal-empty">No timeline clips yet. Create clips in Timeline Mode first.</div>'}
      </div>
      <div class="story-modal-foot"><button class="btn btn-outline story-modal-cancel" type="button">Cancel</button><button class="btn btn-gold story-modal-add" type="button">Add Selected Clips</button></div>
    </div>`;
  modal.querySelector('.story-modal-close').onclick = hideStoryModal;
  modal.querySelector('.story-modal-cancel').onclick = hideStoryModal;
  modal.querySelector('.story-modal-add').onclick = () => {
    const cards = [...modal.querySelectorAll('input[type="checkbox"]:checked')]
      .map(x => storyClipById(x.value))
      .filter(Boolean)
      .map(clip => createClipStoryCard(clip));
    addStoryCardsToRow(rowId, cards);
    hideStoryModal();
  };
}
function showStoryCaptionModal(rowId){
  const modal = ensureStoryModal();
  modal.innerHTML = `
    <div class="story-modal-card story-caption-modal-card">
      <div class="story-modal-head"><div><strong>Add Caption / Lower Third</strong><div class="story-modal-sub">This will be added as a new story row.</div></div><button class="story-modal-close" type="button">×</button></div>
      <div class="story-caption-grid">
        ${STORY_CAPTION_TYPES.map((t,i) => `<label class="story-caption-choice"><input type="radio" name="storyCaptionType" value="${escapeStoryAttr(t)}" ${i===0?'checked':''}>${escapeHtml(t)}</label>`).join('')}
      </div>
      <textarea class="story-caption-text" placeholder="Write the specific lower third / caption text here"></textarea>
      <div class="story-modal-foot"><button class="btn btn-outline story-modal-cancel" type="button">Cancel</button><button class="btn btn-gold story-modal-add" type="button">Add Caption Row</button></div>
    </div>`;
  modal.querySelector('.story-modal-close').onclick = hideStoryModal;
  modal.querySelector('.story-modal-cancel').onclick = hideStoryModal;
  modal.querySelector('.story-modal-add').onclick = () => {
    const type = modal.querySelector('input[name="storyCaptionType"]:checked')?.value || 'Lower Third';
    const text = modal.querySelector('.story-caption-text')?.value || '';
    const row = createStoryRow();
    row.cards.push(createCaptionStoryCard(type, text));
    const idx = Math.max(0, storyRows.findIndex(r => r.id === rowId));
    storyRows.splice(idx + 1, 0, row);
    hideStoryModal();
    renderStoryAssembly();
    storyCommitSharedState(true);
  };
}


function storyCardCues(card){
  const track = storyEffectiveTrack(card);
  return storyEffectiveCueRefs(card).map(id => storyCueById(id, track)).filter(Boolean).map((cue, index) => ({ cue, index, track }));
}
function ensureEntriesBForIndex(aCue, idx){
  if (!entriesB[idx]) entriesB[idx] = { start:Number(aCue?.start || 0), end:Number(aCue?.end || 0), text:'', origIndex:idx };
  if (!entriesB[idx].id) entriesB[idx].id = makeCueId();
  if (entriesB[idx].start == null) entriesB[idx].start = Number(aCue?.start || 0);
  if (entriesB[idx].end == null) entriesB[idx].end = Number(aCue?.end || 0);
  return entriesB[idx];
}
async function storyTranslateSubsetCues(cues, opts={}){
  ensureTranslateModal();
  const lang     = document.getElementById('trLang')?.value     || 'Chinese (Simplified)';
  const fromLang = document.getElementById('trFromLang')?.value || 'English';
  const engine   = document.getElementById('trEngine')?.value   || 'deepseek';
  const dsModel  = document.getElementById('trDsModel')?.value  || 'deepseek-chat';
  const trStyle  = document.getElementById('trStyle')?.value    || 'subtitle_natural';
  const payload = {
    cues: cues.map((item, i) => ({ index:i, start:Number(item.cue.start||0), end:Number(item.cue.end||0), text:String(item.cue.text||'').trim() })),
    target_language: lang,
    from_language: fromLang,
    engine,
    model: dsModel,
    translation_style: trStyle,
    dictionary: loadDictionaryPairs(),
  };
  const res = await fetch(`${API_BASE}/api/translate_srt`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
  if (!res.ok) throw new Error(await res.text().catch(()=>`HTTP ${res.status}`));
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = ''; const out = [];
  const processLine = (line) => {
    const t = String(line||'').trim(); if (!t) return;
    let msg; try{ msg = JSON.parse(t); }catch(_e){ return; }
    if (msg.error) throw new Error(msg.error);
    if (msg.cue) out.push(msg.cue);
    if (Array.isArray(msg.translated)) out.push(...msg.translated);
  };
  if (reader){
    while(true){
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream:true});
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) processLine(line);
    }
    if (buffer.trim()) processLine(buffer);
  }
  return out;
}
async function storySendCardForTranslation(rowId, cardId){
  const { row, card } = storyFindCard(rowId, cardId);
  if (!row || !card) return;
  const cues = storyCardCues(card);
  if (!cues.length) throw new Error('This Story Card has no linked cues to translate.');
  ensureTranslateModal();
  const wrap = document.getElementById('srtTranslateModal');
  wrap?.classList.remove('hidden');
  const title = wrap?.querySelector('#trTitle');
  if (title) title.textContent = 'Story Card Translation';
  const run = wrap?.querySelector('#trRun');
  if (!run) return;
  const oldOnClick = run.onclick;
  run.textContent = 'Translate Story Card →';
  run.onclick = async () => {
    try{
      run.disabled = true; run.textContent = 'Translating…';
      const translated = await storyTranslateSubsetCues(cues);
      const bRefs = [];
      cues.forEach((item, i) => {
        const aIdx = getCueIndexById(item.cue.id, item.track);
        const bCue = ensureEntriesBForIndex(item.cue, aIdx >= 0 ? aIdx : i);
        const t = translated[i] || translated.find(x => Number(x.index) === i) || {};
        bCue.start = Number(t.start ?? item.cue.start ?? bCue.start ?? 0);
        bCue.end = Number(t.end ?? item.cue.end ?? bCue.end ?? 0);
        bCue.text = String(t.text || '');
        bRefs.push(bCue.id);
      });
      card.altCueRefs = card.altCueRefs || {};
      card.altCueRefs.A = card.altCueRefs.A && card.altCueRefs.A.length ? card.altCueRefs.A : [...(card.cueRefs || [])];
      card.altCueRefs.B = bRefs;
      card.track = 'B'; card.cueRefs = bRefs; card.sourceCueRefs = [...bRefs]; card.body = ''; card.bodyManual = false;
      initialEntriesB = entriesB.map(e => ({ start:e.start, end:e.end, text:e.text }));
      setStoryTimelineSubMode('B');
      renderStoryAssembly(); storyCommitSharedState(true);
      if (wrap) wrap.classList.add('hidden');
    } finally {
      run.disabled = false; run.textContent = 'Translate →'; run.onclick = oldOnClick;
      const title2 = wrap?.querySelector('#trTitle'); if (title2) title2.textContent = 'SRT-Translate';
    }
  };
}
function storySendCardForAIAssistant(rowId, cardId){
  const { card } = storyFindCard(rowId, cardId);
  if (!card) return;
  const range = storyCardRange(card);
  const text = storyCardToPlainLines(card);
  openAIAssistantModal();
  const input = document.getElementById('aiAssistInput');
  if (input){
    input.value = `Context from current Story Card${range ? ` (${fmtTC(range.start)} → ${fmtTC(range.end)})` : ''}:\n\n${text}\n\nTask:`;
    setTimeout(() => { try{ input.focus(); input.selectionStart = input.selectionEnd = input.value.length; }catch(_e){} }, 50);
  }
}


function ensureStoryContextMenu(){
  if (storyContextMenuEl) return storyContextMenuEl;
  storyContextMenuEl = document.createElement('div');
  storyContextMenuEl.className = 'story-context-menu';
  storyContextMenuEl.style.display = 'none';
  storyContextMenuEl.innerHTML = `<button type="button" data-story-context-action="remove-cue">Remove Cue From Card</button><button type="button" data-story-context-action="edit-transcript">Edit Transcript</button><button type="button" data-story-context-action="align-audio">Send For Align-To-Audio</button><button type="button" data-story-context-action="translate">Send For Translation</button><button type="button" data-story-context-action="ai">Send For AI Assistant</button>`;
  document.body.appendChild(storyContextMenuEl);
  storyContextMenuEl.addEventListener('click', ev => {
    const act = ev.target?.dataset?.storyContextAction;
    if (!act || !storyContextCueTarget) return;
    const target = storyContextCueTarget;
    hideStoryContextMenu();
    if (act === 'remove-cue'){
      storyRemoveCueFromCard(target.rowId, target.cardId, target.cueId, target.track);
      return;
    }
    if (act === 'edit-transcript'){
      const { rowId, cardId, cueId } = target;
      const { card } = storyFindCard(rowId, cardId);
      if (card){
        card.editMode = true;
        card.bodyManual = false;
        card.body = '';
        renderStoryAssembly();
        storyCommitSharedState(true);
        setTimeout(() => {
          const safeCard = CSS.escape(String(cardId || ''));
          const safeCue = CSS.escape(String(cueId || ''));
          const cueRow = storyModeEl?.querySelector(`.story-card[data-card-id="${safeCard}"] .story-mini-cue[data-cue-id="${safeCue}"]`);
          const textEl = cueRow?.querySelector('.story-mini-text');
          if (cueRow) scrollRowToCenter(getScrollContainerFor(storyModeEl?.querySelector('#storyAssembly') || cueRow.parentElement), cueRow);
          if (textEl) focusNoScroll(textEl);
        }, 60);
      }
      return;
    }
    if (act === 'align-audio'){
      storySendCardForAlignToAudio(target.rowId, target.cardId).catch(err => alert('Story Align-To-Audio failed: ' + (err?.message || err)));
      return;
    }
    if (act === 'translate'){
      storySendCardForTranslation(target.rowId, target.cardId).catch(err => alert('Story Translation failed: ' + (err?.message || err)));
      return;
    }
    if (act === 'ai'){
      storySendCardForAIAssistant(target.rowId, target.cardId);
      return;
    }
  });
  document.addEventListener('click', (ev) => {
    if (storyContextMenuEl && storyContextMenuEl.contains(ev.target)) return;
    hideStoryContextMenu();
  }, true);
  window.addEventListener('resize', hideStoryContextMenu);
  window.addEventListener('scroll', hideStoryContextMenu, true);
  return storyContextMenuEl;
}
function hideStoryContextMenu(){ if (storyContextMenuEl) storyContextMenuEl.style.display = 'none'; storyContextCueTarget = null; }

function storyCardToPlainLines(card){
  if (!card) return '';
  const track = normalizeStoryTrack(card.track || 'A');
  const refs = Array.isArray(card.cueRefs) ? card.cueRefs : [];
  const cues = refs.map(id => storyCueById(id, track)).filter(Boolean);
  if (cues.length) return cues.map(c => String(c.text || '').trim()).filter(Boolean).join('\n');
  return String(card.body || '').trim();
}
function storyReplaceCardCuesWithAligned(row, card, parsed, offset=0){
  if (!row || !card || !Array.isArray(parsed) || !parsed.length) return;
  const track = normalizeStoryTrack(card.track || 'A');
  const list = getCueList(track); ensureCueIds(list);
  const oldRefs = Array.isArray(card.cueRefs) ? [...card.cueRefs] : [];
  const oldIndexes = oldRefs.map(id => getCueIndexById(id, track)).filter(i => i >= 0).sort((a,b)=>a-b);
  const insertAt = oldIndexes.length ? oldIndexes[0] : list.length;
  const removeSet = new Set(oldRefs);
  for (let i = list.length - 1; i >= 0; i--){
    if (removeSet.has(list[i]?.id)) list.splice(i, 1);
  }
  const newCues = parsed.map((e, idx) => ({
    id: makeCueId(),
    start: Math.max(0, Number(e.start || 0) + Number(offset || 0)),
    end: Math.max(0, Number(e.end || 0) + Number(offset || 0)),
    text: String(e.text || ''),
    orig: { start: Math.max(0, Number(e.start || 0) + Number(offset || 0)), end: Math.max(0, Number(e.end || 0) + Number(offset || 0)), text: String(e.text || '') },
    origIndex: null,
    isNew: true,
    storyAligned: true,
  }));
  list.splice(Math.max(0, Math.min(insertAt, list.length)), 0, ...newCues);
  card.cueRefs = newCues.map(c => c.id);
  card.sourceCueRefs = [...card.cueRefs];
  card.start = newCues[0]?.start ?? card.start;
  card.end = newCues.at(-1)?.end ?? card.end;
  card.bodyManual = false;
  card.body = '';
  card.editMode = true;
  try{ renderBySubsMode?.(); updateTxtBox?.(); }catch(_e){}
  renderStoryAssembly();
  storyCommitSharedState(true);
}

function storyFormatBackupTime(sec){
  try{ return formatTimecodeFromSeconds(Number(sec || 0), getFPS()); }catch(_e){ return String(Number(sec || 0).toFixed(3)); }
}
function storyPlainTextForBackup(){
  ensureStorySeed();
  const lines = [];
  lines.push('TRANSCRIBER STORY BACKUP');
  lines.push('VERSION: 1');
  lines.push('PROJECT: ' + (suggestBaseName?.() || window.currentBaseName || getCurrentStoryMediaLabel() || 'story'));
  lines.push('EXPORTED_AT: ' + new Date().toISOString());
  lines.push('FPS: ' + getFPS());
  lines.push('');
  storyRows.forEach((row, rowIndex) => {
    lines.push('--- STORY ROW ' + (rowIndex + 1) + ' ---');
    if (row.notes) { lines.push('ROW_NOTES:'); lines.push(String(row.notes || '')); }
    (row.cards || []).forEach((card, cardIndex) => {
      const track = normalizeStoryTrack(card.track || storyActiveSubTrack || 'A');
      const range = storyCardRange(card) || storyTimelineRangeForCard?.(card) || { start:card.start, end:card.end };
      lines.push('CARD:');
      lines.push('CARD_INDEX: ' + (cardIndex + 1));
      lines.push('KIND: ' + (card.kind || 'generic'));
      lines.push('TITLE: ' + (card.title || ''));
      lines.push('SOURCE: ' + (card.source || getCurrentStoryMediaLabel() || ''));
      lines.push('TRACK: ' + track);
      if (range && range.start != null) lines.push('IN: ' + storyFormatBackupTime(range.start));
      if (range && range.end != null) lines.push('OUT: ' + storyFormatBackupTime(range.end));
      lines.push('LABEL_GROUP: ' + (card.labelGroup || ''));
      lines.push('LABEL: ' + (card.label || ''));
      lines.push('CUE_IDS: ' + ((storyEffectiveCueRefs(card) || card.cueRefs || []).join(',')));
      if (card.notes) { lines.push('NOTES:'); lines.push(String(card.notes || '')); }
      lines.push('TEXT:');
      lines.push(storyCardToPlainLines(card));
      lines.push('END_CARD');
      lines.push('');
    });
    lines.push('END_ROW');
    lines.push('');
  });
  return lines.join('\n');
}
async function exportStoryToGoogleDocBackup(){
  const text = storyPlainTextForBackup();
  const project = (suggestBaseName?.() || window.currentBaseName || 'story');
  const title = `${project} - Story Backup - ${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}`;
  setStatusSafe?.('Exporting Story backup to Google Doc…');
  const res = await fetch(`${API_BASE}/api/google_doc_story/export`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title, text })
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok || data?.ok === false) throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
  const url = data.url || data.document_url || '';
  setStatusSafe?.('Story backup exported to Google Doc.');
  const msg = url ? `Story backup created:\n${url}` : 'Story backup created.';
  if (url && confirm(msg + '\n\nOpen it now?')) window.open(url, '_blank', 'noopener');
  else alert(msg);
}
function storyBackupSections(text){
  const rows = [];
  const src = String(text || '').replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  const rowParts = src.split(/^---\s*STORY\s+ROW\s+\d+\s*---\s*$/gmi).slice(1);
  rowParts.forEach(part => {
    const row = createStoryRow();
    row.cards = [];
    const cardBlocks = [...part.matchAll(/CARD:\s*\n([\s\S]*?)END_CARD/gmi)].map(m => m[1]);
    cardBlocks.forEach(block => {
      const getSingle = (name) => {
        const rx = new RegExp('^' + name + '\\s*:\\s*(.*)$', 'mi');
        const m = block.match(rx);
        return m ? m[1].trim() : '';
      };
      const getLong = (name, stops) => {
        const stop = stops.join('|');
        const rx = new RegExp('^' + name + '\\s*:\\s*\\n([\\s\\S]*?)(?=^(' + stop + ')\\s*:\\s*|$)', 'mi');
        const m = block.match(rx);
        return m ? m[1].trim() : '';
      };
      const kind = getSingle('KIND') || 'cue';
      const track = normalizeStoryTrack(getSingle('TRACK') || 'A');
      const inText = getSingle('IN');
      const outText = getSingle('OUT');
      const start = inText ? parseDisplayedTcToSeconds(inText, getFPS()) : null;
      const end = outText ? parseDisplayedTcToSeconds(outText, getFPS()) : null;
      const cueIds = getSingle('CUE_IDS').split(',').map(x=>x.trim()).filter(Boolean);
      let validCueRefs = cueIds.filter(id => !!storyCueById(id, track));
      if (!validCueRefs.length && start != null && end != null) validCueRefs = storyCueRefsForRange(start, end, track);
      const card = {
        id: makeStoryCardId(), kind, title:getSingle('TITLE'), source:getSingle('SOURCE') || getCurrentStoryMediaLabel(),
        track, start, end, cueRefs: validCueRefs, sourceCueRefs:[...validCueRefs], labelGroup:getSingle('LABEL_GROUP') || 'shot', label:getSingle('LABEL') || '',
        body:'', bodyManual:false, notes:getLong('NOTES', ['TEXT','END_CARD']), notesOpen:false,
      };
      const textBody = getLong('TEXT', ['NOTES','END_CARD']);
      if (!validCueRefs.length && textBody){ card.body = textBody; card.bodyManual = true; }
      row.cards.push(card);
    });
    if (row.cards.length) rows.push(row);
  });
  return rows;
}
async function fetchStoryFromGoogleDocBackup(){
  const url = prompt('Paste the Google Doc backup/review URL:');
  if (!url) return;
  setStatusSafe?.('Fetching Story backup from Google Doc…');
  const res = await fetch(`${API_BASE}/api/google_doc_story/fetch`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url })
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok || data?.ok === false) throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
  const parsedRows = storyBackupSections(data.text || '');
  if (!parsedRows.length) throw new Error('No Story Cards were found in this Google Doc backup.');
  const replace = confirm(`Found ${parsedRows.reduce((n,r)=>n+(r.cards?.length||0),0)} Story Cards.\n\nOK = Replace current Story Mode\nCancel = Append to current Story Mode`);
  if (replace) storyRows = parsedRows;
  else storyRows.push(...parsedRows);
  renderStoryAssembly();
  storyCommitSharedState(true);
  setStatusSafe?.('Story backup loaded from Google Doc.');
}

async function storySendCardForAlignToAudio(rowId, cardId){
  const { row, card } = storyFindCard(rowId, cardId);
  if (!row || !card) return;
  const range = storyTimelineRangeForCard(card) || storyCueRange(card.cueRefs || [], card.track || 'A');
  if (!range || !(Number(range.end) > Number(range.start))) throw new Error('This Story Card has no valid In / Out timecode.');
  const text = storyCardToPlainLines(card);
  if (!text.trim()) throw new Error('This Story Card has no cue text to align.');
  const box = document.getElementById('alignSrtText');
  if (box) box.value = text;
  const { model, device, compute, language } = getWhisperSettings();
  let endpoint = '';
  let src = null;
  if (currentMediaSource?.type === 'drive'){
    src = await ensureGoogleDriveAudioCache();
    endpoint = '/api/google_drive_cached_align_window_start';
  } else {
    src = await ensureLocalAudioCache();
    endpoint = '/api/local_cached_align_window_start';
  }
  if (!src?.cacheId) throw new Error('No cached audio is available. Cache/transcribe this media first.');
  progressStart('Aligning Story Card audio window…');
  const res = await fetch(`${API_BASE}${endpoint}`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      cache_id: src.cacheId,
      text,
      start: Number(range.start),
      end: Number(range.end),
      model, device, compute_type: compute, language,
      word_timestamps: true,
      vad_filter: true,
    })
  });
  const startResp = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(startResp?.error || startResp?.message || `HTTP ${res.status}`);
  const jobId = startResp?.job_id;
  if (!jobId) throw new Error('No job_id returned');
  setActiveBackendJob(jobId, 'story_align_window');
  await pollJob(jobId);
  const data = await fetchJobResult(jobId);
  const alignedSrt = data?.aligned_srt || '';
  if (!alignedSrt.trim()) throw new Error('No aligned SRT returned');
  const parsed = parseSRT(alignedSrt);
  const offset = Number(data?.source_offset || range.start || 0);
  storyReplaceCardCuesWithAligned(row, card, parsed, offset);
  if (box) box.value = toSRT((card.cueRefs || []).map(id => storyCueById(id, card.track || 'A')).filter(Boolean));
  progressDone(true);
  setStatusSafe(`Story Card aligned (${parsed.length} cues).`);
}
function storyCueIdFromTextareaLine(textarea, card){
  if (!textarea || !card || !(card.kind === 'cue' || card.kind === 'clip')) return '';
  const text = String(textarea.value ?? textarea.innerText ?? textarea.textContent ?? '');
  let lineIndex = 0;
  try{
    // Approximate the clicked line from mouse Y. This works for both the old
    // textarea body and the new contenteditable rich-text body.
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 18;
    const rect = textarea.getBoundingClientRect();
    const relY = Math.max(0, (window.__storyLastContextY || rect.top) - rect.top + (textarea.scrollTop || 0));
    lineIndex = Math.max(0, Math.floor(relY / Math.max(1, lineHeight)));
  }catch(_e){
    try{
      const pos = Number(textarea.selectionStart || 0);
      lineIndex = text.slice(0, pos).split(/\r?\n/).length - 1;
    }catch(_e2){ lineIndex = 0; }
  }
  const refs = storyEffectiveCueRefs(card).length ? storyEffectiveCueRefs(card) : (Array.isArray(card.cueRefs) ? card.cueRefs : []);
  return refs[Math.max(0, Math.min(refs.length - 1, lineIndex))] || refs[0] || '';
}
function storyOpenCueInTranscript(track='A', cueId=''){
  track = normalizeStoryTrack(track);
  const idx = getCueIndexById(cueId, track);
  if (idx < 0) return;
  const cue = storyCueById(cueId, track);

  // Leave Story/Timeline mode and force the right panel back into Transcript Mode.
  // Clicking the view-mode button is useful for its normal UI path, but we also
  // set state directly as a fallback in case the button has not been mounted yet.
  try{
    isStoryMode = false;
    isTimelineMode = false;
    isTxtMode = true;
    document.getElementById('btnModeTxt')?.click();
  }catch(_e){}

  try{
    const sel = document.getElementById('subsMode');
    if (sel) sel.value = track;
    if (typeof applySubsMode === 'function') applySubsMode(track);
    if (typeof renderTxtBySubsMode === 'function') renderTxtBySubsMode();
  }catch(_e){}

  const focusCue = () => {
    try{
      const box = getTxtBoxForTrack?.(track) || document.getElementById('txtBigBox');
      const safeCueId = (window.CSS && CSS.escape) ? CSS.escape(String(cueId)) : String(cueId).replace(/"/g, '\\"');
      const row = box?.querySelector?.(`.txt-cue[data-cue-id="${safeCueId}"]`) || box?.querySelector?.(`.txt-cue[data-index="${idx}"][data-track="${track}"]`) || box?.querySelector?.(`.txt-cue[data-index="${idx}"]`);
      const line = row?.querySelector?.('.txt-line');
      if (row) scrollRowToCenter(getScrollContainerFor(box || row.parentElement), row);
      if (line){
        focusNoScroll(line);
        setCaretOffset(line, 0);
        row.classList.add('active');
        setTimeout(() => row.classList.remove('active'), 1800);
      }
      if (cue) seekMediaTo(Math.max(0, Number(cue.start || 0)) + 0.001, { play:false });
      try{ selectRowIn(track, idx, { scroll:false }); }catch(_e){}
    }catch(_e){}
  };

  // renderTxtBySubsMode may rebuild DOM asynchronously through the view switch.
  setTimeout(focusCue, 80);
  setTimeout(focusCue, 220);
}

function onStoryFocusIn(ev){
  const cardEl = ev.target.closest?.('.story-card');
  const rowEl = ev.target.closest?.('.story-row');
  if (!cardEl || !rowEl) return;
  const cueEl = ev.target.closest?.('.story-mini-cue');
  storySetActiveCard(rowEl.dataset.rowId, cardEl.dataset.cardId);
  if (ev.target?.closest?.('.story-mini-text')) ev.target.dataset.editingNow = '1';
  storyHandleFocusForCollab(ev.target, { force:true });
}
function onStoryKeyup(ev){ storyHandleFocusForCollab(ev.target, { force:false }); }
function onStoryKeydown(ev){
  const miniText = ev.target?.closest?.('.story-mini-text');
  if (!miniText) return;
  if (ev.key === 'Enter' && !ev.shiftKey){
    const ctx = storyMiniFindContextFromNode(miniText);
    if (!ctx || isTrackLocked(ctx.track) || VIEW_ONLY_SESSION) return;
    ev.preventDefault();
    storyMiniSplitCue(ctx, getCaretOffset(miniText));
  }
}

function onStoryContextMenu(ev){
  const miniText = ev.target?.closest?.('.story-mini-text');
  if (miniText){
    const ctx = storyMiniFindContextFromNode(miniText);
    if (ctx){ ev.preventDefault(); showStoryMiniContextMenu(ev, ctx); }
    return;
  }
  const textarea = ev.target?.closest?.('.story-card-body');
  const cardEl = ev.target?.closest?.('.story-card');
  const rowEl = ev.target?.closest?.('.story-row');
  if (!textarea || !cardEl || !rowEl) return;
  const row = getStoryRow(rowEl.dataset.rowId);
  const card = row?.cards?.find(c => c.id === cardEl.dataset.cardId);
  if (!card || !(card.kind === 'cue' || card.kind === 'clip') || !(card.cueRefs || []).length) return;
  window.__storyLastContextY = ev.clientY;
  const cueId = storyCueIdFromTextareaLine(textarea, card);
  if (!cueId) return;
  ev.preventDefault();
  storyContextCueTarget = { cueId, track: storyEffectiveTrack(card) || card.track || 'A', rowId: row.id, cardId: card.id };
  const menu = ensureStoryContextMenu();
  menu.style.left = (ev.clientX + window.scrollX) + 'px';
  menu.style.top = (ev.clientY + window.scrollY) + 'px';
  menu.style.display = 'block';
}




let storyMiniTimePopover = null;
function ensureStoryMiniTimePopover(){
  if (storyMiniTimePopover) return storyMiniTimePopover;
  ensureTxtTimePopover();
  storyMiniTimePopover = document.createElement('div');
  storyMiniTimePopover.id = 'storyMiniTimePopover';
  storyMiniTimePopover.className = 'txt-time-popover story-mini-time-popover';
  storyMiniTimePopover.style.display = 'none';
  storyMiniTimePopover.innerHTML = `
    <div class="tc-pop-title">Edit mini cue timecode</div>
    <label><span>In</span><input id="storyMiniTcIn" type="text" placeholder="00:00:00:00"></label>
    <label><span>Out</span><input id="storyMiniTcOut" type="text" placeholder="00:00:00:00"></label>
    <div class="txt-time-note">Updates the live cue used by Transcript, Subtitle and Story Mode.</div>
    <div class="txt-time-actions">
      <button type="button" id="storyMiniTcSeek">Seek</button>
      <button type="button" id="storyMiniTcCancel">Cancel</button>
      <button type="button" class="primary" id="storyMiniTcApply">Apply</button>
    </div>`;
  document.body.appendChild(storyMiniTimePopover);
  document.addEventListener('click', ev => {
    if (!storyMiniTimePopover.classList.contains('is-open')) return;
    if (storyMiniTimePopover.contains(ev.target) || ev.target?.closest?.('.story-mini-time')) return;
    hideStoryMiniTimePopover();
  });
  window.addEventListener('resize', hideStoryMiniTimePopover);
  window.addEventListener('scroll', hideStoryMiniTimePopover, true);
  return storyMiniTimePopover;
}
function hideStoryMiniTimePopover(){
  if (!storyMiniTimePopover) return;
  storyMiniTimePopover.classList.remove('is-open');
  storyMiniTimePopover.style.display = 'none';
  storyMiniTimePopover.__ctx = null;
}
function positionStoryMiniTimePopover(anchor){
  if (!storyMiniTimePopover || !anchor) return;
  const r = anchor.getBoundingClientRect();
  const w = 260, h = 190;
  storyMiniTimePopover.style.position = 'fixed';
  const left = Math.min(window.innerWidth - w - 10, Math.max(10, r.left));
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 10) top = Math.max(10, r.top - h - 8);
  storyMiniTimePopover.style.left = left + 'px';
  storyMiniTimePopover.style.top = top + 'px';
}
function showStoryMiniTimePopover(ev, ctx){
  if (!ctx || ctx.index < 0) return;
  const cue = storyCueById(ctx.cueId, ctx.track);
  if (!cue) return;
  const pop = ensureStoryMiniTimePopover();
  pop.__ctx = ctx;
  const f = getFPS();
  const inInput = pop.querySelector('#storyMiniTcIn');
  const outInput = pop.querySelector('#storyMiniTcOut');
  if (inInput) inInput.value = fmtTC(cue.start, f);
  if (outInput) outInput.value = fmtTC(cue.end, f);
  const locked = isTrackLocked(ctx.track) || VIEW_ONLY_SESSION;
  [inInput, outInput, pop.querySelector('#storyMiniTcApply')].forEach(el => { if (el) el.disabled = !!locked; });
  pop.querySelector('#storyMiniTcSeek').onclick = () => seekMediaTo(Math.max(0, Number(cue.start || 0)) + 0.001, { play:false });
  pop.querySelector('#storyMiniTcCancel').onclick = hideStoryMiniTimePopover;
  pop.querySelector('#storyMiniTcApply').onclick = () => {
    const liveCtx = pop.__ctx || ctx;
    const liveCue = storyCueById(liveCtx.cueId, liveCtx.track);
    if (!liveCue || isTrackLocked(liveCtx.track) || VIEW_ONLY_SESSION) return;
    const f2 = getFPS();
    const s = parseDisplayedTcToSeconds(inInput.value, f2);
    const e = parseDisplayedTcToSeconds(outInput.value, f2);
    if (s == null || e == null){ alert('Invalid timecode. Use HH:MM:SS:FF.'); return; }
    if (e <= s){ alert('Out timecode must be after In timecode.'); return; }
    liveCue.start = Math.max(0, s);
    liveCue.end = Math.max(liveCue.start + (1 / f2), e);
    hideStoryMiniTimePopover();
    storyMiniRenderAfter(liveCtx, liveCtx.cueId, 0);
    try{ renderBySubsMode?.(); updateTxtBox?.(); }catch(_e){}
    seekMediaTo(Math.max(0, liveCue.start) + 0.001, { play:false });
  };
  const anchor = ev?.target?.closest?.('.story-mini-time') || ev?.target || ev?.currentTarget;
  positionStoryMiniTimePopover(anchor);
  pop.style.display = 'block';
  pop.classList.add('is-open');
  setTimeout(() => { try{ inInput?.focus({preventScroll:true}); inInput?.select(); }catch(_e){} }, 0);
}

/* ---------- Story Mini Transcript: full cue editing tools ---------- */
let storyMiniCtxMenu = null;
let storyMiniCtxTarget = null;
function storyMiniFindContextFromNode(node){
  const cueEl = node?.closest?.('.story-mini-cue');
  const cardEl = node?.closest?.('.story-card');
  const rowEl = node?.closest?.('.story-row');
  if (!cueEl || !cardEl || !rowEl) return null;
  const row = getStoryRow(rowEl.dataset.rowId);
  const card = row?.cards?.find(c => c.id === cardEl.dataset.cardId);
  const track = normalizeStoryTrack(cueEl.dataset.track || card?.track || 'A');
  const cueId = cueEl.dataset.cueId || '';
  const index = getCueIndexById(cueId, track);
  const textEl = cueEl.querySelector('.story-mini-text');
  return { row, card, rowId:row?.id || rowEl.dataset.rowId, cardId:card?.id || cardEl.dataset.cardId, cueEl, cardEl, textEl, cueId, track, index };
}
function storyMiniCommitVisibleText(ctx){
  if (!ctx?.textEl || ctx.index < 0) return;
  const cue = storyCueById(ctx.cueId, ctx.track);
  if (cue) cue.text = ctx.textEl.textContent || '';
}
function storyUniqueRefs(refs){
  const out=[]; (refs || []).forEach(id => { if (id && !out.includes(id)) out.push(id); }); return out;
}
function storyReplaceCueRefsEverywhere(oldIds, replacementId=''){
  const oldSet = new Set(Array.isArray(oldIds) ? oldIds : [oldIds]);
  storyRows.forEach(row => (row.cards || []).forEach(card => {
    ['cueRefs','sourceCueRefs'].forEach(key => {
      if (!Array.isArray(card[key])) return;
      const next=[];
      card[key].forEach(id => {
        if (oldSet.has(id)) { if (replacementId) next.push(replacementId); }
        else next.push(id);
      });
      card[key] = storyUniqueRefs(next);
    });
  }));
}
function storyMiniInsertCueRefAfter(card, afterCueId, newCueId){
  if (!card || !newCueId) return;
  ['cueRefs','sourceCueRefs'].forEach(key => {
    const refs = Array.isArray(card[key]) ? [...card[key]] : [];
    const ix = refs.indexOf(afterCueId);
    if (ix >= 0) refs.splice(ix + 1, 0, newCueId);
    else refs.push(newCueId);
    card[key] = storyUniqueRefs(refs);
  });
}
function storyMiniRenderAfter(ctx, focusCueId='', caretOffset=0){
  if (ctx?.card){ ctx.card.bodyManual = false; ctx.card.body = ''; ctx.card.editMode = true; }
  renderStoryAssembly();
  storyCommitSharedState(true);
  setTimeout(() => {
    try{
      const safeCard = CSS.escape(String(ctx?.cardId || ''));
      const safeCue = CSS.escape(String(focusCueId || ctx?.cueId || ''));
      const row = storyModeEl?.querySelector(`.story-card[data-card-id="${safeCard}"] .story-mini-cue[data-cue-id="${safeCue}"]`);
      const text = row?.querySelector('.story-mini-text');
      if (row) scrollRowToCenter(getScrollContainerFor(storyModeEl?.querySelector('#storyAssembly') || row.parentElement), row);
      if (text){ focusNoScroll(text); setCaretOffset(text, Math.max(0, Number(caretOffset)||0)); }
    }catch(_e){}
  }, 60);
}
function storyMiniSplitCue(ctx, caretOffset=null){
  if (!ctx || ctx.index < 0 || isTrackLocked(ctx.track) || VIEW_ONLY_SESSION) return;
  storyMiniCommitVisibleText(ctx);
  const list = getCueList(ctx.track); ensureCueIds(list);
  const cue = list[ctx.index]; if (!cue) return;
  const full = String(ctx.textEl?.textContent ?? cue.text ?? '');
  const caret = Math.max(0, Math.min(caretOffset == null ? getCaretOffset(ctx.textEl) : Number(caretOffset), full.length));
  const left = full.slice(0, caret).trimEnd();
  const right = full.slice(caret).trimStart();
  const f = getFPS();
  const splitF = allowedTxtSplitFrame(cue, caret, full);
  const splitSec = framesToSec(splitF, f);
  const originalEnd = Math.max(Number(cue.end || 0), splitSec + (1 / f));
  cue.text = left;
  cue.end = splitSec;
  const newCue = { id:makeCueId(), start:splitSec, end:originalEnd, text:right, orig:{start:splitSec,end:originalEnd,text:right}, origIndex:null, isNew:true };
  list.splice(ctx.index + 1, 0, newCue);
  storyMiniInsertCueRefAfter(ctx.card, cue.id, newCue.id);
  storyMiniRenderAfter(ctx, newCue.id, 0);
  try{ renderBySubsMode?.(); updateTxtBox?.(); }catch(_e){}
}
function storyMiniMergeWithPrevious(ctx){
  if (!ctx || ctx.index <= 0 || isTrackLocked(ctx.track) || VIEW_ONLY_SESSION) return;
  storyMiniCommitVisibleText(ctx);
  const list = getCueList(ctx.track); ensureCueIds(list);
  const prev = list[ctx.index - 1], cur = list[ctx.index]; if (!prev || !cur) return;
  const focusOffset = String(prev.text || '').trimEnd().length + (String(prev.text || '').trim() && String(cur.text || '').trim() ? 1 : 0);
  prev.text = joinCueText(prev.text, cur.text);
  prev.end = Math.max(Number(prev.end || 0), Number(cur.end || 0));
  list.splice(ctx.index, 1);
  storyReplaceCueRefsEverywhere(cur.id, prev.id);
  storyMiniRenderAfter(ctx, prev.id, focusOffset);
  try{ renderBySubsMode?.(); updateTxtBox?.(); }catch(_e){}
}
function storyMiniMergeWithNext(ctx){
  if (!ctx || ctx.index < 0 || isTrackLocked(ctx.track) || VIEW_ONLY_SESSION) return;
  storyMiniCommitVisibleText(ctx);
  const list = getCueList(ctx.track); ensureCueIds(list);
  if (ctx.index >= list.length - 1) return;
  const cur = list[ctx.index], next = list[ctx.index + 1]; if (!cur || !next) return;
  const focusOffset = String(cur.text || '').trimEnd().length + (String(cur.text || '').trim() && String(next.text || '').trim() ? 1 : 0);
  cur.text = joinCueText(cur.text, next.text);
  cur.end = Math.max(Number(cur.end || 0), Number(next.end || 0));
  list.splice(ctx.index + 1, 1);
  storyReplaceCueRefsEverywhere(next.id, cur.id);
  storyMiniRenderAfter(ctx, cur.id, focusOffset);
  try{ renderBySubsMode?.(); updateTxtBox?.(); }catch(_e){}
}
function storyMiniPushTextUp(ctx){
  if (!ctx || ctx.index <= 0 || isTrackLocked(ctx.track) || VIEW_ONLY_SESSION) return;
  storyMiniCommitVisibleText(ctx);
  const list = getCueList(ctx.track);
  for (let i = ctx.index - 1; i < list.length - 1; i++) list[i].text = list[i + 1].text ?? '';
  list[list.length - 1].text = '';
  const focus = list[ctx.index - 1]?.id || ctx.cueId;
  storyMiniRenderAfter(ctx, focus, String(list[ctx.index - 1]?.text || '').length);
  try{ renderBySubsMode?.(); updateTxtBox?.(); }catch(_e){}
}
function storyMiniPushTextDown(ctx){
  if (!ctx || ctx.index < 0 || isTrackLocked(ctx.track) || VIEW_ONLY_SESSION) return;
  storyMiniCommitVisibleText(ctx);
  const list = getCueList(ctx.track);
  if (ctx.index >= list.length - 1) return;
  for (let i = list.length - 1; i >= ctx.index + 1; i--) list[i].text = list[i - 1].text ?? '';
  list[ctx.index].text = '';
  const focus = list[ctx.index + 1]?.id || ctx.cueId;
  storyMiniRenderAfter(ctx, focus, String(list[ctx.index + 1]?.text || '').length);
  try{ renderBySubsMode?.(); updateTxtBox?.(); }catch(_e){}
}
function storyMiniAddBlankBelow(ctx){
  if (!ctx || ctx.index < 0 || isTrackLocked(ctx.track) || VIEW_ONLY_SESSION) return;
  storyMiniCommitVisibleText(ctx);
  const list = getCueList(ctx.track); ensureCueIds(list);
  const f = getFPS();
  const here = list[ctx.index];
  const next = list[ctx.index + 1];
  const start = here ? Number(here.end || 0) : (list.at(-1)?.end || 0);
  let end = start + 1.0;
  if (next && end >= next.start) end = Math.max(start + (1 / f), Number(next.start || start) - (1 / f));
  const newCue = { id:makeCueId(), start, end, text:'', orig:{start,end,text:''}, origIndex:null, isNew:true };
  list.splice(ctx.index + 1, 0, newCue);
  storyMiniInsertCueRefAfter(ctx.card, here?.id || ctx.cueId, newCue.id);
  storyMiniRenderAfter(ctx, newCue.id, 0);
  try{ renderBySubsMode?.(); updateTxtBox?.(); }catch(_e){}
}
function storyMiniDeleteCue(ctx){
  if (!ctx || ctx.index < 0 || isTrackLocked(ctx.track) || VIEW_ONLY_SESSION) return;
  const list = getCueList(ctx.track); const cue = list[ctx.index]; if (!cue) return;
  list.splice(ctx.index, 1);
  storyReplaceCueRefsEverywhere(cue.id, '');
  const focus = list[Math.max(0, Math.min(ctx.index, list.length - 1))]?.id || '';
  storyMiniRenderAfter(ctx, focus, 0);
  try{ renderBySubsMode?.(); updateTxtBox?.(); }catch(_e){}
}
function ensureStoryMiniContextMenu(){
  if (storyMiniCtxMenu) return storyMiniCtxMenu;
  ensureContextMenu();
  storyMiniCtxMenu = document.createElement('div');
  storyMiniCtxMenu.className = 'ctx-menu story-mini-ctx-menu';
  storyMiniCtxMenu.style.display = 'none';
  const add = (label, action) => {
    const b = document.createElement('button'); b.type='button'; b.textContent=label; b.dataset.storyMiniAction=action; storyMiniCtxMenu.appendChild(b);
  };
  add('Split Cue at Caret','split');
  add('Merge with Previous','merge-prev');
  add('Merge with Next','merge-next');
  const s1=document.createElement('div'); s1.className='ctx-sep'; storyMiniCtxMenu.appendChild(s1);
  add('Push Text Up','push-up');
  add('Push Text Down','push-down');
  const s2=document.createElement('div'); s2.className='ctx-sep'; storyMiniCtxMenu.appendChild(s2);
  add('Add Blank Cue Below','add-blank');
  add('Delete Cue','delete');
  document.body.appendChild(storyMiniCtxMenu);
  storyMiniCtxMenu.addEventListener('click', ev => {
    const action = ev.target?.dataset?.storyMiniAction;
    if (!action || !storyMiniCtxTarget) return;
    const ctx = storyMiniCtxTarget;
    hideStoryMiniContextMenu();
    if (action === 'split') return storyMiniSplitCue(ctx);
    if (action === 'merge-prev') return storyMiniMergeWithPrevious(ctx);
    if (action === 'merge-next') return storyMiniMergeWithNext(ctx);
    if (action === 'push-up') return storyMiniPushTextUp(ctx);
    if (action === 'push-down') return storyMiniPushTextDown(ctx);
    if (action === 'add-blank') return storyMiniAddBlankBelow(ctx);
    if (action === 'delete') return storyMiniDeleteCue(ctx);
  });
  window.addEventListener('click', hideStoryMiniContextMenu);
  window.addEventListener('scroll', hideStoryMiniContextMenu, true);
  window.addEventListener('resize', hideStoryMiniContextMenu);
  return storyMiniCtxMenu;
}
function showStoryMiniContextMenu(ev, ctx){
  if (!ctx || isTrackLocked(ctx.track) || VIEW_ONLY_SESSION) return;
  storyMiniCtxTarget = ctx;
  const menu = ensureStoryMiniContextMenu();
  menu.style.left = (ev.pageX ?? ev.clientX + window.scrollX) + 'px';
  menu.style.top = (ev.pageY ?? ev.clientY + window.scrollY) + 'px';
  menu.style.display = 'block';
}
function hideStoryMiniContextMenu(){ if (storyMiniCtxMenu){ storyMiniCtxMenu.style.display='none'; } storyMiniCtxTarget=null; }

function storyTimelineRangeForCard(card){
  if (!card) return null;
  if ((card.kind === 'cue' || card.kind === 'clip') && Array.isArray(card.cueRefs) && card.cueRefs.length){
    const r = storyCueRange(card.cueRefs, card.track || 'A');
    if (r) return r;
  }
  if (card.kind === 'clip'){
    const clip = storyClipById(card.clipId);
    if (clip) return { start: storyClipStart(clip), end: storyClipEnd(clip), cues: [] };
  }
  if (card.start != null && card.end != null && Number(card.end) > Number(card.start)){
    return { start:Number(card.start), end:Number(card.end), cues: [] };
  }
  return null;
}
function storyTimelineClipLabel(rowIndex, cardIndex, card){
  const prefix = `Story ${String(rowIndex + 1).padStart(2, '0')}.${String(cardIndex + 1).padStart(2, '0')}`;
  const label = String(card?.label || '').trim();
  const title = String(card?.title || '').trim();
  if (label && title) return `${prefix} · ${label} · ${title}`;
  if (label) return `${prefix} · ${label}`;
  if (title) return `${prefix} · ${title}`;
  return prefix;
}
function buildStoryTimelineClips(){
  normalizeTimelineClips?.();
  const ownerLabel = getTimelineOwnerLabel?.() || 'Story Mode';
  const ownerId = getTimelineOwnerId?.() || 'story';
  const ownerColor = getTimelineOwnerColor?.() || '#d7b46a';
  const out = [];
  const skipped = [];
  storyRows.forEach((row, rowIndex) => {
    (row.cards || []).forEach((card, cardIndex) => {
      const range = storyTimelineRangeForCard(card);
      if (!range || !(Number(range.end) > Number(range.start))){
        skipped.push(card);
        return;
      }
      const sourceText = (card.kind === 'cue' || card.kind === 'clip') ? storyTextForCard(card) : (card.body || '');
      const rowNotes = String(row.notes || '').trim();
      const cardNotes = String(card.notes || '').trim();
      const noteParts = [];
      if (sourceText) noteParts.push(sourceText);
      if (cardNotes) noteParts.push('Card notes: ' + cardNotes);
      if (rowNotes) noteParts.push('Row notes: ' + rowNotes);
      out.push({
        id: makeTimelineClipId(),
        start: snapTimeToFrameValue(range.start),
        end: snapTimeToFrameValue(range.end),
        label: storyTimelineClipLabel(rowIndex, cardIndex, card),
        ownerId,
        ownerLabel,
        ownerColor,
        color: card.kind === 'caption' ? (STORY_LABEL_COLORS.caption || ownerColor) : ownerColor,
        enabled: true,
        createdAt: Date.now(),
        source: 'story_mode',
        reason: noteParts.join('\n\n'),
        cueRefs: Array.isArray(card.cueRefs) ? [...card.cueRefs] : [],
        track: card.track || 'A',
        storyRowId: row.id,
        storyCardId: card.id,
        storyKind: card.kind || 'card',
        storyLabel: card.label || '',
        sourceMedia: card.source || getCurrentStoryMediaLabel(),
      });
    });
  });
  return { clips: out, skipped };
}
function exportStoryToTimeline(){
  const { clips, skipped } = buildStoryTimelineClips();
  if (!clips.length){
    alert('No timecoded Story Cards to export. Add cue-linked or clip-linked Story Cards first.');
    return;
  }
  const replace = timelineClips.length
    ? confirm(`Export ${clips.length} Story clip(s) to Timeline?\n\nOK = replace current Timeline clips\nCancel = append after current Timeline clips`)
    : true;
  if (replace) timelineClips = clips;
  else timelineClips.push(...clips);
  timelineSelectedClipId = clips[0]?.id || timelineSelectedClipId;
  timelineSelection = { start: clips[0].start, end: clips[0].end };
  normalizeTimelineClips();
  timelineCommitSharedState?.(true);
  isStoryMode = false;
  isTimelineMode = true;
  isTxtMode = false;
  hideStoryMode();
  showTimelineMode();
  requestTimelineRender?.();
  const skippedText = skipped.length ? ` · skipped ${skipped.length} non-timecoded card(s)` : '';
  timelineSetStatus?.(`Exported ${clips.length} Story clip(s) to Timeline${skippedText}.`);
  try{ document.getElementById('btnModeStory')?.classList.remove('active'); document.getElementById('btnModeTimeline')?.classList.add('active'); document.getElementById('btnModeSrt')?.classList.remove('active'); document.getElementById('btnModeTxt')?.classList.remove('active'); }catch(_e){}
}

function buildStoryExportText(){
  return storyRows.map((row, i) => {
    const cards = (row.cards || []).map(card => {
      const range = card.kind === 'cue' ? storyCueRange(card.cueRefs, card.track) : null;
      const clip = card.kind === 'clip' ? storyClipById(card.clipId) : null;
      const start = range ? range.start : (clip ? storyClipStart(clip) : card.start);
      const end = range ? range.end : (clip ? storyClipEnd(clip) : card.end);
      const tc = (start != null && end != null) ? `${fmtTC(start)} --> ${fmtTC(end)}` : 'NO TIMECODE';
      const body = (card.kind === 'cue' || card.kind === 'clip') ? storyTextForCard(card) : (card.body || '');
      const notes = card.notes ? `\n  Notes: ${card.notes}` : '';
      return `  [${card.kind || 'card'} / ${card.label || ''}] ${card.title || ''}\n  ${tc}\n  ${body}${notes}`;
    }).join('\n\n');
    return `${i+1}. STORY ROW\n${cards}`;
  }).join('\n\n---\n\n');
}


/* ---------- Local Backend (faster-whisper) Integration ---------- */
const API_BASE = window.API_BASE || window.location.origin;

/* ---------- YouTube URL Import (backend yt-dlp; authorized processing only) ---------- */
function parseYouTubeVideoId(url){
  try{
    const u = new URL(String(url || '').trim());
    if (u.hostname.includes('youtu.be')) return u.pathname.split('/').filter(Boolean)[0] || '';
    if (u.pathname.startsWith('/shorts/')) return u.pathname.split('/').filter(Boolean)[1] || '';
    if (u.pathname.startsWith('/embed/')) return u.pathname.split('/').filter(Boolean)[1] || '';
    return u.searchParams.get('v') || '';
  }catch(_e){ return ''; }
}

function getYouTubePreviewUrl(videoId){
  const origin = encodeURIComponent(window.location.origin || 'http://127.0.0.1');
  return `https://www.youtube.com/embed/${encodeURIComponent(videoId)}?rel=0&modestbranding=1&playsinline=1&enablejsapi=1&origin=${origin}`;
}


let __ytFrameReady = false;
let __ytPendingCommands = [];
let __ytMessageBound = false;
let __ytPollTimer = null;
let __ytCurrentTime = 0;
let __ytDuration = 0;
let __ytPlayerState = -1; // -1 unstarted, 0 ended, 1 playing, 2 paused
let __ytLastTickMs = 0;
let __ytLastInfoMs = 0;

// Google Drive iframe preview has no reliable parent-window player API.
// When Drive is previewed as an iframe only, we keep a best-effort virtual
// playhead for app-controlled cue jumps. When the Drive source is cached,
// we switch to the native <video> player via backend media streaming, which
// gives full sync just like local video.
let __gdVirtualTime = 0;
let __gdVirtualPlaying = false;
let __gdVirtualLastMs = 0;
let __gdVirtualTimer = null;

function isYouTubePreviewMode(){
  return !!(currentMediaSource && currentMediaSource.type === 'youtube');
}

function getYouTubePreviewIframe(){
  return document.getElementById('youtubePreviewFrame');
}

function normalizeYouTubeMessageData(data){
  if (!data) return null;
  if (typeof data === 'string'){
    try{ return JSON.parse(data); }catch(_e){ return null; }
  }
  if (typeof data === 'object') return data;
  return null;
}

function handleYouTubeMessage(ev){
  // YouTube sends player status through postMessage when enablejsapi=1.
  // We use this to keep the app's timecode/transcript focus in sync with iframe playback.
  const origin = String(ev.origin || '');
  if (origin && !origin.includes('youtube.com') && !origin.includes('youtube-nocookie.com')) return;
  const msg = normalizeYouTubeMessageData(ev.data);
  if (!msg || !isYouTubePreviewMode()) return;

  if (msg.event === 'onReady'){
    __ytFrameReady = true;
    flushYouTubeCommands();
    startYouTubeTimeSync();
    requestYouTubeInfo();
    return;
  }

  if (msg.event === 'onStateChange'){
    const st = Number(msg.info);
    if (Number.isFinite(st)){
      __ytPlayerState = st;
      __ytLastTickMs = performance.now();
    }
    return;
  }

  if (msg.event === 'infoDelivery' && msg.info){
    const info = msg.info || {};
    if (Number.isFinite(Number(info.currentTime))){
      __ytCurrentTime = Math.max(0, Number(info.currentTime));
      __ytLastInfoMs = performance.now();
      __ytLastTickMs = __ytLastInfoMs;
    }
    if (Number.isFinite(Number(info.duration)) && Number(info.duration) > 0){
      __ytDuration = Number(info.duration);
    }
    if (Number.isFinite(Number(info.playerState))){
      __ytPlayerState = Number(info.playerState);
    }
  }
}

function bindYouTubeMessageListener(){
  if (__ytMessageBound) return;
  __ytMessageBound = true;
  window.addEventListener('message', handleYouTubeMessage, false);
}

function sendYouTubeListeningHandshake(){
  const iframe = getYouTubePreviewIframe();
  if (!iframe || !iframe.contentWindow) return false;
  const payload = JSON.stringify({ event: 'listening', id: iframe.id || 'youtubePreviewFrame' });
  try{ iframe.contentWindow.postMessage(payload, 'https://www.youtube.com'); return true; }
  catch(_e){ try{ iframe.contentWindow.postMessage(payload, '*'); return true; }catch(_e2){ return false; } }
}

function requestYouTubeInfo(){
  if (!isYouTubePreviewMode()) return;
  sendYouTubeListeningHandshake();
  sendYouTubeCommand('getCurrentTime', []);
  sendYouTubeCommand('getDuration', []);
  sendYouTubeCommand('getPlayerState', []);
}

function getMediaCurrentTime(){
  if (isYouTubePreviewMode()){
    // If YouTube infoDelivery is sparse, estimate forward while playing so
    // transcript focus feels live between iframe updates.
    const now = performance.now();
    if (__ytPlayerState === 1 && __ytLastTickMs){
      const dt = Math.max(0, Math.min(1.0, (now - __ytLastTickMs) / 1000));
      if (dt > 0){
        __ytCurrentTime = Math.max(0, __ytCurrentTime + dt);
        __ytLastTickMs = now;
      }
    }
    return __ytCurrentTime || 0;
  }
  if (isGoogleDriveIframeMode()){
    if (__gdVirtualPlaying && __gdVirtualLastMs){
      const now = performance.now();
      const dt = Math.max(0, Math.min(1.0, (now - __gdVirtualLastMs) / 1000));
      if (dt > 0){
        __gdVirtualTime = Math.max(0, __gdVirtualTime + dt);
        __gdVirtualLastMs = now;
      }
    }
    return __gdVirtualTime || 0;
  }
  return player?.currentTime || 0;
}

function getMediaDuration(){
  if (isYouTubePreviewMode()) return __ytDuration || 0;
  if (isGoogleDriveIframeMode()) return Number(currentMediaSource?.metadata?.duration || 0) || 0;
  return Number.isFinite(player?.duration) ? player.duration : 0;
}

function startYouTubeTimeSync(){
  if (__ytPollTimer) return;
  __ytLastTickMs = performance.now();
  __ytPollTimer = setInterval(() => {
    if (!isYouTubePreviewMode()){
      stopYouTubeTimeSync();
      return;
    }
    requestYouTubeInfo();
    handleMediaTimeUpdate(getMediaCurrentTime());
  }, 250);
}

function stopYouTubeTimeSync(){
  if (__ytPollTimer){
    clearInterval(__ytPollTimer);
    __ytPollTimer = null;
  }
}

function sendYouTubeCommand(func, args=[]){
  const iframe = getYouTubePreviewIframe();
  if (!iframe || !iframe.contentWindow) return false;
  const payload = JSON.stringify({ event: 'command', func, args });
  if (!__ytFrameReady && func !== 'stopVideo') {
    __ytPendingCommands.push(payload);
    return true;
  }
  try{
    iframe.contentWindow.postMessage(payload, 'https://www.youtube.com');
    return true;
  }catch(_e){
    try{ iframe.contentWindow.postMessage(payload, '*'); return true; }catch(_e2){ return false; }
  }
}

function flushYouTubeCommands(){
  const iframe = getYouTubePreviewIframe();
  if (!iframe || !iframe.contentWindow) return;
  bindYouTubeMessageListener();
  __ytFrameReady = true;
  sendYouTubeListeningHandshake();
  // Subscribe to iframe API events when available. The polling path below is
  // still the fallback, but these events make play/pause state more accurate.
  try{ sendYouTubeCommand('addEventListener', ['onStateChange']); }catch(_e){}
  try{ sendYouTubeCommand('addEventListener', ['onReady']); }catch(_e){}
  const pending = __ytPendingCommands.splice(0);
  for (const payload of pending){
    try{ iframe.contentWindow.postMessage(payload, 'https://www.youtube.com'); }
    catch(_e){ try{ iframe.contentWindow.postMessage(payload, '*'); }catch(_e2){} }
  }
  requestYouTubeInfo();
  startYouTubeTimeSync();
}

function startGoogleDriveVirtualSync(){
  if (__gdVirtualTimer) return;
  __gdVirtualLastMs = performance.now();
  __gdVirtualTimer = setInterval(() => {
    if (!isGoogleDriveIframeMode()){
      stopGoogleDriveVirtualSync();
      return;
    }
    handleMediaTimeUpdate(getMediaCurrentTime());
  }, 250);
}
function stopGoogleDriveVirtualSync(){
  if (__gdVirtualTimer){
    clearInterval(__gdVirtualTimer);
    __gdVirtualTimer = null;
  }
}
function sendGoogleDriveIframeSoftSeek(seconds, { play=false }={}){
  const iframe = document.getElementById('googleDrivePreviewFrame');
  if (!iframe || !iframe.contentWindow) return false;

  const t = Math.max(0, Number(seconds) || 0);

  // Google Drive's preview iframe does not document a public player API.
  // However some Drive preview builds internally host an HTML5/player surface
  // that may react to postMessage-style seek commands.  Try several harmless
  // command shapes without changing iframe.src.  If Drive ignores them, the app
  // still updates its virtual playhead; the visible iframe simply stays where it is.
  const payloads = [
    {event:'command', func:'seekTo', args:[t, true]},
    {event:'command', func:'setCurrentTime', args:[t]},
    {event:'command', func: play ? 'playVideo' : 'pauseVideo', args:[]},
    {method:'seekTo', value:t},
    {method:'setCurrentTime', value:t},
    {type:'seek', seconds:t},
    {type:'setCurrentTime', seconds:t},
    {command:'seek', seconds:t},
    {command:'currentTime', seconds:t},
  ];

  let sent = false;
  for (const payload of payloads){
    try{
      iframe.contentWindow.postMessage(JSON.stringify(payload), 'https://drive.google.com');
      sent = true;
    }catch(_e){
      try{ iframe.contentWindow.postMessage(payload, '*'); sent = true; }catch(_e2){}
    }
  }
  return sent;
}

function setGoogleDriveIframeTime(seconds, { play=false, forceReload=false }={}){
  const t = Math.max(0, Number(seconds) || 0);
  __gdVirtualTime = t;
  __gdVirtualPlaying = !!play;
  __gdVirtualLastMs = performance.now();

  const src = currentMediaSource || {};
  const fid = src.fileId || parseGoogleDriveFileId(src.url || '');
  const iframe = document.getElementById('googleDrivePreviewFrame');

  // First choice: soft seek through postMessage so the iframe keeps its current
  // play/pause/player state and does not flash back to Drive's poster frame.
  // This is best-effort because Google Drive does not publish a seek API.
  const softSent = sendGoogleDriveIframeSoftSeek(t, { play });

  // Only reload the iframe when explicitly requested. Normal transcript cue
  // clicks should NOT reload, because reload is what resets Drive preview to
  // the poster/first frame. A manual fallback can still call forceReload:true.
  if (fid && iframe && forceReload && !softSent){
    const nextSrc = getGoogleDrivePreviewUrl(fid, t, { autoplay: !!play });
    queueGoogleDriveIframeSeek(nextSrc);
  }

  if (play) startGoogleDriveVirtualSync();
  else stopGoogleDriveVirtualSync();
  handleMediaTimeUpdate(t);
}

function seekMediaTo(seconds, opts={}){
  const t = Math.max(0, Number(seconds) || 0);
  const shouldPlay = !!opts.play;
  if (isYouTubePreviewMode()){
    // YouTube IFrame API command path.  The second seekTo arg means
    // allowSeekAhead=true, so the player jumps to the exact cue time.
    __ytCurrentTime = t;
    __ytLastTickMs = performance.now();
    sendYouTubeCommand('seekTo', [t, true]);
    if (shouldPlay) sendYouTubeCommand('playVideo', []);
    handleMediaTimeUpdate(t);
    return;
  }
  if (isGoogleDriveIframeMode()){
    setGoogleDriveIframeTime(t, { play: shouldPlay });
    return;
  }
  try{ player.currentTime = t; }catch(_e){}
  handleMediaTimeUpdate(t);
  if (shouldPlay){ try{ player.play(); }catch(_e){} }
}

function playMedia(){
  if (isYouTubePreviewMode()) { sendYouTubeCommand('playVideo', []); return; }
  if (isGoogleDriveIframeMode()) { setGoogleDriveIframeTime(getMediaCurrentTime(), { play:true }); return; }
  try{ player.play(); }catch(_e){}
}

function pauseMedia(){
  if (isYouTubePreviewMode()) { sendYouTubeCommand('pauseVideo', []); return; }
  if (isGoogleDriveIframeMode()) { __gdVirtualPlaying = false; stopGoogleDriveVirtualSync(); return; }
  try{ player.pause(); }catch(_e){}
}

function ensureYouTubeFrame(){
  bindYouTubeMessageListener();
  const frameInner = document.querySelector('.frame-inner');
  if (!frameInner) return null;

  // The native <video> element often provides the panel's height. If we use
  // display:none on it, the preview area can collapse to 0px. Keep the frame
  // itself explicitly positioned/aspect-ratioed, then overlay the iframe.
  if (getComputedStyle(frameInner).position === 'static') frameInner.style.position = 'relative';
  frameInner.style.overflow = 'hidden';
  if (!frameInner.style.aspectRatio) frameInner.style.aspectRatio = '16 / 9';
  frameInner.style.background = '#000';

  let mount = document.getElementById('youtubePreviewMount');
  if (!mount){
    mount = document.createElement('div');
    mount.id = 'youtubePreviewMount';
    mount.className = 'youtube-preview-mount';
    mount.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:#000;display:none;z-index:20;';
    frameInner.appendChild(mount);
  }

  let iframe = document.getElementById('youtubePreviewFrame');
  if (!iframe){
    iframe = document.createElement('iframe');
    iframe.id = 'youtubePreviewFrame';
    iframe.className = 'youtube-preview-frame';
    iframe.title = 'YouTube preview';
    iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
    iframe.setAttribute('allowfullscreen', '');
    iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#000;';
    iframe.addEventListener('load', flushYouTubeCommands);
    mount.appendChild(iframe);
  }
  return iframe;
}

function setYouTubePreviewVisible(on){
  const mount = document.getElementById('youtubePreviewMount');
  const iframe = document.getElementById('youtubePreviewFrame');
  if (mount) mount.style.display = on ? 'block' : 'none';
  if (on){
    bindYouTubeMessageListener();
    __ytLastTickMs = performance.now();
    startYouTubeTimeSync();
  }
  if (!on && iframe) {
    try{ sendYouTubeCommand('stopVideo', []); }catch(_e){}
    stopYouTubeTimeSync();
    iframe.removeAttribute('src');
    __ytFrameReady = false;
    __ytPendingCommands = [];
    __ytCurrentTime = 0;
    __ytDuration = 0;
    __ytPlayerState = -1;
    __ytLastTickMs = 0;
    __ytLastInfoMs = 0;
  }

  if (player){
    if (on){
      pauseMedia();
      // Do not use display:none: it can collapse the player panel height.
      player.style.display = '';
      player.style.opacity = '0';
      player.style.visibility = 'hidden';
      player.style.pointerEvents = 'none';
    } else {
      player.style.display = '';
      player.style.opacity = '';
      player.style.visibility = '';
      player.style.pointerEvents = '';
    }
  }

  const controls = document.getElementById('videoControls');
  if (controls) controls.style.display = on ? 'none' : '';
}

function activateLocalMedia(file){
  currentMediaSource = { type: 'local', file: file || null, cacheId: null };
  ensureYouTubeFrame();
  setYouTubePreviewVisible(false);
  try{ setGoogleDrivePreviewVisible(false); }catch(_e){}
  if (player){ player.src = URL.createObjectURL(file); }
}

function activateYouTubePreview({ url, metadata={}, permissionConfirmed=false }){
  try{ setGoogleDrivePreviewVisible(false); }catch(_e){}
  const videoId = metadata.id || parseYouTubeVideoId(url);
  if (!videoId){ alert('Could not find a YouTube video ID from this URL.'); return; }
  currentMediaSource = { type: 'youtube', url, videoId, metadata, permissionConfirmed: !!permissionConfirmed };
  const iframe = ensureYouTubeFrame();
  if (iframe){
    // Load after the mount exists, then reveal. This fixes cases where the
    // previous build created the iframe but the native video still owned layout.
    __ytFrameReady = false;
    __ytPendingCommands = [];
    __ytCurrentTime = 0;
    __ytDuration = 0;
    __ytPlayerState = -1;
    __ytLastTickMs = performance.now();
    bindYouTubeMessageListener();
    iframe.src = getYouTubePreviewUrl(videoId);
  }
  setYouTubePreviewVisible(true);
  const title = metadata.title || 'YouTube video';
  setStatusSafe(`YouTube preview loaded: ${title}`);
}

function getCurrentYouTubeSource(){
  return (currentMediaSource && currentMediaSource.type === 'youtube') ? currentMediaSource : null;
}

async function fetchYouTubeDefaults(){
  try{
    const res = await fetch(`${API_BASE}/api/youtube_defaults`, { method:'GET' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  }catch(_e){
    return { default_download_dir: 'downloads/youtube', download_dir_relative: 'downloads/youtube' };
  }
}

async function probeYouTubeUrl(url){
  const res = await fetch(`${API_BASE}/api/youtube_probe`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url })
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok || data?.ok === false) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
  return data;
}

function ensureYouTubeImportModal(){
  if (document.getElementById('youtubeImportModal')) return;
  const style = document.createElement('style');
  style.id = 'youtubeImportStyle';
  style.textContent = `
    .youtube-import-grid{display:grid;grid-template-columns:1fr;gap:12px}
    .youtube-mode-box{display:flex;gap:10px;flex-wrap:wrap;align-items:center;background:rgba(255,255,255,.04);padding:10px;border-radius:10px}
    .youtube-mode-box label{display:flex;align-items:center;gap:6px}
    .youtube-download-options{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .youtube-cc-options{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .youtube-probe-card{font-size:12px;line-height:1.5;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px;color:#e9edf1}
    .youtube-preview-frame{z-index:1}
    .youtube-icon-btn{display:inline-flex;align-items:center;gap:7px}
    .youtube-icon-btn .yt-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:17px;border-radius:5px;background:#ff0033;color:#fff;font-size:10px;line-height:1;padding-left:1px}
    .youtube-icon-btn .yt-icon-label{font-size:13px}
    .youtube-tabs{display:flex;gap:8px;margin-bottom:12px;border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:10px}
    .youtube-tab-btn{height:34px;border-radius:999px;padding:0 12px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:var(--ink);cursor:pointer}
    .youtube-tab-btn.is-active{border-color:var(--gold-2);color:var(--gold-2);background:rgba(215,180,106,.10)}
    .youtube-tab-panel{display:none}
    .youtube-tab-panel.is-active{display:grid}
    .youtube-export-grid{grid-template-columns:1fr 1fr;gap:12px}
    .youtube-export-grid .full{grid-column:1 / -1}
    .youtube-export-status{font-size:12px;line-height:1.45;padding:10px;border-radius:12px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.04)}
    .youtube-doc-loader{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;padding:10px;border:1px solid rgba(255,255,255,.08);border-radius:12px;background:rgba(255,255,255,.035)}
    .youtube-doc-loader label{flex:1 1 320px}
    .youtube-export-textarea{width:100%;min-height:120px;resize:vertical}
    .youtube-export-tags{width:100%}
    .youtube-field-hint{display:flex;justify-content:space-between;gap:10px;margin-top:3px;font-size:11px;color:var(--ink-dim)}
    .youtube-upload-meter{height:8px;border-radius:999px;background:rgba(255,255,255,.12);overflow:hidden;margin-top:6px}
    .youtube-upload-meter > span{display:block;height:100%;width:0%;background:linear-gradient(90deg,var(--gold),var(--gold-2));transition:width .18s ease}
    #youtubeImportModal{align-items:center;justify-items:center;overflow:hidden;padding:18px}
    #youtubeImportModal .youtube-modal-card{width:min(980px,96vw);max-width:96vw;max-height:92vh;display:flex;flex-direction:column;overflow:hidden}
    #youtubeImportModal .modal-body{flex:1 1 auto;min-height:0;overflow:auto;padding-bottom:12px}
    #youtubeImportModal .modal-foot{flex:0 0 auto}
    .youtube-upload-checklist{font-size:12px;line-height:1.55;padding:10px;border-radius:12px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.035)}
    .youtube-upload-checklist .ok{color:#6ee7b7}.youtube-upload-checklist .warn{color:#fbbf24}.youtube-upload-checklist .bad{color:#fb7185}
    .youtube-ai-helper{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:10px;border:1px solid rgba(215,180,106,.22);border-radius:12px;background:rgba(215,180,106,.06)}
    .youtube-ai-helper .youtube-ai-status{font-size:12px;color:var(--ink-dim)}
  `;
  document.head.appendChild(style);

  const wrap = document.createElement('div');
  wrap.id = 'youtubeImportModal';
  wrap.className = 'modal-overlay hidden';
  wrap.innerHTML = `
    <div class="modal-card youtube-modal-card" role="dialog" aria-modal="true" aria-labelledby="ytTitle">
      <div class="modal-head">
        <div>
          <div id="ytTitle" class="modal-title">YouTube</div>
          <div class="modal-sub">Import videos/captions from YouTube, or prepare export/upload settings for your channel.</div>
        </div>
        <button class="btn btn-outline btn-mini" id="ytClose" type="button" aria-label="Close">✕</button>
      </div>
      <div class="modal-body">
        <div class="youtube-tabs" role="tablist">
          <button class="youtube-tab-btn is-active" id="ytTabImport" type="button" data-yt-tab="import">Import from YouTube</button>
          <button class="youtube-tab-btn" id="ytTabExport" type="button" data-yt-tab="export">Export to YouTube</button>
        </div>
        <div id="ytImportPanel" class="youtube-tab-panel youtube-import-grid is-active">
        <label class="muted" style="display:flex;flex-direction:column;gap:5px">YouTube URL
          <input id="ytUrlInput" class="ui-dark-input" type="url" placeholder="https://www.youtube.com/watch?v=..." style="width:100%">
        </label>
        <div class="youtube-mode-box">
          <label><input type="checkbox" id="ytModePreview" checked> Preview Only</label>
          <label><input type="checkbox" id="ytModeCC"> Import CC</label>
          <label><input type="checkbox" id="ytModeDownload"> Download</label>
          <button class="btn btn-outline btn-mini" id="ytProbe" type="button">Probe</button>
          <span class="muted" id="ytProbeStatus"></span>
        </div>
        <label class="muted" style="display:flex;align-items:flex-start;gap:8px;line-height:1.45">
          <input id="ytPermission" type="checkbox" style="margin-top:3px">
          <span>I own this video or have permission to process/download its audio or video.</span>
        </label>
        <div id="ytCCOptions" class="youtube-cc-options" style="display:none">
          <label class="muted" style="display:flex;flex-direction:column;gap:5px;flex:1 1 280px">Caption track
            <select id="ytCaptionChoice" class="ui-dark-select" style="width:100%"><option value="auto">Auto-select best available CC</option></select>
          </label>
          <span class="muted" style="font-size:12px">Imports YouTube CC directly into Sub A without running Whisper.</span>
        </div>
        <div id="ytDownloadOptions" class="youtube-download-options" style="display:none">
          <label class="muted" style="display:flex;flex-direction:column;gap:5px">Resolution / format
            <select id="ytResolution" class="ui-dark-select" style="min-width:180px"><option value="best">Best available</option><option value="1080">1080p</option><option value="720">720p</option><option value="480">480p</option><option value="audio">Audio only</option></select>
          </label>
          <label class="muted" style="display:flex;flex-direction:column;gap:5px;flex:1 1 280px">Save folder
            <input id="ytOutputDir" class="ui-dark-input" type="text" value="downloads/youtube" placeholder="downloads/youtube" style="width:100%">
          </label>
        </div>
        <div id="ytProbeCard" class="youtube-probe-card" style="display:none"></div>
        </div>
        <div id="ytExportPanel" class="youtube-tab-panel youtube-export-grid">
          <div class="youtube-export-status full" id="ytExportStatus">Not connected.</div>
          <div class="youtube-ai-helper full">
            <button class="btn btn-outline" id="ytSuggestMetadataAI" type="button">AI Suggest Metadata</button>
            <label class="muted" style="display:flex;align-items:center;gap:6px;font-size:12px"><input id="ytAiOverwrite" type="checkbox" checked> Fill fields</label>
            <span class="youtube-ai-status" id="ytAiMetadataStatus">Uses current transcript / story / timeline context.</span>
          </div>
          <div class="youtube-doc-loader full">
            <label class="muted" style="display:flex;flex-direction:column;gap:5px">Google Doc metadata URL
              <input id="ytGoogleDocUrl" class="ui-dark-input" type="url" placeholder="https://docs.google.com/document/d/...">
            </label>
            <button class="btn btn-outline" id="ytFetchGoogleDoc" type="button">Fetch Metadata from Google Doc</button>
            <span class="muted" id="ytGoogleDocStatus" style="font-size:12px"></span>
          </div>
          <label class="muted full" style="display:flex;flex-direction:column;gap:5px">Title
            <input id="ytExportTitle" class="ui-dark-input" type="text" maxlength="100" placeholder="YouTube title">
            <span class="youtube-field-hint"><span id="ytTitleHint">Title required</span><span id="ytTitleCount">0 / 100</span></span>
          </label>
          <label class="muted full" style="display:flex;flex-direction:column;gap:5px">Description
            <textarea id="ytExportDescription" class="ui-dark-textarea youtube-export-textarea" placeholder="YouTube description"></textarea>
            <span class="youtube-field-hint"><span>Description from Google Doc or manual entry</span><span id="ytDescCount">0 / 5000</span></span>
          </label>
          <label class="muted full" style="display:flex;flex-direction:column;gap:5px">Tags
            <input id="ytExportTags" class="ui-dark-input youtube-export-tags" type="text" placeholder="tag1, tag2, tag3">
            <span class="youtube-field-hint"><span>Comma-separated tags</span><span id="ytTagsCount">0 tags</span></span>
          </label>
          <label class="muted full" style="display:flex;flex-direction:column;gap:5px">Thumbnail note / path
            <input id="ytExportThumbnail" class="ui-dark-input" type="text" placeholder="Optional thumbnail file path or note">
          </label>
          <label class="muted full" style="display:flex;flex-direction:column;gap:5px">Schedule / publish note
            <input id="ytExportSchedule" class="ui-dark-input" type="text" placeholder="Optional schedule time or approval note">
          </label>
          <label class="muted full" style="display:flex;flex-direction:column;gap:5px">Video file to upload
            <input id="ytExportVideoFile" class="ui-dark-input" type="file" accept="video/*">
          </label>
          <label class="muted full" style="display:flex;flex-direction:column;gap:5px">Thumbnail image file
            <input id="ytExportThumbnailFile" class="ui-dark-input" type="file" accept="image/png,image/jpeg,image/webp">
          </label>
          <div class="full youtube-caption-options" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:10px;border:1px solid rgba(255,255,255,.08);border-radius:12px;background:rgba(255,255,255,.035)">
            <span class="muted">Caption tracks</span>
            <label class="muted" style="display:flex;align-items:center;gap:6px"><input id="ytUploadSubA" type="checkbox" checked> Upload Sub A</label>
            <label class="muted" style="display:flex;align-items:center;gap:6px"><input id="ytUploadSubB" type="checkbox"> Upload Sub B</label>
          </div>
          <label class="muted full" style="display:flex;flex-direction:column;gap:5px">OAuth Client ID
            <input id="ytClientId" class="ui-dark-input" type="text" placeholder="Google OAuth Client ID" autocomplete="off">
          </label>
          <label class="muted full" style="display:flex;flex-direction:column;gap:5px">OAuth Client Secret
            <input id="ytClientSecret" class="ui-dark-input" type="password" placeholder="Google OAuth Client Secret" autocomplete="off">
          </label>
          <label class="muted" style="display:flex;flex-direction:column;gap:5px">Default visibility
            <select id="ytExportPrivacy" class="ui-dark-select"><option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></select>
          </label>
          <label class="muted" style="display:flex;flex-direction:column;gap:5px">Category
            <select id="ytExportCategory" class="ui-dark-select" style="width:100%;height:35px"><option value="1">Film & Animation</option><option value="2">Autos & Vehicles</option><option value="10">Music</option><option value="15">Pets & Animals</option><option value="17">Sports</option><option value="19">Travel & Events</option><option value="20">Gaming</option><option value="22">People & Blogs</option><option value="23">Comedy</option><option value="24">Entertainment</option><option value="25" selected>News & Politics</option><option value="26">Howto & Style</option><option value="27">Education</option><option value="28">Science & Technology</option><option value="29">Nonprofits & Activism</option></select>
          </label>
          <label class="muted" style="display:flex;flex-direction:column;gap:5px">Default language
            <input id="ytExportLanguage" class="ui-dark-input" type="text" value="en" placeholder="en">
          </label>
          <label class="muted" style="display:flex;align-items:center;gap:8px;padding-top:24px">
            <input id="ytExportMadeForKids" type="checkbox"> Made for kids
          </label>
          <div class="youtube-upload-checklist full" id="ytUploadChecklist">Upload checklist will appear here.</div>
          <div class="full" id="ytUploadProgressWrap" style="display:none">
            <div class="youtube-upload-meter"><span id="ytUploadProgressBar"></span></div>
            <div class="youtube-field-hint"><span id="ytUploadProgressText">Preparing…</span><span id="ytUploadProgressPct">0%</span></div>
          </div>
          <div class="full" style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap">
            <button class="btn btn-outline" id="ytSaveCredentials" type="button">Save Credentials</button>
            <button class="btn btn-outline" id="ytUploadPrivate" type="button">Upload to YouTube</button>
            <button class="btn btn-gold" id="ytConnectAccount" type="button">Connect YouTube Account</button>
          </div>
          <div class="muted full" style="font-size:12px;line-height:1.45">Redirect URI to add in Google Cloud: <code id="ytRedirectUri">http://127.0.0.1:8000/api/youtube_export/oauth_callback</code></div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" id="ytCancel" type="button">Cancel</button>
        <div style="flex:1"></div>
        <button class="btn btn-gold" id="ytImport" type="button">Import</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const close = () => wrap.classList.add('hidden');
  wrap.querySelector('#ytClose').onclick = close;
  wrap.querySelector('#ytCancel').onclick = close;
  wrap.addEventListener('click', (e)=>{ if (e.target === wrap) close(); });
  const syncMode = () => {
    const previewOn = !!document.getElementById('ytModePreview')?.checked;
    const ccOn = !!document.getElementById('ytModeCC')?.checked;
    const downloadOn = !!document.getElementById('ytModeDownload')?.checked;
    const downOpts = document.getElementById('ytDownloadOptions');
    const ccOpts = document.getElementById('ytCCOptions');
    if (downOpts) downOpts.style.display = downloadOn ? 'flex' : 'none';
    if (ccOpts) ccOpts.style.display = ccOn ? 'flex' : 'none';
    const btn = document.getElementById('ytImport');
    if (btn) {
      const actions = [];
      if (previewOn) actions.push('Preview');
      if (ccOn) actions.push('Import CC');
      if (downloadOn) actions.push('Download');
      btn.textContent = actions.length ? actions.join(' + ') : 'Import Preview';
    }
  };
  ['ytModePreview','ytModeCC','ytModeDownload'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', syncMode);
  });
  syncMode();

  const setYtTab = (tab) => {
    const isExport = tab === 'export';
    document.getElementById('ytTabImport')?.classList.toggle('is-active', !isExport);
    document.getElementById('ytTabExport')?.classList.toggle('is-active', isExport);
    document.getElementById('ytImportPanel')?.classList.toggle('is-active', !isExport);
    document.getElementById('ytExportPanel')?.classList.toggle('is-active', isExport);
    const importBtn = document.getElementById('ytImport');
    if (importBtn) importBtn.style.display = isExport ? 'none' : '';
    if (isExport) refreshYouTubeExportStatus();
  };
  document.getElementById('ytTabImport')?.addEventListener('click', () => setYtTab('import'));
  document.getElementById('ytTabExport')?.addEventListener('click', () => setYtTab('export'));
  document.getElementById('ytSaveCredentials')?.addEventListener('click', saveYouTubeExportCredentials);
  document.getElementById('ytConnectAccount')?.addEventListener('click', connectYouTubeExportAccount);
  ['ytExportTitle','ytExportDescription','ytExportTags','ytExportVideoFile','ytUploadSubA','ytUploadSubB'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.__ytCounterBound){
      el.__ytCounterBound = true;
      el.addEventListener('input', updateYouTubeExportCounters);
      el.addEventListener('change', updateYouTubeExportCounters);
    }
  });
  updateYouTubeExportCounters();
  document.getElementById('ytFetchGoogleDoc')?.addEventListener('click', fetchYouTubeMetadataFromGoogleDoc);
  document.getElementById('ytSuggestMetadataAI')?.addEventListener('click', suggestYouTubeMetadataWithAI);
  document.getElementById('ytUploadPrivate')?.addEventListener('click', uploadCurrentYouTubeExport);

  wrap.querySelector('#ytProbe').addEventListener('click', async ()=>{
    const url = document.getElementById('ytUrlInput')?.value?.trim() || '';
    const st = document.getElementById('ytProbeStatus');
    try{
      if (st) st.textContent = 'Probing…';
      const meta = await probeYouTubeUrl(url);
      renderYouTubeProbe(meta);
      if (st) st.textContent = 'Ready';
    }catch(err){
      if (st) st.textContent = 'Probe failed';
      alert('YouTube probe failed: ' + (err?.message || err));
    }
  });

  wrap.querySelector('#ytImport').addEventListener('click', async ()=>{
    const url = document.getElementById('ytUrlInput')?.value?.trim() || '';
    let previewOn = !!document.getElementById('ytModePreview')?.checked;
    const ccOn = !!document.getElementById('ytModeCC')?.checked;
    const downloadOn = !!document.getElementById('ytModeDownload')?.checked;
    const permissionConfirmed = !!document.getElementById('ytPermission')?.checked;
    // Capture the chosen CC track BEFORE the import-time probe, because the probe
    // repopulates the dropdown. This keeps explicit user choices from falling
    // back to "Auto-select best available CC".
    const selectedCaptionChoice = document.getElementById('ytCaptionChoice')?.value || 'auto';
    if (!url){ alert('Paste a YouTube URL first.'); return; }
    if (!previewOn && !ccOn && !downloadOn) previewOn = true;
    try{
      let meta = null;
      try {
        meta = await probeYouTubeUrl(url);
        renderYouTubeProbe(meta);
        const ccSel = document.getElementById('ytCaptionChoice');
        if (ccSel && selectedCaptionChoice !== 'auto' && Array.from(ccSel.options).some(o => o.value === selectedCaptionChoice)){
          ccSel.value = selectedCaptionChoice;
        }
      } catch(_e) { meta = { id: parseYouTubeVideoId(url), title: 'YouTube video' }; }
      if (previewOn){
        activateYouTubePreview({ url, metadata: meta, permissionConfirmed });
      }
      if (ccOn){
        if (!permissionConfirmed){ alert('Please confirm you own this video or have permission to import its captions.'); return; }
        await startYouTubeCCImport(url, permissionConfirmed, selectedCaptionChoice);
      }
      if (downloadOn){
        if (!permissionConfirmed){ alert('Please confirm you own this video or have permission to download it.'); return; }
        await startYouTubeDownload(url, permissionConfirmed);
      }
      close();
    }catch(err){
      alert('YouTube import failed: ' + (err?.message || err));
    }
  });
}

async function fetchYouTubeMetadataFromGoogleDoc(){
  const url = document.getElementById('ytGoogleDocUrl')?.value?.trim() || '';
  const st = document.getElementById('ytGoogleDocStatus');
  if (!url){ alert('Paste a Google Doc URL first.'); return; }
  try{
    if (st) st.textContent = 'Loading…';
    let res = await fetch(`${API_BASE}/api/youtube_export/google_doc_metadata`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url })
    });
    // Fallback for older/running backends that temporarily expose this route as GET only.
    if (res.status === 405){
      res = await fetch(`${API_BASE}/api/youtube_export/google_doc_metadata?url=${encodeURIComponent(url)}`);
    }
    const data = await res.json().catch(()=>({}));
    if (!res.ok || data?.ok === false) throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
    applyYouTubeMetadataToExportForm(data.metadata || {});
    if (st) st.textContent = 'Loaded metadata';
    setStatusSafe('YouTube metadata loaded from Google Doc.');
  }catch(err){
    if (st) st.textContent = 'Load failed';
    alert('Google Doc metadata fetch failed: ' + (err?.message || err));
  }
}


const YOUTUBE_CATEGORY_NAME_TO_ID = {
  'film & animation':'1', 'film and animation':'1', 'autos & vehicles':'2', 'autos and vehicles':'2',
  'music':'10', 'pets & animals':'15', 'pets and animals':'15', 'sports':'17',
  'travel & events':'19', 'travel and events':'19', 'gaming':'20', 'people & blogs':'22', 'people and blogs':'22',
  'comedy':'23', 'entertainment':'24', 'news & politics':'25', 'news and politics':'25',
  'howto & style':'26', 'howto and style':'26', 'how-to & style':'26', 'education':'27',
  'science & technology':'28', 'science and technology':'28', 'nonprofits & activism':'29', 'nonprofits and activism':'29'
};
function normalizeYouTubeCategoryValue(value){
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d+$/.test(raw)) return raw;
  const key = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  return YOUTUBE_CATEGORY_NAME_TO_ID[key] || '';
}
function getYouTubeCategoryLabelById(id){
  const sel = document.getElementById('ytExportCategory');
  const opt = sel ? Array.from(sel.options).find(o => String(o.value) === String(id)) : null;
  return opt ? opt.textContent : String(id || '');
}
function buildYouTubeAIMetadataSource(){
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  let chunks = [];
  try{
    if (typeof storyRows !== 'undefined' && Array.isArray(storyRows) && storyRows.length){
      const storyText = storyRows.map((row, ri) => {
        const cards = (row.cards || []).map((card, ci) => {
          const txt = clean(card.text || card.manualText || card.labelText || '');
          return txt ? `Story ${ri+1}.${ci+1}: ${txt}` : '';
        }).filter(Boolean).join('\n');
        return cards;
      }).filter(Boolean).join('\n');
      if (storyText) chunks.push('STORY MODE ASSEMBLY:\n' + storyText);
    }
  }catch(_e){}
  try{
    if (typeof timelineClips !== 'undefined' && Array.isArray(timelineClips) && timelineClips.length){
      const tl = timelineClips.slice(0, 80).map((c, i) => {
        const txt = clean(c.text || c.reason || c.title || c.name || '');
        const st = Number(c.start ?? c.sourceStart ?? 0); const en = Number(c.end ?? c.sourceEnd ?? 0);
        return `[${i+1}] ${formatTimecodeFromSeconds(st, getFPS())} --> ${formatTimecodeFromSeconds(en, getFPS())} ${txt}`;
      }).join('\n');
      if (tl) chunks.push('TIMELINE CLIPS:\n' + tl);
    }
  }catch(_e){}
  const a = entries.slice(0, 220).map((e,i)=>`[${i+1}] ${clean(e.text)}`).filter(Boolean).join('\n');
  const b = entriesB.slice(0, 220).map((e,i)=>`[${i+1}] ${clean(e.text)}`).filter(Boolean).join('\n');
  if (a) chunks.push('SUB A TRANSCRIPT:\n' + a);
  if (b) chunks.push('SUB B TRANSCRIPT:\n' + b);
  return chunks.join('\n\n').slice(0, 24000);
}
function parseAIJsonObject(text){
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch(_e) {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced){ try { return JSON.parse(fenced[1]); } catch(_e) {} }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first){
    try { return JSON.parse(raw.slice(first, last + 1)); } catch(_e) {}
  }
  throw new Error('AI did not return valid JSON metadata.');
}
async function suggestYouTubeMetadataWithAI(){
  const st = document.getElementById('ytAiMetadataStatus');
  const overwrite = !!document.getElementById('ytAiOverwrite')?.checked;
  const source_text = buildYouTubeAIMetadataSource();
  if (!source_text.trim()){ alert('No transcript/story/timeline content is available for AI metadata.'); return; }
  const current = getYouTubeExportMetadataDraft();
  const instructions = `Generate YouTube metadata for a newsroom video. Return strict JSON only with these keys: title, description, tags, category, visibility, language, made_for_kids. Keep title under 100 characters. Use category as a YouTube category name, preferably News & Politics for news content. Tags must be an array of concise tags. Current draft metadata, if any: ${JSON.stringify(current, null, 2)}`;
  try{
    if (st) st.textContent = 'Generating metadata with AI…';
    const res = await fetch(`${API_BASE}/api/ai_assistant`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ task:'youtube_metadata_json', instructions, source_text, model: document.getElementById('aiAssistModel')?.value || 'deepseek-chat', dictionary: loadDictionaryPairs() })
    });
    const data = await res.json().catch(()=>({}));
    if (!res.ok || !data?.ok) throw new Error(data?.detail || data?.message || (`HTTP ${res.status}`));
    const meta = parseAIJsonObject(data.output || '');
    if (!overwrite){
      const existing = getYouTubeExportMetadataDraft();
      for (const k of Object.keys(meta)){
        if (existing[k] != null && String(existing[k]).trim && String(existing[k]).trim()) delete meta[k];
      }
    }
    applyYouTubeMetadataToExportForm(meta);
    if (st) st.textContent = 'AI metadata filled. Please review before uploading.';
    setStatusSafe('AI YouTube metadata generated.');
  }catch(err){
    if (st) st.textContent = 'AI metadata failed.';
    alert('AI metadata failed: ' + (err?.message || err));
  }
}

function applyYouTubeMetadataToExportForm(meta){
  const setVal = (id, val) => { const el = document.getElementById(id); if (el && val != null && String(val).trim() !== '') el.value = String(val); };
  setVal('ytExportTitle', meta.title);
  setVal('ytExportDescription', meta.description);
  if (Array.isArray(meta.tags)) setVal('ytExportTags', meta.tags.join(', '));
  else setVal('ytExportTags', meta.tags);
  setVal('ytExportThumbnail', meta.thumbnail);
  setVal('ytExportSchedule', meta.schedule || meta.publish_at || meta.publishAt);
  setVal('ytExportLanguage', meta.language || meta.default_language);
  const catVal = normalizeYouTubeCategoryValue(meta.category_id || meta.categoryId || meta.category || '');
  if (catVal) setVal('ytExportCategory', catVal);
  const privacy = String(meta.visibility || meta.privacy || '').trim().toLowerCase();
  if (['private','unlisted','public'].includes(privacy)){
    const el = document.getElementById('ytExportPrivacy'); if (el) el.value = privacy;
  }
  const kids = String(meta.made_for_kids ?? meta.madeForKids ?? '').trim().toLowerCase();
  if (kids){
    const el = document.getElementById('ytExportMadeForKids');
    if (el) el.checked = ['yes','true','1','y','made for kids'].includes(kids);
  }
  const subA = document.getElementById('ytUploadSubA');
  const subB = document.getElementById('ytUploadSubB');
  if (subA && meta.upload_sub_a != null) subA.checked = !!meta.upload_sub_a;
  if (subB && meta.upload_sub_b != null) subB.checked = !!meta.upload_sub_b;
  updateYouTubeExportCounters();
}


function updateYouTubeExportCounters(){
  const title = document.getElementById('ytExportTitle')?.value || '';
  const desc = document.getElementById('ytExportDescription')?.value || '';
  const tagsRaw = document.getElementById('ytExportTags')?.value || '';
  const tags = tagsRaw.split(',').map(x => x.trim()).filter(Boolean);
  const setText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  setText('ytTitleCount', `${title.length} / 100`);
  setText('ytDescCount', `${desc.length} / 5000`);
  setText('ytTagsCount', `${tags.length} tag${tags.length === 1 ? '' : 's'}`);
  setText('ytTitleHint', title.trim() ? 'Ready' : 'Title required');
  const checklist = document.getElementById('ytUploadChecklist');
  if (checklist){
    const videoReady = !!document.getElementById('ytExportVideoFile')?.files?.[0];
    const subAOn = !!document.getElementById('ytUploadSubA')?.checked;
    const subBOn = !!document.getElementById('ytUploadSubB')?.checked;
    const subAReady = !subAOn || !!getYouTubeExportCaptionPayload('A');
    const subBReady = !subBOn || !!getYouTubeExportCaptionPayload('B');
    const titleReady = !!title.trim();
    const rows = [
      [`${titleReady ? 'ok' : 'bad'}`, `${titleReady ? '✓' : '!' } Title`],
      [`${videoReady ? 'ok' : 'bad'}`, `${videoReady ? '✓' : '!' } Video file selected`],
      [`${subAReady ? 'ok' : 'warn'}`, `${subAReady ? '✓' : '!' } Sub A captions${subAOn ? '' : ' not selected'}`],
      [`${subBReady ? 'ok' : 'warn'}`, `${subBReady ? '✓' : '!' } Sub B captions${subBOn ? '' : ' not selected'}`],
    ];
    checklist.innerHTML = rows.map(([cls, txt]) => `<span class="${cls}">${escapeHtml(txt)}</span>`).join(' · ');
  }
}

function validateYouTubeExportDraft(meta, videoFile){
  const problems = [];
  if (!videoFile) problems.push('Choose a video file to upload.');
  if (!meta.title) problems.push('YouTube title is required.');
  if (meta.title && meta.title.length > 100) problems.push('Title is longer than 100 characters.');
  if ((meta.description || '').length > 5000) problems.push('Description is longer than 5000 characters.');
  if (document.getElementById('ytUploadSubA')?.checked && !getYouTubeExportCaptionPayload('A')) problems.push('Sub A is selected but there are no Sub A cues.');
  if (document.getElementById('ytUploadSubB')?.checked && !getYouTubeExportCaptionPayload('B')) problems.push('Sub B is selected but there are no Sub B cues.');
  return problems;
}

function setYouTubeUploadProgress(pct, text){
  const wrap = document.getElementById('ytUploadProgressWrap');
  const bar = document.getElementById('ytUploadProgressBar');
  const txt = document.getElementById('ytUploadProgressText');
  const pc = document.getElementById('ytUploadProgressPct');
  const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  if (wrap) wrap.style.display = '';
  if (bar) bar.style.width = v + '%';
  if (txt) txt.textContent = text || 'Uploading…';
  if (pc) pc.textContent = v + '%';
}

function postFormDataWithProgress(url, fd, onProgress){
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url, true);
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) onProgress((ev.loaded / ev.total) * 100);
    };
    xhr.onload = () => {
      let data = {};
      try{ data = JSON.parse(xhr.responseText || '{}'); }catch(_e){}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.detail || data?.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(fd);
  });
}

function getYouTubeExportMetadataDraft(){
  const tagsRaw = document.getElementById('ytExportTags')?.value || '';
  return {
    title: document.getElementById('ytExportTitle')?.value?.trim() || '',
    description: document.getElementById('ytExportDescription')?.value || '',
    tags: tagsRaw.split(',').map(x => x.trim()).filter(Boolean),
    thumbnail: document.getElementById('ytExportThumbnail')?.value?.trim() || '',
    schedule: document.getElementById('ytExportSchedule')?.value?.trim() || '',
    privacy: document.getElementById('ytExportPrivacy')?.value || 'private',
    category_id: document.getElementById('ytExportCategory')?.value?.trim() || '25',
    language: document.getElementById('ytExportLanguage')?.value?.trim() || 'en',
    made_for_kids: !!document.getElementById('ytExportMadeForKids')?.checked,
  };
}


function getYouTubeExportCaptionPayload(track='A'){
  const list = (track === 'B') ? (Array.isArray(entriesB) ? entriesB : []) : (Array.isArray(entries) ? entries : []);
  if (!list.length) return '';
  try { return toSRT(list); } catch(_e) { return ''; }
}

async function uploadCurrentYouTubeExport(){
  const statusBox = document.getElementById('ytExportStatus');
  const meta = getYouTubeExportMetadataDraft();
  const videoFile = document.getElementById('ytExportVideoFile')?.files?.[0] || null;
  const thumbFile = document.getElementById('ytExportThumbnailFile')?.files?.[0] || null;
  updateYouTubeExportCounters();
  const problems = validateYouTubeExportDraft(meta, videoFile);
  if (problems.length){ alert('Please fix before uploading:\n\n' + problems.join('\n')); return; }
  if (!confirm(`Upload "${meta.title}" to YouTube as ${meta.privacy || 'private'}?`)) return;

  const fd = new FormData();
  fd.append('video', videoFile, videoFile.name || 'upload.mp4');
  if (thumbFile) fd.append('thumbnail', thumbFile, thumbFile.name || 'thumbnail.jpg');
  fd.append('metadata', JSON.stringify(meta));
  fd.append('upload_sub_a', document.getElementById('ytUploadSubA')?.checked ? '1' : '0');
  fd.append('upload_sub_b', document.getElementById('ytUploadSubB')?.checked ? '1' : '0');
  if (document.getElementById('ytUploadSubA')?.checked) fd.append('sub_a_srt', getYouTubeExportCaptionPayload('A'));
  if (document.getElementById('ytUploadSubB')?.checked) fd.append('sub_b_srt', getYouTubeExportCaptionPayload('B'));

  try{
    if (statusBox) statusBox.innerHTML = 'Uploading video to YouTube…<br><span class="muted">Keep this browser tab open until upload completes.</span>';
    setStatusSafe('Uploading to YouTube…');
    setYouTubeUploadProgress(3, 'Preparing upload…');
    const data = await postFormDataWithProgress(`${API_BASE}/api/youtube_export/upload`, fd, pct => {
      // This progress reflects browser → backend transfer. The backend then performs the YouTube upload.
      setYouTubeUploadProgress(Math.min(85, pct * 0.85), 'Sending video package to backend…');
    });
    setYouTubeUploadProgress(100, 'YouTube upload completed.');
    if (data?.ok === false) throw new Error(data?.detail || data?.error || 'Upload failed');
    const link = data.watch_url || (data.video_id ? `https://www.youtube.com/watch?v=${data.video_id}` : '');
    if (statusBox){
      const cap = Array.isArray(data.captions) && data.captions.length ? `<br>Captions: ${data.captions.map(x => `${escapeHtml(x.track || x.name || 'caption')}${x.ok === false ? ' ⚠️' : ''}`).join(', ')}` : '';
      const studio = data.studio_url ? ` · <a href="${escapeHtml(data.studio_url)}" target="_blank" rel="noopener">Open Studio</a>` : '';
      const thumb = data.thumbnail ? `<br>Thumbnail: ${data.thumbnail.ok === false ? '⚠️ failed' : 'uploaded'}` : '';
      statusBox.innerHTML = `✅ Uploaded to YouTube.<br>${link ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">Open video</a>${studio}` : ''}${cap}${thumb}`;
    }
    setStatusSafe('YouTube upload completed.');
  }catch(err){
    if (statusBox) statusBox.textContent = 'YouTube upload failed: ' + (err?.message || err);
    alert('YouTube upload failed: ' + (err?.message || err));
  }
}

async function refreshYouTubeExportStatus(){
  const statusEl2 = document.getElementById('ytExportStatus');
  try{
    const res = await fetch(`${API_BASE}/api/youtube_export/status`);
    const data = await res.json().catch(()=>({}));
    if (!res.ok) throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
    const idEl = document.getElementById('ytClientId');
    const secEl = document.getElementById('ytClientSecret');
    const privEl = document.getElementById('ytExportPrivacy');
    const catEl = document.getElementById('ytExportCategory');
    const langEl = document.getElementById('ytExportLanguage');
    const kidsEl = document.getElementById('ytExportMadeForKids');
    const redirEl = document.getElementById('ytRedirectUri');
    if (idEl && data.client_id && !idEl.value) idEl.value = data.client_id;
    if (secEl && data.client_secret_saved && !secEl.value) secEl.placeholder = 'Saved client secret';
    if (privEl && data.default_privacy) privEl.value = data.default_privacy;
    if (catEl && data.default_category_id) catEl.value = data.default_category_id;
    if (langEl && data.default_language) langEl.value = data.default_language;
    if (kidsEl) kidsEl.checked = !!data.made_for_kids;
    if (redirEl && data.redirect_uri) redirEl.textContent = data.redirect_uri;
    if (statusEl2){
      const docsOk = !!data.google_docs_connected;
      const base = data.connected ? '✅ Connected to YouTube' : data.configured ? '⚠️ Credentials saved. Connect account next.' : 'Not configured.';
      const docsMsg = data.connected ? (docsOk ? ' · Google Docs backup enabled' : ' · ⚠️ Google Docs backup needs reconnect') : '';
      statusEl2.innerHTML = `${base}${docsMsg}<br><span class="muted">OAuth scopes: ${escapeHtml((data.scopes || []).join(', '))}</span>`;
    }
  }catch(err){
    if (statusEl2) statusEl2.textContent = 'YouTube export status failed: ' + (err?.message || err);
  }
}

async function saveYouTubeExportCredentials(){
  const body = {
    client_id: document.getElementById('ytClientId')?.value?.trim() || '',
    client_secret: document.getElementById('ytClientSecret')?.value?.trim() || '',
    default_privacy: document.getElementById('ytExportPrivacy')?.value || 'private',
    default_category_id: document.getElementById('ytExportCategory')?.value?.trim() || '25',
    default_language: document.getElementById('ytExportLanguage')?.value?.trim() || 'en',
    made_for_kids: !!document.getElementById('ytExportMadeForKids')?.checked,
  };
  if (!body.client_id || !body.client_secret){ alert('Client ID and Client Secret are required.'); return; }
  const res = await fetch(`${API_BASE}/api/youtube_export/config`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok) { alert('Save failed: ' + (data?.detail || data?.error || `HTTP ${res.status}`)); return; }
  await refreshYouTubeExportStatus();
  setStatusSafe('YouTube export credentials saved.');
}

async function connectYouTubeExportAccount(){
  try{
    await saveYouTubeExportCredentials();
    const res = await fetch(`${API_BASE}/api/youtube_export/auth_url?force=1`);
    const data = await res.json().catch(()=>({}));
    if (!res.ok || !data.auth_url) throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
    window.open(data.auth_url, 'youtubeExportOAuth', 'width=720,height=820');
  }catch(err){
    alert('YouTube connect failed: ' + (err?.message || err));
  }
}

window.addEventListener('message', (ev) => {
  if (ev?.data?.type === 'youtube-export-connected'){
    refreshYouTubeExportStatus();
    setStatusSafe('YouTube account connected.');
  }
});

function renderYouTubeProbe(meta){
  const card = document.getElementById('ytProbeCard');
  if (!card) return;
  const dur = Number(meta?.duration || 0);
  const mins = dur ? `${Math.floor(dur/60)}m ${Math.round(dur%60)}s` : 'unknown duration';
  card.style.display = 'block';
  const ccCount = Array.isArray(meta?.caption_options) ? meta.caption_options.length : 0;
  const ccTxt = ccCount ? `<br><span class="muted">Closed captions: ${ccCount} available track${ccCount === 1 ? '' : 's'}</span>` : '<br><span class="muted">Closed captions: none found</span>';
  card.innerHTML = `<b>${escapeHtml(meta?.title || 'YouTube video')}</b><br>${escapeHtml(meta?.uploader || '')}${meta?.uploader ? ' • ' : ''}${mins}${ccTxt}<br><span class="muted">Default download folder: ${escapeHtml(meta?.default_download_dir || 'downloads/youtube')}</span>`;
  const ccSel = document.getElementById('ytCaptionChoice');
  if (ccSel){
    // Preserve the user's explicit caption-track choice when Probe/Import refreshes metadata.
    // Without this, renderYouTubeProbe() rebuilds the dropdown and silently resets it
    // to "auto", so Auto-select overrides the selected CC track.
    const previousChoice = ccSel.value || 'auto';
    const caps = Array.isArray(meta?.caption_options) ? meta.caption_options : [];
    ccSel.innerHTML = '<option value="auto">Auto-select best available CC</option>' + caps.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
    const hasPrevious = previousChoice === 'auto' || caps.some(o => String(o.value) === String(previousChoice));
    ccSel.value = hasPrevious ? previousChoice : 'auto';
    ccSel.disabled = !caps.length;
  }
  const sel = document.getElementById('ytResolution');
  if (sel && Array.isArray(meta?.format_options) && meta.format_options.length){
    sel.innerHTML = meta.format_options.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
  }
  const out = document.getElementById('ytOutputDir');
  if (out && meta?.default_download_dir) out.value = meta.default_download_dir;
}

function escapeHtml(s){
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function openYouTubeImportModal(){
  ensureYouTubeImportModal();
  const wrap = document.getElementById('youtubeImportModal');
  const defaults = await fetchYouTubeDefaults();
  const out = document.getElementById('ytOutputDir');
  if (out && defaults?.default_download_dir) out.value = defaults.default_download_dir;
  wrap?.classList.remove('hidden');
  refreshYouTubeExportStatus();
  setTimeout(()=>document.getElementById('ytUrlInput')?.focus(), 50);
}

function ensureYouTubeImportButton(){
  if (document.getElementById('btnYouTubeImport')) return;
  if (!document.getElementById('youtubeIconButtonStyle')){
    const st = document.createElement('style');
    st.id = 'youtubeIconButtonStyle';
    st.textContent = `.youtube-icon-btn{display:inline-flex;align-items:center;gap:7px}.youtube-icon-btn .yt-icon{display:inline-flex;align-items:center;justify-content:center;width:24px;height:17px;border-radius:5px;background:#ff0033;color:#fff;font-size:10px;line-height:1;padding-left:1px}.youtube-icon-btn .yt-icon-label{font-size:13px}.share-session-btn{display:inline-flex;align-items:center;gap:6px}.view-only-banner{padding:8px 10px;border-radius:10px;background:rgba(255,215,0,.13);border:1px solid rgba(255,215,0,.25);color:#f4e6a0;font-size:13px;margin-top:8px}.view-only-session [contenteditable=\"true\"]{outline:none}`;
    document.head.appendChild(st);
  }
  const toolbar = document.querySelector('.toolbar') || document.querySelector('header .toolbar');
  if (!toolbar) return;
  const btn = document.createElement('button');
  btn.id = 'btnYouTubeImport';
  btn.type = 'button';
  btn.className = 'btn btn-outline youtube-icon-btn';
  btn.title = 'Import YouTube URL';
  btn.setAttribute('aria-label', 'Import YouTube URL');
  btn.innerHTML = '<span class="yt-icon" aria-hidden="true">▶</span><span class="yt-icon-label">YouTube</span>';
  const srtLabel = document.getElementById('srtInput')?.closest('label');
  if (srtLabel && srtLabel.parentElement) srtLabel.insertAdjacentElement('afterend', btn);
  else toolbar.insertBefore(btn, toolbar.firstChild);
  btn.addEventListener('click', () => openYouTubeImportModal());
}

function ensureShareSessionButton(){
  if (document.getElementById('btnShareSession')) return;
  const toolbar = document.querySelector('.toolbar') || document.querySelector('header .toolbar');
  if (!toolbar) return;
  const btn = document.createElement('button');
  btn.id = 'btnShareSession';
  btn.type = 'button';
  btn.className = 'btn btn-outline share-session-btn';
  btn.title = 'Create a share link for the current transcript session';
  btn.innerHTML = '<span aria-hidden=\"true\">🔗</span><span>Share</span>';
  const ytBtn = document.getElementById('btnYouTubeImport');
  if (ytBtn && ytBtn.parentElement) ytBtn.insertAdjacentElement('afterend', btn);
  else toolbar.insertBefore(btn, toolbar.firstChild);
  btn.addEventListener('click', () => openShareSessionModal());
}



function ensureExportDropdown(){
  const toolbar = document.querySelector('.toolbar') || document.querySelector('header .toolbar');
  if (!toolbar || document.getElementById('btnExportMenu')) return;
  if (!document.getElementById('exportMenuStyle')){
    const st = document.createElement('style');
    st.id = 'exportMenuStyle';
    st.textContent = `
      .export-menu-wrap{ position:relative; display:inline-flex; align-items:center; }
      .export-menu-btn{ display:inline-flex; align-items:center; gap:7px; }
      .export-menu-btn::after{ content:'▾'; font-size:10px; opacity:.75; transform:translateY(-1px); }
      .export-menu{ position:absolute; right:0; top:calc(100% + 8px); z-index:9998; min-width:150px; padding:6px; border-radius:14px; background:#101317; border:1px solid rgba(255,255,255,.10); box-shadow:0 14px 34px rgba(0,0,0,.38); display:none; }
      .export-menu.is-open{ display:block; }
      .export-menu button{ width:100%; border:0; background:transparent; color:#e9edf1; text-align:left; padding:9px 10px; border-radius:10px; cursor:pointer; font-size:13px; }
      .export-menu button:hover{ background:rgba(255,255,255,.07); }
      #btnExport,#btnExportVtt{ display:none !important; }
    `;
    document.head.appendChild(st);
  }
  const wrap = document.createElement('div');
  wrap.id = 'btnExportMenu';
  wrap.className = 'export-menu-wrap';
  wrap.innerHTML = `
    <button class="btn btn-outline export-menu-btn" type="button" aria-haspopup="true" aria-expanded="false">Export</button>
    <div class="export-menu" role="menu">
      <button type="button" data-export-kind="srt" role="menuitem">Export SRT</button>
      <button type="button" data-export-kind="vtt" role="menuitem">Export VTT</button>
    </div>`;
  const exportSrt = document.getElementById('btnExport');
  if (exportSrt && exportSrt.parentElement) exportSrt.insertAdjacentElement('beforebegin', wrap);
  else toolbar.appendChild(wrap);
  const btn = wrap.querySelector('.export-menu-btn');
  const menu = wrap.querySelector('.export-menu');
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const open = !menu.classList.contains('is-open');
    menu.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  menu.querySelector('[data-export-kind="srt"]')?.addEventListener('click', () => { menu.classList.remove('is-open'); document.getElementById('btnExport')?.click(); });
  menu.querySelector('[data-export-kind="vtt"]')?.addEventListener('click', () => { menu.classList.remove('is-open'); document.getElementById('btnExportVtt')?.click(); });
  document.addEventListener('click', (ev) => { if (!wrap.contains(ev.target)) menu.classList.remove('is-open'); });
}

function rearrangeTopToolbar(){
  const toolbar = document.querySelector('.toolbar') || document.querySelector('header .toolbar');
  if (!toolbar) return;

  const nodes = [];
  const importVideo = document.getElementById('fileInput')?.closest('label');
  const importSrt = document.getElementById('srtInput')?.closest('label');
  const youtube = document.getElementById('btnYouTubeImport');
  const drive = document.getElementById('btnGoogleDriveImport');
  const share = document.getElementById('btnShareSession');
  ensureExportDropdown();
  const exportMenu = document.getElementById('btnExportMenu');
  const exportSrt = document.getElementById('btnExport');
  const exportVtt = document.getElementById('btnExportVtt');
  const fps = document.getElementById('fpsSelect')?.closest('.fps');
  const guide = toolbar.querySelector('a[href*="README"], a[href$="README.html"]');

  [importVideo, importSrt, youtube, drive, share, exportMenu, fps, guide].forEach(el => {
    if (el && toolbar.contains(el) && !nodes.includes(el)) nodes.push(el);
  });

  // Append in requested order. Any unknown toolbar controls remain after these.
  nodes.forEach(el => toolbar.appendChild(el));
}

async function startYouTubeCCImport(url, permissionConfirmed, captionChoiceOverride=null){
  const caption_choice = captionChoiceOverride || document.getElementById('ytCaptionChoice')?.value || 'auto';
  progressStart('Importing YouTube closed captions…');
  const res = await fetch(`${API_BASE}/api/youtube_cc_start`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ url, permission_confirmed: !!permissionConfirmed, caption_choice })
  });
  const startResp = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(startResp?.error || startResp?.message || `HTTP ${res.status}`);
  const jobId = startResp?.job_id;
  if (!jobId) throw new Error('No job_id returned');
  setActiveBackendJob(jobId, 'youtube_cc');
  await pollJob(jobId);
  const data = await fetchJobResult(jobId);
  const srtText = data?.srt || '';
  if (!srtText.trim()) throw new Error('No closed-caption SRT returned.');
  const parsed = parseSRT(srtText);
  initialEntries = parsed.map((e, idx) => ({ start:e.start, end:e.end, text:e.text, index:idx }));
  entries = parsed.map((e, idx) => ({
    start:e.start, end:e.end, text:e.text,
    orig:{ start:e.start, end:e.end, text:e.text }, origIndex: idx
  }));
  if (!entriesB?.length){
    entriesB = parsed.map((e) => ({ start:e.start, end:e.end, text:'' }));
    initialEntriesB = entriesB.map((e) => ({ start:e.start, end:e.end, text:e.text }));
  }
  const box = document.getElementById('alignSrtText');
  if (box) box.value = srtText;
  window.currentBaseName = (data?.title || 'youtube_cc').replace(/[\/:*?"<>|]+/g, ' ').trim() || 'youtube_cc';
  renderBySubsMode();
  progressDone(true);
  setStatusSafe(`Imported ${entries.length} YouTube CC cue(s)${data?.language ? ' (' + data.language + ', ' + data.caption_kind + ')' : ''}.`);
  return data;
}

async function startYouTubeDownload(url, permissionConfirmed){
  const format_choice = document.getElementById('ytResolution')?.value || 'best';
  const output_dir = document.getElementById('ytOutputDir')?.value || 'downloads/youtube';
  progressStart('Starting YouTube download…');
  const res = await fetch(`${API_BASE}/api/youtube_download_start`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ url, permission_confirmed: !!permissionConfirmed, format_choice, output_dir })
  });
  const startResp = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(startResp?.error || startResp?.message || `HTTP ${res.status}`);
  const jobId = startResp?.job_id;
  if (!jobId) throw new Error('No job_id returned');
  setActiveBackendJob(jobId, 'youtube_download');
  await pollJob(jobId);
  const data = await fetchJobResult(jobId);
  progressDone(true);
  setStatusSafe(`Downloaded YouTube media to: ${data?.local_path || data?.download_dir || 'downloads/youtube'}`);
  return data;
}

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
let __activeBackendJobId = null;
let __activeBackendJobKind = '';
let __cancelRequested = false;

function getCancelBackendButton(){
  return document.getElementById('btnCancelBackend');
}

function setActiveBackendJob(jobId, kind=''){
  __activeBackendJobId = jobId || null;
  __activeBackendJobKind = kind || '';
  __cancelRequested = false;
  const btn = getCancelBackendButton();
  if (btn){
    btn.hidden = !__activeBackendJobId;
    btn.disabled = !__activeBackendJobId;
    btn.textContent = 'Cancel';
    btn.title = __activeBackendJobId ? `Cancel ${__activeBackendJobKind || 'backend'} job` : 'No active backend job';
  }
}

function clearActiveBackendJob(){
  __activeBackendJobId = null;
  __activeBackendJobKind = '';
  __cancelRequested = false;
  const btn = getCancelBackendButton();
  if (btn){
    btn.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Cancel';
    btn.title = 'No active backend job';
  }
}

function isBackendCancelError(err){
  return !!(err && (err.cancelled === true || /job cancelled|cancelled by user|cancel requested/i.test(String(err.message || err))));
}

async function cancelCurrentBackendJob(){
  const btn = getCancelBackendButton();
  const jobId = __activeBackendJobId;
  __cancelRequested = true;
  if (btn){
    btn.disabled = true;
    btn.textContent = 'Cancelling…';
  }
  if (!jobId){
    setStatusSafe('Cancel requested…');
    return;
  }
  const res = await fetch(`${API_BASE}/api/job/${jobId}/cancel`, { method: 'POST' });
  if (!res.ok){
    const t = await res.text().catch(()=> '');
    if (btn){ btn.disabled = false; btn.textContent = 'Cancel'; }
    throw new Error(`Cancel HTTP ${res.status} ${t}`);
  }
  setStatusSafe('Cancel requested… waiting for backend to stop.');
}

function progressStart(label){
  const progressStrip = document.getElementById('leftProgressStrip');
  if (progressStrip) progressStrip.classList.add('is-active');
  const bar  = document.getElementById('whisperProgBar');
  const txt  = document.getElementById('whisperProgTxt');
  if (__progTimer) { clearInterval(__progTimer); __progTimer = null; }
  if (bar) bar.style.width = '0%';
  if (txt) txt.textContent = '0%';
  const btn = getCancelBackendButton();
  if (btn){
    btn.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Cancel';
  }
  if (label) setStatusSafe(label);
}

function progressDone(ok=true){
  const progressStrip = document.getElementById('leftProgressStrip');
  const bar  = document.getElementById('whisperProgBar');
  const txt  = document.getElementById('whisperProgTxt');
  if (__progTimer) { clearInterval(__progTimer); __progTimer = null; }

  if (bar && txt){
    if (ok){
      bar.style.width = '100%';
      txt.textContent = '100%';
      setTimeout(() => {
        bar.style.width = '0%';
        txt.textContent = '0%';
      }, 900);
    } else {
      bar.style.width = '0%';
      txt.textContent = '0%';
    }
  }
  clearActiveBackendJob();
  if (progressStrip) setTimeout(() => progressStrip.classList.remove('is-active'), ok ? 1000 : 150);
}

// Alias for older/newer code paths
function progressEnd(ok=true){
  return progressDone(ok);
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
    if (bar) bar.style.width = (p*100).toFixed(1) + '%';
    if (txt) txt.textContent = Math.round(p*100) + '%';
    if (st.message) setStatusSafe(st.message);

    if (st.cancelled || st.stage === 'cancelled'){
      const err = new Error('Backend job cancelled by user.');
      err.cancelled = true;
      throw err;
    }

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
    const err = new Error(`Job result HTTP ${res.status} ${t}`);
    if (/job cancelled|cancelled/i.test(t)) err.cancelled = true;
    throw err;
  }
  return await res.json();
}

const FALLBACK_WHISPER_LANGUAGE_OPTIONS = [
  { value: 'auto', code: 'auto', label: 'Auto Detect' },
  { value: 'en', code: 'en', label: 'English (US)' },
  { value: 'en', code: 'en', label: 'English (UK)' },
  { value: 'zh', code: 'zh', label: 'Chinese (Simplified)' },
  { value: 'zh', code: 'zh', label: 'Chinese (Traditional)' },
  { value: 'de', code: 'de', label: 'German' },
  { value: 'es', code: 'es', label: 'Spanish' },
  { value: 'ru', code: 'ru', label: 'Russian' },
  { value: 'ko', code: 'ko', label: 'Korean' },
  { value: 'fr', code: 'fr', label: 'French' },
  { value: 'ja', code: 'ja', label: 'Japanese' },
  { value: 'pt', code: 'pt', label: 'Portuguese' },
  { value: 'tr', code: 'tr', label: 'Turkish' },
  { value: 'pl', code: 'pl', label: 'Polish' },
  { value: 'ca', code: 'ca', label: 'Catalan' },
  { value: 'nl', code: 'nl', label: 'Dutch' },
  { value: 'ar', code: 'ar', label: 'Arabic' },
  { value: 'sv', code: 'sv', label: 'Swedish' },
  { value: 'it', code: 'it', label: 'Italian' },
  { value: 'id', code: 'id', label: 'Indonesian' },
  { value: 'hi', code: 'hi', label: 'Hindi' },
  { value: 'fi', code: 'fi', label: 'Finnish' },
  { value: 'vi', code: 'vi', label: 'Vietnamese' },
  { value: 'he', code: 'he', label: 'Hebrew' },
  { value: 'uk', code: 'uk', label: 'Ukrainian' },
  { value: 'el', code: 'el', label: 'Greek' },
  { value: 'ms', code: 'ms', label: 'Malay' },
  { value: 'cs', code: 'cs', label: 'Czech' },
  { value: 'ro', code: 'ro', label: 'Romanian' },
  { value: 'da', code: 'da', label: 'Danish' },
  { value: 'hu', code: 'hu', label: 'Hungarian' },
  { value: 'ta', code: 'ta', label: 'Tamil' },
  { value: 'no', code: 'no', label: 'Norwegian' },
  { value: 'th', code: 'th', label: 'Thai' },
  { value: 'ur', code: 'ur', label: 'Urdu' },
  { value: 'hr', code: 'hr', label: 'Croatian' },
  { value: 'bg', code: 'bg', label: 'Bulgarian' },
  { value: 'lt', code: 'lt', label: 'Lithuanian' },
  { value: 'la', code: 'la', label: 'Latin' },
  { value: 'mi', code: 'mi', label: 'Maori' },
  { value: 'ml', code: 'ml', label: 'Malayalam' },
  { value: 'cy', code: 'cy', label: 'Welsh' },
  { value: 'sk', code: 'sk', label: 'Slovak' },
  { value: 'te', code: 'te', label: 'Telugu' },
  { value: 'fa', code: 'fa', label: 'Persian' },
  { value: 'lv', code: 'lv', label: 'Latvian' },
  { value: 'bn', code: 'bn', label: 'Bengali' },
  { value: 'sr', code: 'sr', label: 'Serbian' },
  { value: 'az', code: 'az', label: 'Azerbaijani' },
  { value: 'sl', code: 'sl', label: 'Slovenian' },
  { value: 'kn', code: 'kn', label: 'Kannada' },
  { value: 'et', code: 'et', label: 'Estonian' },
  { value: 'mk', code: 'mk', label: 'Macedonian' },
  { value: 'br', code: 'br', label: 'Breton' },
  { value: 'eu', code: 'eu', label: 'Basque' },
  { value: 'is', code: 'is', label: 'Icelandic' },
  { value: 'hy', code: 'hy', label: 'Armenian' },
  { value: 'ne', code: 'ne', label: 'Nepali' },
  { value: 'mn', code: 'mn', label: 'Mongolian' },
  { value: 'bs', code: 'bs', label: 'Bosnian' },
  { value: 'kk', code: 'kk', label: 'Kazakh' },
  { value: 'sq', code: 'sq', label: 'Albanian' },
  { value: 'sw', code: 'sw', label: 'Swahili' },
  { value: 'gl', code: 'gl', label: 'Galician' },
  { value: 'mr', code: 'mr', label: 'Marathi' },
  { value: 'pa', code: 'pa', label: 'Punjabi' },
  { value: 'si', code: 'si', label: 'Sinhala' },
  { value: 'km', code: 'km', label: 'Khmer' },
  { value: 'sn', code: 'sn', label: 'Shona' },
  { value: 'yo', code: 'yo', label: 'Yoruba' },
  { value: 'so', code: 'so', label: 'Somali' },
  { value: 'af', code: 'af', label: 'Afrikaans' },
  { value: 'oc', code: 'oc', label: 'Occitan' },
  { value: 'ka', code: 'ka', label: 'Georgian' },
  { value: 'be', code: 'be', label: 'Belarusian' },
  { value: 'tg', code: 'tg', label: 'Tajik' },
  { value: 'sd', code: 'sd', label: 'Sindhi' },
  { value: 'gu', code: 'gu', label: 'Gujarati' },
  { value: 'am', code: 'am', label: 'Amharic' },
  { value: 'yi', code: 'yi', label: 'Yiddish' },
  { value: 'lo', code: 'lo', label: 'Lao' },
  { value: 'uz', code: 'uz', label: 'Uzbek' },
  { value: 'fo', code: 'fo', label: 'Faroese' },
  { value: 'ht', code: 'ht', label: 'Haitian Creole' },
  { value: 'ps', code: 'ps', label: 'Pashto' },
  { value: 'tk', code: 'tk', label: 'Turkmen' },
  { value: 'nn', code: 'nn', label: 'Norwegian Nynorsk' },
  { value: 'mt', code: 'mt', label: 'Maltese' },
  { value: 'sa', code: 'sa', label: 'Sanskrit' },
  { value: 'lb', code: 'lb', label: 'Luxembourgish' },
  { value: 'my', code: 'my', label: 'Myanmar / Burmese' },
  { value: 'bo', code: 'bo', label: 'Tibetan' },
  { value: 'tl', code: 'tl', label: 'Tagalog' },
  { value: 'mg', code: 'mg', label: 'Malagasy' },
  { value: 'as', code: 'as', label: 'Assamese' },
  { value: 'tt', code: 'tt', label: 'Tatar' },
  { value: 'haw', code: 'haw', label: 'Hawaiian' },
  { value: 'ln', code: 'ln', label: 'Lingala' },
  { value: 'ha', code: 'ha', label: 'Hausa' },
  { value: 'ba', code: 'ba', label: 'Bashkir' },
  { value: 'jw', code: 'jw', label: 'Javanese' },
  { value: 'su', code: 'su', label: 'Sundanese' },
  { value: 'yue', code: 'yue', label: 'Cantonese' },
];

function renderWhisperLanguageOptions(options){
  const sel = document.getElementById('whisperLang');
  if (!sel) return;
  const prev = sel.value || 'auto';
  const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const clean = (Array.isArray(options) && options.length ? options : FALLBACK_WHISPER_LANGUAGE_OPTIONS)
    .map(o => {
      if (typeof o === 'string') return { value: o, code: o, label: o };
      const label = String(o.label || o.name || o.whisper_name || o.code || o.value || '').trim();
      const code = String(o.code || o.value || '').trim();
      const value = String(o.value || code || label).trim();
      return { value: value || 'auto', code: code || value || 'auto', label: label || value || 'Auto Detect' };
    })
    .filter(o => o.value && o.label);

  sel.innerHTML = clean.map(o => `<option value="${esc(o.value)}" data-code="${esc(o.code)}">${esc(o.label)}</option>`).join('');

  // Restore previous selection when possible; otherwise prefer Auto Detect.
  const values = new Set(clean.map(o => o.value));
  const codes = new Set(clean.map(o => o.code));
  if (values.has(prev)) sel.value = prev;
  else if (codes.has(prev)) {
    const byCode = clean.find(o => o.code === prev);
    if (byCode) sel.value = byCode.value;
  } else {
    sel.value = 'auto';
  }
}

async function populateWhisperLanguageDropdown(){
  renderWhisperLanguageOptions(FALLBACK_WHISPER_LANGUAGE_OPTIONS);
  try{
    const res = await fetch(`${API_BASE}/api/languages`, { method: 'GET' });
    if (!res.ok) return;
    const data = await res.json().catch(()=> null);
    if (data && Array.isArray(data.languages) && data.languages.length){
      renderWhisperLanguageOptions(data.languages);
    }
  }catch(_e){
    // Older backend: keep the local full-name fallback list.
  }
}

/* ============================================================
   SRT-Translate  –  AI translation of Sub A → Sub B
   ============================================================ */


const AI_DICT_LS_KEY = 'transcriber_dictionary_v1';
function loadDictionaryPairs(){
  try{
    const raw = localStorage.getItem(AI_DICT_LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map(x => ({ source: String(x?.source || '').trim(), target: String(x?.target || '').trim() })).filter(x => x.source || x.target);
  }catch(_e){ return []; }
}
function saveDictionaryPairs(rows){
  const clean = (rows || []).map(x => ({ source: String(x?.source || '').trim(), target: String(x?.target || '').trim() })).filter(x => x.source || x.target);
  localStorage.setItem(AI_DICT_LS_KEY, JSON.stringify(clean));
  return clean;
}
function dictionaryCount(){ return loadDictionaryPairs().length; }
function updateDictionaryBadge(){
  const count = dictionaryCount();
  document.querySelectorAll('#dictBadgeMini').forEach(el => { el.textContent = count ? `(${count})` : ''; });
}
function ensureDictionaryModal(){
  if (document.getElementById('dictModal')) return;
  const wrap = document.createElement('div');
  wrap.id = 'dictModal';
  wrap.className = 'modal-overlay hidden';
  wrap.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="dictTitle" style="max-width:920px">
      <div class="modal-head">
        <div>
          <div id="dictTitle" class="modal-title">Dictionary</div>
          <div class="modal-sub">Map source-language terms to preferred translated terms. Applied to DeepSeek translation, AI Check, and AI Assistant.</div>
        </div>
        <button class="btn btn-outline btn-mini" id="dictClose" type="button" aria-label="Close">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
        <div class="dict-head-row">
          <div class="dict-col-label">Original term</div>
          <div class="dict-col-label">Translated term</div>
        </div>
        <div id="dictRows" class="dict-rows"></div>
        <div style="display:flex;gap:8px;align-items:center;justify-content:flex-start">
          <button class="btn btn-outline" id="dictAddRow" type="button">Add Row</button>
          <button class="btn btn-outline" id="dictImportCsv" type="button">Paste TSV/CSV</button>
          <span class="muted" id="dictCountBadge"></span>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" id="dictClear" type="button">Clear</button>
        <div style="flex:1"></div>
        <button class="btn btn-gold" id="dictSave" type="button">Save</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const rowsEl = wrap.querySelector('#dictRows');
  function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function rowTemplate(source='', target=''){
    const row = document.createElement('div');
    row.className = 'dict-row';
    row.innerHTML = `
      <input class="ui-dark-input dict-input" data-col="source" placeholder="e.g. White House" value="${esc(source)}">
      <input class="ui-dark-input dict-input" data-col="target" placeholder="e.g. 白宫" value="${esc(target)}">
      <button class="btn btn-outline btn-mini dict-del" type="button">✕</button>`;
    row.querySelector('.dict-del').addEventListener('click', ()=>{ row.remove(); refreshBadge(); });
    return row;
  }
  function getRows(){
    return Array.from(rowsEl.querySelectorAll('.dict-row')).map(row => ({
      source: row.querySelector('[data-col="source"]')?.value || '',
      target: row.querySelector('[data-col="target"]')?.value || ''
    }));
  }
  function renderRows(data){
    rowsEl.innerHTML='';
    const rows = (data && data.length ? data : [{source:'', target:''}]);
    rows.forEach(r => rowsEl.appendChild(rowTemplate(r.source, r.target)));
    refreshBadge();
  }
  function refreshBadge(){
    const count = getRows().filter(r => (r.source||'').trim() || (r.target||'').trim()).length;
    const badge = document.getElementById('dictCountBadge');
    if (badge) badge.textContent = `${count} entr${count===1?'y':'ies'}`;
    updateDictionaryBadge();
  }
  wrap.querySelector('#dictAddRow').addEventListener('click', ()=>{ rowsEl.appendChild(rowTemplate()); refreshBadge(); });
  wrap.querySelector('#dictImportCsv').addEventListener('click', ()=>{
    const raw = prompt('Paste two-column CSV/TSV lines: source,target');
    if (!raw) return;
    const rows=[];
    raw.split(/\r?\n/).forEach(line => {
      const s = line.trim();
      if (!s) return;
      const parts = s.includes('\t') ? s.split('\t') : s.split(',');
      rows.push({ source: (parts[0]||'').trim(), target: (parts[1]||'').trim() });
    });
    renderRows(rows);
  });
  wrap.querySelector('#dictClear').addEventListener('click', ()=> renderRows([{source:'', target:''}]));
  wrap.querySelector('#dictSave').addEventListener('click', ()=>{ saveDictionaryPairs(getRows()); closeDictionaryModal(); updateDictionaryBadge(); });
  wrap.querySelector('#dictClose').addEventListener('click', closeDictionaryModal);
  wrap.addEventListener('click', (e)=>{ if (e.target === wrap) closeDictionaryModal(); });
  renderRows(loadDictionaryPairs());
}
function openDictionaryModal(){ ensureDictionaryModal(); const el=document.getElementById('dictModal'); if(!el) return; document.body.appendChild(el); el.classList.remove('hidden'); }
function closeDictionaryModal(){ document.getElementById('dictModal')?.classList.add('hidden'); }

function ensureAIAssistantModal(){
  if (document.getElementById('aiAssistantModal')) return;
  const wrap = document.createElement('div');
  wrap.id = 'aiAssistantModal';
  wrap.className = 'modal-overlay hidden';
  wrap.innerHTML = `
    <div class="modal-card ai-assistant-modal-card" role="dialog" aria-modal="true" aria-labelledby="aiAssistTitle">
      <div class="modal-head">
        <div>
          <div id="aiAssistTitle" class="modal-title">AI Assistant</div>
          <div class="modal-sub">Run focused DeepSeek tasks on Sub A, Sub B, or both without affecting the transcript panels unless you choose to copy/insert the output.</div>
        </div>
        <button class="btn btn-outline btn-mini" id="aiAssistClose" type="button" aria-label="Close">✕</button>
      </div>
      <div class="modal-body ai-assistant-body">
        <div class="ai-assistant-pane">
          <label class="muted" style="display:flex;flex-direction:column;gap:5px">Task
            <select id="aiAssistTask" class="ui-dark-select" style="width:100%;height:35px">
              <option value="subtitle_polish">Subtitle Polish</option>
              <option value="extract_quotes">Extract Key Quotes</option>
              <option value="summary">Make Summary</option>
              <option value="identify_chapters">Identify Chapters</option>
              <option value="recommend_clips">Recommend Timeline Clips JSON</option>
              <option value="headline_options">Generate Headline Options</option>
              <option value="social_caption">Generate Social Caption</option>
              <option value="qa">Ask About Transcript</option>
            </select>
          </label>
          <label class="muted" style="display:flex;flex-direction:column;gap:5px">Context
            <select id="aiAssistContext" class="ui-dark-select" style="width:100%;height:35px">
              <option value="A" selected>Sub A only</option>
              <option value="B">Sub B only</option>
              <option value="BOTH">Sub A + Sub B</option>
            </select>
          </label>
          <label class="muted" style="display:flex;flex-direction:column;gap:5px">Model
            <select id="aiAssistModel" class="ui-dark-select" style="width:100%;height:35px">
              <option value="deepseek-chat" selected>deepseek-chat</option>
              <option value="deepseek-reasoner">deepseek-reasoner</option>
            </select>
          </label>
          <label class="muted" style="display:flex;flex-direction:column;gap:5px">Input
            <textarea id="aiAssistInput" class="ui-dark-textarea ai-assistant-textarea ai-assistant-input" placeholder="Add custom instructions, focus, output format, or a question to answer."></textarea>
          </label>
          <div style="display:flex;gap:8px;align-items:center;justify-content:flex-start;flex-wrap:wrap">
            <button class="btn btn-gold" id="aiAssistRun" type="button">Run</button>
            <button class="btn btn-outline" id="aiAssistClear" type="button">Clear</button>
            <span class="muted" id="aiAssistStatus"></span>
          </div>
        </div>
        <div class="ai-assistant-pane">
          <label class="muted" style="display:flex;flex-direction:column;gap:5px">Output
            <textarea id="aiAssistOutput" class="ui-dark-textarea ai-assistant-textarea ai-assistant-output" style="min-height:360px" placeholder="DeepSeek output will appear here."></textarea>
          </label>
          <div style="display:flex;gap:8px;align-items:center;justify-content:flex-start;flex-wrap:wrap">
            <button class="btn btn-outline" id="aiAssistCopy" type="button">Copy Output</button>
            <button class="btn btn-outline" id="aiAssistUseAsAlign" type="button">Send to Align-To-SRT box</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = ()=> wrap.classList.add('hidden');
  wrap.querySelector('#aiAssistClose').onclick = close;
  wrap.addEventListener('click', (e)=>{ if (e.target === wrap) close(); });
  wrap.querySelector('#aiAssistClear').onclick = ()=>{ document.getElementById('aiAssistInput').value=''; document.getElementById('aiAssistOutput').value=''; document.getElementById('aiAssistStatus').textContent=''; };
  wrap.querySelector('#aiAssistCopy').onclick = async ()=>{ const val=document.getElementById('aiAssistOutput')?.value||''; if (val) await copyTextToClipboard(val); };
  wrap.querySelector('#aiAssistUseAsAlign').onclick = ()=>{ const val=document.getElementById('aiAssistOutput')?.value||''; const box=document.getElementById('alignSrtText'); if (box) box.value = val; };
  wrap.querySelector('#aiAssistRun').onclick = ()=>{ runAIAssistant().catch(err=>{ console.error(err); alert('AI Assistant failed: ' + (err?.message || err)); }); };
}
function openAIAssistantModal(){ ensureAIAssistantModal(); document.getElementById('aiAssistantModal')?.classList.remove('hidden'); }
async function runAIAssistant(){
  const task = document.getElementById('aiAssistTask')?.value || 'summary';
  const context = document.getElementById('aiAssistContext')?.value || 'A';
  const model = document.getElementById('aiAssistModel')?.value || 'deepseek-chat';
  const instructions = document.getElementById('aiAssistInput')?.value || '';
  const out = document.getElementById('aiAssistOutput');
  const status = document.getElementById('aiAssistStatus');
  const timecoded = task === 'recommend_clips' || task === 'identify_chapters';
  const sourceA = entries.map((e,i)=> timecoded ? timelineFormatSourceCue('A', e, i) : `[${i+1}] ${e.text||''}`).join('\n');
  const sourceB = entriesB.map((e,i)=> timecoded ? timelineFormatSourceCue('B', e, i) : `[${i+1}] ${e.text||''}`).join('\n');
  let source_text = sourceA;
  if (context === 'B') source_text = sourceB;
  if (context === 'BOTH') source_text = `Sub A:\n${sourceA}\n\nSub B:\n${sourceB}`;
  if (!source_text.trim()) throw new Error('No transcript content available for the selected context.');
  if (status) status.textContent = 'Running…';
  const res = await fetch(`${API_BASE}/api/ai_assistant`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ task, instructions, source_text, model, dictionary: loadDictionaryPairs() })
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok || !data?.ok) throw new Error(data?.detail || data?.message || (`HTTP ${res.status}`));
  if (out) out.value = String(data.output || '');
  if (status) status.textContent = 'Done';
}


function ensureTranslateModal(){
  if (document.getElementById('srtTranslateModal')) return;
  const wrap = document.createElement('div');
  wrap.id = 'srtTranslateModal';
  wrap.className = 'modal-overlay hidden';
  wrap.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="trTitle" style="max-width:520px">
      <div class="modal-head">
        <div>
          <div id="trTitle" class="modal-title">SRT-Translate</div>
          <div class="modal-sub">Translate <b>Sub A</b> into <b>Sub B</b> with Local Argos or DeepSeek API.</div>
        </div>
        <button class="btn btn-outline btn-mini" id="trClose" type="button" aria-label="Close">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:14px">
        <label class="muted" style="display:flex;flex-direction:column;gap:5px">Engine
          <select id="trEngine" class="ui-dark-select" style="width:100%;height:35px">
            <option value="argos">Local Argos</option>
            <option value="deepseek" selected>DeepSeek API</option>
          </select>
        </label>
        <div id="trDeepSeekRow" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
          <label class="muted" style="display:flex;flex-direction:column;gap:5px;flex:1 1 220px">DeepSeek model
            <select id="trDsModel" class="ui-dark-select" style="width:100%;height:35px">
              <option value="deepseek-chat" selected>deepseek-chat</option>
              <option value="deepseek-reasoner">deepseek-reasoner</option>
            </select>
          </label>
                  </div>
        <label class="muted" style="display:flex;flex-direction:column;gap:5px">Source language <span style="opacity:.6">(Sub A)</span>
          <select id="trFromLang" class="ui-dark-select" style="width:100%;height:35px">
            <option value="English" selected>English</option><option value="Chinese (Simplified)">Chinese (Simplified) 中文（简体）</option><option value="Chinese (Traditional)">Chinese (Traditional) 中文（繁體）</option><option value="Japanese">Japanese 日本語</option><option value="Korean">Korean 한국어</option><option value="French">French Français</option><option value="Spanish">Spanish Español</option><option value="German">German Deutsch</option><option value="Portuguese">Portuguese Português</option><option value="Arabic">Arabic العربية</option><option value="Hindi">Hindi हिन्दी</option><option value="Russian">Russian Русский</option><option value="Malay">Malay Bahasa Melayu</option><option value="Indonesian">Indonesian Bahasa Indonesia</option><option value="Thai">Thai ภาษาไทย</option><option value="Turkish">Turkish Türkçe</option><option value="Italian">Italian Italiano</option><option value="Dutch">Dutch Nederlands</option><option value="Polish">Polish Polski</option><option value="Vietnamese">Vietnamese Tiếng Việt</option>
          </select>
        </label>
        <label class="muted" style="display:flex;flex-direction:column;gap:5px">Target language <span style="opacity:.6">(Sub B)</span>
          <select id="trLang" class="ui-dark-select" style="width:100%;height:35px">
            <option value="Chinese (Simplified)" selected>Chinese (Simplified) 中文（简体）</option><option value="Chinese (Traditional)">Chinese (Traditional) 中文（繁體）</option><option value="English">English</option><option value="Japanese">Japanese 日本語</option><option value="Korean">Korean 한국어</option><option value="French">French Français</option><option value="Spanish">Spanish Español</option><option value="German">German Deutsch</option><option value="Portuguese">Portuguese Português</option><option value="Arabic">Arabic العربية</option><option value="Hindi">Hindi हिन्दी</option><option value="Russian">Russian Русский</option><option value="Malay">Malay Bahasa Melayu</option><option value="Indonesian">Indonesian Bahasa Indonesia</option><option value="Thai">Thai ภาษาไทย</option><option value="Turkish">Turkish Türkçe</option><option value="Italian">Italian Italiano</option><option value="Dutch">Dutch Nederlands</option><option value="Polish">Polish Polski</option><option value="Vietnamese">Vietnamese Tiếng Việt</option>
          </select>
        </label>
        <label class="muted" style="display:flex;flex-direction:column;gap:5px">Translation style
          <select id="trStyle" class="ui-dark-select" style="width:100%;height:35px">
            <option value="subtitle_natural" selected>Subtitle Natural</option><option value="literal">Literal</option><option value="newsroom_formal">Newsroom Formal</option><option value="documentary_tone">Documentary Tone</option><option value="social_clip_tone">Social Clip Tone</option>
          </select>
        </label>
        <div class="muted" id="trEngineNote" style="line-height:1.6;font-size:12px;background:rgba(255,255,255,.04);padding:10px;border-radius:8px">DeepSeek API uses your backend key and applies Dictionary terms if available.</div>
        <div id="trProgress" style="display:none;flex-direction:column;gap:6px"><div style="height:6px;background:rgba(255,255,255,.10);border-radius:999px;overflow:hidden"><div id="trProgBar" style="height:100%;width:0%;background:rgba(255,215,0,.9);transition:width .25s"></div></div><div id="trProgTxt" class="muted" style="font-size:12px;text-align:center">0%</div></div>
      </div>
      <div class="modal-foot"><button class="btn btn-outline" id="trCancel" type="button">Cancel</button><button class="btn btn-outline" id="trOpenDict" type="button">Dictionary…</button><div style="flex:1"></div><button class="btn btn-gold" id="trRun" type="button">Translate →</button></div>
    </div>`;
  document.body.appendChild(wrap);
  const sync = ()=>{
    const engine = document.getElementById('trEngine')?.value || 'deepseek';
    const note = document.getElementById('trEngineNote');
    const row = document.getElementById('trDeepSeekRow');
    if (row) row.style.display = engine === 'deepseek' ? 'flex' : 'none';
    if (note) note.innerHTML = engine === 'deepseek' ? 'DeepSeek API uses your backend key and applies Dictionary terms if available.' : 'Local Argos runs offline. Install once: <code>pip install argostranslate</code>';
    updateDictionaryBadge();
  };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeTranslateModal(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !wrap.classList.contains('hidden')) closeTranslateModal(); });
  document.getElementById('trClose').onclick = () => closeTranslateModal();
  document.getElementById('trCancel').onclick = () => closeTranslateModal();
  document.getElementById('trOpenDict').onclick = () => openDictionaryModal();
  document.getElementById('trRun').onclick = () => { translateSubA().catch(err => { console.error(err); alert('SRT-Translate failed: ' + (err?.message || err)); }); };
  document.getElementById('trEngine').addEventListener('change', sync);
  sync();
}

function openTranslateModal(){
  if (!entries?.length){
    alert('Sub A is empty. Import an SRT or Transcribe first.');
    return;
  }
  ensureTranslateModal();
  document.getElementById('srtTranslateModal').classList.remove('hidden');
  setTimeout(() => document.getElementById('trLang')?.focus(), 50);
}

function closeTranslateModal(){
  const wrap = document.getElementById('srtTranslateModal');
  if (wrap) wrap.classList.add('hidden');
  // Reset progress
  const prog = document.getElementById('trProgress');
  const bar  = document.getElementById('trProgBar');
  const txt  = document.getElementById('trProgTxt');
  if (prog) prog.style.display = 'none';
  if (bar)  bar.style.width = '0%';
  if (txt)  txt.textContent = '0%';
  const runBtn = document.getElementById('trRun');
  if (runBtn){ runBtn.disabled = false; runBtn.textContent = 'Translate →'; }
}

async function translateSubA(){
  flushEditsFromDOM();

  if (!entries?.length){
    alert('Sub A is empty.');
    return;
  }

  const lang     = document.getElementById('trLang')?.value     || 'Chinese (Simplified)';
  const fromLang = document.getElementById('trFromLang')?.value || 'English';
  const engine   = document.getElementById('trEngine')?.value   || 'deepseek';
  const dsModel  = document.getElementById('trDsModel')?.value  || 'deepseek-chat';
  const trStyle  = document.getElementById('trStyle')?.value    || 'subtitle_natural';

  // Lock UI
  const runBtn = document.getElementById('trRun');
  if (runBtn){ runBtn.disabled = true; runBtn.textContent = 'Translating…'; }

  const prog    = document.getElementById('trProgress');
  const progBar = document.getElementById('trProgBar');
  const progTxt = document.getElementById('trProgTxt');
  if (prog) prog.style.display = 'flex';

  const setProgress = (pct, label) => {
    if (progBar) progBar.style.width = pct + '%';
    if (progTxt) progTxt.textContent  = label || Math.round(pct) + '%';
    statusEl.textContent = `SRT-Translate: ${label || Math.round(pct) + '%'}`;
  };

  setProgress(2, `Starting… (${engine === 'deepseek' ? 'DeepSeek' : 'Local Argos'})`);

  // Snapshot Sub A cues (text + timecodes)
  const cues = entries.map((e, i) => ({
    index: i,
    start: Number(e.start || 0),
    end:   Number(e.end   || 0),
    text:  String(e.text  || '').trim(),
  }));

  try {
    const payload = {
      cues,
      target_language: lang,
      from_language:   fromLang,
      engine,
      model: dsModel,
      translation_style: trStyle,
      dictionary: loadDictionaryPairs(),
    };

    const res = await fetch(`${API_BASE}/api/translate_srt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok){
      const msg = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }

    // Stream NDJSON: each line is one of:
    //   {"cue": {index, start, end, text}}   — one translated cue
    //   {"progress": 0..1, "message": "…"}   — progress tick
    //   {"done": true}                        — completion sentinel
    //   {"error": "…"}                        — server-side error
    const reader  = res.body?.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const collectedCues = [];

    let serverError = null;

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try { msg = JSON.parse(trimmed); } catch { return; }
      if (msg.error) { serverError = msg.error; return; }
      if (msg.cue)      { collectedCues.push(msg.cue); }
      if (msg.translated && Array.isArray(msg.translated)) { collectedCues.push(...msg.translated); }
      if (msg.progress != null) {
        setProgress(Math.min(99, Math.round(msg.progress * 100)), msg.message || null);
      }
    };

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) processLine(line);
      }
      if (buffer.trim()) processLine(buffer);
    }

    if (serverError) {
      throw new Error('Server error: ' + serverError);
    }
    if (!collectedCues.length) {
      throw new Error('No translated cues returned by the server.');
    }
    const translated = collectedCues;

    // Populate entriesB, preserving Sub A timecodes
    entriesB = translated.map((t, i) => {
      const a = entries[i] || entries[entries.length - 1];
      return {
        start:     Number(t.start ?? a?.start ?? 0),
        end:       Number(t.end   ?? a?.end   ?? 0),
        text:      String(t.text  || ''),
        orig:      { start: Number(t.start ?? 0), end: Number(t.end ?? 0), text: String(t.text || '') },
        origIndex: i,
      };
    });
    initialEntriesB = entriesB.map(e => ({ start: e.start, end: e.end, text: e.text }));

    setDualBadges(true);

    // Switch to Dual view so user immediately sees the side-by-side result
    const subsSel = document.getElementById('subsMode');
    if (subsSel){ subsSel.value = 'DUAL'; }
    applySubsMode('DUAL');

    setProgress(100, 'Done!');
    statusEl.textContent = `SRT-Translate: ${translated.length} cue(s) translated to ${lang}. Showing Dual Sub view.`;
    setTimeout(() => closeTranslateModal(), 900);

  } catch (err) {
    if (runBtn){ runBtn.disabled = false; runBtn.textContent = 'Translate →'; }
    setProgress(0, '');
    if (prog) prog.style.display = 'none';
    throw err;
  }
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
      #btnCancelBackend{ border-color:rgba(255,99,71,.55); color:#ffb3a7; white-space:nowrap; }
      #btnCancelBackend:not([disabled]):hover{ background:rgba(255,99,71,.14); }
      .backend-cancel-btn{ height:32px; padding:5px 10px; }
    `;
    document.head.appendChild(st);
  }

  const bar = document.createElement('div');
  bar.id = 'whisperBar';
  bar.className = 'whisperbar';

  bar.innerHTML = `
    <button class="btn btn-gold" id="btnTranscribe" type="button">Transcribe</button>
    <button class="btn btn-gold" id="btnSrtTranslate" type="button" title="Translate Sub A into Sub B using AI">SRT-Translate</button>
    <button class="btn btn-outline" id="btnDictionary" type="button">Dictionary <span id="dictBadgeMini"></span></button>
    <button class="btn btn-outline" id="btnAIAssistant" type="button">AI Assistant</button>
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
      <button class="btn btn-outline backend-cancel-btn" id="btnCancelBackend" type="button" hidden disabled title="Cancel current backend job">Cancel</button>
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
            <option value="auto">auto</option>
            <option value="cuda" selected>cuda</option>
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
            <option value="auto" selected>Auto Detect</option>
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

  document.getElementById('apiBaseLbl').textContent = API_BASE;
  populateWhisperLanguageDropdown();
  document.getElementById('btnCancelBackend')?.addEventListener('click', () => {
    cancelCurrentBackendJob().catch(err => {
      console.error(err);
      alert('Cancel failed: ' + (err?.message || err));
    });
  });

  // Show anchor filters only in Anchor Drift mode
  const _aiModeEl = document.getElementById('aiCheckMode');
  const _aiFiltEl = document.getElementById('aiAnchorFilters');
  const _syncAiFilterVis = () => {
    if (!_aiFiltEl) return;
    const m = (_aiModeEl?.value || 'semantic').toLowerCase();
    _aiFiltEl.style.display = (m === 'anchor') ? 'flex' : 'none';
  };
  _aiModeEl?.addEventListener('change', _syncAiFilterVis);
  _syncAiFilterVis();
  updateDictionaryBadge();

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
      if (isBackendCancelError(err)) { setStatusSafe('Transcribe cancelled.'); return; }
      alert('Transcribe failed: ' + (err?.message || err));
    });
  });

  document.getElementById('btnSrtTranslate').addEventListener('click', () => {
    openTranslateModal();
  });
  document.getElementById('btnDictionary')?.addEventListener('click', () => { openDictionaryModal(); });
  document.getElementById('btnAIAssistant')?.addEventListener('click', () => { openAIAssistantModal(); });

  document.getElementById('btnAnalyze').addEventListener('click', () => {
    analyzeAlignWithBackend().catch(err => {
      console.error(err);
      if (isBackendCancelError(err)) { setStatusSafe('Align-To-Audio cancelled.'); return; }
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
  const device = document.getElementById('whisperDevice')?.value || 'cuda';
  const compute = document.getElementById('whisperCompute')?.value || 'auto';
  const language = document.getElementById('whisperLang')?.value || 'auto';
  return { model, device, compute, language };
}

function formatBackendLanguageSummary(data){
  const summary = data?.language_summary;
  const langs = Array.isArray(summary?.languages) ? summary.languages : [];
  if (!langs.length){
    const l = data?.language || data?.detected_language || '';
    return l ? `language: ${String(l)}` : '';
  }
  const labels = langs
    .slice(0, 4)
    .map(x => `${x.label || x.code || 'Unknown'}${x.segments ? ` ×${x.segments}` : ''}`);
  const dropped = Number(summary?.dropped_hallucinations || 0);
  const dropText = dropped > 0 ? `, dropped ${dropped} likely hallucinated/meta cue${dropped === 1 ? '' : 's'}` : '';
  return `${summary?.is_mixed ? 'languages' : 'language'}: ${labels.join(', ')}${dropText}`;
}

async function transcribeYouTubeWithBackend(){
  const src = getCurrentYouTubeSource();
  if (!src){ alert('Import a YouTube URL first.'); return; }
  if (!src.permissionConfirmed){
    alert('Please confirm that you own this YouTube video or have permission to process it. Re-open Import YouTube URL and tick the permission checkbox.');
    return;
  }
  const { model, device, compute, language } = getWhisperSettings();
  progressStart('Preparing YouTube audio for transcription…');
  const res = await fetch(`${API_BASE}/api/youtube_transcribe_start`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      url: src.url,
      permission_confirmed: true,
      model, device, compute_type: compute, language,
      word_timestamps: true,
      vad_filter: true,
    })
  });
  const startResp = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(startResp?.error || startResp?.message || `HTTP ${res.status}`);
  const jobId = startResp?.job_id;
  if (!jobId) throw new Error('No job_id returned');
  setActiveBackendJob(jobId, 'youtube_transcribe');
  await pollJob(jobId);
  const data = await fetchJobResult(jobId);

  const srtText = data?.srt || '';
  if (!srtText.trim()){
    setStatus('No SRT returned');
    return;
  }

  const parsed = parseSRT(srtText);
  initialEntries = parsed.map((e, idx) => ({ start:e.start, end:e.end, text:e.text, index:idx }));
  entries = parsed.map((e, idx) => ({
    start:e.start, end:e.end, text:e.text,
    orig:{ start:e.start, end:e.end, text:e.text }, origIndex: idx
  }));
  if (!entriesB?.length){
    entriesB = parsed.map((e) => ({ start:e.start, end:e.end, text:'' }));
    initialEntriesB = entriesB.map((e) => ({ start:e.start, end:e.end, text:e.text }));
  }
  renderTranscript();
  if (isDualMode) renderTranscriptB();
  progressDone(true);

  const box = document.getElementById('alignSrtText');
  if (box && !box.value.trim()) box.value = srtText;

  const langInfo = formatBackendLanguageSummary(data);
  const sourceTitle = data?.source?.title || src.metadata?.title || 'YouTube video';
  statusEl.textContent = `Transcribed ${entries.length} captions from ${sourceTitle} (model: ${data?.model || model}${langInfo ? ', ' + langInfo : ''})`;
  setStatus('Ready');
}

async function analyzeYouTubeAlignWithBackend(){
  const src = getCurrentYouTubeSource();
  if (!src){ alert('Import a YouTube URL first.'); return; }
  if (!src.permissionConfirmed){
    alert('Please confirm that you own this YouTube video or have permission to process it. Re-open Import YouTube URL and tick the permission checkbox.');
    return;
  }
  const srtText = document.getElementById('alignSrtText')?.value || '';
  if (!srtText.trim()){
    alert('Paste SRT text to align first.');
    return;
  }
  const { model, device, compute, language } = getWhisperSettings();
  progressStart('Preparing YouTube audio for alignment…');
  const res = await fetch(`${API_BASE}/api/youtube_align_start`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      url: src.url,
      text: srtText,
      permission_confirmed: true,
      model, device, compute_type: compute, language,
      word_timestamps: true,
      vad_filter: true,
    })
  });
  const startResp = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(startResp?.error || startResp?.message || `HTTP ${res.status}`);
  const jobId = startResp?.job_id;
  if (!jobId) throw new Error('No job_id returned');
  setActiveBackendJob(jobId, 'youtube_align');
  await pollJob(jobId);
  const data = await fetchJobResult(jobId);

  const alignedSrt = data?.aligned_srt || '';
  if (!alignedSrt.trim()){
    setStatus('No aligned SRT returned');
    return;
  }

  const parsed = parseSRT(alignedSrt);
  initialEntries = parsed.map((e, idx) => ({ start:e.start, end:e.end, text:e.text, index:idx }));
  entries = parsed.map((e, idx) => ({
    start:e.start, end:e.end, text:e.text,
    orig:{ start:e.start, end:e.end, text:e.text }, origIndex: idx
  }));
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
  const langInfo = formatBackendLanguageSummary(data);
  const sourceTitle = data?.source?.title || src.metadata?.title || 'YouTube video';
  statusEl.textContent = `Aligned ${entries.length} captions from ${sourceTitle} (low confidence: ${low}/${total}${langInfo ? ', ' + langInfo : ''})`;
  setStatus('Ready');

  const firstLow = data?.first_low_index;
  if (typeof firstLow === 'number' && firstLow >= 0){
    suppressAutoScrollUntil = nowMs() + 800;
    holdManualSelection(firstLow, 4000);
    selectRow(firstLow, {scroll:true});
  }
}


function getCurrentLocalCachedSource(){
  return (currentMediaSource && currentMediaSource.type === 'local' && currentMediaSource.cacheId) ? currentMediaSource : null;
}

function rememberLocalCacheFromBackend(data){
  const src = data?.source;
  if (!src || src.type !== 'local_cached' || !src.cache_id) return;
  const curFile = currentMediaSource?.file || lastLoadedVideoFile || fileInput?.files?.[0] || null;
  currentMediaSource = {
    type: 'local',
    file: curFile,
    cacheId: String(src.cache_id),
    cacheDir: src.cache_dir || '',
    audioPath: src.audio_path || '',
    filename: src.filename || curFile?.name || 'media',
    duration: Number(src.duration || 0) || 0,
  };
}


async function ensureLocalAudioCache(){
  // If the current local file already has a backend cache_id, reuse it.
  const cached = getCurrentLocalCachedSource();
  if (cached?.cacheId) return cached;

  const media = getLoadedMediaFile();
  if (!media) return null;

  progressStart('Extracting and caching local audio…');
  const fd = new FormData();
  fd.append('media', media, media.name);

  const res = await fetch(`${API_BASE}/api/local_cache_start`, { method:'POST', body: fd });
  if (!res.ok){
    const msg = await res.text().catch(()=> '');
    throw new Error(`Local cache HTTP ${res.status} ${msg}`);
  }
  const startResp = await res.json().catch(()=>({}));
  const jobId = startResp?.job_id;
  if (!jobId) throw new Error('No job_id returned from local cache job');
  setActiveBackendJob(jobId, 'local_cache');
  await pollJob(jobId);
  const data = await fetchJobResult(jobId);
  rememberLocalCacheFromBackend(data);
  // Keep the progress UI alive so the next Transcribe/Align job can start cleanly.
  // Do not call progressDone() here; this cache step is only phase 1 of the user's action.
  setStatusSafe('Local audio cached. Starting next step…');

  const src = getCurrentLocalCachedSource();
  if (!src?.cacheId){
    throw new Error('Local audio was cached, but no cache_id was returned by backend.');
  }
  return src;
}

async function transcribeLocalCachedWithBackend(){
  const src = getCurrentLocalCachedSource();
  if (!src?.cacheId) return false;
  const { model, device, compute, language } = getWhisperSettings();
  progressStart('Analyzing cached local audio for transcription…');
  const res = await fetch(`${API_BASE}/api/local_cached_transcribe_start`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      cache_id: src.cacheId,
      model, device, compute_type: compute, language,
      word_timestamps: true,
      vad_filter: true,
    })
  });
  const startResp = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(startResp?.error || startResp?.message || `HTTP ${res.status}`);
  const jobId = startResp?.job_id;
  if (!jobId) throw new Error('No job_id returned');
  setActiveBackendJob(jobId, 'local_cached_transcribe');
  await pollJob(jobId);
  const data = await fetchJobResult(jobId);
  rememberLocalCacheFromBackend(data);

  const srtText = data?.srt || '';
  if (!srtText.trim()){
    setStatus('No SRT returned');
    return true;
  }
  const parsed = parseSRT(srtText);
  initialEntries = parsed.map((e, idx) => ({ start:e.start, end:e.end, text:e.text, index:idx }));
  entries = parsed.map((e, idx) => ({
    start:e.start, end:e.end, text:e.text,
    orig:{ start:e.start, end:e.end, text:e.text }, origIndex: idx
  }));
  if (!entriesB?.length){
    entriesB = parsed.map((e) => ({ start:e.start, end:e.end, text:'' }));
    initialEntriesB = entriesB.map((e) => ({ start:e.start, end:e.end, text:e.text }));
  }
  renderTranscript();
  if (isDualMode) renderTranscriptB();
  progressDone(true);
  const box = document.getElementById('alignSrtText');
  if (box && !box.value.trim()) box.value = srtText;
  const langInfo = formatBackendLanguageSummary(data);
  statusEl.textContent = `Transcribed ${entries.length} captions from cached local audio (model: ${data?.model || model}${langInfo ? ', ' + langInfo : ''})`;
  setStatus('Ready');
  return true;
}

async function analyzeLocalCachedAlignWithBackend(){
  const src = getCurrentLocalCachedSource();
  if (!src?.cacheId) return false;
  const srtText = document.getElementById('alignSrtText')?.value || '';
  if (!srtText.trim()){
    alert('Paste SRT text to align first.');
    return true;
  }
  const { model, device, compute, language } = getWhisperSettings();
  progressStart('Analyzing cached local audio for alignment…');
  const res = await fetch(`${API_BASE}/api/local_cached_align_start`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      cache_id: src.cacheId,
      text: srtText,
      model, device, compute_type: compute, language,
      word_timestamps: true,
      vad_filter: true,
    })
  });
  const startResp = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(startResp?.error || startResp?.message || `HTTP ${res.status}`);
  const jobId = startResp?.job_id;
  if (!jobId) throw new Error('No job_id returned');
  setActiveBackendJob(jobId, 'local_cached_align');
  await pollJob(jobId);
  const data = await fetchJobResult(jobId);
  rememberLocalCacheFromBackend(data);

  const alignedSrt = data?.aligned_srt || '';
  if (!alignedSrt.trim()){
    setStatus('No aligned SRT returned');
    return true;
  }
  const parsed = parseSRT(alignedSrt);
  initialEntries = parsed.map((e, idx) => ({ start:e.start, end:e.end, text:e.text, index:idx }));
  entries = parsed.map((e, idx) => ({
    start:e.start, end:e.end, text:e.text,
    orig:{ start:e.start, end:e.end, text:e.text }, origIndex: idx
  }));
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
  const langInfo = formatBackendLanguageSummary(data);
  statusEl.textContent = `Aligned ${entries.length} captions from cached local audio (low confidence: ${low}/${total}${langInfo ? ', ' + langInfo : ''})`;
  setStatus('Ready');
  const firstLow = data?.first_low_index;
  if (typeof firstLow === 'number' && firstLow >= 0){
    suppressAutoScrollUntil = nowMs() + 800;
    holdManualSelection(firstLow, 4000);
    selectRow(firstLow, {scroll:true});
  }
  return true;
}

async function transcribeWithBackend(){  try {

  if (getCurrentYouTubeSource()) {
    return await transcribeYouTubeWithBackend();
  }

  if (getCurrentGoogleDriveSource()) {
    return await transcribeGoogleDriveCachedWithBackend();
  }

  // Local media path: upload/extract once, remember cache_id, then transcribe from cached WAV.
  await ensureLocalAudioCache();
  if (getCurrentLocalCachedSource()) {
    return await transcribeLocalCachedWithBackend();
  }

  return;
  } finally {
    // If an error happened or the job was cancelled, stop/reset the progress UI.
    if (__activeBackendJobId) progressDone(false);
  }
}

async function analyzeAlignWithBackend(){  try {

  if (getCurrentYouTubeSource()) {
    return await analyzeYouTubeAlignWithBackend();
  }

  if (getCurrentGoogleDriveSource()) {
    return await analyzeGoogleDriveCachedAlignWithBackend();
  }

  // Local media path: upload/extract once, remember cache_id, then align from cached WAV.
  await ensureLocalAudioCache();
  if (getCurrentLocalCachedSource()) {
    return await analyzeLocalCachedAlignWithBackend();
  }

  return;
  } finally {
    // If an error happened or the job was cancelled, stop/reset the progress UI.
    if (__activeBackendJobId) progressDone(false);
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
  setActiveBackendJob(jobId, 'verify');
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


/* ---------- Google Drive Import (public/shared link PoC) ---------- */
function parseGoogleDriveFileId(url){
  const raw = String(url || '').trim();
  if (/^[A-Za-z0-9_-]{20,}$/.test(raw)) return raw;
  const patterns = [
    /drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{20,})/i,
    /drive\.google\.com\/open\?id=([A-Za-z0-9_-]{20,})/i,
    /drive\.google\.com\/uc\?(?:[^#]*&)?id=([A-Za-z0-9_-]{20,})/i,
    /[?&]id=([A-Za-z0-9_-]{20,})/i,
  ];
  for (const rx of patterns){
    const m = raw.match(rx);
    if (m) return m[1];
  }
  return '';
}
function getGoogleDrivePreviewUrl(fileId, seconds=null, { autoplay=false }={}){
  const base = `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`;
  const t = Number(seconds);
  if (!Number.isFinite(t) || t < 0) return base;

  // Google Drive preview does not expose a JS player API. The only practical
  // iframe seek path is to reload the preview URL with a timestamp hint.
  // Different Drive builds have accepted either `t=` or `start=`, so include
  // both. `t=12s` mirrors Drive share links; `start=12` is a common embed hint.
  const sec = Math.max(0, Math.floor(t));
  const qs = new URLSearchParams();
  qs.set('t', `${sec}s`);
  qs.set('start', String(sec));
  if (autoplay) qs.set('autoplay', '1');
  return `${base}?${qs.toString()}`;
}
function isGoogleDrivePreviewMode(){
  return !!(currentMediaSource && currentMediaSource.type === 'drive');
}
function isGoogleDriveIframeMode(){
  return !!(currentMediaSource && currentMediaSource.type === 'drive' && currentMediaSource.playerMode === 'iframe');
}
function isGoogleDriveNativeMode(){
  return !!(currentMediaSource && currentMediaSource.type === 'drive' && currentMediaSource.playerMode === 'native');
}
function ensureGoogleDriveFrame(){
  const frameInner = document.querySelector('.frame-inner') || player?.parentElement;
  if (!frameInner) return null;
  if (getComputedStyle(frameInner).position === 'static') frameInner.style.position = 'relative';
  frameInner.style.overflow = 'hidden';
  frameInner.style.background = '#000';
  if (!frameInner.style.aspectRatio) frameInner.style.aspectRatio = '16 / 9';
  frameInner.style.minHeight = frameInner.style.minHeight || '270px';
  if (!document.getElementById('googleDrivePreviewStyle')){
    const st = document.createElement('style');
    st.id = 'googleDrivePreviewStyle';
    st.textContent = `
      .gdrive-preview-mount{position:absolute;inset:0;width:100%;height:100%;display:none;background:#000;z-index:20;overflow:hidden}
      .gdrive-preview-mount.is-on{display:block}
      .gdrive-preview-frame{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:#000;object-fit:contain;transition:opacity .18s ease}
      .gdrive-preview-frame.is-active{opacity:1;z-index:2;pointer-events:auto}
      .gdrive-preview-frame.is-buffer{opacity:0;z-index:1;pointer-events:none}
      .gdrive-icon-btn{display:inline-flex;align-items:center;gap:7px}
      .gdrive-icon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#0f9d58 0 33%,#f4b400 33% 66%,#4285f4 66%);font-size:0}
      .gdrive-icon:after{content:'';width:8px;height:8px;border-radius:2px;background:#fff;opacity:.9}
      .gdrive-icon-label{font-size:13px}
      .gdrive-import-grid{display:grid;grid-template-columns:1fr;gap:12px}
      .gdrive-mode-box{display:flex;gap:12px;flex-wrap:wrap;align-items:center;background:rgba(255,255,255,.04);padding:10px;border-radius:10px}
      .gdrive-mode-box label{display:flex;align-items:center;gap:6px}
      .gdrive-probe-card{font-size:12px;line-height:1.5;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px;color:#e9edf1}
    `;
    document.head.appendChild(st);
  }
  let mount = document.getElementById('googleDrivePreviewMount');
  if (!mount){
    mount = document.createElement('div');
    mount.id = 'googleDrivePreviewMount';
    mount.className = 'gdrive-preview-mount';
    frameInner.appendChild(mount);
  }
  let iframe = document.getElementById('googleDrivePreviewFrame');
  if (!iframe){
    iframe = document.createElement('iframe');
    iframe.id = 'googleDrivePreviewFrame';
    iframe.className = 'gdrive-preview-frame is-active';
    iframe.title = 'Google Drive preview';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
    iframe.allowFullscreen = true;
    mount.appendChild(iframe);
  }
  return iframe;
}

function ensureGoogleDriveBufferFrame(){
  ensureGoogleDriveFrame();
  const mount = document.getElementById('googleDrivePreviewMount');
  if (!mount) return null;
  let buffer = document.getElementById('googleDrivePreviewFrameBuffer');
  if (!buffer){
    buffer = document.createElement('iframe');
    buffer.id = 'googleDrivePreviewFrameBuffer';
    buffer.className = 'gdrive-preview-frame is-buffer';
    buffer.title = 'Google Drive preview buffer';
    buffer.allow = 'autoplay; encrypted-media; picture-in-picture';
    buffer.allowFullscreen = true;
    mount.appendChild(buffer);
  }
  return buffer;
}

function swapGoogleDrivePreviewFrames(){
  const active = document.getElementById('googleDrivePreviewFrame');
  const buffer = document.getElementById('googleDrivePreviewFrameBuffer');
  if (!active || !buffer) return;
  // Swap identities so future code still targets #googleDrivePreviewFrame.
  active.id = 'googleDrivePreviewFrameOld';
  buffer.id = 'googleDrivePreviewFrame';
  active.id = 'googleDrivePreviewFrameBuffer';
  buffer.className = 'gdrive-preview-frame is-active';
  active.className = 'gdrive-preview-frame is-buffer';
}

let __gdIframeSeekSerial = 0;
function queueGoogleDriveIframeSeek(nextSrc){
  const active = ensureGoogleDriveFrame();
  const buffer = ensureGoogleDriveBufferFrame();
  if (!active || !buffer || !nextSrc) return;

  // If the active iframe is already at this timestamp, do not blank/reload it.
  // Re-blanking is what caused the visible poster/first-frame flash.
  if (active.src === nextSrc) return;

  const serial = ++__gdIframeSeekSerial;
  let swapped = false;
  const doSwap = () => {
    if (swapped || serial !== __gdIframeSeekSerial) return;
    swapped = true;
    swapGoogleDrivePreviewFrames();
  };

  buffer.onload = () => {
    // Give Google Drive a short moment after iframe load to render the requested
    // timestamp instead of exposing its poster frame during the swap.
    setTimeout(doSwap, 320);
  };
  buffer.src = nextSrc;

  // Fallback: if Drive never fires load reliably, still swap eventually.
  setTimeout(doSwap, 1800);
}

function setGoogleDrivePreviewVisible(on){
  const iframe = ensureGoogleDriveFrame();
  const mount = document.getElementById('googleDrivePreviewMount');
  if (mount) mount.classList.toggle('is-on', !!on);
  if (!on){
    __gdVirtualPlaying = false;
    stopGoogleDriveVirtualSync();
  }
  if (!on && iframe) iframe.removeAttribute('src');
  if (!on) document.getElementById('googleDrivePreviewFrameBuffer')?.removeAttribute('src');
  if (player){
    if (on){
      player.style.opacity = '0';
      player.style.visibility = 'hidden';
      player.style.pointerEvents = 'none';
    } else {
      if (!isYouTubePreviewMode()){
        player.style.opacity = '';
        player.style.visibility = '';
        player.style.pointerEvents = '';
      }
    }
  }
  const controls = document.getElementById('videoControls');
  if (controls && !isYouTubePreviewMode()) controls.style.display = on ? 'none' : '';
}
function activateGoogleDrivePreview({ url='', fileId='', metadata={}, cacheId='' }={}){
  const fid = fileId || parseGoogleDriveFileId(url);
  if (!fid){ alert('Could not find a Google Drive file ID from this link.'); return; }
  try{ setYouTubePreviewVisible(false); }catch(_e){}
  const iframe = ensureGoogleDriveFrame();
  currentMediaSource = { type:'drive', playerMode:'iframe', url, fileId:fid, previewUrl:getGoogleDrivePreviewUrl(fid), metadata: metadata || {}, cacheId: cacheId || '' };
  __gdVirtualTime = 0; __gdVirtualPlaying = false; __gdVirtualLastMs = performance.now();
  if (iframe) iframe.src = currentMediaSource.previewUrl;
  setGoogleDrivePreviewVisible(true);
  setStatusSafe('Google Drive preview loaded.');
}
function activateGoogleDriveNativePreview({ url='', fileId='', metadata={}, cacheId='' }={}){
  const fid = fileId || parseGoogleDriveFileId(url);
  if (!cacheId){
    activateGoogleDrivePreview({ url, fileId: fid, metadata, cacheId });
    return;
  }
  try{ setYouTubePreviewVisible(false); }catch(_e){}
  try{ setGoogleDrivePreviewVisible(false); }catch(_e){}
  currentMediaSource = {
    type:'drive', playerMode:'native', url, fileId:fid,
    previewUrl:getGoogleDrivePreviewUrl(fid), metadata: metadata || {}, cacheId
  };
  if (player){
    player.style.display = '';
    player.style.opacity = '';
    player.style.visibility = '';
    player.style.pointerEvents = '';
    player.controls = false;
    player.src = `${API_BASE}/api/google_drive_cached_media/${encodeURIComponent(cacheId)}`;
    try{ player.load(); }catch(_e){}
  }
  const controls = document.getElementById('videoControls');
  if (controls) controls.style.display = '';
  setStatusSafe('Google Drive preview loaded from cached media.');
}

function getCurrentGoogleDriveSource(){
  return (currentMediaSource && currentMediaSource.type === 'drive') ? currentMediaSource : null;
}
async function probeGoogleDriveUrl(url){
  const res = await fetch(`${API_BASE}/api/google_drive_probe`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url })
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok || data?.ok === false) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
  return data;
}
function ensureGoogleDriveImportModal(){
  if (document.getElementById('googleDriveImportModal')) return;
  ensureGoogleDriveFrame();
  const wrap = document.createElement('div');
  wrap.id = 'googleDriveImportModal';
  wrap.className = 'modal-overlay hidden';
  wrap.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="gdTitle" style="max-width:640px">
      <div class="modal-head">
        <div>
          <div id="gdTitle" class="modal-title">Import Google Drive</div>
          <div class="modal-sub">Use a shared Drive file link. The backend caches 16 kHz mono WAV for Transcribe / Align.</div>
        </div>
        <button class="btn btn-outline btn-mini" id="gdClose" type="button" aria-label="Close">✕</button>
      </div>
      <div class="modal-body gdrive-import-grid">
        <label class="muted" style="display:flex;flex-direction:column;gap:5px">Google Drive URL
          <input id="gdUrlInput" class="ui-dark-input" type="url" placeholder="https://drive.google.com/file/d/.../view" style="width:100%">
        </label>
        <div class="gdrive-mode-box">
          <label><input type="checkbox" id="gdModePreview" checked> Preview</label>
          <label><input type="checkbox" id="gdModeCache" checked> Cache audio</label>
          <button class="btn btn-outline btn-mini" id="gdProbe" type="button">Probe</button>
          <span class="muted" id="gdProbeStatus"></span>
        </div>
        <div id="gdProbeCard" class="gdrive-probe-card" style="display:none"></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-outline" id="gdCancel" type="button">Cancel</button>
        <div style="flex:1"></div>
        <button class="btn btn-gold" id="gdImport" type="button">Import</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.classList.add('hidden');
  wrap.querySelector('#gdClose').onclick = close;
  wrap.querySelector('#gdCancel').onclick = close;
  wrap.addEventListener('click', (e)=>{ if (e.target === wrap) close(); });
  const renderProbe = (data) => {
    const card = document.getElementById('gdProbeCard');
    if (!card) return;
    card.style.display = 'block';
    card.innerHTML = `<b>Google Drive file detected</b><br>File ID: ${escapeHtml(data.file_id || '')}<br><span class="muted">This PoC supports files shared as “Anyone with the link can view”.</span>`;
  };
  wrap.querySelector('#gdProbe').addEventListener('click', async ()=>{
    const url = document.getElementById('gdUrlInput')?.value?.trim() || '';
    const st = document.getElementById('gdProbeStatus');
    try{
      if (st) st.textContent = 'Probing…';
      const data = await probeGoogleDriveUrl(url);
      renderProbe(data);
      if (st) st.textContent = 'Ready';
    }catch(err){
      if (st) st.textContent = 'Probe failed';
      alert('Google Drive probe failed: ' + (err?.message || err));
    }
  });
  wrap.querySelector('#gdImport').addEventListener('click', async ()=>{
    const url = document.getElementById('gdUrlInput')?.value?.trim() || '';
    const preview = !!document.getElementById('gdModePreview')?.checked;
    const cache = !!document.getElementById('gdModeCache')?.checked;
    if (!url){ alert('Paste a Google Drive link first.'); return; }
    if (!preview && !cache){ alert('Choose Preview, Cache audio, or both.'); return; }
    try{
      let meta = null;
      try{ meta = await probeGoogleDriveUrl(url); }catch(_e){ meta = { file_id: parseGoogleDriveFileId(url), preview_url: '' }; }
      if (cache){
        const cached = await startGoogleDriveCache(url, meta);
        if (preview && cached?.cacheId){
          activateGoogleDriveNativePreview({
            url,
            fileId: cached.fileId || meta.file_id,
            metadata: cached.metadata || meta,
            cacheId: cached.cacheId
          });
        } else if (preview){
          activateGoogleDrivePreview({ url, fileId: meta.file_id, metadata: meta });
        }
      } else if (preview){
        activateGoogleDrivePreview({ url, fileId: meta.file_id, metadata: meta });
      }
      close();
    }catch(err){
      console.error(err);
      alert('Google Drive import failed: ' + (err?.message || err));
    }
  });
}
async function openGoogleDriveImportModal(){
  ensureGoogleDriveImportModal();
  const wrap = document.getElementById('googleDriveImportModal');
  wrap?.classList.remove('hidden');
  setTimeout(()=>document.getElementById('gdUrlInput')?.focus(), 50);
}
function ensureGoogleDriveImportButton(){
  if (document.getElementById('btnGoogleDriveImport')) return;
  ensureGoogleDriveFrame();
  const toolbar = document.querySelector('.toolbar') || document.querySelector('header .toolbar');
  if (!toolbar) return;
  const btn = document.createElement('button');
  btn.id = 'btnGoogleDriveImport';
  btn.type = 'button';
  btn.className = 'btn btn-outline gdrive-icon-btn';
  btn.title = 'Import Google Drive link';
  btn.setAttribute('aria-label', 'Import Google Drive link');
  btn.innerHTML = '<span class="gdrive-icon" aria-hidden="true"></span><span class="gdrive-icon-label">Drive</span>';
  const ytBtn = document.getElementById('btnYouTubeImport');
  if (ytBtn && ytBtn.parentElement) ytBtn.insertAdjacentElement('afterend', btn);
  else {
    const srtLabel = document.getElementById('srtInput')?.closest('label');
    if (srtLabel && srtLabel.parentElement) srtLabel.insertAdjacentElement('afterend', btn);
    else toolbar.insertBefore(btn, toolbar.firstChild);
  }
  btn.addEventListener('click', () => openGoogleDriveImportModal());
}
async function startGoogleDriveCache(url, meta=null){
  progressStart('Caching Google Drive audio…');
  const res = await fetch(`${API_BASE}/api/google_drive_cache_start`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url })
  });
  const startResp = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(startResp?.error || startResp?.message || `HTTP ${res.status}`);
  const jobId = startResp?.job_id;
  if (!jobId) throw new Error('No job_id returned');
  setActiveBackendJob(jobId, 'google_drive_cache');
  await pollJob(jobId);
  const data = await fetchJobResult(jobId);
  const source = data?.source || {};
  currentMediaSource = Object.assign({}, currentMediaSource || {}, {
    type:'drive',
    playerMode: currentMediaSource?.playerMode || 'native',
    url: source.url || url,
    fileId: source.file_id || meta?.file_id || parseGoogleDriveFileId(url),
    previewUrl: source.preview_url || meta?.preview_url || getGoogleDrivePreviewUrl(source.file_id || meta?.file_id || parseGoogleDriveFileId(url)),
    metadata: Object.assign({}, meta || {}, source || {}),
    cacheId: source.cache_id || jobId,
    cacheDir: source.cache_dir || '',
    audioPath: source.audio_path || '',
    sourceMediaPath: source.source_media_path || '',
    sourceMediaName: source.source_media_name || '',
    duration: Number(source.duration || 0) || 0,
  });
  progressDone(true);
  if (currentMediaSource.cacheId && document.getElementById('googleDrivePreviewMount')?.classList.contains('is-on')){
    activateGoogleDriveNativePreview(currentMediaSource);
  }
  setStatusSafe('Google Drive audio cached.');
  return currentMediaSource;
}
async function ensureGoogleDriveAudioCache(){
  const src = getCurrentGoogleDriveSource();
  if (!src){ alert('Import a Google Drive link first.'); return null; }
  if (src.cacheId) return src;
  return await startGoogleDriveCache(src.url || src.fileId, src.metadata || null);
}
async function transcribeGoogleDriveCachedWithBackend(){
  const src = await ensureGoogleDriveAudioCache();
  if (!src?.cacheId) return false;
  const { model, device, compute, language } = getWhisperSettings();
  progressStart('Analyzing cached Google Drive audio for transcription…');
  const res = await fetch(`${API_BASE}/api/google_drive_cached_transcribe_start`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ cache_id: src.cacheId, model, device, compute_type: compute, language, word_timestamps: true, vad_filter: true })
  });
  const startResp = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(startResp?.error || startResp?.message || `HTTP ${res.status}`);
  const jobId = startResp?.job_id;
  if (!jobId) throw new Error('No job_id returned');
  setActiveBackendJob(jobId, 'google_drive_cached_transcribe');
  await pollJob(jobId);
  const data = await fetchJobResult(jobId);
  const srtText = data?.srt || '';
  if (!srtText.trim()){ setStatus('No SRT returned'); return true; }
  const parsed = parseSRT(srtText);
  initialEntries = parsed.map((e, idx) => ({ start:e.start, end:e.end, text:e.text, index:idx }));
  entries = parsed.map((e, idx) => ({ start:e.start, end:e.end, text:e.text, orig:{ start:e.start, end:e.end, text:e.text }, origIndex: idx }));
  if (!entriesB?.length){
    entriesB = parsed.map((e) => ({ start:e.start, end:e.end, text:'' }));
    initialEntriesB = entriesB.map((e) => ({ start:e.start, end:e.end, text:e.text }));
  }
  renderTranscript();
  if (isDualMode) renderTranscriptB();
  progressDone(true);
  const box = document.getElementById('alignSrtText');
  if (box && !box.value.trim()) box.value = srtText;
  const langInfo = formatBackendLanguageSummary(data);
  statusEl.textContent = `Transcribed ${entries.length} captions from Google Drive (model: ${data?.model || model}${langInfo ? ', ' + langInfo : ''})`;
  setStatus('Ready');
  return true;
}
async function analyzeGoogleDriveCachedAlignWithBackend(){
  const src = await ensureGoogleDriveAudioCache();
  if (!src?.cacheId) return false;
  const srtText = document.getElementById('alignSrtText')?.value || '';
  if (!srtText.trim()){ alert('Paste SRT text to align first.'); return true; }
  const { model, device, compute, language } = getWhisperSettings();
  progressStart('Analyzing cached Google Drive audio for alignment…');
  const res = await fetch(`${API_BASE}/api/google_drive_cached_align_start`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ cache_id: src.cacheId, text: srtText, model, device, compute_type: compute, language, word_timestamps: true, vad_filter: true })
  });
  const startResp = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(startResp?.error || startResp?.message || `HTTP ${res.status}`);
  const jobId = startResp?.job_id;
  if (!jobId) throw new Error('No job_id returned');
  setActiveBackendJob(jobId, 'google_drive_cached_align');
  await pollJob(jobId);
  const data = await fetchJobResult(jobId);
  const alignedSrt = data?.aligned_srt || '';
  if (!alignedSrt.trim()){ setStatus('No aligned SRT returned'); return true; }
  const parsed = parseSRT(alignedSrt);
  initialEntries = parsed.map((e, idx) => ({ start:e.start, end:e.end, text:e.text, index:idx }));
  entries = parsed.map((e, idx) => ({ start:e.start, end:e.end, text:e.text, orig:{ start:e.start, end:e.end, text:e.text }, origIndex: idx }));
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
  const langInfo = formatBackendLanguageSummary(data);
  statusEl.textContent = `Aligned ${entries.length} captions from Google Drive (low confidence: ${low}/${total}${langInfo ? ', ' + langInfo : ''})`;
  setStatus('Ready');
  const firstLow = data?.first_low_index;
  if (typeof firstLow === 'number' && firstLow >= 0){
    suppressAutoScrollUntil = nowMs() + 800;
    holdManualSelection(firstLow, 4000);
    selectRow(firstLow, {scroll:true});
  }
  return true;
}




/* ---------- View-only Share Sessions ---------- */
function cleanEntryForShare(e){
  return {
    id: String(e?.id || ''),
    start: Number(e?.start || 0),
    end: Number(e?.end || 0),
    text: String(e?.text || ''),
  };
}

function getShareableMediaSource(){
  const src = currentMediaSource || {};
  if (src.type === 'youtube'){
    return {
      type: 'youtube',
      url: src.url || '',
      videoId: src.videoId || parseYouTubeVideoId(src.url || ''),
      metadata: src.metadata || {},
    };
  }
  if (src.type === 'drive'){
    return {
      type: 'drive',
      url: src.url || '',
      fileId: src.fileId || parseGoogleDriveFileId(src.url || ''),
      previewUrl: src.previewUrl || '',
      metadata: src.metadata || {},
    };
  }
  if (src.type === 'local' && src.cacheId){
    return {
      type: 'local_cached',
      cacheId: src.cacheId,
      filename: (src.file && src.file.name) || (lastLoadedVideoFile && lastLoadedVideoFile.name) || src.filename || 'local media',
      metadata: src.metadata || {},
      streamUrl: `${API_BASE}/api/local_cached_media/${encodeURIComponent(src.cacheId)}`,
    };
  }
  return {
    type: 'local',
    filename: (src.file && src.file.name) || (lastLoadedVideoFile && lastLoadedVideoFile.name) || '',
    note: 'Local media is not yet cached for shared playback. Run Transcribe or Align once to cache it before sharing/collaboration.',
  };
}

function buildShareSessionState(){
  try{ flushEditsFromDOM(); }catch(_e){}
  try{ storySyncAllRichBodiesToCards?.({ commit:false, reconcile:false }); }catch(_e){}
  try{ ensureCueIds?.(entries); ensureCueIds?.(entriesB); }catch(_e){}
  const box = document.getElementById('alignSrtText');
  return {
    version: 1,
    base_name: window.currentBaseName || 'captions',
    subs_mode: document.getElementById('subsMode')?.value || subsMode || 'A',
    active_overlay_track: activeOverlayTrack || 'A',
    fps: getFPS(),
    use_source_tc: !!useSourceTc,
    source_tc_sec: Number(sourceTcSec || 0),
    media_source: getShareableMediaSource(),
    entriesA: (entries || []).map(cleanEntryForShare),
    entriesB: (entriesB || []).map(cleanEntryForShare),
    align_text: box ? String(box.value || '') : '',
    comments: COLLAB_COMMENTS || {},
    timeline_clips: (timelineClips || []).map(cleanTimelineClipForShare),
    story_rows: (storyRows || []).map(cleanStoryRowForShare),
  };
}

function ensureShareSessionModal(){
  if (document.getElementById('shareSessionModal')) return;
  if (!document.getElementById('shareSessionModalStyle')){
    const st = document.createElement('style');
    st.id = 'shareSessionModalStyle';
    st.textContent = `
      #shareSessionModal .share-card{ width:min(420px, calc(100vw - 32px)); max-width:420px; border-radius:18px; }
      #shareSessionModal .share-body{ padding-top:4px; }
      #shareSessionModal .share-options{ display:grid; grid-template-columns:1fr; gap:10px; }
      #shareSessionModal .share-option{
        width:100%; min-height:50px; padding:13px 14px; border-radius:14px;
        display:flex; align-items:center; justify-content:space-between; gap:12px;
        text-align:left; white-space:normal; box-sizing:border-box; font-weight:700;
      }
      #shareSessionModal .share-option small{ font-weight:500; opacity:.62; font-size:12px; }
      #shareSessionModal .share-option .share-arrow{ opacity:.55; font-size:16px; }
    `;
    document.head.appendChild(st);
  }
  const wrap = document.createElement('div');
  wrap.id = 'shareSessionModal';
  wrap.className = 'modal-overlay hidden';
  wrap.innerHTML = `
    <div class="modal-card share-card" role="dialog" aria-modal="true" aria-labelledby="shareSessionTitle">
      <div class="modal-head">
        <div id="shareSessionTitle" class="modal-title">Share Session</div>
        <button class="btn btn-outline btn-mini" id="shareSessionClose" type="button" aria-label="Close">✕</button>
      </div>
      <div class="modal-body share-body">
        <div class="share-options" role="group" aria-label="Share session type">
          <button class="btn btn-outline share-option" id="shareViewOnlyBtn" type="button"><span>View-only<br><small>Review only</small></span><span class="share-arrow">→</span></button>
          <button class="btn btn-outline share-option" id="shareEditorBtn" type="button"><span>Editor<br><small>Snapshot with controls</small></span><span class="share-arrow">→</span></button>
          <button class="btn btn-gold share-option" id="shareCollabBtn" type="button"><span>Collaborative<br><small>Live sync every 2s</small></span><span class="share-arrow">→</span></button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => wrap.classList.add('hidden');
  wrap.querySelector('#shareSessionClose')?.addEventListener('click', close);
  wrap.addEventListener('click', (e)=>{ if (e.target === wrap) close(); });
  wrap.querySelector('#shareViewOnlyBtn')?.addEventListener('click', async ()=>{
    close();
    try{ await shareCurrentSession({ readOnly: true }); }
    catch(err){ console.error(err); alert('Share failed: ' + (err?.message || err)); }
  });
  wrap.querySelector('#shareEditorBtn')?.addEventListener('click', async ()=>{
    close();
    try{ await shareCurrentSession({ readOnly: false }); }
    catch(err){ console.error(err); alert('Share failed: ' + (err?.message || err)); }
  });
  wrap.querySelector('#shareCollabBtn')?.addEventListener('click', async ()=>{
    close();
    try{ await shareCollaborativeSession(); }
    catch(err){ console.error(err); alert('Collaborative share failed: ' + (err?.message || err)); }
  });
}

function openShareSessionModal(){
  if (VIEW_ONLY_SESSION){
    alert('This is already a view-only shared session.');
    return;
  }
  if (!entries?.length && !entriesB?.length){
    alert('Nothing to share yet. Import/transcribe captions first.');
    return;
  }
  ensureShareSessionModal();
  document.getElementById('shareSessionModal')?.classList.remove('hidden');
}

async function shareCurrentSession({ readOnly = true } = {}){
  if (VIEW_ONLY_SESSION){
    alert('This is already a view-only shared session.');
    return;
  }
  if (!entries?.length && !entriesB?.length){
    alert('Nothing to share yet. Import/transcribe captions first.');
    return;
  }
  const state = buildShareSessionState();
  const res = await fetch(`${API_BASE}/api/share_session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: state.base_name || 'Transcriber Session',
      read_only: !!readOnly,
      state,
    })
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok || !data?.ok){
    throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  }
  const fallbackPath = '/?session=' + data.session_id + '&view=' + (readOnly ? '1' : '0');
  const link = `${window.location.origin}${data.path || fallbackPath}`;
  try{ await navigator.clipboard.writeText(link); }catch(_e){}
  const label = readOnly ? 'View-only' : 'Editor';
  setStatusSafe(`${label} share link created and copied.`);
  prompt(`${label} share link:`, link);
}

function hashSessionState(st){
  // Stable hash used by collaborative sync. Do not include volatile fields,
  // otherwise every 2-second poll looks dirty and each browser keeps
  // overwriting the server instead of applying remote changes.
  try{
    const clone = JSON.parse(JSON.stringify(st || {}));
    delete clone.created_at;
    delete clone.updated_at;
    delete clone.last_seen;
    return JSON.stringify(clone);
  }catch(_e){
    try{ return JSON.stringify(st || {}); }catch(_e2){ return ''; }
  }
}


function collabUserName(uid){
  const u = (COLLAB_USERS || []).find(x => x.user_id === uid);
  return String(u?.label || (uid === COLLAB_USER_ID ? COLLAB_USER_LABEL : 'User'));
}
function collabUserColor(uid){
  const u = (COLLAB_USERS || []).find(x => x.user_id === uid);
  return String(u?.color || (uid === COLLAB_USER_ID ? COLLAB_USER_COLOR : '#4f8cff'));
}

function collabCueKey(track, index){ return `${track || 'A'}:${Number(index || 0)}`; }
function getCueComments(track, index){
  const key = collabCueKey(track, index);
  const arr = COLLAB_COMMENTS && Array.isArray(COLLAB_COMMENTS[key]) ? COLLAB_COMMENTS[key] : [];
  return arr;
}
function addCueComment(track, index, text){
  const t = String(text || '').trim();
  if (!t || VIEW_ONLY_SESSION) return;
  const key = collabCueKey(track, index);
  if (!COLLAB_COMMENTS || typeof COLLAB_COMMENTS !== 'object') COLLAB_COMMENTS = {};
  const arr = Array.isArray(COLLAB_COMMENTS[key]) ? COLLAB_COMMENTS[key] : [];
  arr.push({
    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    user_id: COLLAB_USER_ID || 'local',
    user_label: COLLAB_USER_LABEL || 'User',
    user_color: COLLAB_USER_COLOR || '#4f8cff',
    text: t,
    created_at: Date.now(),
  });
  COLLAB_COMMENTS[key] = arr;
  scheduleCollabPush?.();
  maybeSendCollabStateOverWebSocket?.({ force: true });
  applyCollabCueAwareness();
  refreshOpenCueComments();
}
function deleteCueComment(track, index, commentId){
  if (VIEW_ONLY_SESSION) return;
  const key = collabCueKey(track, index);
  const arr = Array.isArray(COLLAB_COMMENTS?.[key]) ? COLLAB_COMMENTS[key] : [];
  COLLAB_COMMENTS[key] = arr.filter(c => c && c.id !== commentId);
  scheduleCollabPush?.();
  maybeSendCollabStateOverWebSocket?.({ force: true });
  openCueComments(track, index);
  applyCollabCueAwareness();
}
function ensureCueCommentPopover(){
  ensureCollabAwarenessStyle();
  if (COLLAB_COMMENT_POPOVER && document.body.contains(COLLAB_COMMENT_POPOVER)) return COLLAB_COMMENT_POPOVER;
  const pop = document.createElement('div');
  pop.id = 'collabCueCommentsPopover';
  pop.innerHTML = `
    <div class="cue-comments-head"><strong>Comments</strong><button type="button" id="cueCommentsClose" class="btn btn-outline btn-mini">×</button></div>
    <div id="cueCommentsList" class="cue-comments-list"></div>
    <textarea id="cueCommentsInput" class="ui-dark-textarea" placeholder="Add a comment…"></textarea>
    <button id="cueCommentsAdd" class="btn btn-gold" type="button">Add Comment</button>`;
  document.body.appendChild(pop);
  pop.querySelector('#cueCommentsClose')?.addEventListener('click', () => pop.classList.remove('is-open'));
  document.addEventListener('click', (ev)=>{
    if (!pop.classList.contains('is-open')) return;
    if (pop.contains(ev.target)) return;
    if (ev.target && ev.target.closest && ev.target.closest('.collab-comment-button')) return;
    pop.classList.remove('is-open');
  });
  COLLAB_COMMENT_POPOVER = pop;
  return pop;
}
function openCueComments(track, index, anchorEl=null){
  const pop = ensureCueCommentPopover();
  pop.dataset.track = track || 'A';
  pop.dataset.index = String(index || 0);
  const list = pop.querySelector('#cueCommentsList');
  const input = pop.querySelector('#cueCommentsInput');
  const comments = getCueComments(track, index);
  list.innerHTML = comments.length ? comments.map(c => `
    <div class="cue-comment-item" style="--comment-color:${escapeHtml(c.user_color || '#4f8cff')}">
      <div class="cue-comment-meta"><span class="comment-dot"></span><b>${escapeHtml(c.user_label || 'User')}</b><span>${new Date(Number(c.created_at||Date.now())).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</span>${(c.user_id===COLLAB_USER_ID||!COLLAB_SESSION_ID)?`<button class="comment-del" data-id="${escapeHtml(c.id)}" title="Delete">×</button>`:''}</div>
      <div class="cue-comment-text">${escapeHtml(c.text || '')}</div>
    </div>`).join('') : '<div class="cue-comments-empty">No comments yet.</div>';
  list.querySelectorAll('.comment-del').forEach(btn => btn.addEventListener('click', (ev)=>{ ev.stopPropagation(); deleteCueComment(track, index, btn.dataset.id); }));
  pop.querySelector('#cueCommentsAdd').onclick = () => {
    addCueComment(track, index, input.value || '');
    input.value = '';
    openCueComments(track, index, anchorEl);
  };
  if (VIEW_ONLY_SESSION){ input.disabled = true; pop.querySelector('#cueCommentsAdd').disabled = true; }
  else { input.disabled = false; pop.querySelector('#cueCommentsAdd').disabled = false; }
  let x = window.innerWidth/2 - 160, y = 120;
  if (anchorEl){ const r = anchorEl.getBoundingClientRect(); x = r.right - 320; y = r.bottom + 8; }
  pop.style.left = Math.max(12, Math.min(window.innerWidth - 340, x)) + 'px';
  pop.style.top = Math.max(12, Math.min(window.innerHeight - 360, y)) + 'px';
  pop.classList.add('is-open');
}

function refreshOpenCueComments(){
  const pop = COLLAB_COMMENT_POPOVER || document.getElementById('collabCueCommentsPopover');
  if (!pop || !pop.classList.contains('is-open')) return;
  const track = pop.dataset.track || 'A';
  const idx = Number(pop.dataset.index || 0);
  openCueComments(track, idx);
}
function sendCollabEvent(payload){
  if (!COLLAB_SESSION_ID || !COLLAB_WS_CONNECTED || !COLLAB_WS || COLLAB_WS.readyState !== WebSocket.OPEN) return;
  try{ COLLAB_WS.send(JSON.stringify(payload)); }catch(_e){}
}
function sendCollabProfileUpdate(label, color){
  if (label != null) COLLAB_USER_LABEL = String(label || 'User').trim().slice(0,32) || 'User';
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) COLLAB_USER_COLOR = color.toLowerCase();
  try{ localStorage.setItem('transcriber_collab_label', COLLAB_USER_LABEL || 'User'); localStorage.setItem('transcriber_collab_color', COLLAB_USER_COLOR || '#4f8cff'); }catch(_e){}
  updateLiveUsersDisplay(COLLAB_USERS);
  sendCollabEvent({ type:'profile_update', user_id: COLLAB_USER_ID, label: COLLAB_USER_LABEL, color: COLLAB_USER_COLOR });
}
function sendCollabActiveCue(track, index){
  if (!COLLAB_SESSION_ID || VIEW_ONLY_SESSION || index == null || index < 0) return;
  sendCollabEvent({ type:'active_cue', track, cue_index:index });
}
function sendCollabCaret(track, index, caretOffset=0){
  if (!COLLAB_SESSION_ID || VIEW_ONLY_SESSION || index == null || index < 0) return;
  sendCollabEvent({ type:'caret_update', track, cue_index:index, caret_offset:Number(caretOffset||0) });
}
function sendCollabTxtCursor(){
  if (!COLLAB_SESSION_ID || VIEW_ONLY_SESSION || !txtBoxEl) return;
  const info = (typeof getTxtSelectionInfo === 'function') ? getTxtSelectionInfo() : { index:-1, caret:0, track:'A' };
  const line = Number(info.index ?? getTxtLineIndexAtSelection?.() ?? -1);
  const caret = Math.max(0, Number(info.caret || 0));
  sendCollabEvent({
    type:'txt_cursor_update',
    line_index:line,
    caret_offset:caret,
    track:info.track || 'A',
    selection_start_index:Number(info.selection_start_index ?? line),
    selection_end_index:Number(info.selection_end_index ?? line),
    has_selection:!!info.has_selection,
  });
}
function sendCollabTxtTyping(){
  if (!COLLAB_SESSION_ID || VIEW_ONLY_SESSION || !txtBoxEl) return;
  const info = (typeof getTxtSelectionInfo === 'function') ? getTxtSelectionInfo() : { index:-1, caret:0, track:'A' };
  const line = Number(info.index ?? getTxtLineIndexAtSelection?.() ?? -1);
  sendCollabEvent({
    type:'txt_typing_update',
    line_index:line,
    caret_offset:Math.max(0, Number(info.caret || 0)),
    typing:true,
    track:info.track || 'A',
    selection_start_index:Number(info.selection_start_index ?? line),
    selection_end_index:Number(info.selection_end_index ?? line),
    has_selection:!!info.has_selection,
  });
}
function collabLockKey(track, index){ return `${track || 'A'}:${Number(index || 0)}`; }
function getRemoteCueLock(track, index){
  const key = collabLockKey(track, index);
  const lock = COLLAB_REMOTE_LOCKS ? COLLAB_REMOTE_LOCKS[key] : null;
  if (!lock || lock.user_id === COLLAB_USER_ID) return null;
  return lock;
}
function isCueRemoteLocked(track, index){ return !!getRemoteCueLock(track, index); }
function sendCollabCueLock(track, index){
  if (!COLLAB_SESSION_ID || VIEW_ONLY_SESSION || index == null || index < 0) return;
  sendCollabEvent({ type:'lock_cue', track, cue_index:index });
}
function sendCollabCueUnlock(track, index){
  if (!COLLAB_SESSION_ID || VIEW_ONLY_SESSION || index == null || index < 0) return;
  sendCollabEvent({ type:'unlock_cue', track, cue_index:index });
}
function isMediaPlaying(){
  if (isYouTubePreviewMode()) return __ytPlayerState === 1;
  if (isGoogleDriveIframeMode()) return !!__gdVirtualPlaying;
  return !!(player && !player.paused && !player.ended);
}
function sendCollabPlayheadUpdate({ force=false } = {}){
  if (!COLLAB_SESSION_ID || VIEW_ONLY_SESSION || !COLLAB_WS_CONNECTED || !COLLAB_WS || COLLAB_WS.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (!force && now - COLLAB_PLAYHEAD_LAST_SEND_MS < 900) return;
  COLLAB_PLAYHEAD_LAST_SEND_MS = now;
  sendCollabEvent({ type:'playhead_update', time:getMediaCurrentTime(), playing:isMediaPlaying(), track:activeOverlayTrack || 'A' });
}

function ensureCollabAwarenessStyle(){
  if (document.getElementById('collabAwarenessStyle')) return;
  const st = document.createElement('style');
  st.id = 'collabAwarenessStyle';
  st.textContent = `
    .line{ position:relative; }
    .line.collab-active-cue{ box-shadow: inset 4px 0 0 var(--collab-color, #4f8cff), 0 0 0 1px color-mix(in srgb, var(--collab-color, #4f8cff) 45%, transparent); }
    .line.collab-locked-cue{ opacity:.82; background:color-mix(in srgb, var(--collab-color,#4f8cff) 10%, transparent); box-shadow: inset 4px 0 0 var(--collab-color,#4f8cff), 0 0 0 1px color-mix(in srgb, var(--collab-color,#4f8cff) 40%, transparent); }
    .line.collab-locked-cue .text{ cursor:not-allowed; }
    .collab-cue-badge{ position:absolute; right:8px; top:6px; z-index:3; display:inline-flex; align-items:center; gap:5px; padding:2px 7px; border-radius:999px; font-size:10px; line-height:1.5; color:#fff; background:var(--collab-color,#4f8cff); box-shadow:0 6px 14px rgba(0,0,0,.18); pointer-events:none; }
    .collab-lock-badge{ position:absolute; left:8px; bottom:6px; z-index:3; display:inline-flex; align-items:center; gap:5px; padding:2px 7px; border-radius:999px; font-size:10px; line-height:1.5; color:#fff; background:var(--collab-color,#4f8cff); box-shadow:0 6px 14px rgba(0,0,0,.20); pointer-events:none; }
    .collab-caret-badge{ position:absolute; right:8px; bottom:6px; z-index:3; display:inline-flex; align-items:center; gap:5px; padding:2px 7px; border-radius:999px; font-size:10px; line-height:1.5; border:1px solid var(--collab-color,#4f8cff); background:rgba(0,0,0,.48); color:var(--collab-color,#4f8cff); pointer-events:none; }
    .live-users{ position:relative; }
    .live-users .user-pill{ border:1px solid color-mix(in srgb, var(--user-color,#4f8cff) 60%, transparent); }
    .live-users .user-dot{ width:8px;height:8px;border-radius:50%; background:var(--user-color,#4f8cff); display:inline-block; }
    #collabProfilePopover{ position:absolute; top:calc(100% + 8px); right:0; z-index:10000; width:260px; padding:12px; border:1px solid var(--line,rgba(255,255,255,.14)); border-radius:16px; background:#10151d; box-shadow:0 16px 45px rgba(0,0,0,.35); display:none; }
    #collabProfilePopover.is-open{ display:block; }
    .collab-profile-row{ display:flex; flex-direction:column; gap:6px; margin-bottom:10px; }
    .collab-swatch-grid{ display:grid; grid-template-columns:repeat(6, 1fr); gap:6px; }
    .collab-swatch{ width:28px; height:28px; border-radius:999px; border:2px solid rgba(255,255,255,.18); cursor:pointer; padding:0; background:var(--swatch); }
    .collab-swatch.is-selected{ border-color:#fff; box-shadow:0 0 0 3px color-mix(in srgb, var(--swatch) 36%, transparent); }
    #txtBigBoxWrap{ position:relative; width:100%; }
    #txtBigBoxWrap #txtBigBox{ padding-right:108px !important; box-sizing:border-box; }
    #txtCollabOverlay{ position:absolute; inset:0; pointer-events:none; padding:12px; box-sizing:border-box; font-size:14px; line-height:1.5; white-space:pre; overflow:hidden; }
    .txt-user-marker{ position:absolute; right:10px; left:auto; height:1.45em; max-width:96px; display:inline-flex; align-items:center; gap:5px; border-right:4px solid var(--collab-color,#4f8cff); border-left:0; border-radius:999px; padding:1px 8px; font-size:10px; color:#fff; background:color-mix(in srgb, var(--collab-color,#4f8cff) 72%, rgba(0,0,0,.52)); box-shadow:0 4px 14px rgba(0,0,0,.22); transform:translateY(2px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .collab-comment-button{ position:absolute; right:8px; top:28px; z-index:3; min-width:24px; height:22px; border-radius:999px; border:1px solid rgba(255,255,255,.20); background:rgba(0,0,0,.28); color:#e9edf1; font-size:11px; display:inline-flex; align-items:center; justify-content:center; gap:3px; cursor:pointer; }
    .collab-comment-button.has-comments{ background:color-mix(in srgb, var(--collab-color,#4f8cff) 60%, rgba(0,0,0,.45)); color:#fff; }
    #collabCueCommentsPopover{ position:fixed; z-index:20000; width:320px; max-height:76vh; display:none; flex-direction:column; gap:8px; padding:12px; border:1px solid rgba(255,255,255,.14); border-radius:16px; background:#10151d; box-shadow:0 18px 50px rgba(0,0,0,.38); color:#e9edf1; }
    #collabCueCommentsPopover.is-open{ display:flex; }
    .cue-comments-head{ display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .cue-comments-list{ display:flex; flex-direction:column; gap:8px; max-height:260px; overflow:auto; }
    .cue-comment-item{ border-left:4px solid var(--comment-color,#4f8cff); background:rgba(255,255,255,.045); border-radius:10px; padding:8px; }
    .cue-comment-meta{ display:flex; align-items:center; gap:7px; font-size:13px; opacity:.95; }
    .comment-dot{ width:8px; height:8px; border-radius:50%; background:var(--comment-color,#4f8cff); display:inline-block; }
    .comment-del{ margin-left:auto; border:0; background:transparent; color:#e9edf1; cursor:pointer; opacity:.7; }
    .cue-comment-text{ margin-top:7px; font-size:15px; line-height:1.55; white-space:pre-wrap; }
    .cue-comments-empty{ font-size:14px; opacity:.7; padding:10px; text-align:center; }
    #cueCommentsInput{ min-height:70px; resize:vertical; }
    .txt-user-marker.is-typing::after{ content:'typing…'; opacity:.8; margin-left:3px; }
    .collab-version-btn{ margin-left:8px; }
    #collabVersionModal .version-list{ display:flex; flex-direction:column; gap:8px; max-height:360px; overflow:auto; }
    #collabVersionModal .version-item{ display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px; border:1px solid rgba(255,255,255,.10); border-radius:12px; background:rgba(255,255,255,.04); }
    #collabVersionModal .version-meta{ display:flex; flex-direction:column; gap:2px; font-size:12px; }

    .txt-user-marker::before{ content:''; width:6px; height:6px; border-radius:50%; flex:0 0 auto; background:#fff; opacity:.85; }
  `;
  document.head.appendChild(st);
}
function applyCollabCueAwareness(){
  ensureCollabAwarenessStyle();
  const applyTo = (track, root) => {
    if (!root) return;
    root.querySelectorAll('.collab-cue-badge,.collab-caret-badge,.collab-lock-badge').forEach(x => x.remove());
    root.querySelectorAll('.line.collab-active-cue,.line.collab-locked-cue').forEach(x => { x.classList.remove('collab-active-cue','collab-locked-cue'); x.style.removeProperty('--collab-color'); });
    root.querySelectorAll('.line .text').forEach((textEl) => {
      const row = textEl.closest('.line');
      const idx = Number(row?.dataset?.index || -1);
      const remoteLock = idx >= 0 ? getRemoteCueLock(track, idx) : null;
      if (remoteLock){
        try{ textEl.contentEditable = 'false'; }catch(_e){}
        textEl.title = `${collabUserName(remoteLock.user_id)} is editing this cue`;
      } else if (!VIEW_ONLY_SESSION && !isTrackLocked(track)){
        try{ textEl.contentEditable = 'true'; }catch(_e){}
        textEl.title = '';
      }
    });
    const lockEntries = Object.entries(COLLAB_REMOTE_LOCKS || {}).filter(([key,v]) => v && v.track === track && v.user_id !== COLLAB_USER_ID);
    for (const [_key, v] of lockEntries){
      const row = root.querySelector(`[data-index="${Number(v.cue_index)}"]`);
      if (!row) continue;
      const color = collabUserColor(v.user_id);
      row.classList.add('collab-locked-cue');
      row.style.setProperty('--collab-color', color);
      const badge = document.createElement('span');
      badge.className = 'collab-lock-badge';
      badge.style.setProperty('--collab-color', color);
      badge.textContent = `Locked · ${collabUserName(v.user_id)}`;
      row.appendChild(badge);
    }
    const cueEntries = Object.entries(COLLAB_REMOTE_CUES || {}).filter(([uid,v]) => v && v.track === track && uid !== COLLAB_USER_ID);
    for (const [uid, v] of cueEntries){
      const row = root.querySelector(`[data-index="${Number(v.cue_index)}"]`);
      if (!row) continue;
      const color = collabUserColor(uid);
      row.classList.add('collab-active-cue');
      row.style.setProperty('--collab-color', color);
      const badge = document.createElement('span');
      badge.className = 'collab-cue-badge';
      badge.style.setProperty('--collab-color', color);
      badge.textContent = collabUserName(uid);
      row.appendChild(badge);
    }
    const caretEntries = Object.entries(COLLAB_REMOTE_CARETS || {}).filter(([uid,v]) => v && v.track === track && uid !== COLLAB_USER_ID);
    for (const [uid, v] of caretEntries){
      const row = root.querySelector(`[data-index="${Number(v.cue_index)}"]`);
      if (!row) continue;
      const color = collabUserColor(uid);
      const badge = document.createElement('span');
      badge.className = 'collab-caret-badge';
      badge.style.setProperty('--collab-color', color);
      badge.textContent = `${collabUserName(uid)} editing`;
      row.appendChild(badge);
    }

    // Cue comments: small bubble button on each cue card.
    Array.from(root.children || []).forEach(row => {
      if (!row || !row.dataset) return;
      const idx = Number(row.dataset.index || 0);
      const comments = getCueComments(track, idx);
      let btn = row.querySelector('.collab-comment-button');
      if (!btn){
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'collab-comment-button';
        btn.title = 'Cue comments';
        btn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          openCueComments(track, idx, btn);
        });
        row.appendChild(btn);
      }
      btn.classList.toggle('has-comments', comments.length > 0);
      btn.style.setProperty('--collab-color', comments[0]?.user_color || COLLAB_USER_COLOR || '#4f8cff');
      btn.textContent = comments.length ? `💬 ${comments.length}` : '💬';
    });
  };
  applyTo('A', transcriptEl);
  applyTo('B', (subsMode === 'B') ? transcriptEl : document.getElementById('transcriptB'));
}
function applyTxtCollabAwareness(){
  if (!isTxtMode) return;
  const boxes = (typeof getTxtVisibleBoxes === 'function') ? getTxtVisibleBoxes() : (txtBoxEl ? [txtBoxEl] : []);
  if (!boxes.length) return;
  ensureCollabAwarenessStyle();

  for (const box of boxes){
    try{
      box.querySelectorAll('.txt-user-marker').forEach(el => el.remove());
      box.querySelectorAll('.txt-remote-active,.txt-remote-selected').forEach(row => {
        row.classList.remove('txt-remote-active','txt-remote-selected');
        row.style.removeProperty('--collab-color');
      });
    }catch(_e){}
  }

  for (const [uid, v] of Object.entries(COLLAB_REMOTE_TXT || {})){
    if (uid === COLLAB_USER_ID || !v) continue;
    const line = Number(v.line_index || 0);
    const track = (v.track === 'B') ? 'B' : 'A';
    const box = (typeof getTxtBoxForTrack === 'function') ? getTxtBoxForTrack(track) : txtBoxEl;
    if (!box) continue;
    const color = collabUserColor(uid);
    const start = Math.max(0, Math.min(Number(v.selection_start_index ?? line), Number(v.selection_end_index ?? line)));
    const end = Math.max(start, Math.max(Number(v.selection_start_index ?? line), Number(v.selection_end_index ?? line)));
    const hasSelection = !!v.has_selection && end >= start;
    if (hasSelection){
      for (let i=start; i<=end; i++){
        const selRow = box.querySelector?.(`.txt-cue[data-index="${i}"][data-track="${track}"]`) || box.querySelector?.(`.txt-cue[data-index="${i}"]`);
        if (!selRow) continue;
        selRow.classList.add('txt-remote-selected');
        selRow.style.setProperty('--collab-color', color);
      }
    }
    const row = box?.querySelector?.(`.txt-cue[data-index="${line}"][data-track="${track}"]`) || box?.querySelector?.(`.txt-cue[data-index="${line}"]`);
    if (!row) continue;
    row.classList.add('txt-remote-active');
    row.style.setProperty('--collab-color', color);
    const mark = document.createElement('div');
    mark.className = 'txt-user-marker';
    const typing = COLLAB_TXT_TYPING?.[uid] && (Date.now() - Number(COLLAB_TXT_TYPING[uid].ts || 0) < 1800);
    if (typing) mark.classList.add('is-typing');
    if (hasSelection) mark.classList.add('has-selection');
    mark.style.setProperty('--collab-color', color);
    mark.textContent = hasSelection ? `${collabUserName(uid)} selected` : collabUserName(uid);
    row.appendChild(mark);
  }
}
const COLLAB_COLOR_SWATCHES = ['#4f8cff','#37c978','#b178ff','#ff9f43','#ff5f7e','#28c7d9','#ffd166','#8bd450','#ff7ad9','#a3a7ff','#9ca3af','#f87171'];

function ensureLiveUsersDisplay(){
  if (document.getElementById('liveUsersDisplay')) return;
  ensureCollabAwarenessStyle();
  const st = document.createElement('style');
  st.id = 'liveUsersDisplayStyle';
  st.textContent = `
    .live-users{display:none;align-items:center;gap:6px;padding:6px 9px;border:1px solid var(--line, rgba(255,255,255,.14));border-radius:999px;background:rgba(255,255,255,.06);font-size:12px;color:var(--ink,#e9edf1);cursor:pointer;user-select:none}
    .live-users.is-on{display:inline-flex}
    .live-users .dot{width:7px;height:7px;border-radius:50%;background:#5ee38a;box-shadow:0 0 0 3px rgba(94,227,138,.12)}
    .live-users .user-pill{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:999px;background:rgba(255,255,255,.08)}
    .collab-follow-pill{display:none;align-items:center;gap:6px;margin-left:6px;padding:5px 8px;border-radius:999px;border:1px solid var(--line,rgba(255,255,255,.14));background:rgba(255,255,255,.04);font-size:12px;color:var(--ink,#e9edf1)}
    .collab-follow-pill.is-on{display:inline-flex}
    .collab-follow-pill select{height:24px;max-width:150px;background:rgba(0,0,0,.24);color:inherit;border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:0 6px;font-size:12px}
  `;
  document.head.appendChild(st);
  const el = document.createElement('div');
  el.id = 'liveUsersDisplay';
  el.className = 'live-users';
  el.innerHTML = `<span class="dot" aria-hidden="true"></span><span id="liveUsersText">Live</span>`;
  const follow = document.createElement('label');
  follow.id = 'collabFollowPill';
  follow.className = 'collab-follow-pill';
  follow.innerHTML = `<span>Follow</span><select id="collabFollowSelect"><option value="">Off</option></select>`;
  const toolbar = document.querySelector('header .toolbar') || document.querySelector('.toolbar') || document.querySelector('header') || document.body;
  toolbar.insertBefore(follow, toolbar.firstChild);
  toolbar.insertBefore(el, follow);
  follow.querySelector('#collabFollowSelect')?.addEventListener('change', (ev) => {
    COLLAB_FOLLOW_USER_ID = ev.currentTarget.value || '';
    try{ localStorage.setItem('transcriber_collab_follow_user', COLLAB_FOLLOW_USER_ID); }catch(_e){}
    setStatusSafe(COLLAB_FOLLOW_USER_ID ? `Following ${collabUserName(COLLAB_FOLLOW_USER_ID)}` : 'Follow presenter off');
  });
  el.addEventListener('click', (ev) => { ev.stopPropagation(); toggleCollabProfilePopover(); });
  document.addEventListener('click', (ev) => {
    const pop = document.getElementById('collabProfilePopover');
    if (!pop) return;
    if (el.contains(ev.target) || pop.contains(ev.target)) return;
    pop.classList.remove('is-open');
  });
}

function ensureCollabProfilePopover(){
  ensureLiveUsersDisplay();
  let pop = document.getElementById('collabProfilePopover');
  if (pop) return pop;
  pop = document.createElement('div');
  pop.id = 'collabProfilePopover';
  pop.innerHTML = `
    <div class="collab-profile-row">
      <label class="muted" style="font-size:12px">Display name</label>
      <input id="collabNameInput" class="ui-dark-input" type="text" maxlength="32" placeholder="User name">
    </div>
    <div class="collab-profile-row">
      <label class="muted" style="font-size:12px">Color</label>
      <div id="collabColorGrid" class="collab-swatch-grid"></div>
    </div>
    <button id="collabProfileApply" class="btn btn-gold" type="button" style="width:100%">Apply</button>`;
  document.getElementById('liveUsersDisplay').appendChild(pop);
  pop.addEventListener('click', (ev) => ev.stopPropagation());
  const grid = pop.querySelector('#collabColorGrid');
  COLLAB_COLOR_SWATCHES.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'collab-swatch'; b.style.setProperty('--swatch', c); b.dataset.color = c;
    b.addEventListener('click', () => {
      COLLAB_USER_COLOR = c;
      grid.querySelectorAll('.collab-swatch').forEach(x => x.classList.toggle('is-selected', x.dataset.color === c));
    });
    grid.appendChild(b);
  });
  pop.querySelector('#collabProfileApply').addEventListener('click', () => {
    const label = pop.querySelector('#collabNameInput')?.value || COLLAB_USER_LABEL || 'User';
    sendCollabProfileUpdate(label, COLLAB_USER_COLOR);
    pop.classList.remove('is-open');
  });
  return pop;
}

function toggleCollabProfilePopover(){
  if (!COLLAB_SESSION_ID) return;
  const pop = ensureCollabProfilePopover();
  const input = pop.querySelector('#collabNameInput');
  if (input) input.value = COLLAB_USER_LABEL || 'User';
  pop.querySelectorAll('.collab-swatch').forEach(x => x.classList.toggle('is-selected', String(x.dataset.color).toLowerCase() === String(COLLAB_USER_COLOR || '').toLowerCase()));
  pop.classList.toggle('is-open');
}


function ensureCollabVersionButton(){
  ensureCollabAwarenessStyle();
  const box = document.getElementById('liveUsersDisplay');
  if (!box || document.getElementById('collabVersionBtn')) return;
  const b = document.createElement('button');
  b.id = 'collabVersionBtn';
  b.className = 'btn btn-outline btn-mini collab-version-btn';
  b.type = 'button';
  b.textContent = 'History';
  b.addEventListener('click', () => openCollabVersionHistory().catch(err => alert('Version history failed: ' + (err?.message || err))));
  box.appendChild(b);
}
function ensureCollabVersionModal(){
  if (document.getElementById('collabVersionModal')) return;
  const wrap = document.createElement('div');
  wrap.id = 'collabVersionModal';
  wrap.className = 'modal-overlay hidden';
  wrap.innerHTML = `
    <div class="modal-card" style="max-width:620px" role="dialog" aria-modal="true">
      <div class="modal-head"><div><div class="modal-title">Version History</div><div class="modal-sub">Restore a previous collaborative snapshot.</div></div><button class="btn btn-outline btn-mini" id="collabVersionClose" type="button">×</button></div>
      <div class="modal-body"><div id="collabVersionList" class="version-list"></div></div>
      <div class="modal-foot"><button class="btn btn-outline" id="collabVersionClear" type="button">Clear History</button><div style="flex:1"></div><button class="btn btn-outline" id="collabVersionDone" type="button">Close</button></div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('#collabVersionClose')?.addEventListener('click', () => wrap.classList.add('hidden'));
  wrap.querySelector('#collabVersionDone')?.addEventListener('click', () => wrap.classList.add('hidden'));
  wrap.querySelector('#collabVersionClear')?.addEventListener('click', async () => {
    if (!COLLAB_SESSION_ID) return;
    if (!confirm('Clear all saved version history for this collaborative session? This will not change the current transcript.')) return;
    const rr = await fetch(`${API_BASE}/api/collab_session/${encodeURIComponent(COLLAB_SESSION_ID)}/versions/clear`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ user_id:COLLAB_USER_ID }) });
    const data = await rr.json().catch(()=>({}));
    if (!rr.ok || !data?.ok) throw new Error(data?.message || data?.error || `HTTP ${rr.status}`);
    await openCollabVersionHistory();
  });
  wrap.addEventListener('click', ev => { if (ev.target === wrap) wrap.classList.add('hidden'); });
}
async function openCollabVersionHistory(){
  if (!COLLAB_SESSION_ID){ alert('Version history is available in collaborative sessions.'); return; }
  ensureCollabVersionModal();
  const wrap = document.getElementById('collabVersionModal');
  const list = document.getElementById('collabVersionList');
  list.innerHTML = '<div class="muted">Loading…</div>';
  wrap.classList.remove('hidden');
  const res = await fetch(`${API_BASE}/api/collab_session/${encodeURIComponent(COLLAB_SESSION_ID)}/versions`);
  const data = await res.json().catch(()=>({}));
  if (!res.ok || !data?.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  const items = data.versions || [];
  if (!items.length){ list.innerHTML = '<div class="muted">No saved versions yet.</div>'; return; }
  list.innerHTML = items.map(v => `<div class="version-item"><div class="version-meta"><strong>Revision ${escapeHtml(String(v.revision || ''))}</strong><span>${escapeHtml(v.updated_at_label || '')}</span><span class="muted">${escapeHtml(v.updated_by_label || 'Unknown user')}</span></div><button class="btn btn-gold btn-mini" data-snapshot="${escapeHtml(v.snapshot_id)}">Restore</button></div>`).join('');
  list.querySelectorAll('[data-snapshot]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Restore this version for everyone in the collaborative session?')) return;
    const rr = await fetch(`${API_BASE}/api/collab_session/${encodeURIComponent(COLLAB_SESSION_ID)}/restore`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ user_id:COLLAB_USER_ID, snapshot_id:btn.dataset.snapshot }) });
    const restored = await rr.json().catch(()=>({}));
    if (!rr.ok || !restored?.ok) throw new Error(restored?.message || restored?.error || `HTTP ${rr.status}`);
    wrap.classList.add('hidden');
    if (restored.state){ COLLAB_APPLYING = true; try{ applySharedSessionState(restored.state, { preserveMedia:true, remoteUpdate:true }); try{ refreshOpenCueComments(); }catch(_e){} } finally{ COLLAB_APPLYING = false; } }
    COLLAB_REVISION = Number(restored.revision || COLLAB_REVISION);
    COLLAB_LAST_HASH = hashSessionState(buildShareSessionState());
    setStatusSafe('Version restored.');
  }));
}

function updateLiveUsersDisplay(users){
  ensureLiveUsersDisplay();
  const box = document.getElementById('liveUsersDisplay');
  const txt = document.getElementById('liveUsersText');
  if (!box || !txt) return;
  const list = Array.isArray(users) ? users : [];
  if (list.length) COLLAB_USERS = list;
  if (!COLLAB_SESSION_ID){ box.classList.remove('is-on'); return; }
  box.classList.add('is-on');
  ensureCollabVersionButton();
  const shown = (COLLAB_USERS.length ? COLLAB_USERS : [{user_id:COLLAB_USER_ID,label:COLLAB_USER_LABEL||'User',color:COLLAB_USER_COLOR}]).slice(0, 8);
  txt.innerHTML = shown.map(u => `<span class="user-pill" style="--user-color:${escapeHtml(u.color || '#4f8cff')}"><span class="user-dot"></span>${escapeHtml(u.label || 'User')}</span>`).join(' ');
  updateCollabFollowControl(shown);
  applyCollabCueAwareness();
  applyTxtCollabAwareness();
}

function updateCollabFollowControl(users){
  const pill = document.getElementById('collabFollowPill');
  const sel = document.getElementById('collabFollowSelect');
  if (!pill || !sel) return;
  if (!COLLAB_SESSION_ID){ pill.classList.remove('is-on'); return; }
  pill.classList.add('is-on');
  const old = COLLAB_FOLLOW_USER_ID || '';
  const opts = ['<option value="">Off</option>'];
  (users || []).forEach(u => {
    if (!u || u.user_id === COLLAB_USER_ID) return;
    opts.push(`<option value="${escapeHtml(u.user_id)}">${escapeHtml(u.label || 'User')}</option>`);
  });
  sel.innerHTML = opts.join('');
  if ([...sel.options].some(o => o.value === old)) sel.value = old;
  else { COLLAB_FOLLOW_USER_ID = ''; sel.value = ''; }
}

function setCollabSyncStatus(kind){
  const box = document.getElementById('liveUsersDisplay');
  if (!box) return;
  box.dataset.sync = kind || 'live';
  box.title = kind === 'saved' ? 'Collaborative session saved' :
              kind === 'updated' ? 'Collaborative session updated from another user' :
              'Collaborative session live';
}

function addCollaborativeBanner(sessionId){
  if (document.getElementById('collabSharedBanner')) return;
  const anchor = document.querySelector('.video-panel .status') || document.getElementById('status') || document.body;
  const div = document.createElement('div');
  div.id = 'collabSharedBanner';
  div.className = 'view-only-banner';
  div.textContent = `Collaborative session${sessionId ? ' · ' + sessionId.slice(0, 8) : ''}. WebSocket live sync is on.`;
  if (anchor && anchor.parentElement) anchor.insertAdjacentElement('afterend', div);
  else document.body.insertBefore(div, document.body.firstChild);
}

async function shareCollaborativeSession(){
  if (VIEW_ONLY_SESSION){ alert('This is already a view-only shared session.'); return; }
  if (!entries?.length && !entriesB?.length){ alert('Nothing to share yet. Import/transcribe captions first.'); return; }
  const state = buildShareSessionState();
  const res = await fetch(`${API_BASE}/api/collab_session`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ title: state.base_name || 'Collaborative Session', state })
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok || !data?.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  const link = `${window.location.origin}${data.path || ('/?collab=' + data.session_id)}`;
  try{ await navigator.clipboard.writeText(link); }catch(_e){}
  setStatusSafe('Collaborative link created and copied.');
  prompt('Collaborative link:', link);
  await joinCollaborativeSession(data.session_id, { applyState:false });
}

async function joinCollaborativeSession(sessionId, { applyState=true } = {}){
  if (!sessionId) return;
  COLLAB_SESSION_ID = sessionId;
  const res = await fetch(`${API_BASE}/api/collab_session/${encodeURIComponent(sessionId)}/join`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ user_id: COLLAB_USER_ID || '' })
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok || !data?.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  COLLAB_USER_ID = data.user_id;
  COLLAB_USER_LABEL = data.user_label || 'User';
  COLLAB_USER_COLOR = data.user_color || COLLAB_USER_COLOR || '#4f8cff';
  try{ if (!localStorage.getItem('transcriber_collab_label')) localStorage.setItem('transcriber_collab_label', COLLAB_USER_LABEL); if (!localStorage.getItem('transcriber_collab_color')) localStorage.setItem('transcriber_collab_color', COLLAB_USER_COLOR); }catch(_e){}
  COLLAB_REVISION = Number(data.revision || 0);
  try{ localStorage.setItem('transcriber_collab_user_id', COLLAB_USER_ID); }catch(_e){}
  if (applyState && data.state){
    COLLAB_APPLYING = true;
    try{ applySharedSessionState(data.state); }
    finally{ COLLAB_APPLYING = false; }
  }
  VIEW_ONLY_SESSION = false;
  EDITOR_SHARED_SESSION = false;
  document.body.classList.remove('view-only-session');
  addCollaborativeBanner(sessionId);
  updateLiveUsersDisplay(data.users || []);
  const state = buildShareSessionState();
  COLLAB_LAST_HASH = hashSessionState(state);
  startCollabSync();
}


function collabWebSocketUrl(sessionId){
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const uid = encodeURIComponent(COLLAB_USER_ID || '');
  const label = encodeURIComponent(COLLAB_USER_LABEL || localStorage.getItem('transcriber_collab_label') || '');
  const color = encodeURIComponent(COLLAB_USER_COLOR || localStorage.getItem('transcriber_collab_color') || '');
  return `${proto}://${window.location.host}/ws/collab/${encodeURIComponent(sessionId)}?user_id=${uid}&label=${label}&color=${color}`;
}

function stopCollabWebSocket(){
  if (COLLAB_WS_TIMER){ clearInterval(COLLAB_WS_TIMER); COLLAB_WS_TIMER = null; }
  if (COLLAB_WS_RECONNECT_TIMER){ clearTimeout(COLLAB_WS_RECONNECT_TIMER); COLLAB_WS_RECONNECT_TIMER = null; }
  if (COLLAB_WS){
    try{ COLLAB_WS.onclose = null; COLLAB_WS.close(); }catch(_e){}
  }
  COLLAB_WS = null;
  COLLAB_WS_CONNECTED = false;
}

function startCollabWebSocket(){
  if (!COLLAB_SESSION_ID || VIEW_ONLY_SESSION) return;
  if (COLLAB_WS && (COLLAB_WS.readyState === WebSocket.OPEN || COLLAB_WS.readyState === WebSocket.CONNECTING)) return;
  try{
    COLLAB_WS = new WebSocket(collabWebSocketUrl(COLLAB_SESSION_ID));
  }catch(err){
    console.warn('Collab WebSocket create failed:', err);
    return;
  }

  COLLAB_WS.onopen = () => {
    COLLAB_WS_CONNECTED = true;
    COLLAB_WS_RECONNECT_ATTEMPTS = 0;
    setCollabSyncStatus('live');
    if (COLLAB_WS_TIMER) clearInterval(COLLAB_WS_TIMER);
    // Push changed session state quickly, but not on every keystroke.
    COLLAB_WS_TIMER = setInterval(() => {
      try{ maybeSendCollabStateOverWebSocket(); }catch(err){ console.warn('Collab WebSocket send check failed:', err); }
    }, 700);
  };

  COLLAB_WS.onmessage = (ev) => {
    try{
      const msg = JSON.parse(ev.data || '{}');
      handleCollabWebSocketMessage(msg);
    }catch(err){
      console.warn('Collab WebSocket message failed:', err);
    }
  };

  COLLAB_WS.onerror = (ev) => {
    console.warn('Collab WebSocket error:', ev);
  };

  COLLAB_WS.onclose = () => {
    COLLAB_WS_CONNECTED = false;
    if (COLLAB_WS_TIMER){ clearInterval(COLLAB_WS_TIMER); COLLAB_WS_TIMER = null; }
    // Keep polling as fallback, and attempt reconnect for live collaboration.
    if (COLLAB_SESSION_ID && !VIEW_ONLY_SESSION){
      const delay = Math.min(8000, 1000 * Math.pow(1.4, COLLAB_WS_RECONNECT_ATTEMPTS++));
      COLLAB_WS_RECONNECT_TIMER = setTimeout(() => startCollabWebSocket(), delay);
    }
  };
}

function handleCollabWebSocketMessage(msg){
  const type = String(msg?.type || '');
  if (type === 'error'){
    console.warn('Collab WebSocket error message:', msg.message || msg);
    return;
  }
  if (Array.isArray(msg.users)) updateLiveUsersDisplay(msg.users);

  if (type === 'hello'){
    if (msg.user_id) COLLAB_USER_ID = msg.user_id;
    if (msg.user_label) COLLAB_USER_LABEL = msg.user_label;
    if (msg.user_color) COLLAB_USER_COLOR = msg.user_color;
    try{ if (COLLAB_USER_ID) localStorage.setItem('transcriber_collab_user_id', COLLAB_USER_ID); if (COLLAB_USER_LABEL) localStorage.setItem('transcriber_collab_label', COLLAB_USER_LABEL); if (COLLAB_USER_COLOR) localStorage.setItem('transcriber_collab_color', COLLAB_USER_COLOR); }catch(_e){}
    const serverRev = Number(msg.revision || 0);
    if (msg.state && serverRev >= COLLAB_REVISION){
      COLLAB_APPLYING = true;
      try{ applySharedSessionState(msg.state); }
      finally{ COLLAB_APPLYING = false; }
      COLLAB_REVISION = serverRev;
      COLLAB_LAST_HASH = hashSessionState(buildShareSessionState());
    }
    try{ applyTimelineLocksFromList(msg.locks || []); }catch(_e){}
    try{ applyStoryLocksFromList(msg.locks || []); }catch(_e){}
    setCollabSyncStatus('live');
    return;
  }

  if (type === 'presence'){
    if (Array.isArray(msg.users)) updateLiveUsersDisplay(msg.users);
    setCollabSyncStatus('live');
    return;
  }

  if (type === 'profile_update'){
    if (msg.user_id === COLLAB_USER_ID){
      if (msg.user_label) COLLAB_USER_LABEL = msg.user_label;
      if (msg.user_color) COLLAB_USER_COLOR = msg.user_color;
    }
    if (Array.isArray(msg.users)) updateLiveUsersDisplay(msg.users);
    setCollabSyncStatus('live');
    return;
  }

  if (type === 'active_cue'){
    if (msg.user_id && msg.user_id !== COLLAB_USER_ID){
      COLLAB_REMOTE_CUES[msg.user_id] = { track: msg.track || 'A', cue_index: Number(msg.cue_index || 0) };
      applyCollabCueAwareness();
    }
    return;
  }

  if (type === 'caret_update'){
    if (msg.user_id && msg.user_id !== COLLAB_USER_ID){
      COLLAB_REMOTE_CARETS[msg.user_id] = { track: msg.track || 'A', cue_index: Number(msg.cue_index || 0), caret_offset: Number(msg.caret_offset || 0) };
      applyCollabCueAwareness();
    }
    return;
  }

  if (type === 'txt_cursor_update'){
    if (msg.user_id && msg.user_id !== COLLAB_USER_ID){
      COLLAB_REMOTE_TXT[msg.user_id] = { line_index: Number(msg.line_index || 0), caret_offset: Number(msg.caret_offset || 0), track: msg.track || 'A', selection_start_index:Number(msg.selection_start_index ?? msg.line_index ?? 0), selection_end_index:Number(msg.selection_end_index ?? msg.line_index ?? 0), has_selection:!!msg.has_selection };
      applyTxtCollabAwareness();
    }
    return;
  }

  if (type === 'story_cursor_update'){
    if (msg.user_id && msg.user_id !== COLLAB_USER_ID){
      COLLAB_REMOTE_STORY[msg.user_id] = { row_id:String(msg.row_id || ''), card_id:String(msg.card_id || ''), cue_id:String(msg.cue_id || ''), mode:String(msg.mode || 'card'), ts:Date.now() };
      scheduleApplyStoryCollabAwareness();
    }
    return;
  }

  if (type === 'txt_typing_update'){
    if (msg.user_id && msg.user_id !== COLLAB_USER_ID){
      COLLAB_TXT_TYPING[msg.user_id] = { line_index:Number(msg.line_index || 0), track: msg.track || 'A', ts:Date.now() };
      COLLAB_REMOTE_TXT[msg.user_id] = { line_index:Number(msg.line_index || 0), caret_offset:Number(msg.caret_offset || 0), track: msg.track || 'A', selection_start_index:Number(msg.selection_start_index ?? msg.line_index ?? 0), selection_end_index:Number(msg.selection_end_index ?? msg.line_index ?? 0), has_selection:!!msg.has_selection };
      applyTxtCollabAwareness();
    }
    return;
  }

  if (type === 'lock_cue'){
    if (msg.user_id && msg.user_id !== COLLAB_USER_ID){
      const key = collabLockKey(msg.track || 'A', Number(msg.cue_index || 0));
      COLLAB_REMOTE_LOCKS[key] = { user_id: msg.user_id, track: msg.track || 'A', cue_index: Number(msg.cue_index || 0) };
      applyCollabCueAwareness();
    }
    return;
  }
  if (type === 'unlock_cue'){
    const key = collabLockKey(msg.track || 'A', Number(msg.cue_index || 0));
    delete COLLAB_REMOTE_LOCKS[key];
    applyCollabCueAwareness();
    return;
  }
  if (type === 'locks'){
    COLLAB_REMOTE_LOCKS = {};
    (msg.locks || []).forEach(l => {
      if (!l || l.user_id === COLLAB_USER_ID) return;
      if (l.kind === 'timeline_clip' || l.clip_id || l.kind === 'story_card' || l.card_id) return;
      COLLAB_REMOTE_LOCKS[collabLockKey(l.track || 'A', Number(l.cue_index || 0))] = l;
    });
    applyCollabCueAwareness();
    applyTimelineLocksFromList(msg.locks || []);
    applyStoryLocksFromList(msg.locks || []);
    return;
  }


  if (type === 'story_locks'){
    applyStoryLocksFromList(msg.locks || []);
    return;
  }

  if (type === 'lock_story_card'){
    if (msg.user_id && msg.user_id !== COLLAB_USER_ID && msg.card_id){
      COLLAB_STORY_LOCKS[String(msg.card_id)] = {
        kind:'story_card', card_id:String(msg.card_id), row_id:String(msg.row_id || ''), action:String(msg.action || 'edit'),
        user_id:msg.user_id, user_label:msg.user_label || collabUserName(msg.user_id), user_color:msg.user_color || collabUserColor(msg.user_id), updated_at:Date.now() / 1000,
      };
      if (isStoryMode) applyStoryCollabAwareness();
    }
    return;
  }
  if (type === 'unlock_story_card'){
    if (msg.card_id) delete COLLAB_STORY_LOCKS[String(msg.card_id)];
    if (isStoryMode) applyStoryCollabAwareness();
    return;
  }

  if (type === 'timeline_presence'){
    if (msg.user_id && msg.user_id !== COLLAB_USER_ID){
      COLLAB_TIMELINE_PRESENCE[msg.user_id] = {
        time:Number(msg.time || 0),
        action:String(msg.action || 'viewing'),
        clip_id:String(msg.clip_id || ''),
        label:msg.user_label || collabUserName(msg.user_id),
        color:msg.user_color || collabUserColor(msg.user_id),
        ts:Date.now(),
      };
      if (isTimelineMode) requestTimelineRender();
    }
    return;
  }

  if (type === 'timeline_range_preview'){
    if (msg.user_id && msg.user_id !== COLLAB_USER_ID){
      if (msg.active === false){
        delete COLLAB_TIMELINE_RANGES[msg.user_id];
      } else {
        COLLAB_TIMELINE_RANGES[msg.user_id] = {
          start:Number(msg.start || 0), end:Number(msg.end || 0), active:true,
          status:String(msg.status || (msg.persisted ? 'selected' : 'selecting')),
          persisted:!!msg.persisted,
          label:msg.user_label || collabUserName(msg.user_id),
          color:msg.user_color || collabUserColor(msg.user_id),
          ts:Date.now(),
        };
      }
      if (isTimelineMode) requestTimelineRender();
    }
    return;
  }

  if (type === 'lock_timeline_clip'){
    if (msg.user_id && msg.user_id !== COLLAB_USER_ID && msg.clip_id){
      COLLAB_TIMELINE_LOCKS[String(msg.clip_id)] = {
        kind:'timeline_clip', clip_id:String(msg.clip_id), action:String(msg.action || 'edit'),
        user_id:msg.user_id, user_label:msg.user_label || collabUserName(msg.user_id), user_color:msg.user_color || collabUserColor(msg.user_id), updated_at:Date.now(),
      };
      if (isTimelineMode) requestTimelineRender();
    }
    return;
  }
  if (type === 'unlock_timeline_clip'){
    if (msg.clip_id) delete COLLAB_TIMELINE_LOCKS[String(msg.clip_id)];
    if (isTimelineMode) requestTimelineRender();
    return;
  }
  if (type === 'timeline_locks'){
    applyTimelineLocksFromList(msg.locks || []);
    return;
  }

  if (type === 'playhead_update'){
    if (msg.user_id && msg.user_id !== COLLAB_USER_ID && COLLAB_FOLLOW_USER_ID && msg.user_id === COLLAB_FOLLOW_USER_ID){
      const now = Date.now();
      if (now - COLLAB_LAST_REMOTE_PLAYHEAD_MS > 450){
        COLLAB_LAST_REMOTE_PLAYHEAD_MS = now;
        activeOverlayTrack = msg.track === 'B' ? 'B' : 'A';
        seekMediaTo(Number(msg.time || 0), { play: !!msg.playing });
      }
    }
    return;
  }

  if (type === 'state_update'){
    const serverRev = Number(msg.revision || 0);
    const updatedBy = msg.updated_by || msg.user_id || '';

    if (updatedBy === COLLAB_USER_ID){
      COLLAB_REVISION = Math.max(COLLAB_REVISION, serverRev);
      COLLAB_LAST_HASH = hashSessionState(buildShareSessionState());
      setCollabSyncStatus('saved');
      return;
    }

    if (msg.state && serverRev >= COLLAB_REVISION){
      COLLAB_APPLYING = true;
      try{
        applySharedSessionState(msg.state, { preserveMedia: true, remoteUpdate: true });
        try{ refreshOpenCueComments(); }catch(_e){}
        COLLAB_REVISION = serverRev;
        COLLAB_LAST_HASH = hashSessionState(buildShareSessionState());
        setCollabSyncStatus('updated');
      } finally {
        COLLAB_APPLYING = false;
      }
    }
  }
}

function maybeSendCollabStateOverWebSocket(opts={}){
  if (!COLLAB_WS_CONNECTED || !COLLAB_WS || COLLAB_WS.readyState !== WebSocket.OPEN) return;
  if (!COLLAB_SESSION_ID || !COLLAB_USER_ID || VIEW_ONLY_SESSION || COLLAB_APPLYING) return;
  const now = Date.now();
  const minStateInterval = (isStoryMode && storyIsEditingOrSelecting()) ? 1400 : 500;
  if (!opts.force && now - COLLAB_WS_LAST_SEND_MS < minStateInterval) return;

  const state = buildShareSessionState();
  const hash = hashSessionState(state);
  // Playhead events are awareness-only. They do not modify transcript state and
  // are used only by users who explicitly choose Follow Presenter.
  sendCollabPlayheadUpdate();
  if (isTimelineMode) sendTimelinePresence('viewing');
  if (isStoryMode){
    const snap = storySnapshotEditingFocus();
    if (snap?.rowId && snap?.cardId) sendCollabStoryCursor(snap.rowId, snap.cardId, snap.cueId || '', snap.field === 'mini' ? 'mini' : 'card');
  }
  if (hash === COLLAB_LAST_HASH){
    // Presence heartbeat keeps live user list fresh without sending transcript state.
    if (now - COLLAB_WS_LAST_SEND_MS > 5000){
      COLLAB_WS.send(JSON.stringify({ type:'presence_ping', user_id: COLLAB_USER_ID }));
      COLLAB_WS_LAST_SEND_MS = now;
    }
    return;
  }

  COLLAB_WS.send(JSON.stringify({
    type: 'state_update',
    user_id: COLLAB_USER_ID,
    client_revision: COLLAB_REVISION,
    state,
  }));
  COLLAB_WS_LAST_SEND_MS = now;
  // Optimistically set the hash to prevent duplicate sends while awaiting echo.
  COLLAB_LAST_HASH = hash;
  setCollabSyncStatus('saved');
}

function startCollabSync(){
  if (COLLAB_TIMER) clearInterval(COLLAB_TIMER);
  startCollabWebSocket();
  // Polling remains as a fallback when WebSocket is unavailable or reconnecting.
  COLLAB_TIMER = setInterval(() => {
    if (!COLLAB_WS_CONNECTED){
      syncCollaborativeSession().catch(err => console.warn('Collab polling fallback failed', err));
    }
  }, 2000);
  syncCollaborativeSession().catch(err => console.warn('Initial collab sync failed', err));
}

async function syncCollaborativeSession(){
  if (!COLLAB_SESSION_ID || !COLLAB_USER_ID || VIEW_ONLY_SESSION || COLLAB_APPLYING) return;

  const localState = buildShareSessionState();
  const localHash = hashSessionState(localState);
  const localDirty = localHash !== COLLAB_LAST_HASH;

  const payload = {
    user_id: COLLAB_USER_ID,
    client_revision: COLLAB_REVISION,
    dirty: localDirty,
    state: localDirty ? localState : null
  };

  const res = await fetch(`${API_BASE}/api/collab_session/${encodeURIComponent(COLLAB_SESSION_ID)}/sync`, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok || !data?.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);

  updateLiveUsersDisplay(data.users || []);

  const serverRev = Number(data.revision || 0);
  const updatedBy = data.updated_by || '';

  // If this browser just pushed a local change, accept the new server revision.
  // Because hashSessionState is now stable, this only happens when actual
  // transcript/session data changed, not on every polling tick.
  if (localDirty && updatedBy === COLLAB_USER_ID){
    COLLAB_REVISION = Math.max(COLLAB_REVISION, serverRev);
    COLLAB_LAST_HASH = localHash;
    setCollabSyncStatus('saved');
    return;
  }

  // If another browser has a newer revision, apply it immediately so the UI
  // updates without refresh. This is the automatic frontend refresh path.
  if (serverRev > COLLAB_REVISION && updatedBy !== COLLAB_USER_ID && data.state){
    COLLAB_APPLYING = true;
    try{
      const active = document.activeElement;
      const wasEditingText = !!(active && active.closest && active.closest('.text'));
      applySharedSessionState(data.state, { remoteUpdate: true });
      COLLAB_REVISION = serverRev;
      COLLAB_LAST_HASH = hashSessionState(buildShareSessionState());
      setCollabSyncStatus('updated');
      // Do not try to restore focus after remote apply; it can place the caret
      // into stale DOM nodes. Last-save-wins is intentional for this PoC.
    } finally {
      COLLAB_APPLYING = false;
    }
    return;
  }

  COLLAB_REVISION = Math.max(COLLAB_REVISION, serverRev);
  COLLAB_LAST_HASH = localHash;
  setCollabSyncStatus('live');
}

async function loadCollaborativeSessionFromUrl(){
  const params = new URLSearchParams(window.location.search || '');
  const sid = params.get('collab');
  if (!sid) return;
  try{ COLLAB_USER_ID = localStorage.getItem('transcriber_collab_user_id') || null; COLLAB_USER_LABEL = localStorage.getItem('transcriber_collab_label') || COLLAB_USER_LABEL; COLLAB_USER_COLOR = localStorage.getItem('transcriber_collab_color') || COLLAB_USER_COLOR; COLLAB_FOLLOW_USER_ID = localStorage.getItem('transcriber_collab_follow_user') || ''; }catch(_e){}
  setStatusSafe('Joining collaborative session…');
  await joinCollaborativeSession(sid, { applyState:true });
  setStatusSafe(`Joined collaborative session as ${COLLAB_USER_LABEL || 'User'}.`);
}

function addViewOnlyBanner(sessionId){
  if (document.getElementById('viewOnlyBanner')) return;
  const anchor = document.querySelector('.video-panel .status') || document.getElementById('status') || document.body;
  const div = document.createElement('div');
  div.id = 'viewOnlyBanner';
  div.className = 'view-only-banner';
  div.textContent = `View-only shared session${sessionId ? ' · ' + sessionId.slice(0, 8) : ''}. Editing and backend actions are disabled.`;
  if (anchor && anchor.parentElement) anchor.insertAdjacentElement('afterend', div);
  else document.body.insertBefore(div, document.body.firstChild);
}

function addEditorSharedBanner(sessionId){
  if (document.getElementById('editorSharedBanner')) return;
  const anchor = document.querySelector('.video-panel .status') || document.getElementById('status') || document.body;
  const div = document.createElement('div');
  div.id = 'editorSharedBanner';
  div.className = 'view-only-banner';
  div.textContent = `Editor shared session${sessionId ? ' · ' + sessionId.slice(0, 8) : ''}. This link gives full app control to the viewer.`;
  if (anchor && anchor.parentElement) anchor.insertAdjacentElement('afterend', div);
  else document.body.insertBefore(div, document.body.firstChild);
}

function applyEditorSharedMode(){
  VIEW_ONLY_SESSION = false;
  EDITOR_SHARED_SESSION = true;
  document.body.classList.remove('view-only-session');
  lockedA = false;
  lockedB = false;
  try{ applyAllLocks(); }catch(_e){}
  addEditorSharedBanner(CURRENT_SHARE_SESSION_ID);
}

function applyViewOnlyMode(){
  VIEW_ONLY_SESSION = true;
  document.body.classList.add('view-only-session');
  lockedA = true;
  lockedB = true;
  try{ applyAllLocks(); }catch(_e){}

  const disableIds = [
    'fileInput','srtInput','srtInputA','srtInputB','btnYouTubeImport','btnGoogleDriveImport','btnShareSession',
    'btnTranscribe','btnSrtTranslate','btnDictionary','btnAIAssistant','btnAnalyze','btnAlignSrt','btnAICheck',
    'btnKeyTerms','btnCancelBackend','btnExport','btnExportVtt','alignSrtText',
    'whisperModel','whisperDevice','whisperCompute','whisperLang','aiCheckMode'
  ];
  for (const id of disableIds){
    const el = document.getElementById(id);
    if (!el) continue;
    try{ el.disabled = true; }catch(_e){}
    if (id === 'btnShareSession' || id === 'btnYouTubeImport' || id === 'btnGoogleDriveImport'){
      try{ el.style.display = 'none'; }catch(_e){}
    }
  }

  document.querySelectorAll('#transcript .text, #transcriptB .text, .timepill, .txt-script-editor, .story-card-body, .story-mini-text').forEach(el => {
    try{ el.contentEditable = 'false'; }catch(_e){}
  });
  document.querySelectorAll('.transcript .line').forEach(el => {
    try{ el.draggable = false; }catch(_e){}
  });
  addViewOnlyBanner(CURRENT_SHARE_SESSION_ID);
}

function applySharedSessionState(state, opts={}){
  const st = state || {};
  COLLAB_COMMENTS = (st.comments && typeof st.comments === 'object') ? st.comments : {};
  window.currentBaseName = st.base_name || 'shared_session';
  fps = Number(st.fps || fps || 25);
  if (fpsSelect && st.fps) fpsSelect.value = String(st.fps);
  if (tcFps) tcFps.textContent = getFPS();
  useSourceTc = !!st.use_source_tc;
  sourceTcSec = Number(st.source_tc_sec || 0);

  entries = Array.isArray(st.entriesA) ? st.entriesA.map((e, idx) => ({
    id: String(e.id || '') || (typeof makeCueId === 'function' ? makeCueId() : ('cue_A_' + idx + '_' + Date.now())),
    start: Number(e.start || 0), end: Number(e.end || 0), text: String(e.text || ''),
    orig: { start: Number(e.start || 0), end: Number(e.end || 0), text: String(e.text || '') }, origIndex: idx,
  })) : [];
  initialEntries = entries.map((e, idx) => ({ start:e.start, end:e.end, text:e.text, index:idx }));

  entriesB = Array.isArray(st.entriesB) ? st.entriesB.map((e, idx) => ({
    id: String(e.id || '') || (typeof makeCueId === 'function' ? makeCueId() : ('cue_B_' + idx + '_' + Date.now())),
    start: Number(e.start || 0), end: Number(e.end || 0), text: String(e.text || ''),
    orig: { start: Number(e.start || 0), end: Number(e.end || 0), text: String(e.text || '') }, origIndex: idx,
  })) : [];
  initialEntriesB = entriesB.map((e) => ({ start:e.start, end:e.end, text:e.text }));

  if (Array.isArray(st.timeline_clips)){
    timelineClips = st.timeline_clips.map((c, idx) => cleanTimelineClipForShare(c, idx));
    normalizeTimelineClips();
    if (!timelineClips.some(c => c.id === timelineSelectedClipId)) timelineSelectedClipId = '';
    if (isTimelineMode) requestTimelineRender();
  }
  if (Array.isArray(st.story_rows)){
    if (opts.remoteUpdate && storyIsEditingOrSelecting()){
      storyQueueRemoteRows(st.story_rows);
    } else {
      applySharedStoryRows(st.story_rows, { remoteUpdate: !!opts.remoteUpdate });
    }
  }

  const box = document.getElementById('alignSrtText');
  if (box) box.value = String(st.align_text || (entries.length ? toSRT(entries) : ''));

  const media = st.media_source || {};
  const preserveMedia = !!opts.preserveMedia;
  const currentKey = `${currentMediaSource?.type || ''}:${currentMediaSource?.videoId || currentMediaSource?.fileId || currentMediaSource?.cacheId || currentMediaSource?.url || ''}`;
  const incomingKey = `${media?.type || ''}:${media?.videoId || media?.fileId || media?.cacheId || media?.url || ''}`;
  if (!preserveMedia || currentKey !== incomingKey){
    if (media.type === 'youtube' && (media.videoId || media.url)){
      activateYouTubePreview({
        url: media.url || `https://www.youtube.com/watch?v=${media.videoId}`,
        metadata: Object.assign({}, media.metadata || {}, { id: media.videoId || media.metadata?.id }),
        permissionConfirmed: false,
      });
    } else if (media.type === 'drive' && (media.fileId || media.url)){
      activateGoogleDrivePreview({
        url: media.url || '',
        fileId: media.fileId || parseGoogleDriveFileId(media.url || ''),
        metadata: media.metadata || {},
      });
    } else if (media.type === 'local_cached' && media.cacheId){
      currentMediaSource = { type:'local', cacheId:String(media.cacheId), filename:media.filename || 'local media', metadata:media.metadata || {} };
      setYouTubePreviewVisible(false);
      try{ setGoogleDrivePreviewVisible(false); }catch(_e){}
      if (player){
        player.src = `${API_BASE}/api/local_cached_media/${encodeURIComponent(media.cacheId)}`;
        try{ player.load(); }catch(_e){}
      }
    } else if (!preserveMedia){
      currentMediaSource = { type: 'shared_local', metadata: media };
      setYouTubePreviewVisible(false);
      try{ setGoogleDrivePreviewVisible(false); }catch(_e){}
      if (player) player.removeAttribute('src');
    }
  }

  const mode = (st.subs_mode === 'B' || st.subs_mode === 'DUAL') ? st.subs_mode : 'A';
  const subsSel = document.getElementById('subsMode');
  if (subsSel) subsSel.value = mode;
  activeOverlayTrack = st.active_overlay_track === 'B' ? 'B' : 'A';
  applySubsMode(mode);
  if (isTxtMode){ try{ updateTxtBox(!!opts.remoteUpdate); }catch(_e){} }
  if (VIEW_ONLY_SESSION){
    setStatusSafe('Loaded view-only shared session.');
    applyViewOnlyMode();
  } else if (COLLAB_SESSION_ID){
    setStatusSafe('Loaded collaborative session.');
  } else {
    setStatusSafe('Loaded editor shared session.');
    applyEditorSharedMode();
  }
}

async function loadSharedSessionFromUrl(){
  const params = new URLSearchParams(window.location.search || '');
  const sid = params.get('session');
  const view = params.get('view');
  if (!sid) return;
  CURRENT_SHARE_SESSION_ID = sid;
  setStatusSafe('Loading shared session…');
  const res = await fetch(`${API_BASE}/api/share_session/${encodeURIComponent(sid)}`);
  const data = await res.json().catch(()=>({}));
  if (!res.ok || !data?.ok){
    setStatusSafe('Shared session failed to load.');
    alert('Shared session failed to load: ' + (data?.message || data?.error || `HTTP ${res.status}`));
    return;
  }
  // Backend read_only is the source of truth. URL view=0 may grant editor mode
  // only when the session was created with editor rights.
  const backendReadOnly = data.read_only !== false;
  VIEW_ONLY_SESSION = (view === '0') ? backendReadOnly : true;
  if (backendReadOnly) VIEW_ONLY_SESSION = true;
  applySharedSessionState(data.state || {});
}




/* ---------- Balanced left-panel control surface ---------- */
function ensureLeftPanelControlSurface(){
  const panel = document.querySelector('.video-panel');
  const status = document.getElementById('status');
  if (!panel || !status) return;
  if (document.getElementById('leftControlSurface')) return;

  if (!document.getElementById('leftPanelControlSurfaceStyle')){
    const st = document.createElement('style');
    st.id = 'leftPanelControlSurfaceStyle';
    st.textContent = `
      .video-panel{ --lp-gap:8px; }
      .video-panel .smallprint{ display:none !important; }
      .left-control-surface{ margin-top:10px; display:flex; flex-direction:column; gap:8px; }
      .left-status-backend{ align-self:flex-start; width:fit-content; max-width:100%; display:inline-flex; align-items:center; justify-content:center; gap:7px; padding:5px 10px; border-radius:999px; background:rgba(255,255,255,.055); border:1px solid rgba(255,255,255,.10); color:rgba(233,237,241,.72); font-size:11.5px; min-height:18px; box-sizing:border-box; }
      .left-status-backend::before{ content:'Backend'; opacity:.72; }
      .left-status-backend .muted{ opacity:1; min-width:0; max-width:210px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .left-progress-strip{ display:none; align-items:center; gap:8px; padding:8px 10px; border-radius:14px; background:rgba(255,255,255,.045); border:1px solid rgba(255,255,255,.08); }
      .left-progress-strip.is-active{ display:flex; }
      .left-progress-strip #whisperProgWrap{ min-width:0; }
      .left-progress-strip #whisperProgTxt{ min-width:40px; text-align:right; font-variant-numeric:tabular-nums; }
      .left-dock{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px; width:100%; }
      .left-dock-btn{ height:38px; min-width:0; border-radius:14px; padding:0 6px; display:flex; align-items:center; justify-content:center; gap:6px; text-align:center; font-size:12px; line-height:1.05; white-space:normal; }
      .left-dock-btn.is-active{ border-color:rgba(255,215,0,.55); background:rgba(255,215,0,.10); color:#fff; box-shadow:inset 0 0 0 1px rgba(255,215,0,.14); }
      .left-dock-divider{ height:1px; width:100%; margin:2px 0; background:linear-gradient(90deg, transparent, rgba(255,255,255,.18), transparent); }
      .left-language-strip{ display:flex; justify-content:flex-start; align-items:center; min-height:0; }
      .left-language-strip label{ display:flex; align-items:center; gap:7px; font-size:12px; color:rgba(233,237,241,.74); margin:0; }
      .left-language-strip select{ min-width:190px; max-width:100%; height:34px; }
      #txtBigBox{ caret-color:#fff; }
      #txtBigBox:not([readonly]){ background:#0e1116; }

      #leftMiniDrawerHost{ display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; min-height:0; width:100%; container-type:inline-size; }
      .left-settings-shell{ display:flex; flex-direction:column; gap:7px; align-items:stretch; }
      .left-settings-toggle{ height:34px; border-radius:999px; justify-content:center; letter-spacing:.01em; }
      .left-settings-toggle::after{ content:'▾'; font-size:10px; opacity:.7; margin-left:6px; transform:translateY(-1px); }
      .left-settings-shell:not(.is-open) #mediaSettingsDock{ display:none; }
      .left-settings-shell:not(.is-open) .left-settings-toggle::after{ content:'▸'; }
      .left-settings-shell.is-open #mediaSettingsDock{ display:grid; }
      .left-settings-shell.is-open .left-settings-toggle{ border-color:rgba(255,255,255,.16); background:rgba(255,255,255,.055); }
      #leftDrawerHost{ display:flex; flex-direction:column; align-items:stretch; gap:8px; }
      .left-drawer{ display:none; width:100%; box-sizing:border-box; padding:12px; border-radius:16px; background:linear-gradient(180deg, rgba(255,255,255,.055), rgba(255,255,255,.032)); border:1px solid rgba(255,255,255,.09); box-shadow:0 12px 30px rgba(0,0,0,.16); color:#e9edf1; }
      .left-drawer.is-open{ display:block; }
      .left-mini-drawer{ width:fit-content; min-width:210px; max-width:min(340px, 100%); margin-left:auto; margin-right:auto; padding:9px; border-radius:14px; background:rgba(255,255,255,.045); border-color:rgba(255,255,255,.075); box-shadow:0 8px 22px rgba(0,0,0,.12); }
      /* Font drawer must respond to the actual left-panel width, not only viewport width. */
      .left-mini-drawer[data-drawer="font"]{ width:100%; max-width:min(920px, calc(100vw - 56px)); min-width:0; padding:10px; overflow:hidden; box-sizing:border-box; }
      .left-mini-drawer[data-drawer="font"] .left-drawer-body{ overflow:auto; max-width:100%; }
      .left-mini-drawer .left-drawer-title{ margin-bottom:8px; font-size:13px; }
      .left-mini-drawer .left-drawer-body{ display:flex; flex-direction:column; gap:8px; }
      .left-drawer-title{ display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px; font-weight:650; letter-spacing:.01em; }
      .left-drawer-title .btn-mini{ padding:4px 8px; min-height:26px; border-radius:10px; font-size:11px; }
      .left-drawer-sub{ color:rgba(233,237,241,.66); font-size:12px; margin-top:-5px; margin-bottom:10px; line-height:1.45; }
      .left-drawer-grid{ display:grid; grid-template-columns:1fr 1fr; gap:8px; align-items:center; }
      .left-drawer-row{ display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
      .left-drawer .btn{ min-height:36px; padding:8px 12px; }
      .left-drawer-row{ row-gap:10px; margin-top:8px; }
      .left-drawer-row .btn{ margin-bottom:2px; }
      .left-drawer label{ font-size:12px; color:rgba(233,237,241,.74); }
      .left-drawer textarea{ width:100%; box-sizing:border-box; background:#0e1116; color:#e9edf1; border:1px solid rgba(255,255,255,.09); border-radius:12px; padding:10px; font-size:13px; line-height:1.5; resize:vertical; }
      .left-drawer #alignSrtText{ min-height:132px; }
      .left-ai-chat{ display:flex; flex-direction:column; gap:8px; }
      .left-ai-chat textarea{ min-height:96px; }
      .left-ai-chat #leftAiAnswer{ min-height:120px; }
      .left-tool-note{ font-size:12px; line-height:1.45; color:rgba(233,237,241,.68); }
      .left-advanced-grid{ display:grid; grid-template-columns:minmax(0,1.35fr) minmax(0,.8fr) minmax(0,1fr); gap:8px; margin-top:8px; align-items:end; }
      .left-advanced-grid label{ display:flex; flex-direction:column; gap:5px; }
      .left-advanced-grid input,.left-advanced-grid select{ width:100%; box-sizing:border-box; min-height:34px; }
      .left-advanced-grid label{ min-width:0; }
      .stylebar,.view-mode-embedded,#tcOriginBar{ margin:0 !important; }
      #leftControlSurface #tcSrcMini{ display:flex !important; align-items:center; gap:8px; margin:0; padding:0; color:rgba(233,237,241,.78); }
      #leftControlSurface #tcOriginBar{ width:100%; box-sizing:border-box; padding:8px; gap:8px; align-items:center; flex-wrap:wrap; }
      #leftControlSurface #tcOriginBar label{ width:100%; justify-content:space-between; }
      #leftControlSurface #tcOriginBar input[type="text"]{ width:120px !important; }
      #videoStyleBar{ display:block !important; width:100% !important; max-width:100% !important; padding:0 !important; background:transparent !important; border:0 !important; overflow:visible !important; box-sizing:border-box !important; }
      #videoStyleBar .font-settings-grid{ display:grid; grid-template-columns:repeat(2, minmax(240px,1fr)); gap:14px; width:100%; max-width:100%; min-width:0; align-items:start; }
      #videoStyleBar .font-settings-col{ padding:12px; min-width:0; max-width:100%; overflow:hidden; box-sizing:border-box; }
      #videoStyleBar label{ display:grid; grid-template-columns:minmax(70px,86px) minmax(0,1fr); align-items:center; width:100%; gap:10px; min-width:0; }
      #videoStyleBar label span{ min-width:0; overflow-wrap:anywhere; }
      #videoStyleBar .ui-dark-input,#videoStyleBar .ui-dark-select{ width:100%; min-width:0; max-width:100%; }
      #videoStyleBar .ui-dark-color{ justify-self:start; width:44px; max-width:100%; }
      .caption-max-row{ display:grid !important; grid-template-columns:78px minmax(0,1fr) !important; align-items:center; gap:10px; width:100%; font-size:12px; color:rgba(233,237,241,.74); }
      .caption-max-row input{ width:100%; min-width:0; box-sizing:border-box; text-align:center; }
      #viewModeBar{ margin:0 !important; display:flex; flex-direction:column; align-items:stretch; gap:8px; }
      #viewModeBar .seg-toggle{ width:100%; display:grid; grid-template-columns:1fr 1fr; }
      #viewModeBar .txt-tools{ flex-wrap:wrap; }
      #whisperBar{ display:none !important; }
      .left-whisper-hidden{ display:none !important; }
      @media (max-width: 920px){
        .left-dock{ grid-template-columns:repeat(2,minmax(0,1fr)); }
        .left-drawer-grid,.left-advanced-grid{ grid-template-columns:1fr; }
        .left-mini-drawer:not([data-drawer="font"]){ width:100%; max-width:100%; }
      }
      @container (max-width: 620px){
        .left-mini-drawer[data-drawer="font"]{ width:100%; max-width:100%; }
        #videoStyleBar .font-settings-grid{ grid-template-columns:1fr; }
      }
      @media (max-width: 700px){
        .left-mini-drawer[data-drawer="font"]{ width:100%; max-width:100%; }
        #videoStyleBar .font-settings-grid{ grid-template-columns:1fr; }
      }
    `;
    document.head.appendChild(st);
  }

  const surface = document.createElement('div');
  surface.id = 'leftControlSurface';
  surface.className = 'left-control-surface';
  surface.innerHTML = `
    <div class="left-status-backend" id="leftStatusBackend"></div>
    <div class="left-progress-strip" id="leftProgressStrip"></div>
    <div class="left-settings-shell" id="leftSettingsShell">
      <button class="btn btn-outline left-settings-toggle" id="leftSettingsToggle" type="button" aria-expanded="false">Settings</button>
      <div class="left-dock" id="mediaSettingsDock" aria-label="Media settings">
        <button class="btn btn-outline left-dock-btn" data-left-drawer="source" type="button">Source TC</button>
        <button class="btn btn-outline left-dock-btn" data-left-drawer="view" type="button">View Mode</button>
        <button class="btn btn-outline left-dock-btn" data-left-drawer="font" type="button">Font</button>
        <button class="btn btn-outline left-dock-btn" data-left-drawer="tips" type="button">Tips</button>
      </div>
    </div>
    <div id="leftMiniDrawerHost"></div>
    <div class="left-dock-divider" role="separator" aria-hidden="true"></div>
    <div class="left-language-strip" id="leftLanguageStrip"></div>
    <div class="left-dock" id="workflowToolsDock" aria-label="Workflow tools">
      <button class="btn btn-gold left-dock-btn" data-left-drawer="transcribe" type="button">Transcribe</button>
      <button class="btn btn-gold left-dock-btn" data-left-drawer="align" type="button">Align</button>
      <button class="btn btn-gold left-dock-btn" data-left-drawer="translate" type="button">Translate</button>
      <button class="btn btn-gold left-dock-btn" data-left-drawer="ai" type="button">AI Assistant</button>
    </div>
    <div id="leftDrawerHost"></div>
  `;
  status.insertAdjacentElement('afterend', surface);

  const drawerHost = surface.querySelector('#leftDrawerHost');
  const miniDrawerHost = surface.querySelector('#leftMiniDrawerHost');
  const makeDrawer = (name, title, subtitle='', compact=false) => {
    const d = document.createElement('section');
    d.className = 'left-drawer' + (compact ? ' left-mini-drawer' : '');
    d.dataset.drawer = name;
    d.innerHTML = `<div class="left-drawer-title"><span>${title}</span><button class="btn btn-outline btn-mini" data-close-left-drawer type="button">Close</button></div>${subtitle ? `<div class="left-drawer-sub">${subtitle}</div>` : ''}<div class="left-drawer-body"></div>`;
    (compact ? miniDrawerHost : drawerHost).appendChild(d);
    d.querySelector('[data-close-left-drawer]')?.addEventListener('click', () => openLeftDrawer(null));
    return d.querySelector('.left-drawer-body');
  };

  const floatingDrawerClose = (() => {
    let btn = document.getElementById('mobileFloatingDrawerClose');
    if (!btn){
      btn = document.createElement('button');
      btn.id = 'mobileFloatingDrawerClose';
      btn.className = 'btn btn-outline mobile-floating-drawer-close';
      btn.type = 'button';
      btn.textContent = 'Close';
      btn.setAttribute('aria-label', 'Close drawer');
      btn.hidden = true;
      document.body.appendChild(btn);
    }
    btn.addEventListener('click', () => openLeftDrawer(null));
    return btn;
  })();

  function getOpenLeftDrawerName(){
    const open = surface.querySelector('.left-drawer.is-open');
    return open?.dataset?.drawer || '';
  }

  function updateMobileDrawerFloatingClose(){
    const btn = floatingDrawerClose;
    const openName = getOpenLeftDrawerName();
    const isPhone = window.matchMedia?.('(max-width: 640px)')?.matches || window.innerWidth <= 640;
    if (!btn) return;
    if (!isPhone || !openName){
      btn.hidden = true;
      document.body.classList.remove('mobile-drawer-floating-close-visible');
      return;
    }

    const switcher = document.getElementById('mobilePanelSwitcher');
    const divider = document.getElementById('phoneVideoHorizontalDivider');
    let sheetTop = 96;

    try{
      const swRect = switcher?.getBoundingClientRect?.();
      if (swRect && swRect.height > 0) sheetTop = Math.max(sheetTop, swRect.bottom + 8);

      // In iPhone Video mode, the drawer should start immediately below the
      // horizontal divider under the Timecode bar. Do NOT read the drawer's own
      // current top position here; doing that creates a feedback loop where each
      // open/scroll update pushes the sheet lower and lower.
      if (document.body.classList.contains('mobile-panel-video') && divider){
        const divRect = divider.getBoundingClientRect();
        if (divRect && divRect.height >= 0) sheetTop = Math.max(72, divRect.bottom + 6);
      }
    }catch(_e){}

    // Keep at least a useful minimum height for the sheet, even on short phones.
    const maxTop = Math.max(72, window.innerHeight - 360);
    sheetTop = Math.min(Math.max(56, sheetTop), maxTop);
    try { document.documentElement.style.setProperty('--mobile-drawer-sheet-top', `${sheetTop}px`); } catch(_e) {}

    const closeTop = Math.min(Math.max(56, sheetTop + 8), Math.max(56, window.innerHeight - 84));
    btn.style.top = `${closeTop}px`;

    btn.hidden = false;
    document.body.classList.add('mobile-drawer-floating-close-visible');
  }
  window.updateMobileDrawerFloatingClose = updateMobileDrawerFloatingClose;
  window.addEventListener('resize', updateMobileDrawerFloatingClose, { passive:true });
  window.addEventListener('orientationchange', () => setTimeout(updateMobileDrawerFloatingClose, 160), { passive:true });
  window.addEventListener('scroll', updateMobileDrawerFloatingClose, { passive:true });
  document.addEventListener('touchmove', () => {
    if (document.body.classList.contains('mobile-drawer-floating-close-visible')) updateMobileDrawerFloatingClose();
  }, { passive:true });

  const sourceBody = makeDrawer('source', 'Source TC', '', true);
  const viewBody = makeDrawer('view', 'View Mode', '', true);
  const fontBody = makeDrawer('font', 'Font', '', true);
  const tipsBody = makeDrawer('tips', 'Tips', '', true);
  const transcribeBody = makeDrawer('transcribe', 'Transcribe', 'Run Whisper with current media source.');
  const alignBody = makeDrawer('align', 'Align', 'Paste subtitle text or SRT, then align it to the current audio.');
  const translateBody = makeDrawer('translate', 'Translate', 'Translate, manage dictionary terms, and run checks.');
  const aiBody = makeDrawer('ai', 'AI Assistant');

  const move = (id, target) => {
    const el = document.getElementById(id);
    if (el && target) target.appendChild(el);
    return el;
  };

  const statusBackend = document.getElementById('leftStatusBackend');
  const backendEl = document.getElementById('apiBaseLbl')?.closest('.muted');
  if (statusBackend){
    statusBackend.innerHTML = '';
    if (backendEl) statusBackend.appendChild(backendEl);
    else statusBackend.innerHTML = '<span class="muted">same-origin</span>';
  }

  const progressStrip = document.getElementById('leftProgressStrip');
  const progWrap = document.getElementById('whisperProgWrap');
  const progTxt = document.getElementById('whisperProgTxt');
  const cancelBtn = document.getElementById('btnCancelBackend');
  if (progressStrip){
    if (progWrap) progressStrip.appendChild(progWrap);
    if (progTxt) progressStrip.appendChild(progTxt);
    if (cancelBtn) progressStrip.appendChild(cancelBtn);
  }

  const tcMini = document.getElementById('tcSrcMini');
  if (tcMini) sourceBody.appendChild(tcMini);
  const tcOrigin = move('tcOriginBar', sourceBody);
  if (!tcMini && !tcOrigin){ sourceBody.innerHTML += '<div class="left-tool-note">Source TC controls are unavailable.</div>'; }

  const viewBar = move('viewModeBar', viewBody);
  if (viewBar) viewBar.classList.add('view-mode-embedded');
  const styleBar = move('videoStyleBar', fontBody);
  const captionFontColumn = styleBar?.querySelector?.('#captionFontColumn') || fontBody;
  if (styleBar){
    ensureCaptionMaxCharsControl(captionFontColumn);
  } else {
    fontBody.innerHTML += '<div class="left-tool-note">Font controls are unavailable.</div>';
    ensureCaptionMaxCharsControl(fontBody);
  }

  const smallprint = panel.querySelector('.smallprint');
  if (smallprint){
    const tips = smallprint.innerHTML
      .split(/<hr\s*\/?>/i)
      .map(x => x.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim())
      .filter(Boolean);
    tipsBody.innerHTML = '<ul style="margin:0;padding-left:18px;line-height:1.65;font-size:12px;color:rgba(233,237,241,.76)">' + tips.map(t => `<li>${escapeHtml(t)}</li>`).join('') + '</ul>';
  } else {
    tipsBody.innerHTML = '<div class="left-tool-note">No tips available.</div>';
  }

  const langStrip = document.getElementById('leftLanguageStrip');
  const langEl = document.getElementById('whisperLang');
  const langLab = langEl?.closest('label');
  if (langStrip && langLab) langStrip.appendChild(langLab);

  const transcribeSettings = document.createElement('div');
  transcribeSettings.className = 'left-advanced-grid';
  transcribeBody.appendChild(transcribeSettings);
  ['whisperModel','whisperDevice','whisperCompute'].forEach(id => {
    const el = document.getElementById(id);
    const lab = el?.closest('label');
    if (lab) transcribeSettings.appendChild(lab);
  });
  const devSel = document.getElementById('whisperDevice');
  if (devSel && (!devSel.value || devSel.value === 'auto')) devSel.value = 'cuda';
  const tActionRow = document.createElement('div');
  tActionRow.className = 'left-drawer-row';
  transcribeBody.appendChild(tActionRow);
  const transcribeBtn = move('btnTranscribe', tActionRow);
  if (transcribeBtn) transcribeBtn.textContent = 'Start Transcribe';

  const alignActions = document.createElement('div');
  alignActions.className = 'left-drawer-row';
  alignBody.appendChild(alignActions);
  move('btnAnalyze', alignActions);
  move('btnAlignSrt', alignActions);
  const alignBox = move('alignSrtText', alignBody);
  if (alignBox) alignBox.placeholder = 'Paste subtitle lines or SRT here…';

  const translateRow = document.createElement('div');
  translateRow.className = 'left-drawer-row';
  translateBody.appendChild(translateRow);
  const startTranslateBtn = move('btnSrtTranslate', translateRow);
  if (startTranslateBtn) startTranslateBtn.textContent = 'Start Translate';
  move('btnDictionary', translateRow);

  const checkRow = document.createElement('div');
  checkRow.className = 'left-drawer-row';
  translateBody.appendChild(checkRow);
  move('btnAICheck', checkRow);
  move('aiCheckMode', checkRow);
  const keyTermsBtn = move('btnKeyTerms', checkRow);
  const anchorFilters = move('aiAnchorFilters', translateBody);
  const syncTranslateCheckControls = () => {
    const mode = (document.getElementById('aiCheckMode')?.value || 'semantic').toLowerCase();
    const isAnchor = mode === 'anchor';
    if (keyTermsBtn) keyTermsBtn.style.display = isAnchor ? '' : 'none';
    if (anchorFilters) anchorFilters.style.display = isAnchor ? 'flex' : 'none';
  };
  document.getElementById('aiCheckMode')?.addEventListener('change', syncTranslateCheckControls);
  syncTranslateCheckControls();

  aiBody.innerHTML = `
    <div class="left-ai-chat">
      <div class="left-drawer-grid">
        <label>Context
          <select id="leftAiContext" class="ui-dark-select">
            <option value="A" selected>Sub A</option>
            <option value="B">Sub B</option>
            <option value="BOTH">Sub A + Sub B</option>
            <option value="CURRENT">Current cue</option>
          </select>
        </label>
        <label>Task
          <select id="leftAiTask" class="ui-dark-select">
            <option value="qa" selected>Ask anything</option>
            <option value="summary">Summary</option>
            <option value="subtitle_polish">Subtitle Polish</option>
            <option value="extract_quotes">Extract Quotes</option>
            <option value="identify_chapters">Chapters</option>
          </select>
        </label>
      </div>
      <textarea id="leftAiPrompt" placeholder="Ask DeepSeek about the transcript…"></textarea>
      <div class="left-drawer-row">
        <button class="btn btn-gold" id="leftAiRun" type="button">Ask</button>
        <button class="btn btn-outline" id="leftAiCopy" type="button">Copy</button>
        <button class="btn btn-outline" id="leftAiOpenModal" type="button">Open Full Assistant</button>
      </div>
      <textarea id="leftAiAnswer" readonly placeholder="Answer will appear here…"></textarea>
    </div>`;
  const aiModalBtn = document.getElementById('btnAIAssistant');
  if (aiModalBtn) aiModalBtn.classList.add('left-whisper-hidden');
  aiBody.querySelector('#leftAiOpenModal')?.addEventListener('click', () => openAIAssistantModal());
  aiBody.querySelector('#leftAiCopy')?.addEventListener('click', async () => {
    const val = document.getElementById('leftAiAnswer')?.value || '';
    if (val) await copyTextToClipboard(val);
  });
  aiBody.querySelector('#leftAiRun')?.addEventListener('click', () => runLeftPanelAIAssistant().catch(err => {
    console.error(err); alert('AI Assistant failed: ' + (err?.message || err));
  }));

  const whisperBar = document.getElementById('whisperBar');
  if (whisperBar) whisperBar.classList.add('left-whisper-hidden');

  const settingsShell = document.getElementById('leftSettingsShell');
  const settingsToggle = document.getElementById('leftSettingsToggle');
  const savedSettingsOpen = localStorage.getItem('leftPanelSettingsOpen') === '1';
  const setSettingsOpen = (open) => {
    if (!settingsShell || !settingsToggle) return;
    settingsShell.classList.toggle('is-open', !!open);
    settingsToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    localStorage.setItem('leftPanelSettingsOpen', open ? '1' : '0');
    if (!open){
      ['source','view','font','tips'].forEach(n => {
        const d = document.querySelector(`.left-drawer[data-drawer="${n}"]`);
        if (d) d.classList.remove('is-open');
        const b = document.querySelector(`[data-left-drawer="${n}"]`);
        if (b) b.classList.remove('is-active');
      });
    }
  };
  setSettingsOpen(savedSettingsOpen);
  settingsToggle?.addEventListener('click', () => setSettingsOpen(!settingsShell.classList.contains('is-open')));

  surface.querySelectorAll('[data-left-drawer]').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-left-drawer');
      const target = document.querySelector(`.left-drawer[data-drawer="${name}"]`);
      openLeftDrawer(target?.classList.contains('is-open') ? null : name);
    });
  });

  function openLeftDrawer(name){
    if (['source','view','font','tips'].includes(name || '')) setSettingsOpen(true);
    surface.querySelectorAll('.left-dock-btn').forEach(b => b.classList.toggle('is-active', !!name && b.getAttribute('data-left-drawer') === name));
    surface.querySelectorAll('.left-drawer').forEach(d => d.classList.toggle('is-open', !!name && d.dataset.drawer === name));
    if (name) localStorage.setItem('leftPanelOpenDrawer', name); else localStorage.removeItem('leftPanelOpenDrawer');
    requestAnimationFrame(updateMobileDrawerFloatingClose);
    setTimeout(updateMobileDrawerFloatingClose, 180);
  }
  window.openLeftPanelDrawer = openLeftDrawer;
  let saved = localStorage.getItem('leftPanelOpenDrawer');
  if (saved === 'captions') saved = 'font';
  if (saved) openLeftDrawer(saved);
}

const CAPTION_MAX_CHARS_LS_KEY = 'caption_max_chars_per_row_v1';
function getCaptionMaxChars(){
  const raw = localStorage.getItem(CAPTION_MAX_CHARS_LS_KEY);
  const n = parseInt(raw || '0', 10);
  return Number.isFinite(n) && n > 0 ? Math.max(8, Math.min(80, n)) : 0;
}
function setCaptionMaxChars(n){
  const v = parseInt(String(n || ''), 10);
  if (!Number.isFinite(v) || v <= 0) localStorage.removeItem(CAPTION_MAX_CHARS_LS_KEY);
  else localStorage.setItem(CAPTION_MAX_CHARS_LS_KEY, String(Math.max(8, Math.min(80, v))));
  try { const idx = getActiveIndex(getMediaCurrentTime?.() ?? player?.currentTime ?? 0); updateOverlay(idx); } catch(_e){}
}
function wrapSubtitleTextByChars(text, maxChars){
  const src = String(text || '').trim();
  const max = parseInt(maxChars || 0, 10);
  if (!src || !max || max <= 0) return src;
  const paragraphs = src.split(/\n+/);
  const out = [];
  for (const para of paragraphs){
    const s = para.trim();
    if (!s){ out.push(''); continue; }
    if (/\s/.test(s)){
      let line = '';
      for (const word of s.split(/\s+/)){
        if (!line) line = word;
        else if ((line + ' ' + word).length <= max) line += ' ' + word;
        else { out.push(line); line = word; }
      }
      if (line) out.push(line);
    } else {
      for (let i=0; i<s.length; i+=max) out.push(s.slice(i, i+max));
    }
  }
  return out.join('\n');
}
function ensureCaptionMaxCharsControl(target){
  if (!target || document.getElementById('captionMaxChars')) return;
  const row = document.createElement('label');
  row.className = 'caption-max-row';
  row.innerHTML = `<span>Max chars / row</span><input id="captionMaxChars" class="ui-dark-input" type="number" min="8" max="80" step="1" placeholder="Auto">`;
  target.appendChild(row);
  const input = row.querySelector('#captionMaxChars');
  const cur = getCaptionMaxChars();
  if (cur) input.value = String(cur);
  input.addEventListener('change', () => setCaptionMaxChars(input.value));
  input.addEventListener('input', () => setCaptionMaxChars(input.value));
}

function buildLeftAIContextText(context){
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  if (context === 'B') return entriesB.map((e,i)=>`[${i+1}] ${clean(e.text)}`).join('\n');
  if (context === 'BOTH'){
    const a = entries.map((e,i)=>`[${i+1}] ${clean(e.text)}`).join('\n');
    const b = entriesB.map((e,i)=>`[${i+1}] ${clean(e.text)}`).join('\n');
    return `Sub A:\n${a}\n\nSub B:\n${b}`;
  }
  if (context === 'CURRENT'){
    const t = (typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : (player?.currentTime || 0);
    const track = activeOverlayTrack || 'A';
    const idx = getActiveIndex(t, track);
    const list = track === 'B' ? entriesB : entries;
    const e = list[idx];
    if (!e) return '';
    return `[${idx+1}] ${formatTimecodeFromSeconds(e.start, getFPS())} --> ${formatTimecodeFromSeconds(e.end, getFPS())}\n${clean(e.text)}`;
  }
  return entries.map((e,i)=>`[${i+1}] ${clean(e.text)}`).join('\n');
}

async function runLeftPanelAIAssistant(){
  const task = document.getElementById('leftAiTask')?.value || 'qa';
  const context = document.getElementById('leftAiContext')?.value || 'A';
  const prompt = document.getElementById('leftAiPrompt')?.value || '';
  const out = document.getElementById('leftAiAnswer');
  const source_text = buildLeftAIContextText(context);
  if (!source_text.trim()) throw new Error('No transcript content available for this context.');
  if (out) out.value = 'Running…';
  const res = await fetch(`${API_BASE}/api/ai_assistant`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ task, instructions: prompt, source_text, model: document.getElementById('aiAssistModel')?.value || 'deepseek-chat', dictionary: loadDictionaryPairs() })
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok || !data?.ok) throw new Error(data?.detail || data?.message || (`HTTP ${res.status}`));
  if (out) out.value = String(data.output || '');
}

/* ---------- Resizable center divider ---------- */
function setupCenterDivider(){
  const wrap = document.querySelector('main.wrap') || document.querySelector('.wrap');
  const divider = document.getElementById('panelDivider');
  const videoPanel = document.querySelector('.video-panel');
  if (!wrap || !divider || !videoPanel) return;

  // Restore previous split, but clamp it after layout is available so iPad widths do not get stuck.
  const clampAndSet = (px) => {
    const wrapW = wrap.getBoundingClientRect().width || window.innerWidth || 0;
    const minPx = Math.min(320, Math.max(240, wrapW * 0.28));
    const maxPx = Math.max(minPx, wrapW - minPx - 28);
    const val = Math.max(minPx, Math.min(Number(px) || minPx, maxPx));
    wrap.style.setProperty('--videoW', `${Math.round(val)}px`);
    return val;
  };

  const saved = localStorage.getItem('panelSplitPx');
  if (saved && /^[0-9]+$/.test(saved)){
    requestAnimationFrame(() => clampAndSet(Number(saved)));
  }

  let dragging = false;
  let startX = 0;
  let startW = 0;
  let pointerId = null;

  const canDragDivider = () => {
    // Phone uses one-panel-at-a-time layout, so the divider is intentionally hidden there. iPad/tablets keep the split divider.
    return window.innerWidth > 640 && getComputedStyle(divider).display !== 'none';
  };

  const onDown = (e) => {
    if (!canDragDivider()) return;
    dragging = true;
    pointerId = e.pointerId ?? null;
    startX = e.clientX;
    startW = videoPanel.getBoundingClientRect().width;
    document.body.classList.add('resizing');
    try{ divider.setPointerCapture?.(pointerId); }catch(_e){}
    e.preventDefault();
  };

  const onMove = (e) => {
    if (!dragging) return;
    if (pointerId != null && e.pointerId != null && e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    clampAndSet(startW + dx);
    e.preventDefault?.();
  };

  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    try{ divider.releasePointerCapture?.(pointerId); }catch(_e){}
    pointerId = null;
    document.body.classList.remove('resizing');
    const w = Math.round(videoPanel.getBoundingClientRect().width);
    localStorage.setItem('panelSplitPx', String(w));
  };

  // Pointer events cover mouse + iPad touch/Apple Pencil. Keep old mouse fallback harmlessly omitted.
  divider.addEventListener('pointerdown', onDown, { passive:false });
  window.addEventListener('pointermove', onMove, { passive:false });
  window.addEventListener('pointerup', onUp, { passive:true });
  window.addEventListener('pointercancel', onUp, { passive:true });

  // Make the divider easier to grab on touch devices.
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', 'vertical');
  divider.title = 'Drag to resize panels';
}


function setupVideoControls() {
  const video = document.getElementById('player');
  const btnPlay = document.getElementById('vidPlayPause');
  const selSpeed = document.getElementById('vidSpeed');
  const btnCC = document.getElementById('vidCaptionToggle');
  const ccOverlay = document.getElementById('captionOverlay');
  const controls = document.getElementById('videoControls');
  const timeline = document.getElementById('vidTimeline');
  const timeLbl = document.getElementById('vidTime');
  const btnMute = document.getElementById('vidMuteToggle');
  const volSlider = document.getElementById('vidVolume');
  const volWrap = document.getElementById('vidVolumeWrap');

  if (!video || !btnPlay || !selSpeed || !btnCC) return;

  // Ensure native controls are off (we provide our own overlay controls).
  video.controls = false;

  const fmtTime = (t) => {
    if (!Number.isFinite(t) || t < 0) t = 0;
    const s = Math.floor(t % 60);
    const m = Math.floor((t / 60) % 60);
    const h = Math.floor(t / 3600);
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  };

  const syncPlayIcon = () => {
    btnPlay.textContent = video.paused ? '▶' : '⏸';
  };

  const updateTimeUI = () => {
    if (!timeline || !timeLbl) return;
    const dur = (typeof getMediaDuration === 'function') ? getMediaDuration() : (Number.isFinite(video.duration) ? video.duration : 0);
    const cur = (typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : (Number.isFinite(video.currentTime) ? video.currentTime : 0);
    const max = 1000;
    timeline.max = String(max);
    timeline.value = String(dur > 0 ? Math.round((cur / dur) * max) : 0);
    timeLbl.textContent = `${fmtTime(cur)} / ${fmtTime(dur)}`;
  };

  // Caption overlay offset so captions never cover the transport bar
  const setCaptionOffset = (px) => {
    const root = document.querySelector('.frame-inner');
    if (!root) return;
    root.style.setProperty('--cc-bottom-offset', `${px}px`);
  };

  const computeAndApplyCaptionOffset = () => {
    // gap between captions and controls
    const GAP = 10;
    if (!controls) { setCaptionOffset(12); return; }
    // If controls are visible (hovered), reserve height.
    const visible = controls.matches(':hover') || controls.classList.contains('force-show');
    if (!visible) { setCaptionOffset(12); return; }
    const h = controls.getBoundingClientRect().height || 0;
    // captions baseline should sit above controls + gap + bottom padding (12)
    setCaptionOffset(12 + h + GAP);
  };

  btnPlay.addEventListener('click', () => {
    if (video.paused) video.play();
    else video.pause();
    syncPlayIcon();
  });

  video.addEventListener('play', syncPlayIcon);
  video.addEventListener('pause', syncPlayIcon);
  video.addEventListener('ended', syncPlayIcon);
  video.addEventListener('loadedmetadata', () => {
    syncPlayIcon();
    updateTimeUI();
  });
  video.addEventListener('timeupdate', updateTimeUI);
  video.addEventListener('durationchange', updateTimeUI);

  selSpeed.addEventListener('change', () => {
    const v = parseFloat(selSpeed.value || '1');
    video.playbackRate = Number.isFinite(v) ? v : 1;
  });

  // Scrub timeline
  if (timeline) {
    let scrubbing = false;

    const seekFromSlider = () => {
      const dur = Number.isFinite(video.duration) ? video.duration : 0;
      const v = parseFloat(timeline.value || '0');
      const max = parseFloat(timeline.max || '1000') || 1000;
      const t = dur > 0 ? (v / max) * dur : 0;
      video.currentTime = Math.max(0, Math.min(dur || 0, t));
    };

    timeline.addEventListener('input', () => {
      scrubbing = true;
      seekFromSlider();
      updateTimeUI();
    });

    timeline.addEventListener('change', () => {
      scrubbing = false;
    });

    // Prevent dragging from selecting text etc.
    timeline.addEventListener('pointerdown', () => { scrubbing = true; });
    window.addEventListener('pointerup', () => { scrubbing = false; });
  }

  const VOL_KEY = 'transcriberVolume';
  const savedVol = parseFloat(localStorage.getItem(VOL_KEY) || '1');
  video.volume = Number.isFinite(savedVol) ? Math.max(0, Math.min(1, savedVol)) : 1;
  video.muted = video.volume === 0;

  const syncVolumeUI = () => {
    const v = video.muted ? 0 : video.volume;
    if (volSlider) volSlider.value = String(v);
    if (btnMute) btnMute.textContent = v <= 0 ? '🔇' : (v < 0.5 ? '🔉' : '🔊');
  };

  if (volSlider){
    volSlider.addEventListener('input', () => {
      const v = parseFloat(volSlider.value || '1');
      video.volume = Math.max(0, Math.min(1, v));
      video.muted = v <= 0.001;
      localStorage.setItem(VOL_KEY, String(video.volume));
      syncVolumeUI();
    });
  }

  if (btnMute){
    btnMute.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (video.muted || video.volume <= 0.001){
        const restore = Math.max(0.35, parseFloat(localStorage.getItem(VOL_KEY) || '1'));
        video.muted = false;
        video.volume = restore;
      } else {
        video.muted = true;
      }
      if (volWrap) volWrap.classList.toggle('is-open');
      syncVolumeUI();
    });
  }

  document.addEventListener('click', (ev) => {
    if (volWrap && !volWrap.contains(ev.target)) volWrap.classList.remove('is-open');
  });
  video.addEventListener('volumechange', syncVolumeUI);
  syncVolumeUI();

  // Captions toggle controls the overlay captions div.
  let ccOn = true;
  const setCC = (on) => {
    ccOn = !!on;
    btnCC.setAttribute('aria-pressed', ccOn ? 'true' : 'false');
    btnCC.textContent = ccOn ? 'CC On' : 'CC Off';
    if (ccOverlay) ccOverlay.style.display = ccOn ? '' : 'none';
  };
  btnCC.addEventListener('click', () => setCC(!ccOn));
  setCC(true);

  // Keep selector in sync if code changes playbackRate elsewhere.
  video.addEventListener('ratechange', () => {
    const opts = Array.from(selSpeed.options).map(o => parseFloat(o.value));
    let best = opts[0], bestd = Math.abs(opts[0] - video.playbackRate);
    for (const o of opts) {
      const d = Math.abs(o - video.playbackRate);
      if (d < bestd) { bestd = d; best = o; }
    }
    selSpeed.value = String(best);
  });

  // Hover-driven caption offset updates
  if (controls) {
    controls.addEventListener('mouseenter', computeAndApplyCaptionOffset);
    controls.addEventListener('mouseleave', () => setCaptionOffset(12));
  }
  const frameInner = document.querySelector('.frame-inner');
  if (frameInner) {
    frameInner.addEventListener('mouseenter', computeAndApplyCaptionOffset);
    frameInner.addEventListener('mouseleave', () => setCaptionOffset(12));
  }
  window.addEventListener('resize', computeAndApplyCaptionOffset);

  // Initial state
  updateTimeUI();
  setCaptionOffset(12);
}


function ensureAppThemeToggle(){
  if (document.getElementById('appThemeToggle')) return;
  const brand = document.querySelector('.brand');
  if (!brand) return;
  const wrap = document.createElement('label');
  wrap.className = 'app-theme-toggle';
  wrap.title = 'Toggle Dark / Light Mode';
  wrap.innerHTML = `
    <input id="appThemeToggle" type="checkbox" aria-label="Toggle Dark or Light Mode">
    <span class="theme-track"><span class="theme-knob"></span></span>
    <span class="theme-label" id="appThemeLabel">Dark</span>
  `;
  brand.appendChild(wrap);
  const input = wrap.querySelector('#appThemeToggle');
  const label = wrap.querySelector('#appThemeLabel');
  const applyTheme = (mode) => {
    const light = mode === 'light';
    document.body.classList.toggle('theme-light', light);
    document.body.classList.toggle('theme-dark', !light);
    if (input) input.checked = light;
    if (label) label.textContent = light ? 'Light' : 'Dark';
    try{ localStorage.setItem('appThemeMode', light ? 'light' : 'dark'); }catch(_e){}
    try{
      const cueColor = document.getElementById('cueColor');
      if (cueColor){
        const v = String(cueColor.value || '').trim().toLowerCase();
        const darkDefaults = new Set(['#e7ecf3','#e9edf1','#dfe6ee','#f1f5f9','#ffffff']);
        const lightDefaults = new Set(['#151922','#111315','#1f2937','#222222','#000000']);
        // Old dark-mode default cue colors become almost invisible on light backgrounds.
        // Auto-swap only common defaults; user-selected non-default colors are left alone.
        if (light && darkDefaults.has(v)) cueColor.value = '#151922';
        if (!light && lightDefaults.has(v)) cueColor.value = '#e7ecf3';
        cueColor.dispatchEvent(new Event('input', { bubbles:true }));
      }
    }catch(_e){}
  };
  let saved = 'dark';
  try{ saved = localStorage.getItem('appThemeMode') || 'dark'; }catch(_e){}
  applyTheme(saved === 'light' ? 'light' : 'dark');
  input?.addEventListener('change', () => applyTheme(input.checked ? 'light' : 'dark'));
}

function ensureTranscriptBoundaryFix(){
  if (document.getElementById('transcriptBoundaryFixStyle')) return;
  const st = document.createElement('style');
  st.id = 'transcriptBoundaryFixStyle';
  st.textContent = `
    .transcript-panel{min-height:0;overflow:hidden}
    #transcriptSingleWrap{min-height:0;overflow:hidden}
    #dualWrap,.dual-wrap{min-height:0;overflow:hidden}
    .dual-col{min-height:0;overflow:hidden}
    #transcript,#transcriptB,#transcriptBHost,.transcript-b-host{box-sizing:border-box;scroll-padding-bottom:80px}
    #transcript,#transcriptB,#transcriptBHost{padding-bottom:72px}
    #transcript .line:last-child,#transcriptB .line:last-child{margin-bottom:48px}
    #txtBigBox,#txtBoxA,#txtBoxB{box-sizing:border-box;scroll-padding-bottom:96px;padding-bottom:96px}
    #txtBigBox .txt-cue:last-child,#txtBoxA .txt-cue:last-child,#txtBoxB .txt-cue:last-child{margin-bottom:56px}
    #txtDualWrap{min-height:0;overflow:hidden;flex:1 1 auto}
  `;
  document.head.appendChild(st);
}


/* ---------- Timeline Mode Phase 2: robust clip ordering, cue snap, dual SRT export ---------- */
let timelineLoopPreview = false;
let timelinePreviewQueue = [];
let timelinePreviewIndex = -1;
let timelineRulerPanState = null;
let timelineLastAutoScroll = 0;
let TIMELINE_COLOR_PICKER_OPEN = false;
let TIMELINE_COLOR_PICKER_CLIP_ID = '';

function getTimelineTrackChoice(){
  // The top SUBS control decides which subtitle cue markers are visible in Timeline Mode.
  // Export panel can still use "Current visible track", which resolves through getTimelineSubtitleSource().
  const top = timelineModeEl?.querySelector('#timelineSubModeTop')?.value;
  if (top === 'A' || top === 'B') return top;
  return timelineModeEl?.querySelector('#tlSubTrack')?.value || 'current';
}
function getTimelineTrackLists(trackChoice='current'){
  const choice = trackChoice === 'current' ? getTimelineSubtitleSource().track : String(trackChoice || 'A');
  if (choice === 'dual') return { mode:'dual', tracks:[{track:'A', list:entries || []}, {track:'B', list:entriesB || []}] };
  const track = normalizeTxtTrack(choice);
  return { mode:'single', tracks:[{track, list: track === 'B' ? (entriesB || []) : (entries || [])}] };
}
function snapTimeToFrameValue(t){
  const f = getFPS();
  return framesToSec(secToFrames(clampTimelineTime(t), f), f);
}
function setTimelineSelection(start, end, { seek=true } = {}){
  const f = getFPS();
  let a = snapTimeToFrameValue(Math.min(start, end));
  let b = snapTimeToFrameValue(Math.max(start, end));
  if (b <= a) b = Math.min(getTimelineDuration(), a + (1 / f));
  timelineSelection = { start:a, end:b };
  if (seek) seekMediaTo(a, { play:false });
  sendTimelineRangePreview(true);
  requestTimelineRender();
}
function getTimelineSelectedClip(){
  return timelineClips.find(c => c.id === timelineSelectedClipId) || null;
}
function isTimelineListNameEditing(){
  const active = document.activeElement;
  return !!(active && active.classList && active.classList.contains('tl-list-name') && timelineModeEl?.contains(active));
}
function timelineMakeUndoSnapshot(reason='edit'){
  return {
    reason,
    clips: JSON.parse(JSON.stringify((timelineClips || []).map((c, idx) => cleanTimelineClipForShare(c, idx)))),
    selectedClipId: String(timelineSelectedClipId || ''),
    selection: timelineSelection ? { start:Number(timelineSelection.start)||0, end:Number(timelineSelection.end)||0 } : null,
  };
}
function timelinePushUndo(reason='edit'){
  try{
    timelineUndoStack.push(timelineMakeUndoSnapshot(reason));
    if (timelineUndoStack.length > 40) timelineUndoStack.shift();
  }catch(_e){}
}
function timelineUndoLast(){
  const snap = timelineUndoStack.pop();
  if (!snap){ timelineSetStatus?.('Nothing to undo.'); return false; }
  timelineClips = Array.isArray(snap.clips) ? snap.clips.map((c, idx) => cleanTimelineClipForShare(c, idx)) : [];
  normalizeTimelineClips();
  timelineSelectedClipId = timelineClips.some(c => c.id === snap.selectedClipId) ? snap.selectedClipId : '';
  timelineSelection = snap.selection ? { start:Number(snap.selection.start)||0, end:Number(snap.selection.end)||0 } : null;
  requestTimelineRender();
  timelineCommitSharedState(true);
  timelineSetStatus?.(`Undid ${snap.reason || 'last timeline edit'}.`);
  return true;
}
function ensureTimelineConfirmModal(){
  if (timelineConfirmModalEl && document.body.contains(timelineConfirmModalEl)) return timelineConfirmModalEl;
  const wrap = document.createElement('div');
  wrap.id = 'timelineConfirmModal';
  wrap.className = 'tl-confirm-overlay hidden';
  wrap.innerHTML = `
    <div class="tl-confirm-card" role="dialog" aria-modal="true" aria-labelledby="tlConfirmTitle">
      <div class="tl-confirm-title" id="tlConfirmTitle">Delete timeline clip?</div>
      <div class="tl-confirm-body" id="tlConfirmBody">This will remove the selected clip from the timeline.</div>
      <div class="tl-confirm-actions">
        <button class="btn btn-outline" id="tlConfirmCancel" type="button">Cancel</button>
        <button class="btn btn-gold danger" id="tlConfirmDelete" type="button">Delete</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  return wrap;
}
function timelineConfirmDeleteClip(clip){
  return new Promise(resolve => {
    const modal = ensureTimelineConfirmModal();
    const body = modal.querySelector('#tlConfirmBody');
    const title = modal.querySelector('#tlConfirmTitle');
    const cancel = modal.querySelector('#tlConfirmCancel');
    const del = modal.querySelector('#tlConfirmDelete');
    const name = getTimelineClipDisplayName(clip, Math.max(0, timelineClips.findIndex(c => c.id === clip?.id)));
    if (title) title.textContent = 'Delete timeline clip?';
    if (body) body.innerHTML = `<b>${escapeHtml(name || 'Selected clip')}</b><br><span>${fmtTimelineTime(clip.start)} → ${fmtTimelineTime(clip.end)}</span><br><small>You can undo this with Ctrl+Z after deleting.</small>`;
    const close = (ok) => {
      modal.classList.add('hidden');
      cancel?.removeEventListener('click', onCancel);
      del?.removeEventListener('click', onDelete);
      modal.removeEventListener('click', onOverlay);
      document.removeEventListener('keydown', onKey);
      resolve(!!ok);
    };
    const onCancel = () => close(false);
    const onDelete = () => close(true);
    const onOverlay = (ev) => { if (ev.target === modal) close(false); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(false); if (ev.key === 'Enter') close(true); };
    cancel?.addEventListener('click', onCancel);
    del?.addEventListener('click', onDelete);
    modal.addEventListener('click', onOverlay);
    document.addEventListener('keydown', onKey);
    modal.classList.remove('hidden');
    setTimeout(() => del?.focus?.(), 0);
  });
}
async function deleteTimelineClipWithConfirm(clipId){
  const clip = timelineClips.find(c => c.id === clipId);
  if (!clip) return false;
  if (isTimelineClipRemoteLocked(clip.id)){ timelineSetStatus('This clip is locked by another user.'); return false; }
  const ok = await timelineConfirmDeleteClip(clip);
  if (!ok) return false;
  timelinePushUndo('clip deletion');
  timelineClips = timelineClips.filter(c => c.id !== clip.id);
  if (timelineSelectedClipId === clip.id) timelineSelectedClipId = '';
  requestTimelineRender();
  timelineCommitSharedState(true);
  timelineSetStatus(`Deleted ${getTimelineClipDisplayName(clip)}. Press Ctrl+Z to undo.`);
  return true;
}
function getTimelineActivePreviewRange(){
  const clip = getTimelineSelectedClip();
  if (clip && Number(clip.end) > Number(clip.start)){
    return { start:Number(clip.start), end:Number(clip.end), clip, source:'clip' };
  }
  if (!timelineSelection) createDefaultTimelineSelection();
  if (timelineSelection){
    const a = Math.min(Number(timelineSelection.start) || 0, Number(timelineSelection.end) || 0);
    const b = Math.max(Number(timelineSelection.start) || 0, Number(timelineSelection.end) || 0);
    return { start:a, end:b, clip:null, source:'selection' };
  }
  return null;
}
function previewTimelineActiveClipOrSelection(){
  const range = getTimelineActivePreviewRange();
  if (!range || range.end <= range.start + (1 / getFPS())){ alert('No valid clip or range to preview.'); return; }
  timelineSelection = { start:range.start, end:range.end };
  requestTimelineRender();
  const label = range.clip ? `Preview Clip · ${getTimelineClipDisplayName(range.clip)}` : 'Preview Selection';
  previewMediaRange(range.start, range.end, {
    label,
    onStop: () => {
      try{ timelineSetStatus(`Preview stopped at ${fmtTimelineTime(range.end)}.`); }catch(_e){}
      requestTimelineRender();
    }
  });
}
function trimTimelineSelectedClipToPlayhead(edge){
  const clip = getTimelineSelectedClip();
  if (!clip) return false;
  if (isTimelineClipRemoteLocked(clip.id)){ timelineSetStatus('This clip is locked by another user.'); return true; }
  const t = snapTimeToFrameValue((typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : 0);
  const minDur = 1 / getFPS();
  if (edge === 'in'){
    if (t >= Number(clip.end) - minDur){ timelineSetStatus('In point must stay before the clip Out point.'); return true; }
    clip.start = Math.max(0, t);
  } else if (edge === 'out'){
    if (t <= Number(clip.start) + minDur){ timelineSetStatus('Out point must stay after the clip In point.'); return true; }
    clip.end = Math.min(getTimelineDuration(), t);
  } else {
    return false;
  }
  clip.start = snapTimeToFrameValue(clip.start);
  clip.end = snapTimeToFrameValue(clip.end);
  timelineSelection = { start:clip.start, end:clip.end };
  timelineSetStatus(`${edge === 'in' ? 'In' : 'Out'} set for ${getTimelineClipDisplayName(clip)}.`);
  requestTimelineRender();
  timelineCommitSharedState(true);
  return true;
}
function moveTimelineClipOrder(clipId, dir){
  const i = timelineClips.findIndex(c => c.id === clipId);
  if (i < 0) return;
  const j = Math.max(0, Math.min(timelineClips.length - 1, i + dir));
  if (i === j) return;
  const [item] = timelineClips.splice(i, 1);
  timelineClips.splice(j, 0, item);
  timelineSelectedClipId = item.id;
  requestTimelineRender();
  timelineCommitSharedState();
}
function normalizeTimelineClips(){
  const f = getFPS();
  const minDur = 1 / f;
  const dur = getTimelineDuration();
  timelineClips.forEach((c, idx) => {
    c.id = c.id || makeTimelineClipId();
    c.start = snapTimeToFrameValue(Math.max(0, Math.min(dur, Number(c.start) || 0)));
    c.end = snapTimeToFrameValue(Math.max(0, Math.min(dur, Number(c.end) || 0)));
    if (c.end <= c.start) c.end = Math.min(dur, c.start + minDur);
    c.label = String(c.label || timelineClipBaseLabel(idx));
    c.ownerId = String(c.ownerId || c.owner_id || 'local');
    c.ownerLabel = String(c.ownerLabel || c.owner_label || (c.ownerId === 'local' ? 'Local' : 'User'));
    c.ownerColor = String(c.ownerColor || c.owner_color || c.color || timelineDefaultClipColor(idx));
    c.color = String(c.color || c.ownerColor || timelineDefaultClipColor(idx));
    if (c.enabled !== false) c.enabled = true;
  });
}
function timelineSetStatus(text){
  const status = timelineModeEl?.querySelector('#tlStatus');
  if (status) status.textContent = text;
}

function getTimelineExportClips(){
  normalizeTimelineClips();
  return timelineClips.filter(c => c.enabled !== false && (Number(c.end) || 0) > (Number(c.start) || 0));
}
function timelineDefaultClipColor(idx=0){
  const palette = ['#d7b46a', '#4f8cff', '#22c55e', '#f97316', '#a855f7', '#ef4444', '#14b8a6', '#f59e0b'];
  return palette[Math.max(0, idx) % palette.length];
}
function getTimelineOwnerLabel(){
  return String(COLLAB_USER_LABEL || localStorage.getItem('transcriber_collab_label') || 'User 1').trim() || 'User 1';
}
function getTimelineOwnerId(){
  return String(COLLAB_USER_ID || localStorage.getItem('transcriber_collab_user_id') || 'local');
}
function getTimelineOwnerColor(){
  const c = String(COLLAB_USER_COLOR || localStorage.getItem('transcriber_collab_color') || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : '#4f8cff';
}
function timelineClipBaseLabel(idx){
  return 'Clip ' + String(Math.max(1, Number(idx || 0) + 1)).padStart(2, '0');
}
function getTimelineClipDisplayName(clip, idx=0){
  const label = String(clip?.label || timelineClipBaseLabel(idx)).trim();
  const owner = String(clip?.ownerLabel || clip?.owner_label || 'Local').trim();
  return owner ? `${label}. ${owner}` : label;
}
function cleanTimelineClipForShare(clip, idx=0){
  return {
    id: String(clip?.id || makeTimelineClipId()),
    label: String(clip?.label || timelineClipBaseLabel(idx)),
    ownerId: String(clip?.ownerId || clip?.owner_id || 'local'),
    ownerLabel: String(clip?.ownerLabel || clip?.owner_label || 'Local'),
    ownerColor: String(clip?.ownerColor || clip?.owner_color || clip?.color || timelineDefaultClipColor(idx)),
    start: Number(clip?.start || 0),
    end: Number(clip?.end || 0),
    color: String(clip?.color || clip?.ownerColor || timelineDefaultClipColor(idx)),
    enabled: clip?.enabled !== false,
    createdAt: Number(clip?.createdAt || clip?.created_at || Date.now()),
    source: String(clip?.source || clip?.source_type || ''),
    reason: String(clip?.reason || ''),
    cueRefs: Array.isArray(clip?.cueRefs) ? clip.cueRefs.map(x => String(x)).filter(Boolean) : [],
    track: String(clip?.track || 'A'),
    storyRowId: String(clip?.storyRowId || ''),
    storyCardId: String(clip?.storyCardId || ''),
    storyKind: String(clip?.storyKind || ''),
    storyLabel: String(clip?.storyLabel || ''),
    sourceMedia: String(clip?.sourceMedia || ''),
  };
}

function timelineWsSend(payload){
  if (!COLLAB_SESSION_ID || !COLLAB_WS_CONNECTED || !COLLAB_WS || COLLAB_WS.readyState !== WebSocket.OPEN) return false;
  try{
    COLLAB_WS.send(JSON.stringify(Object.assign({ user_id: COLLAB_USER_ID }, payload || {})));
    return true;
  }catch(_e){ return false; }
}
function timelineCommitSharedState(force=false){
  if (!COLLAB_SESSION_ID || VIEW_ONLY_SESSION || COLLAB_APPLYING) return;
  if (COLLAB_TIMELINE_STATE_TIMER) clearTimeout(COLLAB_TIMELINE_STATE_TIMER);
  COLLAB_TIMELINE_STATE_TIMER = setTimeout(() => {
    try{ maybeSendCollabStateOverWebSocket?.({ force: !!force }); }catch(_e){}
  }, force ? 30 : 240);
}
function timelineUserLabel(uid){
  if (uid === COLLAB_USER_ID) return COLLAB_USER_LABEL || 'You';
  return collabUserName(uid) || 'User';
}
function timelineUserColor(uid){
  if (uid === COLLAB_USER_ID) return COLLAB_USER_COLOR || '#4f8cff';
  return collabUserColor(uid) || '#4f8cff';
}
function sendTimelinePresence(action='viewing', time=null, opts={}){
  if (!COLLAB_SESSION_ID || !COLLAB_USER_ID || VIEW_ONLY_SESSION) return;
  const now = Date.now();
  if (!opts.force && now - COLLAB_TIMELINE_LAST_SEND_MS < 90) return;
  COLLAB_TIMELINE_LAST_SEND_MS = now;
  const t = clampTimelineTime(time != null ? time : ((typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : 0));
  timelineWsSend({
    type:'timeline_presence',
    time:t,
    action:String(action || 'viewing'),
    clip_id:String(opts.clipId || ''),
    range: timelineSelection ? { start:Number(timelineSelection.start || 0), end:Number(timelineSelection.end || 0) } : null,
  });
}
function sendTimelineRangePreview(active=true, opts={}){
  if (!COLLAB_SESSION_ID || !COLLAB_USER_ID || VIEW_ONLY_SESSION) return;
  if (!timelineSelection && active) return;
  const a = timelineSelection ? Math.min(timelineSelection.start, timelineSelection.end) : 0;
  const b = timelineSelection ? Math.max(timelineSelection.start, timelineSelection.end) : 0;
  timelineWsSend({
    type:'timeline_range_preview',
    active:!!active,
    persisted: !!opts.persisted || String(opts.status || '') === 'selected',
    status: String(opts.status || (active ? 'selecting' : 'cleared')),
    start:a,
    end:b
  });
}
function sendTimelineClipLock(clipId, action='edit'){
  if (!clipId || !COLLAB_SESSION_ID || !COLLAB_USER_ID || VIEW_ONLY_SESSION) return false;
  return timelineWsSend({ type:'lock_timeline_clip', clip_id:String(clipId), action:String(action || 'edit') });
}
function sendTimelineClipUnlock(clipId){
  if (!clipId || !COLLAB_SESSION_ID || !COLLAB_USER_ID || VIEW_ONLY_SESSION) return false;
  return timelineWsSend({ type:'unlock_timeline_clip', clip_id:String(clipId) });
}
function getTimelineRemoteLock(clipId){
  const lock = COLLAB_TIMELINE_LOCKS ? COLLAB_TIMELINE_LOCKS[String(clipId || '')] : null;
  if (!lock || lock.user_id === COLLAB_USER_ID) return null;
  return lock;
}
function isTimelineClipRemoteLocked(clipId){ return !!getTimelineRemoteLock(clipId); }
function applyTimelineLocksFromList(locks){
  COLLAB_TIMELINE_LOCKS = {};
  (locks || []).forEach(l => {
    if (!l) return;
    if ((l.kind === 'timeline_clip' || l.clip_id) && l.user_id !== COLLAB_USER_ID){
      COLLAB_TIMELINE_LOCKS[String(l.clip_id)] = l;
    }
  });
  requestTimelineRender?.();
}
function cleanupTimelinePresenceMaps(){
  const now = Date.now();
  for (const [uid,v] of Object.entries(COLLAB_TIMELINE_PRESENCE || {})){
    if (!v || now - Number(v.ts || 0) > 12000) delete COLLAB_TIMELINE_PRESENCE[uid];
  }
  for (const [uid,v] of Object.entries(COLLAB_TIMELINE_RANGES || {})){
    // Persist other users' latest range selection long enough to remain useful.
    // If the user's timeline presence has expired, remove the range as well.
    const presence = COLLAB_TIMELINE_PRESENCE ? COLLAB_TIMELINE_PRESENCE[uid] : null;
    const staleRange = !v || now - Number(v.ts || 0) > 120000;
    const stalePresence = !presence || now - Number(presence.ts || 0) > 20000;
    if (staleRange || stalePresence) delete COLLAB_TIMELINE_RANGES[uid];
  }
}
function ensureTimelinePresenceHeartbeat(){
  if (COLLAB_TIMELINE_PRESENCE_TIMER) return;
  COLLAB_TIMELINE_PRESENCE_TIMER = setInterval(() => {
    if (isTimelineMode && COLLAB_WS_CONNECTED) {
      sendTimelinePresence('viewing');
      // Re-broadcast the latest local range so collaborators who joined later,
      // or whose transient map expired, can still see it.
      if (timelineSelection) sendTimelineRangePreview(true, { status:'selected', persisted:true });
    }
    cleanupTimelinePresenceMaps();
    if (isTimelineMode) requestTimelineRender();
  }, 1500);
}
function renderTimelineCollabAwareness(){
  if (!timelineModeEl) return;
  cleanupTimelinePresenceMaps();
  const playHost = timelineModeEl.querySelector('#tlRemotePlayheads');
  const rangeHost = timelineModeEl.querySelector('#tlRemoteRanges');
  const presenceHost = timelineModeEl.querySelector('#tlPresence');
  if (playHost){
    let html = '';
    for (const [uid,v] of Object.entries(COLLAB_TIMELINE_PRESENCE || {})){
      if (!v || uid === COLLAB_USER_ID) continue;
      const color = v.color || timelineUserColor(uid);
      const label = v.label || timelineUserLabel(uid);
      const left = timelineTimeToPx(Number(v.time || 0));
      html += `<div class="tl-remote-playhead" style="left:${left}px;--user-color:${escapeHtml(color)}"><span>${escapeHtml(label)}</span></div>`;
    }
    playHost.innerHTML = html;
  }
  if (rangeHost){
    let html = '';
    for (const [uid,v] of Object.entries(COLLAB_TIMELINE_RANGES || {})){
      if (!v || uid === COLLAB_USER_ID || v.active === false) continue;
      const a = Math.min(Number(v.start || 0), Number(v.end || 0));
      const b = Math.max(Number(v.start || 0), Number(v.end || 0));
      if (b <= a) continue;
      const color = v.color || timelineUserColor(uid);
      const label = v.label || timelineUserLabel(uid);
      const status = String(v.status || (v.persisted ? 'selected' : 'selecting'));
      const verb = status === 'selected' ? 'range' : 'selecting';
      html += `<div class="tl-remote-range ${status === 'selected' ? 'is-persisted' : ''}" style="left:${timelineTimeToPx(a)}px;width:${Math.max(2,timelineTimeToPx(b)-timelineTimeToPx(a))}px;--user-color:${escapeHtml(color)}"><span>${escapeHtml(label)} ${verb} ${fmtTimelineTime(a)} → ${fmtTimelineTime(b)}</span></div>`;
    }
    rangeHost.innerHTML = html;
  }
  if (presenceHost){
    const items = [];
    if (COLLAB_SESSION_ID){
      items.push(`<span class="tl-presence-chip self" style="--user-color:${escapeHtml(COLLAB_USER_COLOR || '#d7b46a')}"><i></i>You</span>`);
    }
    for (const [uid,v] of Object.entries(COLLAB_TIMELINE_PRESENCE || {})){
      if (!v || uid === COLLAB_USER_ID) continue;
      const color = v.color || timelineUserColor(uid);
      const label = v.label || timelineUserLabel(uid);
      const action = v.action ? ` — ${v.action}` : '';
      items.push(`<span class="tl-presence-chip" style="--user-color:${escapeHtml(color)}"><i></i>${escapeHtml(label + action)}</span>`);
    }
    for (const [clipId,l] of Object.entries(COLLAB_TIMELINE_LOCKS || {})){
      if (!l || l.user_id === COLLAB_USER_ID) continue;
      const color = l.user_color || timelineUserColor(l.user_id);
      const label = l.user_label || timelineUserLabel(l.user_id);
      const clip = timelineClips.find(c => c.id === clipId);
      items.push(`<span class="tl-presence-chip locked" style="--user-color:${escapeHtml(color)}"><i></i>${escapeHtml(label)} editing ${escapeHtml(clip?.label || 'clip')}</span>`);
    }
    presenceHost.innerHTML = items.length ? items.join('') : '<span class="tl-presence-empty">Timeline collaboration appears here.</span>';
  }
}

function timelineLiveSeek(t){
  const tt = snapTimeToFrameValue(t);
  try{ pauseMedia(); }catch(_e){}
  try{ seekMediaTo(tt, { play:false }); }catch(_e){}
  try{ updateTimelinePlayhead(tt); }catch(_e){}
  return tt;
}
function timelinePointerTimeInContent(ev){
  const content = timelineModeEl?.querySelector('#tlContent');
  if (!content) return 0;
  const rect = content.getBoundingClientRect();
  return timelinePxToTime(ev.clientX - rect.left);
}
function bindTimelineRulerPan(){
  const ruler = timelineModeEl?.querySelector('#tlRuler');
  const scroll = timelineModeEl?.querySelector('#tlScroll');
  if (!ruler || !scroll || ruler.__panBound) return;
  ruler.__panBound = true;
  ruler.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    timelineRulerPanState = { x:ev.clientX, scrollLeft:scroll.scrollLeft };
    ruler.classList.add('is-panning');
    ruler.setPointerCapture?.(ev.pointerId);
    const move = (e) => {
      if (!timelineRulerPanState) return;
      scroll.scrollLeft = Math.max(0, timelineRulerPanState.scrollLeft - (e.clientX - timelineRulerPanState.x));
    };
    const up = (e) => {
      ruler.releasePointerCapture?.(e.pointerId);
      ruler.classList.remove('is-panning');
      timelineRulerPanState = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once:true });
  });
}

function ensureTimelineMode(){
  if (timelineModeEl && document.body.contains(timelineModeEl)) return timelineModeEl;
  const parent = document.querySelector('.transcript-panel') || document.body;
  timelineModeEl = document.createElement('div');
  timelineModeEl.id = 'timelineMode';
  timelineModeEl.className = 'timeline-mode timeline-phase2';
  timelineModeEl.style.display = 'none';
  timelineModeEl.innerHTML = `
    <div class="tl-head">
      <div>
        <div class="tl-title">Timeline Mode</div>
        <div class="tl-sub">Select ranges, reorder clips, preview the rough cut, then export stitched video + re-timed subtitles.</div>
      </div>
      <div class="tl-actions">
        <label class="tl-sub-top">SUBS <select id="timelineSubModeTop" class="subs-mode"><option value="A">Sub A</option><option value="B">Sub B</option></select></label>
        <button class="btn btn-outline" id="tlFit" type="button">Fit</button>
        <button class="btn btn-outline tl-zoom-btn" id="tlZoomOut" type="button">−</button>
        <label class="tl-zoom-label">Zoom <input id="tlZoom" type="range" min="1" max="800" step="1" value="28"></label>
        <button class="btn btn-outline tl-zoom-btn" id="tlZoomIn" type="button">+</button>
        <button class="btn btn-outline" id="tlSnapCue" type="button">Snap to Cue</button>
        <button class="btn btn-outline" id="tlSetIn" type="button">Set In</button>
        <button class="btn btn-outline" id="tlSetOut" type="button">Set Out</button>
        <button class="btn btn-outline" id="tlPreviewClip" type="button">Preview Clip</button>
        <button class="btn btn-gold" id="tlAddClip" type="button">Add Clip</button>
        <button class="btn btn-gold" id="tlAiSelect" type="button">AI Select</button>
      </div>
    </div>
    <div class="tl-status" id="tlStatus">No clips yet. Drag on the timeline to create a selection.</div>
    <div class="tl-presence" id="tlPresence"><span class="tl-presence-empty">Timeline collaboration appears here.</span></div>
    <div class="tl-scroll" id="tlScroll">
      <div class="tl-content" id="tlContent">
        <div class="tl-ruler" id="tlRuler"></div>
        <div class="tl-lane" id="tlLane">
          <div class="tl-playhead" id="tlPlayhead"></div>
          <div class="tl-remote-playheads" id="tlRemotePlayheads"></div>
          <div class="tl-remote-ranges" id="tlRemoteRanges"></div>
          <div class="tl-selection" id="tlSelection" hidden><span></span></div>
          <div class="tl-cue-markers" id="tlCueMarkers"></div>
          <div class="tl-clips" id="tlClips"></div>
        </div>
      </div>
    </div>
    <div class="tl-bottom">
      <div class="tl-clip-list" id="tlClipList"></div>
      <div class="tl-export-panel">
        <label>Export Quality
          <select id="tlExportMode">
            <option value="accurate" selected>Accurate / Re-encode</option>
            <option value="fast">Fast / Keyframe Cut</option>
          </select>
        </label>
        <label>Subtitle Track
          <select id="tlSubTrack">
            <option value="current" selected>Current visible track</option>
            <option value="A">Sub A</option>
            <option value="B">Sub B</option>
            <option value="dual">Dual Sub A + B</option>
          </select>
        </label>
        <label>Aspect Ratio
          <select id="tlAspectRatio">
            <option value="16:9" selected>16 : 9</option>
            <option value="9:16">9 : 16 Vertical</option>
          </select>
        </label>
        <div class="tl-export-note">Export order follows the checked clip list. Vertical export uses a center crop, so it keeps the middle of the frame rather than doing AI subject tracking.</div>
        <button class="btn btn-outline" id="tlPreviewExport" type="button">Preview</button>
        <button class="btn btn-gold" id="tlExport" type="button">Export Cut</button>
        <div class="tl-export-links" id="tlExportLinks"></div>
      </div>
    </div>
  `;
  parent.appendChild(timelineModeEl);
  bindTimelineMode();
  return timelineModeEl;
}

function bindTimelineMode(){
  const el = timelineModeEl;
  if (!el || el.__bound) return;
  el.__bound = true;
  const scroll = el.querySelector('#tlScroll');
  const lane = el.querySelector('#tlLane');
  const zoom = el.querySelector('#tlZoom');
  el.querySelector('#tlFit')?.addEventListener('click', () => fitTimelineZoom());
  el.querySelector('#tlZoomIn')?.addEventListener('click', () => setTimelineZoom(timelinePxPerSec * 1.25));
  el.querySelector('#tlZoomOut')?.addEventListener('click', () => setTimelineZoom(timelinePxPerSec / 1.25));
  zoom?.addEventListener('input', () => setTimelineZoom(Number(zoom.value) || timelinePxPerSec));
  el.querySelector('#tlPreviewClip')?.addEventListener('click', () => previewTimelineActiveClipOrSelection());
  el.querySelector('#tlAddClip')?.addEventListener('click', () => addTimelineClipFromSelection());
  el.querySelector('#tlAiSelect')?.addEventListener('click', () => openTimelineAiModal());
  el.querySelector('#tlExport')?.addEventListener('click', () => exportTimelineCut());
  el.querySelector('#tlSnapCue')?.addEventListener('click', () => snapTimelineSelectionToCurrentCue());
  el.querySelector('#tlSetIn')?.addEventListener('click', () => setTimelineInAtPlayhead());
  el.querySelector('#tlSetOut')?.addEventListener('click', () => setTimelineOutAtPlayhead());
  el.querySelector('#tlPreviewExport')?.addEventListener('click', () => openTimelinePreviewModal());
  el.querySelector('#timelineSubModeTop')?.addEventListener('change', (ev) => { setStoryTimelineSubMode(ev.currentTarget.value); requestTimelineRender(); });
  el.querySelector('#tlSubTrack')?.addEventListener('change', () => requestTimelineRender());
  scroll?.addEventListener('scroll', () => requestTimelineRender(), { passive:true });
  scroll?.addEventListener('wheel', (ev) => {
    if (ev.ctrlKey || ev.metaKey){
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.18 : 0.85;
      setTimelineZoom(timelinePxPerSec * factor);
      return;
    }
    // Normal mouse wheel scrolls through the horizontal timeline.
    ev.preventDefault();
    const dx = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
    scroll.scrollLeft += dx;
  }, { passive:false });
  bindTimelineRulerPan();
  lane?.addEventListener('pointerdown', onTimelineLanePointerDown);
  document.addEventListener('keydown', (ev) => {
    if (!isTimelineMode) return;
    if (timelineConfirmModalEl && !timelineConfirmModalEl.classList.contains('hidden')) return;
    if (ev.target && ['INPUT','TEXTAREA','SELECT'].includes(ev.target.tagName)) return;
    if ((ev.ctrlKey || ev.metaKey) && String(ev.key || '').toLowerCase() === 'z'){
      ev.preventDefault();
      timelineUndoLast();
      return;
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace'){
      if (timelineSelectedClipId){
        ev.preventDefault();
        deleteTimelineClipWithConfirm(timelineSelectedClipId);
      }
    } else if (ev.key === '['){
      ev.preventDefault(); setTimelineInAtPlayhead();
    } else if (ev.key === ']'){
      ev.preventDefault(); setTimelineOutAtPlayhead();
    } else if (ev.key === 'Enter'){
      ev.preventDefault(); addTimelineClipFromSelection();
    } else if (ev.key === 'ArrowUp' && (ev.altKey || ev.metaKey)){
      ev.preventDefault(); if (timelineSelectedClipId) moveTimelineClipOrder(timelineSelectedClipId, -1);
    } else if (ev.key === 'ArrowDown' && (ev.altKey || ev.metaKey)){
      ev.preventDefault(); if (timelineSelectedClipId) moveTimelineClipOrder(timelineSelectedClipId, 1);
    }
  });
}


function centerTimelineOnTime(t){
  const scroll = timelineModeEl?.querySelector('#tlScroll');
  if (!scroll) return;
  const x = timelineTimeToPx(clampTimelineTime(t));
  scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 2);
}
function centerTimelineOnPlayhead(){
  const t = (typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : 0;
  centerTimelineOnTime(t);
}
function setTimelineZoom(v, opts={}){
  const scroll = timelineModeEl?.querySelector('#tlScroll');
  const focusT = opts.focusTime != null
    ? clampTimelineTime(opts.focusTime)
    : ((typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : 0);
  const f = getFPS();
  const max = Math.max(160, f * 16); // 16px/frame at max zoom
  timelinePxPerSec = Math.max(1, Math.min(max, Number(v) || 1));
  const zoom = timelineModeEl?.querySelector('#tlZoom');
  if (zoom){ zoom.max = String(max); zoom.value = String(Math.round(timelinePxPerSec)); }
  requestTimelineRender();
  if (scroll){
    requestAnimationFrame(() => centerTimelineOnTime(focusT));
  }
}
function showTimelineMode(){
  ensureTimelineMode();
  if (!timelineSelection) createDefaultTimelineSelection();
  setTranscriptWorkAreaHidden(true);
  if (singleWrap) singleWrap.style.display = 'none';
  if (dualWrap){ dualWrap.hidden = true; dualWrap.style.display = 'none'; }
  timelineModeEl.style.display = 'flex';
  ensureTimelinePresenceHeartbeat();
  sendTimelinePresence('viewing', null, { force:true });
  const findBar = document.getElementById('transcriptFindBar');
  if (findBar) findBar.style.display = 'none';
  const singleBar = document.getElementById('singleSubBar');
  if (singleBar) singleBar.style.display = 'none';
  if (transcriptEl) transcriptEl.style.display = 'none';
  if (txtBoxEl) txtBoxEl.style.display = 'none';
  if (txtDualWrapEl){ txtDualWrapEl.hidden = true; txtDualWrapEl.style.display = 'none'; }
  fitTimelineZoom();
  bindTimelineRulerPan();
  requestTimelineRender();
}
function renderTimelineMode(){
  const el = ensureTimelineMode();
  if (!el || el.style.display === 'none') return;
  normalizeTimelineClips();
  const dur = getTimelineDuration();
  const content = el.querySelector('#tlContent');
  const scroll = el.querySelector('#tlScroll');
  const ruler = el.querySelector('#tlRuler');
  const clipsHost = el.querySelector('#tlClips');
  const selEl = el.querySelector('#tlSelection');
  const cueHost = el.querySelector('#tlCueMarkers');
  const status = el.querySelector('#tlStatus');
  const zoom = el.querySelector('#tlZoom');
  const width = Math.max((scroll?.clientWidth || 900), Math.ceil(dur * timelinePxPerSec) + 2);
  if (content) content.style.width = width + 'px';
  if (zoom) zoom.value = String(Math.round(timelinePxPerSec));
  renderTimelineRuler(ruler, scroll, dur);
  renderTimelineCueMarkers(cueHost, scroll, dur);
  renderTimelineSelection(selEl);
  renderTimelineClips(clipsHost);
  renderTimelineCollabAwareness();
  updateTimelinePlayhead((typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : 0);
  const enabledClips = getTimelineExportClips();
  const total = enabledClips.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0);
  if (status) status.textContent = timelineClips.length ? `${enabledClips.length}/${timelineClips.length} clip(s) checked · final duration ${fmtTimelineTime(total)} · zoom ${Math.round(timelinePxPerSec)} px/s · ${Math.max(1, Math.round(timelinePxPerSec / getFPS()))} px/frame` : 'No clips yet. Drag on the timeline to create a selection, or snap to the current cue.';
  renderTimelineClipList();
}
function renderTimelineCueMarkers(host, scroll, dur){
  if (!host || !scroll) return;
  const { tracks } = getTimelineTrackLists(getTimelineTrackChoice());
  const viewStart = timelinePxToTime(scroll.scrollLeft - 200);
  const viewEnd = timelinePxToTime(scroll.scrollLeft + scroll.clientWidth + 300);
  let html = '';
  tracks.forEach((tr, ti) => {
    const rowTop = ti * 34;
    (tr.list || []).forEach((cue, i) => {
      const s = Number(cue.start) || 0, e = Number(cue.end) || 0;
      if (e < viewStart || s > viewEnd) return;
      const left = timelineTimeToPx(s);
      const width = Math.max(4, timelineTimeToPx(Math.min(e, dur)) - left);
      const cls = tr.track === 'B' ? ' b' : ' a';
      const txt = String(cue.text || '').replace(/\s+/g, ' ').trim();
      html += `<button class="tl-cue-marker${cls}" data-track="${tr.track}" data-index="${i}" title="${escapeHtml(tr.track)} ${fmtTimelineTime(s)} → ${fmtTimelineTime(e)} · ${escapeHtml(txt)}" style="left:${left}px;width:${width}px;top:${rowTop}px"><span>${escapeHtml(txt || (tr.track + ' cue ' + (i+1)))}</span></button>`;
    });
  });
  host.innerHTML = html;
  host.querySelectorAll('.tl-cue-marker').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const tr = btn.dataset.track === 'B' ? 'B' : 'A';
      const list = tr === 'B' ? entriesB : entries;
      const cue = list[Number(btn.dataset.index) || 0];
      if (cue){ setTimelineSelection(cue.start, cue.end); timelineLiveSeek(cue.start); }
    });
  });
}
function renderTimelineClips(host){
  if (!host) return;
  host.innerHTML = '';
  timelineClips.forEach((clip, idx) => {
    const block = document.createElement('div');
    block.className = 'tl-clip' + (clip.id === timelineSelectedClipId ? ' selected' : '');
    block.dataset.id = clip.id;
    block.style.left = timelineTimeToPx(clip.start) + 'px';
    block.style.width = Math.max(8, timelineTimeToPx(clip.end) - timelineTimeToPx(clip.start)) + 'px';
    block.style.setProperty('--clip-color', clip.color || timelineDefaultClipColor(idx));
    if (clip.enabled === false) block.classList.add('disabled');
    const remoteLock = getTimelineRemoteLock(clip.id);
    if (remoteLock) block.classList.add('remote-locked');
    const lockBadge = remoteLock ? `<div class="tl-lock-badge" style="--user-color:${escapeHtml(remoteLock.user_color || timelineUserColor(remoteLock.user_id))}">${escapeHtml(remoteLock.user_label || timelineUserLabel(remoteLock.user_id))}</div>` : '';
    block.innerHTML = `<div class="tl-handle left" data-edge="left"></div><div class="tl-clip-label"><b>${idx+1}</b> ${escapeHtml(getTimelineClipDisplayName(clip, idx))}</div><div class="tl-handle right" data-edge="right"></div>${lockBadge}`;
    block.addEventListener('pointerdown', onTimelineClipPointerDown);
    block.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      const next = prompt('Clip name:', clip.label || timelineClipBaseLabel(idx));
      if (next != null){ clip.label = next.trim() || clip.label || timelineClipBaseLabel(idx); requestTimelineRender(); timelineCommitSharedState(); }
    });
    host.appendChild(block);
  });
}
function onTimelineClipPointerDown(ev){
  ev.preventDefault();
  const block = ev.currentTarget;
  const clip = timelineClips.find(c => c.id === block.dataset.id);
  if (!clip) return;
  const remoteLock = getTimelineRemoteLock(clip.id);
  if (remoteLock){
    timelineSetStatus(`${remoteLock.user_label || timelineUserLabel(remoteLock.user_id)} is editing ${clip.label || 'this clip'}.`);
    return;
  }
  timelineSelectedClipId = clip.id;
  const edge = ev.target?.dataset?.edge || '';
  const startX = ev.clientX;
  const original = { start:clip.start, end:clip.end };
  timelineDragState = { kind: edge ? 'trim' : 'move', edge, clipId:clip.id, startX, original };
  sendTimelineClipLock(clip.id, edge ? ('trim_' + edge) : 'move');
  sendTimelinePresence(edge ? ('trimming ' + clip.label) : ('moving ' + clip.label), clip.start, { force:true, clipId:clip.id });
  block.setPointerCapture?.(ev.pointerId);
  seekMediaTo(clip.start, { play:false });
  const move = (e) => {
    const c = timelineClips.find(x => x.id === clip.id); if (!c) return;
    timelineAutoScrollWhileDragging(e);
    const dt = (e.clientX - startX) / timelinePxPerSec;
    const minDur = 1 / getFPS();
    if (timelineDragState.kind === 'move'){
      const cdur = original.end - original.start;
      let ns = snapTimeToFrameValue(original.start + dt);
      if (ns + cdur > getTimelineDuration()) ns = Math.max(0, getTimelineDuration() - cdur);
      c.start = ns; c.end = snapTimeToFrameValue(ns + cdur);
    } else if (edge === 'left'){
      c.start = snapTimeToFrameValue(Math.min(c.end - minDur, Math.max(0, original.start + dt)));
    } else if (edge === 'right'){
      c.end = snapTimeToFrameValue(Math.max(c.start + minDur, Math.min(getTimelineDuration(), original.end + dt)));
    }
    timelineSelection = { start:c.start, end:c.end };
    const liveT = edge === 'right' ? c.end : c.start;
    timelineLiveSeek(liveT);
    sendTimelinePresence(edge === 'right' ? 'trimming out' : 'trimming in', liveT, { clipId:clip.id });
    requestTimelineRender();
  };
  const up = (e) => { block.releasePointerCapture?.(e.pointerId); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); timelineDragState=null; sendTimelineClipUnlock(clip.id); sendTimelinePresence('viewing', (edge === 'right' ? clip.end : clip.start), { force:true }); requestTimelineRender(); timelineCommitSharedState(true); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once:true });
}
function addTimelineClipFromSelection(){
  if (!timelineSelection) createDefaultTimelineSelection();
  const a = Math.min(timelineSelection.start, timelineSelection.end);
  const b = Math.max(timelineSelection.start, timelineSelection.end);
  if (b <= a + (1/getFPS())){ alert('Selection is too short.'); return; }
  const ownerLabel = getTimelineOwnerLabel();
  const ownerColor = getTimelineOwnerColor();
  const clip = {
    id:makeTimelineClipId(),
    start:snapTimeToFrameValue(a),
    end:snapTimeToFrameValue(b),
    label:timelineClipBaseLabel(timelineClips.length),
    ownerId:getTimelineOwnerId(),
    ownerLabel,
    ownerColor,
    color:ownerColor,
    enabled:true,
    createdAt:Date.now(),
  };
  timelineClips.push(clip);
  timelineSelectedClipId = clip.id;
  requestTimelineRender();
  timelineCommitSharedState(true);
}
function renderTimelineClipList(){
  const host = timelineModeEl?.querySelector('#tlClipList');
  if (!host) return;
  // Do not rebuild the clip list while the user is renaming a clip. A full
  // re-render replaces the <input>, which makes Chrome drop focus/caret.
  if (isTimelineListNameEditing()) return;
  if (TIMELINE_COLOR_PICKER_OPEN && document.activeElement?.classList?.contains('tl-list-color')) return;
  if (!timelineClips.length){ host.innerHTML = '<div class="tl-empty">Selected clips will appear here. Export order follows this list.</div>'; return; }
  host.innerHTML = '';
  timelineClips.forEach((clip, idx) => {
    const row = document.createElement('div');
    row.className = 'tl-list-row' + (clip.id === timelineSelectedClipId ? ' selected' : '');
    row.draggable = false;
    row.dataset.id = clip.id;
    row.style.setProperty('--clip-color', clip.color || timelineDefaultClipColor(idx));
    row.innerHTML = `
      <button class="tl-list-drag" type="button" title="Drag to reorder" draggable="true">⋮⋮</button>
      <label class="tl-list-check" title="Include in export"><input type="checkbox" ${clip.enabled === false ? '' : 'checked'}></label>
      <button class="tl-list-main" type="button"><strong>${idx+1}. ${escapeHtml(getTimelineClipDisplayName(clip, idx))}</strong><span class="tl-list-time"><span class="tl-io-time">${fmtTimelineTime(clip.start)} → ${fmtTimelineTime(clip.end)}</span><span class="tl-duration-pill">${fmtTimelineTime(clip.end - clip.start)}</span></span></button>
      <input class="tl-list-name" type="text" value="${escapeHtml(clip.label || timelineClipBaseLabel(idx))}" title="Rename clip label only; owner tag stays attached">
      <input class="tl-list-color" type="color" value="${escapeHtml(clip.color || timelineDefaultClipColor(idx))}" title="Clip color">
      <button class="tl-list-icon" data-act="up" type="button" title="Move earlier">↑</button>
      <button class="tl-list-icon" data-act="down" type="button" title="Move later">↓</button>
      <button class="tl-list-del" type="button" title="Delete">×</button>`;
    row.querySelector('.tl-list-check input').onchange = (ev) => { clip.enabled = !!ev.currentTarget.checked; requestTimelineRender(); timelineCommitSharedState(); };
    row.querySelector('.tl-list-main').onclick = () => { timelineSelectedClipId = clip.id; timelineSelection = { start:clip.start, end:clip.end }; timelineLiveSeek(clip.start); requestTimelineRender(); };
    const nameInput = row.querySelector('.tl-list-name');
    nameInput.addEventListener('focus', () => { timelineSelectedClipId = clip.id; row.classList.add('selected'); });
    nameInput.addEventListener('input', () => {
      clip.label = nameInput.value;
      const blockLabel = timelineModeEl?.querySelector(`.tl-clip[data-id="${CSS.escape(clip.id)}"] .tl-clip-label`);
      if (blockLabel) blockLabel.innerHTML = `<b>${idx+1}</b> ${escapeHtml(getTimelineClipDisplayName(clip, idx))}`;
    });
    nameInput.addEventListener('change', () => { clip.label = nameInput.value.trim() || timelineClipBaseLabel(idx); timelineCommitSharedState(); requestTimelineRender(); });
    nameInput.addEventListener('blur', () => { clip.label = nameInput.value.trim() || timelineClipBaseLabel(idx); timelineCommitSharedState(); requestTimelineRender(); });
    nameInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter'){ ev.preventDefault(); nameInput.blur(); } });
    const colorInput = row.querySelector('.tl-list-color');
    const openColorPicker = () => { TIMELINE_COLOR_PICKER_OPEN = true; TIMELINE_COLOR_PICKER_CLIP_ID = clip.id; timelineSelectedClipId = clip.id; };
    const closeColorPicker = () => { setTimeout(() => { TIMELINE_COLOR_PICKER_OPEN = false; TIMELINE_COLOR_PICKER_CLIP_ID = ''; requestTimelineRender(); }, 120); };
    colorInput.addEventListener('pointerdown', openColorPicker);
    colorInput.addEventListener('mousedown', openColorPicker);
    colorInput.addEventListener('focus', openColorPicker);
    colorInput.addEventListener('input', (ev) => { clip.color = ev.currentTarget.value || clip.color; row.style.setProperty('--clip-color', clip.color); const block = timelineModeEl?.querySelector(`.tl-clip[data-id="${clip.id}"]`); if (block) block.style.setProperty('--clip-color', clip.color); });
    colorInput.addEventListener('change', () => { timelineCommitSharedState(); closeColorPicker(); });
    colorInput.addEventListener('blur', closeColorPicker);
    row.querySelector('[data-act="up"]').onclick = () => moveTimelineClipOrder(clip.id, -1);
    row.querySelector('[data-act="down"]').onclick = () => moveTimelineClipOrder(clip.id, 1);
    row.querySelector('.tl-list-del').onclick = () => { deleteTimelineClipWithConfirm(clip.id); };
    row.querySelector('.tl-list-drag')?.addEventListener('dragstart', (ev) => { ev.dataTransfer.setData('text/plain', clip.id); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (ev) => { ev.preventDefault(); row.classList.add('drop-target'); });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (ev) => {
      ev.preventDefault(); row.classList.remove('drop-target');
      const srcId = ev.dataTransfer.getData('text/plain');
      const srcI = timelineClips.findIndex(c => c.id === srcId);
      const dstI = timelineClips.findIndex(c => c.id === clip.id);
      if (srcI < 0 || dstI < 0 || srcI === dstI) return;
      const [item] = timelineClips.splice(srcI, 1);
      timelineClips.splice(dstI, 0, item);
      timelineSelectedClipId = item.id;
      requestTimelineRender();
      timelineCommitSharedState();
    });
    host.appendChild(row);
  });
}
function snapTimelineSelectionToCurrentCue(){
  const choice = getTimelineTrackChoice();
  const track = choice === 'B' ? 'B' : choice === 'dual' ? (activeOverlayTrack === 'B' ? 'B' : 'A') : getTimelineSubtitleSource().track;
  const list = track === 'B' ? entriesB : entries;
  const t = (typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : 0;
  let idx = getActiveIndex(t, track);
  if (idx < 0 && list?.length){
    let best = 0, bestD = Infinity;
    list.forEach((cue, i) => {
      const mid = ((Number(cue.start)||0) + (Number(cue.end)||0)) / 2;
      const d = Math.abs(mid - t);
      if (d < bestD){ bestD = d; best = i; }
    });
    idx = best;
  }
  const cue = list?.[idx];
  if (!cue){ alert('No subtitle cue available to snap to.'); return; }
  setTimelineSelection(cue.start, cue.end);
}
function setTimelineInAtPlayhead(){
  if (trimTimelineSelectedClipToPlayhead('in')) return;
  const t = snapTimeToFrameValue((typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : 0);
  if (!timelineSelection) createDefaultTimelineSelection();
  setTimelineSelection(t, Math.max(t + 1/getFPS(), timelineSelection.end), { seek:false });
}
function setTimelineOutAtPlayhead(){
  if (trimTimelineSelectedClipToPlayhead('out')) return;
  const t = snapTimeToFrameValue((typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : 0);
  if (!timelineSelection) createDefaultTimelineSelection();
  setTimelineSelection(Math.min(timelineSelection.start, t - 1/getFPS()), t, { seek:false });
}

let timelinePreviewModalEl = null;
let tlModalPreview = { clips: [], index: 0, playing: false, ratio:'16:9', scale:1, x:0, y:0, raf:0, iframeMode:false, iframeType:'', virtualMediaTime:0, virtualLastMs:0 };
function ensureTimelinePreviewModal(){
  if (timelinePreviewModalEl && document.body.contains(timelinePreviewModalEl)) return timelinePreviewModalEl;
  const wrap = document.createElement('div');
  wrap.id = 'timelinePreviewModal';
  wrap.className = 'modal-overlay hidden tl-preview-overlay';
  wrap.innerHTML = `
    <div class="modal-card tl-preview-card" role="dialog" aria-modal="true" aria-labelledby="tlPreviewTitle">
      <div class="modal-head">
        <div>
          <div id="tlPreviewTitle" class="modal-title">Timeline Preview</div>
          <div class="modal-sub">Preview checked clips in sequence with subtitle overlay before Export Cut.</div>
        </div>
        <button class="btn btn-outline btn-mini" id="tlPreviewClose" type="button">✕</button>
      </div>
      <div class="modal-body tl-preview-body">
        <div class="tl-preview-stage-wrap">
          <div id="tlPreviewStage" class="tl-preview-stage ratio-16x9">
            <video id="tlPreviewVideo" playsinline></video>
            <iframe id="tlPreviewIframe" class="tl-preview-iframe" title="Timeline iframe preview" allow="autoplay; encrypted-media; picture-in-picture; web-share" allowfullscreen hidden></iframe>
            <div id="tlPreviewIframeNote" class="tl-preview-iframe-note" hidden>Iframe preview uses virtual timing. For exact frame-accurate preview/export, cache the media first.</div>
            <div id="tlPreviewSafe" class="tl-preview-safe"></div>
            <div id="tlPreviewSubtitle" class="tl-preview-subtitle"></div>
          </div>
        </div>
        <div class="tl-preview-side">
          <div class="tl-preview-controls">
            <div class="tl-preview-transport">
              <button class="btn btn-gold" id="tlPreviewPlay" type="button">Play</button>
              <button class="btn btn-outline" id="tlPreviewPrev" type="button">Prev Clip</button>
              <button class="btn btn-outline" id="tlPreviewNext" type="button">Next Clip</button>
              <input id="tlPreviewScrub" class="tl-preview-scrub" type="range" min="0" max="1000" step="1" value="0" aria-label="Preview timeline">
              <div id="tlPreviewTime" class="tl-preview-time">00:00 / 00:00</div>
            </div>
            <label>Aspect <select id="tlPreviewRatio" class="ui-dark-select"><option value="16:9">16:9</option><option value="9:16">9:16</option></select></label>
            <label>Scale <input id="tlPreviewScale" type="range" min="0.6" max="2.6" step="0.01" value="1"></label>
            <label>X <input id="tlPreviewX" type="range" min="-60" max="60" step="1" value="0"></label>
            <label>Y <input id="tlPreviewY" type="range" min="-60" max="60" step="1" value="0"></label>
            <div id="tlPreviewStatus" class="tl-preview-status">Ready</div>
          </div>
          <div class="tl-preview-subpanel">
            <div class="tl-preview-subhead"><strong>Subtitles</strong><span>stitched timeline</span></div>
            <div id="tlPreviewSubtitleRows" class="tl-preview-subrows"></div>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  timelinePreviewModalEl = wrap;
  const close = () => { stopTimelineModalPreview(); try{ const f=wrap.querySelector('#tlPreviewIframe'); if(f) f.removeAttribute('src'); }catch(_e){} wrap.classList.add('hidden'); };
  wrap.querySelector('#tlPreviewClose').onclick = close;
  wrap.addEventListener('click', ev => { if (ev.target === wrap) close(); });
  wrap.querySelector('#tlPreviewPlay').onclick = () => toggleTimelineModalPreview();
  wrap.querySelector('#tlPreviewPrev').onclick = () => jumpTimelineModalPreview(-1);
  wrap.querySelector('#tlPreviewNext').onclick = () => jumpTimelineModalPreview(1);
  const scrub = wrap.querySelector('#tlPreviewScrub');
  scrub?.addEventListener('input', () => seekTimelinePreviewToAssembledTime(Number(scrub.value || 0), false));
  scrub?.addEventListener('change', () => seekTimelinePreviewToAssembledTime(Number(scrub.value || 0), tlModalPreview.playing));
  const subRows = wrap.querySelector('#tlPreviewSubtitleRows');
  subRows?.addEventListener('input', onTimelinePreviewSubtitleInput);
  subRows?.addEventListener('keydown', onTimelinePreviewSubtitleKeydown);
  subRows?.addEventListener('contextmenu', onTimelinePreviewSubtitleContextMenu);
  subRows?.addEventListener('click', onTimelinePreviewSubtitleClick);
  ['tlPreviewRatio','tlPreviewScale','tlPreviewX','tlPreviewY'].forEach(id => {
    wrap.querySelector('#'+id)?.addEventListener('input', applyTimelinePreviewStageSettings);
    wrap.querySelector('#'+id)?.addEventListener('change', applyTimelinePreviewStageSettings);
  });
  const v = wrap.querySelector('#tlPreviewVideo');
  v?.addEventListener('timeupdate', updateTimelinePreviewSubtitle);
  v?.addEventListener('ended', () => advanceTimelineModalPreview());
  return wrap;
}
function getTimelinePreviewClips(){
  const clips = getTimelineExportClips().map(c => ({ ...c, start:Number(c.start)||0, end:Number(c.end)||0 })).filter(c => c.end > c.start);
  if (clips.length) return clips;
  if (timelineSelection){
    const a = Math.min(timelineSelection.start, timelineSelection.end);
    const b = Math.max(timelineSelection.start, timelineSelection.end);
    if (b > a) return [{ id:'selection_preview', label:'Selection', start:a, end:b, color:'#d7b46a', enabled:true }];
  }
  return [];
}

function getTimelinePreviewIframeType(){
  if (currentMediaSource?.type === 'youtube') return 'youtube';
  if (currentMediaSource?.type === 'drive' && currentMediaSource?.playerMode === 'iframe') return 'drive';
  return '';
}
function timelinePreviewBuildIframeSrc(time=0, { autoplay=false }={}){
  const t = Math.max(0, Math.floor(Number(time) || 0));
  const type = getTimelinePreviewIframeType();
  if (type === 'youtube'){
    const vid = currentMediaSource?.videoId || parseYouTubeVideoId(currentMediaSource?.url || '');
    if (!vid) return '';
    const origin = encodeURIComponent(window.location.origin || 'http://127.0.0.1');
    const params = new URLSearchParams({ rel:'0', modestbranding:'1', playsinline:'1', enablejsapi:'1', origin:decodeURIComponent(origin), start:String(t) });
    if (autoplay) params.set('autoplay', '1');
    return `https://www.youtube.com/embed/${encodeURIComponent(vid)}?${params.toString()}`;
  }
  if (type === 'drive'){
    const fid = currentMediaSource?.fileId || parseGoogleDriveFileId(currentMediaSource?.url || '');
    return fid ? getGoogleDrivePreviewUrl(fid, t, { autoplay }) : '';
  }
  return '';
}
function timelinePreviewIframePost(func, args=[]){
  const iframe = timelinePreviewModalEl?.querySelector?.('#tlPreviewIframe');
  if (!iframe || !iframe.contentWindow || tlModalPreview.iframeType !== 'youtube') return false;
  const payload = JSON.stringify({ event:'command', func, args: Array.isArray(args) ? args : [] });
  try{ iframe.contentWindow.postMessage(payload, 'https://www.youtube.com'); return true; }
  catch(_e){ try{ iframe.contentWindow.postMessage(payload, '*'); return true; }catch(_e2){ return false; } }
}
function timelinePreviewSetIframeVisible(modal, on){
  const iframe = modal?.querySelector?.('#tlPreviewIframe');
  const note = modal?.querySelector?.('#tlPreviewIframeNote');
  const video = modal?.querySelector?.('#tlPreviewVideo');
  if (iframe) iframe.hidden = !on;
  if (note) note.hidden = !on;
  if (video) video.hidden = !!on;
}
function timelinePreviewIframeMediaTime(){
  if (!tlModalPreview.iframeMode) return Number(timelinePreviewModalEl?.querySelector?.('#tlPreviewVideo')?.currentTime || 0);
  if (tlModalPreview.playing && tlModalPreview.virtualLastMs){
    const now = performance.now();
    const dt = Math.max(0, Math.min(1.0, (now - tlModalPreview.virtualLastMs) / 1000));
    if (dt){
      tlModalPreview.virtualMediaTime = Math.max(0, Number(tlModalPreview.virtualMediaTime || 0) + dt);
      tlModalPreview.virtualLastMs = now;
    }
  }
  return Number(tlModalPreview.virtualMediaTime || 0);
}
function timelinePreviewSetIframeTime(time, play=false){
  const modal = ensureTimelinePreviewModal();
  const iframe = modal.querySelector('#tlPreviewIframe');
  const t = Math.max(0, Number(time) || 0);
  tlModalPreview.virtualMediaTime = t;
  tlModalPreview.virtualLastMs = performance.now();
  timelinePreviewSetIframeVisible(modal, true);
  if (!iframe) return;
  if (tlModalPreview.iframeType === 'youtube'){
    const src = timelinePreviewBuildIframeSrc(t, { autoplay: play });
    if (!iframe.src || !iframe.src.includes('/embed/') || Math.abs(t - Number(tlModalPreview._lastIframeStart || -999)) > 1.2){
      iframe.src = src;
      tlModalPreview._lastIframeStart = t;
    }
    timelinePreviewIframePost('seekTo', [t, true]);
    timelinePreviewIframePost(play ? 'playVideo' : 'pauseVideo', []);
  } else if (tlModalPreview.iframeType === 'drive'){
    const src = timelinePreviewBuildIframeSrc(t, { autoplay: play });
    if (src) iframe.src = src;
  }
}
function openTimelinePreviewModal(){
  const modal = ensureTimelinePreviewModal();
  tlModalPreview.clips = getTimelinePreviewClips();
  tlModalPreview.index = 0;
  tlModalPreview.playing = false;
  tlModalPreview.iframeType = getTimelinePreviewIframeType();
  tlModalPreview.iframeMode = !!tlModalPreview.iframeType;
  tlModalPreview.virtualMediaTime = 0;
  tlModalPreview.virtualLastMs = performance.now();
  tlPreviewCues = buildTimelinePreviewCues(tlModalPreview.clips);
  modal.classList.remove('hidden');
  const src = player?.currentSrc || player?.src || '';
  const v = modal.querySelector('#tlPreviewVideo');
  timelinePreviewSetIframeVisible(modal, tlModalPreview.iframeMode);
  if (!tlModalPreview.iframeMode && v && src && v.src !== src) v.src = src;
  applyTimelinePreviewStageSettings();
  renderTimelinePreviewSubtitlePanel();
  loadTimelineModalPreviewClip(0, false);
}
function applyTimelinePreviewStageSettings(){
  const modal = ensureTimelinePreviewModal();
  const stage = modal.querySelector('#tlPreviewStage');
  const video = modal.querySelector('#tlPreviewVideo');
  const ratio = modal.querySelector('#tlPreviewRatio')?.value || '16:9';
  const scale = Number(modal.querySelector('#tlPreviewScale')?.value || 1);
  const x = Number(modal.querySelector('#tlPreviewX')?.value || 0);
  const y = Number(modal.querySelector('#tlPreviewY')?.value || 0);
  tlModalPreview.ratio = ratio; tlModalPreview.scale = scale; tlModalPreview.x = x; tlModalPreview.y = y;
  const iframe = modal.querySelector('#tlPreviewIframe');
  if (stage){ stage.classList.toggle('ratio-9x16', ratio === '9:16'); stage.classList.toggle('ratio-16x9', ratio !== '9:16'); }
  if (video){ video.style.transform = `translate(${x}%, ${y}%) scale(${scale})`; }
  if (iframe){ iframe.style.transform = `translate(${x}%, ${y}%) scale(${scale})`; }
}
function loadTimelineModalPreviewClip(index, play=true){
  const modal = ensureTimelinePreviewModal();
  const clips = tlModalPreview.clips || [];
  if (!clips.length){ const st=modal.querySelector('#tlPreviewStatus'); if(st) st.textContent='No clips to preview.'; return; }
  tlModalPreview.index = Math.max(0, Math.min(clips.length - 1, index));
  const clip = clips[tlModalPreview.index];
  const v = modal.querySelector('#tlPreviewVideo');
  const st = modal.querySelector('#tlPreviewStatus');
  if (st) st.textContent = `${tlModalPreview.index + 1}/${clips.length} · ${clip.label || 'Clip'} · ${fmtTimelineTime(clip.start)} → ${fmtTimelineTime(clip.end)}`;
  if (tlModalPreview.iframeMode){
    tlModalPreview.playing = !!play;
    timelinePreviewSetIframeTime(Math.max(0, clip.start || 0), !!play);
    modal.querySelector('#tlPreviewPlay').textContent = play ? 'Pause' : 'Play';
    updateTimelinePreviewSubtitle();
    if (play) startTimelineModalPreviewLoop();
    return;
  }
  if (!v) return;
  try{ v.currentTime = Math.max(0, clip.start || 0); }catch(_e){}
  updateTimelinePreviewSubtitle();
  if (play){ tlModalPreview.playing = true; v.play().catch(()=>{}); modal.querySelector('#tlPreviewPlay').textContent = 'Pause'; startTimelineModalPreviewLoop(); }
  else { tlModalPreview.playing = false; v.pause(); modal.querySelector('#tlPreviewPlay').textContent = 'Play'; }
}
function toggleTimelineModalPreview(){
  const modal = ensureTimelinePreviewModal();
  if (tlModalPreview.playing){
    tlModalPreview.playing=false;
    if (tlModalPreview.iframeMode){
      tlModalPreview.virtualMediaTime = timelinePreviewIframeMediaTime();
      timelinePreviewIframePost('pauseVideo', []);
    } else {
      const v = modal.querySelector('#tlPreviewVideo');
      try{ v?.pause(); }catch(_e){}
    }
    modal.querySelector('#tlPreviewPlay').textContent='Play';
    return;
  }
  if (!tlModalPreview.clips?.length) tlModalPreview.clips = getTimelinePreviewClips();
  if (!tlModalPreview.clips.length) return;
  tlModalPreview.playing=true; modal.querySelector('#tlPreviewPlay').textContent='Pause';
  if (tlModalPreview.iframeMode){
    tlModalPreview.virtualLastMs = performance.now();
    if (tlModalPreview.iframeType === 'youtube') timelinePreviewIframePost('playVideo', []);
    else timelinePreviewSetIframeTime(timelinePreviewIframeMediaTime(), true);
  } else {
    const v = modal.querySelector('#tlPreviewVideo');
    v?.play?.().catch(()=>{});
  }
  startTimelineModalPreviewLoop();
}
function stopTimelineModalPreview(){
  tlModalPreview.playing = false;
  if (tlModalPreview.raf) cancelAnimationFrame(tlModalPreview.raf);
  tlModalPreview.raf = 0;
  if (tlModalPreview.iframeMode){
    try{ timelinePreviewIframePost('pauseVideo', []); }catch(_e){}
  }
  const v = timelinePreviewModalEl?.querySelector('#tlPreviewVideo');
  try{ v?.pause(); }catch(_e){}
}
function jumpTimelineModalPreview(dir){ loadTimelineModalPreviewClip((tlModalPreview.index || 0) + dir, tlModalPreview.playing); }
function advanceTimelineModalPreview(){
  if (!tlModalPreview.clips?.length) return;
  const next = (tlModalPreview.index || 0) + 1;
  if (next >= tlModalPreview.clips.length){ stopTimelineModalPreview(); ensureTimelinePreviewModal().querySelector('#tlPreviewPlay').textContent='Play'; return; }
  loadTimelineModalPreviewClip(next, true);
}
function startTimelineModalPreviewLoop(){
  if (tlModalPreview.raf) cancelAnimationFrame(tlModalPreview.raf);
  const tick = () => {
    const modal = timelinePreviewModalEl;
    const v = modal?.querySelector('#tlPreviewVideo');
    const clip = tlModalPreview.clips?.[tlModalPreview.index || 0];
    if (!modal || modal.classList.contains('hidden') || !clip || !tlModalPreview.playing){ tlModalPreview.raf = 0; return; }
    if (!tlModalPreview.iframeMode && !v){ tlModalPreview.raf = 0; return; }
    updateTimelinePreviewSubtitle();
    const mediaT = tlModalPreview.iframeMode ? timelinePreviewIframeMediaTime() : Number(v.currentTime || 0);
    if (Number(mediaT || 0) >= Number(clip.end || 0) - 0.015){ advanceTimelineModalPreview(); return; }
    tlModalPreview.raf = requestAnimationFrame(tick);
  };
  tlModalPreview.raf = requestAnimationFrame(tick);
}

let tlPreviewCues = [];
let tlPreviewSubCtxMenu = null;
let tlPreviewSubCtxIndex = -1;
function timelinePreviewClipOffsets(clips=tlModalPreview.clips || []){
  const offsets = [];
  let cursor = 0;
  clips.forEach((clip, i) => {
    const start = Number(clip.start) || 0;
    const end = Math.max(start, Number(clip.end) || start);
    offsets.push({ index:i, start:cursor, end:cursor + Math.max(0, end - start), clip });
    cursor += Math.max(0, end - start);
  });
  return offsets;
}
function getTimelinePreviewTotalDuration(){
  const offsets = timelinePreviewClipOffsets();
  return offsets.length ? offsets[offsets.length - 1].end : 0;
}
function getTimelinePreviewTrackForPanel(){
  const choice = getTimelineTrackChoice();
  if (choice === 'B') return 'B';
  if (choice === 'dual') return 'A';
  const src = getTimelineSubtitleSource?.();
  return normalizeTxtTrack(src?.track || 'A');
}
function buildTimelinePreviewCues(clips){
  const track = getTimelinePreviewTrackForPanel();
  const list = track === 'B' ? (entriesB || []) : (entries || []);
  ensureCueIds(list);
  const out = [];
  let cursor = 0;
  (clips || []).forEach((clip, clipIndex) => {
    const c0 = Number(clip.start) || 0;
    const c1 = Math.max(c0, Number(clip.end) || c0);
    (list || []).forEach((cue, srcIndex) => {
      const s0 = Number(cue.start) || 0;
      const s1 = Math.max(s0, Number(cue.end) || s0);
      const ov0 = Math.max(c0, s0);
      const ov1 = Math.min(c1, s1);
      if (ov1 <= ov0) return;
      const text = String(cue.text || '').trim();
      if (!text) return;
      out.push({
        id:'tlprev_' + track + '_' + clipIndex + '_' + srcIndex + '_' + (cue.id || ''),
        track, sourceCueId:cue.id || '', sourceIndex:srcIndex,
        clipIndex, sourceStart:ov0, sourceEnd:ov1,
        start:cursor + (ov0 - c0), end:cursor + (ov1 - c0), text
      });
    });
    cursor += Math.max(0, c1 - c0);
  });
  out.sort((a,b) => (a.start - b.start) || (a.end - b.end));
  return out;
}
function getTimelinePreviewAssembledTime(){
  const clip = tlModalPreview.clips?.[tlModalPreview.index || 0];
  if (!clip) return 0;
  const v = timelinePreviewModalEl?.querySelector('#tlPreviewVideo');
  if (!tlModalPreview.iframeMode && !v) return 0;
  const offsets = timelinePreviewClipOffsets();
  const off = offsets[tlModalPreview.index || 0]?.start || 0;
  const mediaTime = tlModalPreview.iframeMode ? timelinePreviewIframeMediaTime() : Number(v.currentTime || 0);
  return off + Math.max(0, Number(mediaTime || 0) - (Number(clip.start) || 0));
}
function seekTimelinePreviewToAssembledTime(t, play=false){
  const clips = tlModalPreview.clips || [];
  if (!clips.length) return;
  const offsets = timelinePreviewClipOffsets(clips);
  const total = offsets.length ? offsets[offsets.length - 1].end : 0;
  const target = Math.max(0, Math.min(total, Number(t) || 0));
  let found = offsets.find(o => target >= o.start && target <= o.end) || offsets[offsets.length - 1];
  const local = Math.max(0, target - found.start);
  tlModalPreview.index = found.index;
  const v = timelinePreviewModalEl?.querySelector('#tlPreviewVideo');
  const mediaTarget = (Number(found.clip.start) || 0) + local;
  if (tlModalPreview.iframeMode){
    timelinePreviewSetIframeTime(mediaTarget, !!play);
  } else {
    if (!v) return;
    try{ v.currentTime = mediaTarget; }catch(_e){}
  }
  const st = timelinePreviewModalEl?.querySelector('#tlPreviewStatus');
  if (st) st.textContent = `${found.index + 1}/${clips.length} · ${found.clip.label || 'Clip'} · ${fmtTimelineTime(found.clip.start)} → ${fmtTimelineTime(found.clip.end)}`;
  if (play){
    tlModalPreview.playing = true;
    if (!tlModalPreview.iframeMode) v?.play?.().catch(()=>{});
    timelinePreviewModalEl.querySelector('#tlPreviewPlay').textContent='Pause';
    startTimelineModalPreviewLoop();
  }
  updateTimelinePreviewSubtitle();
}
function renderTimelinePreviewSubtitlePanel(){
  const modal = ensureTimelinePreviewModal();
  const host = modal.querySelector('#tlPreviewSubtitleRows');
  if (!host) return;
  if (!tlPreviewCues.length){ host.innerHTML = '<div class="tl-preview-subempty">No subtitle cues overlap the checked clips.</div>'; return; }
  host.innerHTML = tlPreviewCues.map((cue, i) => `
    <div class="tl-preview-subrow" data-preview-index="${i}">
      <button class="tl-preview-subtime" type="button" data-preview-seek="${i}">${fmtTimelineTime(cue.start)} → ${fmtTimelineTime(cue.end)}</button>
      <div class="tl-preview-subtext" contenteditable="${VIEW_ONLY_SESSION ? 'false' : 'true'}" tabindex="0" spellcheck="false">${escapeHtml(cue.text || '')}</div>
    </div>`).join('');
}
function updateTimelinePreviewSourceCueText(pcue){
  if (!pcue?.sourceCueId) return;
  const list = pcue.track === 'B' ? entriesB : entries;
  const idx = getCueIndexById(pcue.sourceCueId, pcue.track);
  if (idx >= 0 && list[idx]){
    list[idx].text = String(pcue.text || '');
    try{ renderBySubsMode?.(); }catch(_e){}
  }
}
function onTimelinePreviewSubtitleInput(ev){
  const textEl = ev.target?.closest?.('.tl-preview-subtext');
  if (!textEl) return;
  const row = textEl.closest('.tl-preview-subrow');
  const idx = Number(row?.dataset?.previewIndex || -1);
  const cue = tlPreviewCues[idx];
  if (!cue) return;
  cue.text = textEl.textContent || '';
  updateTimelinePreviewSourceCueText(cue);
  updateTimelinePreviewSubtitle();
}
function onTimelinePreviewSubtitleClick(ev){
  const row = ev.target?.closest?.('.tl-preview-subrow');
  if (!row) return;
  const idx = Number(row.dataset.previewIndex || -1);
  const cue = tlPreviewCues[idx];
  if (!cue) return;
  seekTimelinePreviewToAssembledTime(cue.start + 0.001, false);
}
function onTimelinePreviewSubtitleKeydown(ev){
  const textEl = ev.target?.closest?.('.tl-preview-subtext');
  if (!textEl) return;
  if (ev.key === 'Enter' && !ev.shiftKey){
    ev.preventDefault();
    const row = textEl.closest('.tl-preview-subrow');
    timelinePreviewSplitCue(Number(row?.dataset?.previewIndex || -1), getCaretOffset(textEl));
  }
}
function onTimelinePreviewSubtitleContextMenu(ev){
  const row = ev.target?.closest?.('.tl-preview-subrow');
  if (!row) return;
  ev.preventDefault();
  tlPreviewSubCtxIndex = Number(row.dataset.previewIndex || -1);
  ensureTimelinePreviewSubtitleContextMenu();
  tlPreviewSubCtxMenu.style.left = (ev.pageX || ev.clientX + window.scrollX) + 'px';
  tlPreviewSubCtxMenu.style.top = (ev.pageY || ev.clientY + window.scrollY) + 'px';
  tlPreviewSubCtxMenu.style.display = 'block';
}
function ensureTimelinePreviewSubtitleContextMenu(){
  if (tlPreviewSubCtxMenu) return tlPreviewSubCtxMenu;
  tlPreviewSubCtxMenu = document.createElement('div');
  tlPreviewSubCtxMenu.className = 'ctx-menu tl-preview-subctx';
  tlPreviewSubCtxMenu.style.display = 'none';
  tlPreviewSubCtxMenu.innerHTML = `<button data-act="split">Split Cue at Caret</button><button data-act="merge-prev">Merge with Previous</button><button data-act="merge-next">Merge with Next</button><button data-act="push-up">Push Text Up</button><button data-act="push-down">Push Text Down</button><button data-act="add-blank">Add Blank Cue Below</button><button data-act="delete">Delete Cue</button>`;
  document.body.appendChild(tlPreviewSubCtxMenu);
  tlPreviewSubCtxMenu.addEventListener('click', ev => {
    const act = ev.target?.dataset?.act;
    if (!act) return;
    const idx = tlPreviewSubCtxIndex;
    tlPreviewSubCtxMenu.style.display = 'none';
    timelinePreviewRunCueAction(idx, act);
  });
  document.addEventListener('click', ev => { if (tlPreviewSubCtxMenu && !tlPreviewSubCtxMenu.contains(ev.target)) tlPreviewSubCtxMenu.style.display='none'; }, true);
  return tlPreviewSubCtxMenu;
}
function timelinePreviewSplitCue(idx, caret=null){
  const cue = tlPreviewCues[idx]; if (!cue) return;
  const textEl = timelinePreviewModalEl?.querySelector(`.tl-preview-subrow[data-preview-index="${idx}"] .tl-preview-subtext`);
  const full = String(textEl?.textContent ?? cue.text ?? '');
  const at = Math.max(0, Math.min(caret == null && textEl ? getCaretOffset(textEl) : Number(caret || 0), full.length));
  const left = full.slice(0, at).trimEnd();
  const right = full.slice(at).trimStart();
  const ratio = full.length ? Math.max(0.12, Math.min(0.88, at / full.length)) : 0.5;
  const mid = cue.start + (cue.end - cue.start) * ratio;
  cue.text = left; cue.end = mid;
  const next = { ...cue, id:cue.id + '_split_' + Date.now().toString(36), sourceCueId:'', sourceIndex:-1, start:mid, end:Math.max(mid + 1/getFPS(), (Number(tlPreviewCues[idx+1]?.start) || cue.end || mid + 1)) , text:right };
  tlPreviewCues.splice(idx + 1, 0, next);
  renderTimelinePreviewSubtitlePanel(); updateTimelinePreviewSubtitle();
}
function timelinePreviewRunCueAction(idx, act){
  if (idx < 0 || idx >= tlPreviewCues.length) return;
  const cue = tlPreviewCues[idx];
  if (act === 'split') return timelinePreviewSplitCue(idx);
  if (act === 'merge-prev' && idx > 0){ const p=tlPreviewCues[idx-1]; p.text = [p.text, cue.text].filter(Boolean).join(' '); p.end = Math.max(p.end, cue.end); tlPreviewCues.splice(idx,1); }
  else if (act === 'merge-next' && idx < tlPreviewCues.length-1){ const n=tlPreviewCues[idx+1]; cue.text = [cue.text, n.text].filter(Boolean).join(' '); cue.end = Math.max(cue.end, n.end); tlPreviewCues.splice(idx+1,1); }
  else if (act === 'push-up' && idx > 0){ const tmp=tlPreviewCues[idx-1].text; tlPreviewCues[idx-1].text=cue.text; cue.text=tmp; updateTimelinePreviewSourceCueText(tlPreviewCues[idx-1]); updateTimelinePreviewSourceCueText(cue); }
  else if (act === 'push-down' && idx < tlPreviewCues.length-1){ const tmp=tlPreviewCues[idx+1].text; tlPreviewCues[idx+1].text=cue.text; cue.text=tmp; updateTimelinePreviewSourceCueText(tlPreviewCues[idx+1]); updateTimelinePreviewSourceCueText(cue); }
  else if (act === 'add-blank'){ const start=cue.end; const end=Math.max(start + 1/getFPS(), Number(tlPreviewCues[idx+1]?.start) || start + 1); tlPreviewCues.splice(idx+1,0,{id:'blank_'+Date.now().toString(36), track:cue.track, sourceCueId:'', sourceIndex:-1, clipIndex:cue.clipIndex, sourceStart:start, sourceEnd:end, start, end, text:''}); }
  else if (act === 'delete'){ tlPreviewCues.splice(idx,1); }
  renderTimelinePreviewSubtitlePanel(); updateTimelinePreviewSubtitle();
}
function updateTimelinePreviewSubtitle(){
  const modal = timelinePreviewModalEl;
  if (!modal || modal.classList.contains('hidden')) return;
  const v = modal.querySelector('#tlPreviewVideo');
  const sub = modal.querySelector('#tlPreviewSubtitle');
  if ((!tlModalPreview.iframeMode && !v) || !sub) return;
  const assembled = getTimelinePreviewAssembledTime();
  const cue = (tlPreviewCues || []).find(c => assembled >= Number(c.start||0) && assembled <= Number(c.end||0));
  sub.textContent = cue ? wrapSubtitleTextByChars(String(cue.text || '').trim(), getCaptionMaxChars()) : '';
  sub.style.opacity = cue ? '1' : '0';
  const scrub = modal.querySelector('#tlPreviewScrub');
  const time = modal.querySelector('#tlPreviewTime');
  const total = getTimelinePreviewTotalDuration();
  if (scrub){ scrub.max = String(Math.max(0.01, total)); scrub.step = String(1 / getFPS()); scrub.value = String(Math.max(0, Math.min(total, assembled))); }
  if (time) time.textContent = `${fmtTimelineTime(assembled)} / ${fmtTimelineTime(total)}`;
  const host = modal.querySelector('#tlPreviewSubtitleRows');
  if (host){
    host.querySelectorAll('.tl-preview-subrow.active').forEach(x => x.classList.remove('active'));
    if (cue){
      const idx = tlPreviewCues.indexOf(cue);
      const row = host.querySelector(`.tl-preview-subrow[data-preview-index="${idx}"]`);
      if (row){ row.classList.add('active'); if (!row.matches(':focus-within')) row.scrollIntoView({ block:'nearest' }); }
    }
  }
}

function previewTimelineSelectionOrClip(){
  const clips = getTimelineExportClips();
  if (clips.length){
    timelinePreviewQueue = clips.map(c => ({ start:Number(c.start)||0, end:Number(c.end)||0, label:c.label || 'Clip' })).filter(c => c.end > c.start);
    timelinePreviewIndex = 0;
    timelineLoopPreview = true;
    const first = timelinePreviewQueue[0];
    if (!first) return;
    timelineSelectedClipId = clips[0].id;
    timelineSelection = { start:first.start, end:first.end };
    seekMediaTo(first.start, { play:true });
    timelineSetStatus(`Previewing rough cut 1/${timelinePreviewQueue.length}: ${escapeHtml(first.label)} · ${fmtTimelineTime(first.start)} → ${fmtTimelineTime(first.end)}`);
    requestTimelineRender();
    return;
  }
  const range = timelineSelection;
  if (!range){ createDefaultTimelineSelection(); }
  const r = timelineSelection;
  if (!r) return;
  timelinePreviewQueue = [{ start:Math.min(r.start, r.end), end:Math.max(r.start, r.end), label:'Selection' }];
  timelinePreviewIndex = 0;
  timelineLoopPreview = true;
  seekMediaTo(Math.min(r.start, r.end), { play:true });
  timelineSetStatus(`Previewing selection ${fmtTimelineTime(Math.min(r.start, r.end))} → ${fmtTimelineTime(Math.max(r.start, r.end))}`);
}
function timelinePreviewTick(){
  if (!isTimelineMode) return;
  const t = (typeof getMediaCurrentTime === 'function') ? getMediaCurrentTime() : 0;
  updateTimelinePlayhead(t);
  const scroll = timelineModeEl?.querySelector('#tlScroll');
  if (scroll && performance.now() - timelineLastAutoScroll > 400){
    const x = timelineTimeToPx(t);
    if (x < scroll.scrollLeft + 40 || x > scroll.scrollLeft + scroll.clientWidth - 80){
      scroll.scrollLeft = Math.max(0, x - scroll.clientWidth * 0.35);
      timelineLastAutoScroll = performance.now();
    }
  }
  if (timelineLoopPreview){
    const r = timelinePreviewQueue[timelinePreviewIndex] || null;
    if (r && t >= Math.max(r.start, r.end) - 0.02){
      timelinePreviewIndex += 1;
      const next = timelinePreviewQueue[timelinePreviewIndex];
      if (next){
        seekMediaTo(next.start, { play:true });
        timelineSetStatus(`Previewing rough cut ${timelinePreviewIndex+1}/${timelinePreviewQueue.length}: ${escapeHtml(next.label || 'Clip')} · ${fmtTimelineTime(next.start)} → ${fmtTimelineTime(next.end)}`);
        return;
      }
      timelineLoopPreview = false;
      timelinePreviewQueue = [];
      timelinePreviewIndex = -1;
      pauseMedia();
      seekMediaTo(Math.max(r.start, r.end), { play:false });
      timelineSetStatus('Preview finished.');
    }
  }
}
try{ player?.addEventListener('timeupdate', timelinePreviewTick); }catch(_e){}


function timelineFormatSourceCue(track, cue, idx){
  const start = Number(cue?.start || 0);
  const end = Number(cue?.end || 0);
  const text = String(cue?.text || '').replace(/\s+/g, ' ').trim();
  return `[${track}${idx+1}] ${fmtTimelineTime(start)} --> ${fmtTimelineTime(end)} | ${text}`;
}
function buildTimelineAiSourceText(trackChoice='current'){
  const pack = getTimelineTrackLists(trackChoice || 'current');
  const chunks = [];
  for (const tr of pack.tracks || []){
    const list = Array.isArray(tr.list) ? tr.list : [];
    if (!list.length) continue;
    chunks.push(`### Sub ${tr.track}`);
    chunks.push(list.map((cue, idx) => timelineFormatSourceCue(tr.track, cue, idx)).join('\n'));
  }
  return chunks.join('\n\n').trim();
}
function extractJsonObjectFromText(text){
  const raw = String(text || '').trim();
  if (!raw) throw new Error('AI returned empty output.');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try { return JSON.parse(candidate); } catch(_e) {}
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start >= 0 && end > start){
    return JSON.parse(candidate.slice(start, end + 1));
  }
  throw new Error('AI output was not valid JSON. The raw output is still shown for review.');
}
function normalizeTimelineAiSuggestion(item, idx=0){
  const start = snapTimeToFrameValue(Number(item?.start ?? item?.in ?? item?.start_time ?? 0));
  const end = snapTimeToFrameValue(Number(item?.end ?? item?.out ?? item?.end_time ?? 0));
  const dur = getTimelineDuration();
  const a = Math.max(0, Math.min(dur, start));
  const b = Math.max(a + 1/getFPS(), Math.min(dur, end));
  return {
    id: String(item?.id || ('ai_' + Date.now().toString(36) + '_' + idx)),
    label: String(item?.label || item?.title || item?.name || `AI Clip ${idx+1}`).trim() || `AI Clip ${idx+1}`,
    start: a,
    end: b,
    reason: String(item?.reason || item?.rationale || item?.summary || '').trim(),
    score: Number(item?.score ?? item?.confidence ?? 0),
    checked: item?.checked !== false,
  };
}
function getTimelineAiCueRowsForSuggestion(sg){
  const trackChoice = document.getElementById('tlAiTrack')?.value || 'current';
  const pack = getTimelineTrackLists(trackChoice || 'current');
  const rows = [];
  const a = Math.min(Number(sg.start)||0, Number(sg.end)||0);
  const b = Math.max(Number(sg.start)||0, Number(sg.end)||0);
  for (const tr of pack.tracks || []){
    (tr.list || []).forEach((cue, idx) => {
      const s = Number(cue.start) || 0;
      const e = Number(cue.end) || 0;
      if (e <= a || s >= b) return;
      const text = String(cue.text || '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      rows.push({ track:tr.track, index:idx+1, start:s, end:e, text });
    });
  }
  rows.sort((x,y) => (x.start - y.start) || String(x.track).localeCompare(String(y.track)));
  return rows;
}
function renderTimelineAiCueRows(sg){
  const rows = getTimelineAiCueRowsForSuggestion(sg);
  if (!rows.length) return '<div class="tl-ai-cues-empty">No cue text overlaps this suggestion.</div>';
  return `<div class="tl-ai-cues">${rows.map(r => `<div class="tl-ai-cue-row"><span class="tl-ai-cue-time">${escapeHtml(r.track)} ${fmtTimelineTime(r.start)} → ${fmtTimelineTime(r.end)}</span><span class="tl-ai-cue-text">${escapeHtml(r.text)}</span></div>`).join('')}</div>`;
}

function renderTimelineAiSuggestions(){
  const host = document.getElementById('tlAiSuggestions');
  if (!host) return;
  if (!timelineAiSuggestions.length){
    host.innerHTML = '<div class="tl-ai-empty">AI clip suggestions will appear here.</div>';
    return;
  }
  host.innerHTML = timelineAiSuggestions.map((sg, idx) => {
    const score = sg.score ? ` · score ${Math.round(sg.score * 100)}%` : '';
    return `<div class="tl-ai-card" data-index="${idx}">
      <label class="tl-ai-check"><input type="checkbox" ${sg.checked === false ? '' : 'checked'}> Add</label>
      <div class="tl-ai-main">
        <input class="tl-ai-name" type="text" value="${escapeHtml(sg.label)}" title="Suggestion label">
        <div class="tl-ai-time">${fmtTimelineTime(sg.start)} → ${fmtTimelineTime(sg.end)} · ${fmtTimelineTime(sg.end - sg.start)}${score}</div>
        <textarea class="tl-ai-reason" rows="2" placeholder="Reason">${escapeHtml(sg.reason || '')}</textarea>
        ${renderTimelineAiCueRows(sg)}
      </div>
      <button class="btn btn-outline btn-mini tl-ai-preview" type="button">Preview</button>
      <button class="btn btn-outline btn-mini tl-ai-range" type="button">Select Range</button>
    </div>`;
  }).join('');
  host.querySelectorAll('.tl-ai-card').forEach(card => {
    const idx = Number(card.dataset.index || 0);
    const sg = timelineAiSuggestions[idx];
    card.querySelector('input[type="checkbox"]')?.addEventListener('change', ev => { sg.checked = !!ev.currentTarget.checked; });
    card.querySelector('.tl-ai-name')?.addEventListener('input', ev => { sg.label = ev.currentTarget.value || sg.label; });
    card.querySelector('.tl-ai-reason')?.addEventListener('input', ev => { sg.reason = ev.currentTarget.value || ''; });
    card.querySelector('.tl-ai-preview')?.addEventListener('click', () => { setTimelineSelection(sg.start, sg.end); seekMediaTo(sg.start, { play:true }); timelinePreviewQueue = [{ start:sg.start, end:sg.end, label:sg.label }]; timelinePreviewIndex = 0; timelineLoopPreview = true; });
    card.querySelector('.tl-ai-range')?.addEventListener('click', () => { setTimelineSelection(sg.start, sg.end); timelineLiveSeek(sg.start); });
  });
}
function ensureTimelineAiModal(){
  if (timelineAiModalEl && document.body.contains(timelineAiModalEl)) return timelineAiModalEl;
  const wrap = document.createElement('div');
  wrap.id = 'timelineAiModal';
  wrap.className = 'modal-overlay hidden';
  wrap.innerHTML = `
    <div class="modal-card tl-ai-modal-card" role="dialog" aria-modal="true" aria-labelledby="tlAiTitle">
      <div class="modal-head">
        <div>
          <div id="tlAiTitle" class="modal-title">AI Clip Selection</div>
          <div class="modal-sub">Analyze the timecoded transcript, recommend key moments, chapters, and short-video clips, then add reviewed suggestions to Timeline Mode.</div>
        </div>
        <button class="btn btn-outline btn-mini" id="tlAiClose" type="button" aria-label="Close">✕</button>
      </div>
      <div class="modal-body tl-ai-body">
        <div class="tl-ai-left">
          <label>Transcript Source
            <select id="tlAiTrack" class="ui-dark-select">
              <option value="current" selected>Current visible track</option>
              <option value="A">Sub A</option>
              <option value="B">Sub B</option>
              <option value="dual">Dual Sub A + B</option>
            </select>
          </label>
          <label>AI Task
            <select id="tlAiTask" class="ui-dark-select">
              <option value="shorts" selected>Long video → shorts recommendations</option>
              <option value="chapters">Find chapters + key moments</option>
              <option value="quotes">Find strongest quotes / soundbites</option>
              <option value="custom">Custom brief</option>
            </select>
          </label>
          <div class="tl-ai-grid2">
            <label>Number of clips <input id="tlAiCount" class="ui-dark-input" type="number" min="1" max="20" value="6"></label>
            <label>Target seconds each <input id="tlAiDur" class="ui-dark-input" type="number" min="5" max="600" value="45"></label>
          </div>
          <label>Model
            <select id="tlAiModel" class="ui-dark-select">
              <option value="deepseek-chat" selected>deepseek-chat</option>
              <option value="deepseek-reasoner">deepseek-reasoner</option>
            </select>
          </label>
          <label>Brief / Prompt
            <textarea id="tlAiPrompt" class="ui-dark-textarea" placeholder="Example: Find the strongest hooks, surprising claims, emotional moments, or self-contained clips suitable for vertical shorts."></textarea>
          </label>
          <div class="tl-ai-actions">
            <button class="btn btn-gold" id="tlAiRun" type="button">Analyze Transcript</button>
            <button class="btn btn-outline" id="tlAiRawToggle" type="button">Show Raw JSON</button>
            <span class="muted" id="tlAiStatus"></span>
          </div>
          <textarea id="tlAiRaw" class="ui-dark-textarea tl-ai-raw" placeholder="Raw AI JSON output" hidden></textarea>
        </div>
        <div class="tl-ai-right">
          <div class="tl-ai-suggestion-head">
            <strong>Review Suggestions</strong>
            <div>
              <button class="btn btn-outline btn-mini" id="tlAiCheckAll" type="button">Check All</button>
              <button class="btn btn-outline btn-mini" id="tlAiUncheckAll" type="button">Uncheck All</button>
            </div>
          </div>
          <div id="tlAiSuggestions" class="tl-ai-suggestions"><div class="tl-ai-empty">AI clip suggestions will appear here.</div></div>
          <div class="tl-ai-actions bottom">
            <button class="btn btn-gold" id="tlAiAddSelected" type="button">Add Selected to Timeline</button>
            <button class="btn btn-outline" id="tlAiCopyRaw" type="button">Copy Raw</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  timelineAiModalEl = wrap;
  const close = () => wrap.classList.add('hidden');
  wrap.querySelector('#tlAiClose').onclick = close;
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelector('#tlAiRun').onclick = () => runTimelineAiSelection().catch(err => { console.error(err); const st=document.getElementById('tlAiStatus'); if (st) st.textContent = 'Failed: ' + (err?.message || err); alert('AI clip selection failed: ' + (err?.message || err)); });
  wrap.querySelector('#tlAiRawToggle').onclick = () => { const raw=document.getElementById('tlAiRaw'); if (raw) raw.hidden = !raw.hidden; };
  wrap.querySelector('#tlAiCopyRaw').onclick = async () => { const val=document.getElementById('tlAiRaw')?.value || ''; if (val) await copyTextToClipboard(val); };
  wrap.querySelector('#tlAiCheckAll').onclick = () => { timelineAiSuggestions.forEach(s => s.checked = true); renderTimelineAiSuggestions(); };
  wrap.querySelector('#tlAiUncheckAll').onclick = () => { timelineAiSuggestions.forEach(s => s.checked = false); renderTimelineAiSuggestions(); };
  wrap.querySelector('#tlAiAddSelected').onclick = () => addSelectedTimelineAiSuggestions();
  return wrap;
}
function openTimelineAiModal(){ ensureTimelineAiModal().classList.remove('hidden'); renderTimelineAiSuggestions(); }
function timelineAiTaskBrief(task, count, dur){
  if (task === 'chapters') return `Identify chapters, key moments, and ${count} possible clip selections. Aim for clips around ${dur} seconds when possible.`;
  if (task === 'quotes') return `Find ${count} strong self-contained quotes or soundbites. Aim for clips around ${dur} seconds each.`;
  if (task === 'custom') return `Use the custom brief to recommend up to ${count} clip selections. Aim for clips around ${dur} seconds when possible.`;
  return `Recommend ${count} short-video clip selections from this long video. Prioritize clear hooks, self-contained context, strong quotes, emotional or surprising moments, and clean endings. Aim for around ${dur} seconds per clip unless a stronger moment needs a slightly different duration.`;
}
async function runTimelineAiSelection(){
  const track = document.getElementById('tlAiTrack')?.value || 'current';
  const task = document.getElementById('tlAiTask')?.value || 'shorts';
  const count = Math.max(1, Math.min(20, Number(document.getElementById('tlAiCount')?.value || 6)));
  const dur = Math.max(5, Math.min(600, Number(document.getElementById('tlAiDur')?.value || 45)));
  const model = document.getElementById('tlAiModel')?.value || 'deepseek-chat';
  const custom = String(document.getElementById('tlAiPrompt')?.value || '').trim();
  const st = document.getElementById('tlAiStatus');
  const rawBox = document.getElementById('tlAiRaw');
  const source_text = buildTimelineAiSourceText(track);
  if (!source_text) throw new Error('No transcript cues available for the selected source.');
  const instructions = [
    timelineAiTaskBrief(task, count, dur),
    custom ? `Custom brief: ${custom}` : '',
    `Video duration: ${fmtTimelineTime(getTimelineDuration())}. Current FPS: ${getFPS()}.`,
    `Return STRICT JSON only, no markdown fences. Schema: {"clips":[{"label":"short name","start":12.34,"end":56.78,"reason":"why this works","score":0.0}],"chapters":[{"title":"chapter title","start":0,"end":60}],"key_moments":[{"time":12.34,"summary":"what happens"}]}.`,
    `Use seconds as numbers for all times. Keep clip start/end inside the original video. Avoid overlapping clips unless the transcript strongly supports it.`,
  ].filter(Boolean).join('\n\n');
  if (st) st.textContent = 'Analyzing…';
  const res = await fetch(`${API_BASE}/api/ai_assistant`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ task:'recommend_clips', instructions, source_text, model, dictionary: loadDictionaryPairs() })
  });
  const data = await res.json().catch(()=>({}));
  if (!res.ok || !data?.ok) throw new Error(data?.detail || data?.message || (`HTTP ${res.status}`));
  const output = String(data.output || '').trim();
  if (rawBox) rawBox.value = output;
  let parsed;
  try{
    parsed = extractJsonObjectFromText(output);
  }catch(err){
    if (st) st.textContent = 'Raw output received, but JSON parsing failed.';
    timelineAiSuggestions = [];
    renderTimelineAiSuggestions();
    throw err;
  }
  const clips = Array.isArray(parsed?.clips) ? parsed.clips : [];
  timelineAiSuggestions = clips.map(normalizeTimelineAiSuggestion).filter(c => c.end > c.start);
  renderTimelineAiSuggestions();
  if (st) st.textContent = timelineAiSuggestions.length ? `Done · ${timelineAiSuggestions.length} clip suggestion(s)` : 'Done · no clips returned';
}
function addSelectedTimelineAiSuggestions(){
  const selected = (timelineAiSuggestions || []).filter(s => s.checked !== false && s.end > s.start);
  if (!selected.length){ alert('No AI suggestions checked.'); return; }
  const ownerLabel = getTimelineOwnerLabel();
  const ownerColor = getTimelineOwnerColor();
  const ownerId = getTimelineOwnerId();
  selected.forEach((sg) => {
    timelineClips.push({
      id: makeTimelineClipId(),
      start: snapTimeToFrameValue(sg.start),
      end: snapTimeToFrameValue(sg.end),
      label: sg.label || timelineClipBaseLabel(timelineClips.length),
      ownerId,
      ownerLabel,
      ownerColor,
      color: ownerColor,
      enabled: true,
      createdAt: Date.now(),
      source: 'ai_assistant',
      reason: sg.reason || '',
    });
  });
  timelineSelectedClipId = timelineClips.at(-1)?.id || timelineSelectedClipId;
  requestTimelineRender();
  timelineCommitSharedState(true);
  timelineSetStatus(`Added ${selected.length} AI clip suggestion(s) to the timeline.`);
  document.getElementById('timelineAiModal')?.classList.add('hidden');
}

function buildRetimedSubtitlePayload(trackChoice='current'){
  const pack = getTimelineTrackLists(trackChoice);
  const out = { track: pack.mode === 'dual' ? 'dual' : pack.tracks[0].track, subtitles:[], subtitles_b:[] };
  const a = pack.tracks.find(t => t.track === 'A');
  const b = pack.tracks.find(t => t.track === 'B');
  if (pack.mode === 'dual'){
    out.subtitles = (a?.list || []).map(e => ({ start:Number(e.start)||0, end:Number(e.end)||0, text:String(e.text || '') }));
    out.subtitles_b = (b?.list || []).map(e => ({ start:Number(e.start)||0, end:Number(e.end)||0, text:String(e.text || '') }));
  } else {
    out.subtitles = (pack.tracks[0]?.list || []).map(e => ({ start:Number(e.start)||0, end:Number(e.end)||0, text:String(e.text || '') }));
  }
  return out;
}
async function exportTimelineCut(){
  const exportClips = getTimelineExportClips();
  if (!exportClips.length){ alert('Check at least one clip for export.'); return; }
  normalizeTimelineClips();
  const links = timelineModeEl?.querySelector('#tlExportLinks');
  if (links) links.textContent = 'Preparing export…';
  try{
    progressStart?.('Exporting timeline cut…');
    const source = await resolveTimelineSourceForExport();
    const subChoice = getTimelineTrackChoice();
    const { track, subtitles, subtitles_b } = buildRetimedSubtitlePayload(subChoice);
    const mode = timelineModeEl?.querySelector('#tlExportMode')?.value || 'accurate';
    const aspect_ratio = timelineModeEl?.querySelector('#tlAspectRatio')?.value || '16:9';
    const res = await fetch(`${API_BASE}/api/timeline_export`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        source,
        clips: exportClips.map(c => ({ start:c.start, end:c.end, label:getTimelineClipDisplayName(c), color:c.color, owner_label:c.ownerLabel || '', reason:c.reason || '' })),
        subtitles,
        subtitles_b,
        subtitle_track:track,
        fps:getFPS(),
        mode,
        aspect_ratio
      })
    });
    const data = await res.json().catch(()=>({}));
    if (!res.ok || data?.ok === false) throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
    const videoUrl = data.video_url ? `${API_BASE}${data.video_url}` : '';
    const srtUrl = data.srt_url ? `${API_BASE}${data.srt_url}` : '';
    const srtBUrl = data.srt_b_url ? `${API_BASE}${data.srt_b_url}` : '';
    let html = '';
    if (videoUrl) html += `<a class="btn btn-gold" href="${videoUrl}" download>Download MP4</a>`;
    if (srtUrl) html += `<a class="btn btn-outline" href="${srtUrl}" download>${track === 'dual' ? 'Download Sub A SRT' : 'Download SRT'}</a>`;
    if (srtBUrl) html += `<a class="btn btn-outline" href="${srtBUrl}" download>Download Sub B SRT</a>`;
    if (links) links.innerHTML = html || 'Export finished.';
    setStatusSafe('Timeline export ready.');
    progressDone?.(true);
  }catch(e){
    if (links) links.textContent = 'Export failed: ' + (e?.message || e);
    setStatusSafe('Timeline export failed: ' + (e?.message || e));
    progressDone?.(false);
    alert('Timeline export failed: ' + (e?.message || e));
  }
}




/* ---------- Mobile / iPad adaptive shell ---------- */
function ensureMobileAdaptiveShell(){
  const head = document.querySelector('.head');
  if (!head || document.getElementById('mobileToolbarToggle')) return;

  const btn = document.createElement('button');
  btn.id = 'mobileToolbarToggle';
  btn.className = 'btn btn-outline mobile-toolbar-toggle';
  btn.type = 'button';
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', 'mainToolbarMobile');
  btn.textContent = 'Menu';

  const toolbar = head.querySelector('.toolbar');
  if (toolbar && !toolbar.id) toolbar.id = 'mainToolbarMobile';

  const brand = head.querySelector('.brand');
  if (brand && brand.nextSibling) head.insertBefore(btn, brand.nextSibling);
  else head.appendChild(btn);

  const closeMenu = () => {
    document.body.classList.remove('mobile-menu-open');
    btn.setAttribute('aria-expanded', 'false');
  };
  const openMenu = () => {
    document.body.classList.add('mobile-menu-open');
    btn.setAttribute('aria-expanded', 'true');
  };

  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (document.body.classList.contains('mobile-menu-open')) closeMenu();
    else openMenu();
  });

  document.addEventListener('click', (ev) => {
    if (!document.body.classList.contains('mobile-menu-open')) return;
    const t = ev.target;
    if (head.contains(t)) return;
    closeMenu();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeMenu();
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 760) closeMenu();
  }, { passive:true });

  // Mark touch devices so CSS can avoid hover-only assumptions.
  try{
    if (window.matchMedia && window.matchMedia('(hover: none), (pointer: coarse)').matches){
      document.body.classList.add('touch-ui');
    }
  }catch(_e){}
}


/* ---------- Phone panel switcher: one-panel-at-a-time layout ---------- */
function ensureMobilePanelSwitcher(){
  if (document.getElementById('mobilePanelSwitcher')) return;
  const wrap = document.querySelector('.wrap');
  if (!wrap) return;

  const switcher = document.createElement('div');
  switcher.id = 'mobilePanelSwitcher';
  switcher.className = 'mobile-panel-switcher';
  switcher.innerHTML = `
    <button type="button" class="mobile-panel-tab" data-mobile-panel="video" aria-pressed="false">Video</button>
    <button type="button" class="mobile-panel-tab" data-mobile-panel="editor" aria-pressed="false">Editor</button>
  `;

  wrap.parentElement?.insertBefore(switcher, wrap);

  const apply = (panel, { persist=true } = {}) => {
    const mode = (panel === 'video') ? 'video' : 'editor';
    document.body.classList.toggle('mobile-panel-video', mode === 'video');
    document.body.classList.toggle('mobile-panel-editor', mode === 'editor');
    switcher.querySelectorAll('.mobile-panel-tab').forEach(btn => {
      const on = btn.getAttribute('data-mobile-panel') === mode;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (persist) {
      try{ localStorage.setItem('transcriber_mobile_panel', mode); }catch(_e){}
    }
    try{ requestAnimationFrame(() => window.updateMobileDrawerFloatingClose?.()); }catch(_e){}
  };

  switcher.addEventListener('click', (ev) => {
    const btn = ev.target?.closest?.('[data-mobile-panel]');
    if (!btn) return;
    apply(btn.getAttribute('data-mobile-panel') || 'editor');
  });

  const syncForViewport = () => {
    if (window.innerWidth <= 640){
      let saved = 'video';
      try{ saved = localStorage.getItem('transcriber_mobile_panel') || 'video'; }catch(_e){}
      apply(saved, { persist:false });
    } else {
      document.body.classList.remove('mobile-panel-video','mobile-panel-editor');
    }
  };

  window.addEventListener('resize', syncForViewport, { passive:true });
  syncForViewport();

  // Expose a tiny helper for future UI actions, e.g. switching to Editor after import.
  window.setMobilePanel = (panel) => apply(panel || 'editor');
}




/* ---------- iPhone video panel split: fixed media + scrollable controls ---------- */
function ensurePhoneVideoScrollRegion(){
  const panel = document.querySelector('.video-panel');
  if (!panel || panel.__phoneVideoScrollBound) return;

  const tcbar = panel.querySelector('.tcbar') || document.getElementById('tcPanel')?.closest?.('.tcbar');
  if (!tcbar || !panel.contains(tcbar)) return;

  let divider = document.getElementById('phoneVideoHorizontalDivider');
  if (!divider){
    divider = document.createElement('div');
    divider.id = 'phoneVideoHorizontalDivider';
    divider.className = 'phone-video-horizontal-divider';
    divider.setAttribute('aria-hidden', 'true');
    tcbar.insertAdjacentElement('afterend', divider);
  }

  let body = document.getElementById('phoneVideoScrollBody');
  if (!body){
    body = document.createElement('div');
    body.id = 'phoneVideoScrollBody';
    body.className = 'phone-video-scroll-body';
    divider.insertAdjacentElement('afterend', body);
  }

  const shouldStayInPanel = (node) => {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return true;
    if (node === body || node === divider || node === tcbar) return true;
    if (node.classList?.contains('frame')) return true;
    return false;
  };

  const moveLooseChildren = () => {
    if (!body || !panel.contains(body)) return;
    const children = Array.from(panel.children);
    for (const child of children){
      if (shouldStayInPanel(child)) continue;
      body.appendChild(child);
    }
  };

  moveLooseChildren();

  const obs = new MutationObserver(() => {
    // Dynamic drawers/workflow docks can be injected after init. Keep them in the
    // scrollable lower half so they do not push the iframe/video out of view.
    moveLooseChildren();
  });
  obs.observe(panel, { childList:true });
  panel.__phoneVideoScrollBound = true;
  panel.__phoneVideoScrollObserver = obs;
}


/* ---------- Init ---------- */
function init(){
  ensureAppThemeToggle();
  ensureMobileAdaptiveShell();
  ensureMobilePanelSwitcher();
  ensurePhoneVideoScrollRegion();
  ensureTranscriptBoundaryFix();
  setupVideoSourceTcToggle();
  setupVideoControls();
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
  ensureLeftPanelControlSurface();
  ensureYouTubeImportButton();
  ensureGoogleDriveImportButton();
  ensureShareSessionButton();
  rearrangeTopToolbar();
  ensureDictionaryModal();
  ensureAIAssistantModal();
  setupCenterDivider();
  loadSharedSessionFromUrl().catch(err => { console.error(err); setStatusSafe('Shared session load failed: ' + (err?.message || err)); });
  loadCollaborativeSessionFromUrl().catch(err => { console.error(err); setStatusSafe('Collaborative session load failed: ' + (err?.message || err)); });
}
init();
