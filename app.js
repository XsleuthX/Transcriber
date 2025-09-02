import { parseSRT, toSRT } from './srt.js';

const fileInput = document.getElementById('fileInput');
const srtInput = document.getElementById('srtInput');
const player = document.getElementById('player');
const transcriptEl = document.getElementById('transcript');
const statusEl = document.getElementById('status');
const btnExport = document.getElementById('btnExport');
const lineTpl = document.getElementById('lineTpl');
const fpsSelect = document.getElementById('fpsSelect');
const tcPanel = document.getElementById('tcPanel');
const tcFps = document.getElementById('tcFps');

let entries = []; // {start,end,text}
let currentFileBlob = null;
let fps = 30;

function pad2(n){ return String(n).padStart(2,'0'); }

function formatTimecodeFromSeconds(sec, fpsVal){
  // Convert seconds -> HH:MM:SS:FF using the selected fps
  const totalFrames = Math.floor(sec * fpsVal + 1e-6);
  const frames = totalFrames % fpsVal;
  const totalSeconds = Math.floor(totalFrames / fpsVal);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}:${pad2(frames)}`;
}

function renderTranscript(){
  transcriptEl.innerHTML='';
  entries.forEach((e, i) => {
    const node = lineTpl.content.firstElementChild.cloneNode(true);
    node.dataset.index = i;
    node.querySelector('.stamp').textContent = `[${formatTimecodeFromSeconds(e.start, fps)}]`;
    node.querySelector('.text').textContent = e.text || '';
    node.querySelector('.stamp').onclick = () => {
      player.currentTime = e.start + 0.001;
      player.play();
    };
    node.querySelector('.text').addEventListener('input', ev => {
      entries[i].text = ev.currentTarget.textContent;
    });
    transcriptEl.appendChild(node);
  });
}

function updateLiveTimecode(){
  if (!player) return;
  const t = player.currentTime || 0;
  tcPanel.textContent = formatTimecodeFromSeconds(t, fps);
  requestAnimationFrame(updateLiveTimecode);
}

// Import video/audio
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  if (!f) return;
  currentFileBlob = f;
  player.src = URL.createObjectURL(f);
  statusEl.textContent = `Loaded: ${f.name} (${Math.round(f.size/1024/1024)} MB)`;
  entries = []; renderTranscript();
});

// Import SRT/VTT
srtInput.addEventListener('change', async () => {
  const f = srtInput.files[0];
  if (!f) return;
  const text = await f.text();
  entries = parseSRT(text);
  renderTranscript();
  statusEl.textContent = `Imported ${entries.length} captions from ${f.name}`;
});

// Export SRT
btnExport.addEventListener('click', () => {
  if (!entries.length) { alert('No transcript to export.'); return; }
  const srt = toSRT(entries); // standard SRT uses milliseconds, not frames
  const blob = new Blob([srt], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'transcript.srt';
  a.click();
});

// Highlight active line while playing
player.addEventListener('timeupdate', () => {
  const t = player.currentTime;
  for (const el of transcriptEl.children) el.classList.remove('active');
  const idx = entries.findIndex(e => t >= e.start && t <= e.end);
  if (idx >= 0) {
    const el = transcriptEl.children[idx];
    el.classList.add('active');
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
});

// FPS control
fpsSelect.addEventListener('change', () => {
  fps = parseInt(fpsSelect.value, 10) || 30;
  tcFps.textContent = fps;
  renderTranscript(); // re-render stamps with new FPS
});

// Init
tcFps.textContent = fps;
requestAnimationFrame(updateLiveTimecode);
