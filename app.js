/* ==========================================================================
   Interval Timer & Treadmill Calendar PWA - Main Application (app.js)
   ========================================================================== */

/* ==========================================================================
   1. STATE & CONSTANTS
   ========================================================================== */
function safeGetStorageNumber(key, fallback) {
  try {
    const val = Number(localStorage.getItem(key));
    return Number.isFinite(val) && val > 0 ? val : fallback;
  } catch (err) {
    return fallback;
  }
}

let settings = {
  run: safeGetStorageNumber('runSec', 60),
  walk: safeGetStorageNumber('walkSec', 120),
  sets: safeGetStorageNumber('setCount', 4),
  warmup: safeGetStorageNumber('warmupSec', 30),
  finish: safeGetStorageNumber('finishSec', 60)
};

let totalSeconds = 0;
let intervalSecondsLeft = settings.warmup;
let currentMode = 'WARMUP'; // WARMUP, RUN, WALK, FINISH
let setCount = 1;
let isRunning = false;
let timerId = null;
let timerWorker = null;
let audioContext = null;
let wakeLock = null;
let lastTick = 0;

const RING_CIRCUMFERENCE = 2 * Math.PI * 125; // 785.398

/* ==========================================================================
   2. DOM ELEMENTS
   ========================================================================== */
const statusEl = document.getElementById('status');
const intervalTimeEl = document.getElementById('intervalTime');
const totalTimeEl = document.getElementById('totalTime');
const setCountEl = document.getElementById('setCount');
const setDotsEl = document.getElementById('setDots');
const timerContainerEl = document.getElementById('timerContainer');

const toggleBtn = document.getElementById('toggleBtn');
const resetBtn = document.getElementById('resetBtn');
const sub10Btn = document.getElementById('sub10Btn');
const add10Btn = document.getElementById('add10Btn');

const settingsBtn = document.getElementById('settingsBtn');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const settingsEl = document.getElementById('settings');
const overlay = document.getElementById('overlay');
const calendarBtn = document.getElementById('calendarBtn');
const muteBtn = document.getElementById('muteBtn');

const pipBtn = document.getElementById('pipBtn');
const pipCanvas = document.getElementById('pipCanvas');
const pipVideo = document.getElementById('pipVideo');
let pipCtx = pipCanvas ? pipCanvas.getContext('2d') : null;
let pipStream = null;

const runInput = document.getElementById('runInput');
const walkInput = document.getElementById('walkInput');
const setInput = document.getElementById('setInput');
const warmupInput = document.getElementById('warmupInput');
const finishInput = document.getElementById('finishInput');

const weekSummaryEl = document.getElementById('weekSummary');
const monthSummaryEl = document.getElementById('monthSummary');
const savePresetBtn = document.getElementById('savePresetBtn');
const presetsListEl = document.getElementById('presetsList');

let calendarEl, closeCalendarBtn, prevMonthBtn, nextMonthBtn, calendarMonthYear, calendarDaysEl, selectedDateLabel;
let runTimeInput, runDistInput, saveRunBtn, deleteRunBtn, gymCheckbox;
let calendarExportImportEl, exportCalendarBtn, importCalendarBtn, importCalendarFileInput;

/* ==========================================================================
   3. WEB WORKER & TIMER ENGINE
   ========================================================================== */
function initTimerWorker() {
  if (window.Worker) {
    try {
      timerWorker = new Worker('timer-worker.js');
      timerWorker.onmessage = function (e) {
        const data = e.data || {};
        if (data.type === 'tick' && isRunning) {
          const elapsedSec = Number(data.elapsedSec) || 1;
          lastTick = Date.now();
          consumeElapsedSeconds(elapsedSec);
          updateDisplay();
        }
      };
    } catch (err) {
      console.warn('Web Worker creation failed, fallback to main thread timer:', err);
      timerWorker = null;
    }
  }
}
initTimerWorker();

function startTimerLoop() {
  lastTick = Date.now();
  if (timerWorker) {
    timerWorker.postMessage({ command: 'start' });
  } else {
    if (timerId) clearInterval(timerId);
    const TICK_MS = 500;
    timerId = setInterval(() => {
      const now = Date.now();
      let elapsedMs = now - lastTick;
      if (elapsedMs < 0) elapsedMs = 0;
      const elapsedSec = Math.floor(elapsedMs / 1000);
      if (elapsedSec >= 1) {
        lastTick += elapsedSec * 1000;
        consumeElapsedSeconds(elapsedSec);
        updateDisplay();
      }
    }, TICK_MS);
  }
}

function pauseTimerLoop() {
  if (timerWorker) {
    timerWorker.postMessage({ command: 'pause' });
  }
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

function resetTimerLoop() {
  if (timerWorker) {
    timerWorker.postMessage({ command: 'reset' });
  }
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

function switchMode() {
  if (currentMode === 'WARMUP') {
    currentMode = 'RUN';
    intervalSecondsLeft = settings.run;
    setCount = 1;
    playTransitionBeep('RUN');
    return;
  }

  if (currentMode === 'RUN') {
    currentMode = 'WALK';
    intervalSecondsLeft = settings.walk;
    playTransitionBeep('WALK');
  } else if (currentMode === 'WALK') {
    if (setCount >= settings.sets) {
      currentMode = 'FINISH';
      intervalSecondsLeft = settings.finish;
      playTransitionBeep('FINISH');
      autoStampCompletedRun();
    } else {
      currentMode = 'RUN';
      intervalSecondsLeft = settings.run;
      setCount++;
      playTransitionBeep('RUN');
    }
  } else if (currentMode === 'FINISH') {
    isRunning = false;
    pauseTimerLoop();
    releaseWakeLock();
    autoStampCompletedRun();
  }
}

function consumeElapsedSeconds(seconds) {
  let sec = seconds;
  while (sec > 0 && isRunning) {
    if (sec >= intervalSecondsLeft) {
      totalSeconds += intervalSecondsLeft;
      sec -= intervalSecondsLeft;
      intervalSecondsLeft = 0;
      switchMode();
      if (!isRunning) break;
    } else {
      totalSeconds += sec;
      intervalSecondsLeft -= sec;
      sec = 0;
      playCountdownBeep(intervalSecondsLeft);
    }
  }
}

/* ==========================================================================
   4. SCREEN WAKE LOCK
   ========================================================================== */
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    if (!wakeLock || wakeLock.released) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch (err) {
    console.warn('Screen Wake Lock request failed:', err);
    wakeLock = null;
  }
}

async function releaseWakeLock() {
  if (wakeLock) {
    try {
      await wakeLock.release();
    } catch (err) {
      console.warn('Screen Wake Lock release failed:', err);
    }
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && isRunning) {
    await requestWakeLock();
    const now = Date.now();
    const elapsedSec = lastTick ? Math.floor((now - lastTick) / 1000) : 0;
    if (elapsedSec >= 1) {
      lastTick = now;
      consumeElapsedSeconds(elapsedSec);
      updateDisplay();
    }
  }
});

/* ==========================================================================
   5. AUDIO, VIBRATION & MUTE
   ========================================================================== */
let isMuted = localStorage.getItem('isMuted') === 'true';

function updateMuteUI() {
  if (!muteBtn) return;
  muteBtn.textContent = isMuted ? '🔇' : '🔊';
  if (isMuted) {
    muteBtn.classList.add('muted');
  } else {
    muteBtn.classList.remove('muted');
  }
}

if (muteBtn) {
  muteBtn.onclick = () => {
    isMuted = !isMuted;
    localStorage.setItem('isMuted', isMuted);
    updateMuteUI();
  };
  updateMuteUI();
}

function triggerVibration(pattern) {
  if (isMuted) return;
  if ('vibrate' in navigator) {
    try {
      navigator.vibrate(pattern);
    } catch (err) {}
  }
}

function playBeep(freq, dur, type = 'sine') {
  if (isMuted) return;
  if (!audioContext) return;
  try {
    const o = audioContext.createOscillator();
    const g = audioContext.createGain();
    o.type = type;
    o.frequency.value = freq;
    o.connect(g);
    g.connect(audioContext.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + dur);
    o.stop(audioContext.currentTime + dur);
  } catch (err) {
    console.warn('playBeep error:', err);
  }
}

function playCountdownBeep(secLeft) {
  if (secLeft <= 3 && secLeft > 0) {
    playBeep(660, 0.09, 'triangle');
    triggerVibration([60]);
  }
}

function playTransitionBeep(newMode) {
  triggerVibration([200, 100, 200]);
  if (newMode === 'RUN') {
    playBeep(880, 0.15, 'sine');
    setTimeout(() => playBeep(1046.5, 0.2, 'sine'), 120);
  } else if (newMode === 'WALK') {
    playBeep(523.25, 0.15, 'sine');
    setTimeout(() => playBeep(392, 0.2, 'sine'), 120);
  } else if (newMode === 'FINISH') {
    playBeep(880, 0.15, 'sine');
    setTimeout(() => playBeep(1174.66, 0.15, 'sine'), 150);
    setTimeout(() => playBeep(1567.98, 0.35, 'sine'), 300);
  } else if (newMode === 'WARMUP') {
    playBeep(660, 0.15, 'sine');
  }
}

/* ==========================================================================
   6. CANVAS PIP & MEDIA SESSION
   ========================================================================== */
function renderPipCanvas() {
  if (!pipCtx || !pipCanvas) return;
  const width = pipCanvas.width;
  const height = pipCanvas.height;

  let bgColor = '#2ed573';
  if (currentMode === 'RUN') bgColor = '#ff4757';
  else if (currentMode === 'WALK') bgColor = '#1e90ff';
  else if (currentMode === 'FINISH') bgColor = '#a55eea';

  pipCtx.fillStyle = bgColor;
  pipCtx.fillRect(0, 0, width, height);

  pipCtx.fillStyle = '#ffffff';
  pipCtx.font = 'bold 26px Pretendard, sans-serif';
  pipCtx.textAlign = 'center';
  pipCtx.fillText(currentMode, width / 2, 54);

  pipCtx.font = 'bold 74px Pretendard, sans-serif';
  pipCtx.fillText(formatTime(intervalSecondsLeft), width / 2, 160);

  pipCtx.font = 'bold 22px Pretendard, sans-serif';
  pipCtx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  pipCtx.fillText(`Set ${setCount} / ${settings.sets}`, width / 2, 225);

  pipCtx.font = '16px Pretendard, sans-serif';
  pipCtx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  pipCtx.fillText(`Total ${formatTime(totalSeconds)}`, width / 2, 262);
}

function updatePipUI() {
  if (!pipBtn) return;
  const isPiPActive = !!(document.pictureInPictureElement && document.pictureInPictureElement === pipVideo);
  if (isPiPActive) {
    pipBtn.classList.add('active');
  } else {
    pipBtn.classList.remove('active');
  }
}

async function togglePictureInPicture() {
  if (!document.pictureInPictureEnabled || !pipVideo || !pipCanvas) {
    alert('Picture-in-Picture mode is not supported by your browser.');
    return;
  }

  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
    } else {
      renderPipCanvas();
      if (!pipStream && pipCanvas.captureStream) {
        pipStream = pipCanvas.captureStream(10);
        pipVideo.srcObject = pipStream;
      }
      await pipVideo.play();
      await pipVideo.requestPictureInPicture();
    }
  } catch (err) {
    console.warn('PiP error:', err);
  }
}

if (pipBtn) {
  if (!document.pictureInPictureEnabled) {
    pipBtn.style.display = 'none';
  } else {
    pipBtn.onclick = togglePictureInPicture;
  }
}

if (pipVideo) {
  pipVideo.addEventListener('enterpictureinpicture', updatePipUI);
  pipVideo.addEventListener('leavepictureinpicture', updatePipUI);
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;

  try {
    const modeEmoji = currentMode === 'RUN' ? '🔥' : currentMode === 'WALK' ? '💧' : '🌱';
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `${modeEmoji} [${currentMode}] ${formatTime(intervalSecondsLeft)}`,
      artist: `세트 ${setCount} / ${settings.sets}`,
      album: '러닝머신 인터벌 타이머'
    });

    navigator.mediaSession.setActionHandler('play', () => {
      if (!isRunning && toggleBtn) toggleBtn.click();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      if (isRunning && toggleBtn) toggleBtn.click();
    });
  } catch (err) {
    console.warn('MediaSession error:', err);
  }
}

/* ==========================================================================
   7. DISPLAY & UI UPDATES
   ========================================================================== */
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function getModeTotalSeconds(mode) {
  switch (mode) {
    case 'WARMUP': return settings.warmup || 1;
    case 'RUN': return settings.run || 1;
    case 'WALK': return settings.walk || 1;
    case 'FINISH': return settings.finish || 1;
    default: return 1;
  }
}

function updateProgressRing() {

  const progressCircleEl = document.getElementById('progressCircle');
  if (!progressCircleEl) return;
  const total = getModeTotalSeconds(currentMode);
  const ratio = Math.max(0, Math.min(1, intervalSecondsLeft / total));
  const offset = RING_CIRCUMFERENCE * (1 - ratio);
  progressCircleEl.style.strokeDashoffset = offset;
}

function updateSetDots() {
  if (!setDotsEl) return;
  const total = Math.max(1, settings.sets);
  setDotsEl.innerHTML = '';
  for (let i = 1; i <= total; i++) {
    const dot = document.createElement('div');
    dot.className = 'dot';
    if (i <= setCount && (currentMode === 'RUN' || currentMode === 'WALK' || currentMode === 'FINISH')) {
      dot.classList.add('filled');
    }
    setDotsEl.appendChild(dot);
  }
}

function updateVisualPulse() {
  if (!timerContainerEl) return;
  if (isRunning && intervalSecondsLeft <= 3 && intervalSecondsLeft > 0) {
    timerContainerEl.classList.add('pulsing');
  } else {
    timerContainerEl.classList.remove('pulsing');
  }
}

function updateThemeClass() {
  document.body.className = `theme-${currentMode}`;
}

function updateDisplay() {
  intervalTimeEl.textContent = formatTime(intervalSecondsLeft);
  totalTimeEl.textContent = `Total ${formatTime(totalSeconds)}`;
  setCountEl.textContent = `Set ${setCount}`;
  statusEl.textContent = currentMode;
  statusEl.className = `status ${currentMode}`;

  updateProgressRing();
  updateSetDots();
  updateVisualPulse();
  updateThemeClass();
  renderPipCanvas();
  updateMediaSession();
}

function updateToggle() {
  toggleBtn.textContent = isRunning ? 'PAUSE' : 'START';
  if (isRunning) {
    toggleBtn.style.background = 'rgba(255, 255, 255, 0.15)';
    toggleBtn.style.color = '#ffffff';
    toggleBtn.style.boxShadow = 'none';
  } else {
    toggleBtn.style.background = 'var(--theme-color)';
    toggleBtn.style.color = '#000000';
    toggleBtn.style.boxShadow = '0 4px 20px var(--theme-glow)';
  }
}

function adjustIntervalTime(deltaSec) {
  intervalSecondsLeft = Math.max(1, intervalSecondsLeft + deltaSec);
  updateDisplay();
}

if (sub10Btn) sub10Btn.onclick = () => adjustIntervalTime(-10);
if (add10Btn) add10Btn.onclick = () => adjustIntervalTime(10);

/* ==========================================================================
   8. PRESET MANAGEMENT
   ========================================================================== */
const DEFAULT_PRESETS = [
  { id: 'tabata', name: 'Tabata 20s/10s', warmup: 10, run: 20, walk: 10, finish: 10, sets: 8 },
  { id: 'hiit30', name: 'HIIT 30s/30s', warmup: 30, run: 30, walk: 30, finish: 30, sets: 10 },
  { id: 'run12', name: 'Run 1m / Walk 2m', warmup: 30, run: 60, walk: 120, finish: 60, sets: 5 }
];

function getCustomPresets() {
  try {
    const data = localStorage.getItem('customPresets');
    if (!data) return DEFAULT_PRESETS;
    const parsed = JSON.parse(data);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_PRESETS;
  } catch (e) {
    return DEFAULT_PRESETS;
  }
}

function saveCustomPresets(presets) {
  try {
    localStorage.setItem('customPresets', JSON.stringify(presets));
  } catch (e) {}
}

function applyPreset(preset) {
  settings.run = preset.run;
  settings.walk = preset.walk;
  settings.sets = preset.sets;
  settings.warmup = preset.warmup;
  settings.finish = preset.finish;

  localStorage.setItem('runSec', preset.run);
  localStorage.setItem('walkSec', preset.walk);
  localStorage.setItem('setCount', preset.sets);
  localStorage.setItem('warmupSec', preset.warmup);
  localStorage.setItem('finishSec', preset.finish);

  runInput.value = preset.run;
  walkInput.value = preset.walk;
  setInput.value = preset.sets;
  warmupInput.value = preset.warmup;
  finishInput.value = preset.finish;

  if (!isRunning) {
    intervalSecondsLeft =
      currentMode === 'RUN'
        ? settings.run
        : currentMode === 'WALK'
        ? settings.walk
        : currentMode === 'WARMUP'
        ? settings.warmup
        : settings.finish;
    updateDisplay();
  }
  renderPresetChips();
}

function renderPresetChips() {
  const container = document.getElementById('presetsList');
  if (!container) return;
  container.innerHTML = '';
  const presets = getCustomPresets();

  presets.forEach((preset) => {
    const chip = document.createElement('div');
    chip.className = 'preset-chip';

    if (
      settings.run === preset.run &&
      settings.walk === preset.walk &&
      settings.sets === preset.sets &&
      settings.warmup === preset.warmup &&
      settings.finish === preset.finish
    ) {
      chip.classList.add('active');
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'chip-name';
    nameSpan.textContent = preset.name;
    chip.appendChild(nameSpan);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'chip-delete-btn';
    deleteBtn.textContent = '✕';
    deleteBtn.ariaLabel = 'Delete preset';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deletePreset(preset.id);
    };
    chip.appendChild(deleteBtn);

    chip.onclick = () => applyPreset(preset);
    container.appendChild(chip);
  });
}

function deletePreset(id) {
  let presets = getCustomPresets();
  presets = presets.filter((p) => p.id !== id);
  saveCustomPresets(presets);
  renderPresetChips();
}

function saveCurrentAsPreset() {
  const defaultName = `Preset ${settings.run}s/${settings.walk}s`;
  const name = prompt('Preset Name:', defaultName);
  if (!name || !name.trim()) return;

  const newPreset = {
    id: 'preset-' + Date.now(),
    name: name.trim(),
    run: settings.run,
    walk: settings.walk,
    sets: settings.sets,
    warmup: settings.warmup,
    finish: settings.finish
  };

  const presets = getCustomPresets();
  presets.push(newPreset);
  saveCustomPresets(presets);
  renderPresetChips();
}

if (savePresetBtn) {
  savePresetBtn.onclick = saveCurrentAsPreset;
}

/* ==========================================================================
   9. CALENDAR & ATTENDANCE LOGS
   ========================================================================== */
let calDate = new Date();
let selectedDateStr = null;

function loadRunLogs() {
  try {
    return JSON.parse(localStorage.getItem('runLogs') || '{}');
  } catch (err) {
    return {};
  }
}

function saveRunLogs(obj) {
  try {
    localStorage.setItem('runLogs', JSON.stringify(obj));
  } catch (err) {}
}

function getLogFor(dateStr) {
  return loadRunLogs()[dateStr] || null;
}

function formatYYYYMMDD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function secToMMSS(sec = 0) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function getWeekRange(dateObj) {
  const d = new Date(dateObj);
  const day = d.getDay();
  const start = new Date(d); start.setDate(d.getDate() - day); start.setHours(0,0,0,0);
  const end = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23,59,59,999);
  return { start, end };
}

function getMonthRange(dateObj) {
  const d = new Date(dateObj);
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0); end.setHours(23,59,59,999);
  return { start, end };
}

function sumLogsBetween(startDate, endDate) {
  const logs = loadRunLogs();
  let time = 0, dist = 0;
  for (const k of Object.keys(logs)) {
    const t = new Date(k + 'T00:00:00');
    if (t >= startDate && t <= endDate) {
      const entry = logs[k] || {};
      time += Number(entry.timeSec || 0);
      dist += Number(entry.distanceKm || 0);
    }
  }
  return { time, dist };
}

function updateSummaries(forDateObj) {
  if (!weekSummaryEl || !monthSummaryEl) return;
  const ref = forDateObj ? new Date(forDateObj) : new Date();
  const week = getWeekRange(ref);
  const month = getMonthRange(ref);
  const w = sumLogsBetween(week.start, week.end);
  const m = sumLogsBetween(month.start, month.end);

  weekSummaryEl.textContent = `Week: ${secToMMSS(w.time)} · ${w.dist.toFixed(2)} km`;
  monthSummaryEl.textContent = `Month: ${secToMMSS(m.time)} · ${m.dist.toFixed(2)} km`;
}

function calculateStreak() {
  const logs = loadRunLogs();
  const today = new Date();
  let count = 0;

  let checkDate = new Date(today);
  let checkStr = formatYYYYMMDD(checkDate);

  const todayEntry = logs[checkStr];
  const isTodayLogged = todayEntry && (todayEntry.completed || todayEntry.stamp || Number(todayEntry.timeSec) > 0 || Number(todayEntry.distanceKm) > 0);
  if (!isTodayLogged) {
    checkDate.setDate(checkDate.getDate() - 1);
    checkStr = formatYYYYMMDD(checkDate);
  }

  while (logs[checkStr]) {
    const entry = logs[checkStr];
    if (entry.completed || entry.stamp || Number(entry.timeSec) > 0 || Number(entry.distanceKm) > 0) {
      count++;
      checkDate.setDate(checkDate.getDate() - 1);
      checkStr = formatYYYYMMDD(checkDate);
    } else {
      break;
    }
  }

  return count;
}

function updateStreakUI() {
  const streakEl = document.getElementById('streakCounter');
  if (!streakEl) return;
  const streak = calculateStreak();
  streakEl.textContent = `🔥 ${streak}일 연속 러닝!`;
}

function autoStampCompletedRun() {
  const todayStr = formatYYYYMMDD(new Date());
  const logs = loadRunLogs();
  const entry = logs[todayStr] || {};
  entry.completed = true;
  entry.stamp = '🏃';
  if (!entry.timeSec) {
    entry.timeSec = totalSeconds || (settings.run * settings.sets);
  }
  logs[todayStr] = entry;
  saveRunLogs(logs);
  safeRenderCalendar();
  updateSummaries();
  updateStreakUI();
}

function exportCalendar() {
  const backup = {
    app: "IntervalTimerPWA",
    version: "2.0",
    exportedAt: new Date().toISOString(),
    runLogs: loadRunLogs(),
    customPresets: getCustomPresets(),
    settings: settings
  };
  return JSON.stringify(backup, null, 2);
}

function importCalendar(data) {
  let parsed = data;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (err) {
      console.error('Import JSON parse error:', err);
      return false;
    }
  }
  if (!parsed || typeof parsed !== 'object') return false;

  try {
    const runLogs = parsed.runLogs || (typeof parsed === 'object' && !parsed.customPresets && !parsed.settings ? parsed : null);
    if (runLogs && typeof runLogs === 'object' && !Array.isArray(runLogs)) {
      const existing = loadRunLogs();
      const merged = { ...existing, ...runLogs };
      saveRunLogs(merged);
    }

    if (Array.isArray(parsed.customPresets)) {
      saveCustomPresets(parsed.customPresets);
      renderPresetChips();
    }

    if (parsed.settings && typeof parsed.settings === 'object') {
      if (parsed.settings.run) localStorage.setItem('runSec', parsed.settings.run);
      if (parsed.settings.walk) localStorage.setItem('walkSec', parsed.settings.walk);
      if (parsed.settings.sets) localStorage.setItem('setCount', parsed.settings.sets);
      if (parsed.settings.warmup) localStorage.setItem('warmupSec', parsed.settings.warmup);
      if (parsed.settings.finish) localStorage.setItem('finishSec', parsed.settings.finish);
    }

    safeRenderCalendar();
    updateSummaries();
    updateStreakUI();
    return true;
  } catch (err) {
    console.error('importCalendar error:', err);
    return false;
  }
}

window.exportCalendar = exportCalendar;
window.importCalendar = importCalendar;

function formatDistanceDisplay(d) {
  if (d == null || d === '') return '';
  const n = Number(d) || 0;
  if (n >= 100) return `${Math.round(n)}km`;
  const s = n.toFixed(1).replace(/\.0$/,'');
  return `${s}km`;
}

function renderCalendar(year, month) {
  if (!calendarDaysEl || !calendarMonthYear) return;

  calDate = new Date(year, month, 1);
  calendarMonthYear.textContent = calDate.toLocaleString(undefined, { month: 'long', year: 'numeric' });

  calendarDaysEl.innerHTML = '';
  const firstDay = new Date(year, month, 1);
  const startDay = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();
  const totalCells = Math.ceil((startDay + daysInMonth) / 7) * 7;
  const logs = loadRunLogs();

  for (let i = 0; i < totalCells; i++) {
    const dayEl = document.createElement('div');
    dayEl.className = 'calendar-day';
    let cellDate, inThisMonth = true;

    if (i < startDay) {
      const d = prevMonthDays - (startDay - 1 - i);
      dayEl.classList.add('other-month');
      cellDate = new Date(year, month - 1, d);
      inThisMonth = false;
    } else if (i >= startDay + daysInMonth) {
      const d = i - (startDay + daysInMonth) + 1;
      dayEl.classList.add('other-month');
      cellDate = new Date(year, month + 1, d);
      inThisMonth = false;
    } else {
      const d = i - startDay + 1;
      cellDate = new Date(year, month, d);
    }

    const dateStr = formatYYYYMMDD(cellDate);
    dayEl.setAttribute('data-date', dateStr);
    dayEl.innerHTML = `<div class="day-number">${String(cellDate.getDate())}</div><div class="gym-badge" aria-hidden="true"></div>`;

    if (!inThisMonth) {
      dayEl.style.opacity = '0.45';
    } else {
      dayEl.onclick = () => selectDate(dateStr, cellDate);

      const entry = logs[dateStr];
      if (entry) {
        const isRunCompleted = entry.completed || entry.stamp || Number(entry.timeSec) > 0 || Number(entry.distanceKm) > 0;
        if (isRunCompleted) {
          dayEl.classList.add('completed-stamp');
        }

        const gymBadgeEl = dayEl.querySelector('.gym-badge');
        if (gymBadgeEl) {
          if (entry.gym === true || entry.gym === 'true' || entry.gym === 1 || entry.gym === '1' || !!entry.gym) {
            gymBadgeEl.textContent = 'GYM';
            gymBadgeEl.classList.add('active');
          } else {
            gymBadgeEl.textContent = '';
            gymBadgeEl.classList.remove('active');
          }
        }
        const kmVal = (entry.distanceKm != null && entry.distanceKm !== '') ? formatDistanceDisplay(entry.distanceKm) : '';
        const minVal = entry.timeSec ? `${Math.round(Number(entry.timeSec) / 60)}m` : '';

        if (isRunCompleted || kmVal || minVal) {
          const rec = document.createElement('div');
          rec.className = 'day-record';

          if (isRunCompleted) {
            const stampEl = document.createElement('div');
            stampEl.className = 'stamp-icon';
            stampEl.textContent = '🏃';
            rec.appendChild(stampEl);
          }

          if (kmVal) {
            const kmEl = document.createElement('div');
            kmEl.className = 'km';
            kmEl.textContent = kmVal;
            rec.appendChild(kmEl);
          }

          if (minVal) {
            const minEl = document.createElement('div');
            minEl.className = 'min';
            minEl.textContent = minVal;
            rec.appendChild(minEl);
          }

          dayEl.appendChild(rec);
        }
      }
    }

    if (dateStr === selectedDateStr) dayEl.classList.add('selected');
    calendarDaysEl.appendChild(dayEl);
  }
}

function safeRenderCalendar() {
  try {
    if (!calendarDaysEl) initCalendarRefs();
    if (calendarDaysEl) renderCalendar(calDate.getFullYear(), calDate.getMonth());
  } catch (err) {
    console.error('safeRenderCalendar error:', err);
  }
}

function selectDate(dateStr, dateObj) {
  selectedDateStr = dateStr;
  if (selectedDateLabel) {
    selectedDateLabel.classList.remove('placeholder');
    selectedDateLabel.textContent = `${dateObj.getFullYear()}. ${String(dateObj.getMonth() + 1).padStart(2, '0')}. ${String(dateObj.getDate()).padStart(2, '0')}.`;
  }
  const log = getLogFor(dateStr);
  if (runTimeInput) runTimeInput.value = log ? String(Math.round((log.timeSec || 0) / 60)) : '';
  if (runDistInput) runDistInput.value = log && log.distanceKm != null ? log.distanceKm : '';
  if (gymCheckbox) gymCheckbox.checked = !!(log && log.gym);
  renderCalendar(calDate.getFullYear(), calDate.getMonth());
  updateSummaries(dateObj);
}

function saveRunBtnHandler() {
  if (!selectedDateStr) return;
  const minutes = Number(runTimeInput.value) || 0;
  const timeSec = Math.max(0, Math.floor(minutes)) * 60;
  const distanceKm = runDistInput && runDistInput.value !== '' ? Number(String(runDistInput.value).replace(',', '.')) : null;
  const logs = loadRunLogs();
  const gym = !!(gymCheckbox && gymCheckbox.checked);

  if (timeSec > 0 || (distanceKm !== null && distanceKm > 0) || gym) {
    const entry = logs[selectedDateStr] || {};
    entry.timeSec = timeSec;
    entry.distanceKm = distanceKm;
    entry.gym = gym;
    logs[selectedDateStr] = entry;
  } else {
    delete logs[selectedDateStr];
  }
  saveRunLogs(logs);
  if (gymCheckbox) gymCheckbox.checked = !!logs[selectedDateStr]?.gym;
  safeRenderCalendar();
  updateSummaries(new Date(selectedDateStr + 'T00:00:00'));
  updateStreakUI();
}

function deleteRunBtnHandler() {
  if (!selectedDateStr) return;
  const logs = loadRunLogs();
  delete logs[selectedDateStr];
  saveRunLogs(logs);
  if (runTimeInput) runTimeInput.value = '';
  if (runDistInput) runDistInput.value = '';
  if (gymCheckbox) gymCheckbox.checked = false;
  safeRenderCalendar();
  updateSummaries(new Date(selectedDateStr + 'T00:00:00'));
  updateStreakUI();
}

function initCalendarRefs() {
  calendarEl = document.getElementById('calendar');
  closeCalendarBtn = document.getElementById('closeCalendarBtn');
  prevMonthBtn = document.getElementById('prevMonthBtn');
  nextMonthBtn = document.getElementById('nextMonthBtn');
  calendarMonthYear = document.getElementById('calendarMonthYear');
  calendarDaysEl = document.getElementById('calendarDays');
  selectedDateLabel = document.getElementById('selectedDateLabel');

  runTimeInput = document.getElementById('runTimeInput');
  runDistInput = document.getElementById('runDistInput');
  saveRunBtn = document.getElementById('saveRunBtn');
  deleteRunBtn = document.getElementById('deleteRunBtn');
  gymCheckbox = document.getElementById('gymCheckbox');
  calendarExportImportEl = document.getElementById('calendarExportImport');
  exportCalendarBtn = document.getElementById('exportCalendarBtn');
  importCalendarBtn = document.getElementById('importCalendarBtn');
  importCalendarFileInput = document.getElementById('importCalendarFile');

  if (prevMonthBtn) {
    prevMonthBtn.onclick = () => {
      calDate = new Date(calDate.getFullYear(), calDate.getMonth() - 1, 1);
      safeRenderCalendar();
    };
  }
  if (nextMonthBtn) {
    nextMonthBtn.onclick = () => {
      calDate = new Date(calDate.getFullYear(), calDate.getMonth() + 1, 1);
      safeRenderCalendar();
    };
  }
  if (closeCalendarBtn) closeCalendarBtn.onclick = closeCalendar;
  if (saveRunBtn) saveRunBtn.onclick = saveRunBtnHandler;
  if (deleteRunBtn) deleteRunBtn.onclick = deleteRunBtnHandler;

  if (exportCalendarBtn) {
    exportCalendarBtn.onclick = () => {
      const payload = exportCalendar();
      const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'interval-timer-backup.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    };
  }
  if (importCalendarBtn) {
    importCalendarBtn.onclick = () => {
      if (!importCalendarFileInput) return;
      importCalendarFileInput.value = '';
      importCalendarFileInput.click();
    };
  }
  if (importCalendarFileInput && !importCalendarFileInput.dataset.bound) {
    importCalendarFileInput.dataset.bound = 'true';
    importCalendarFileInput.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result;
        if (!importCalendar(text)) {
          alert('Import failed. Invalid JSON format.');
          return;
        }
        alert('Data successfully imported!');
      };
      reader.readAsText(file);
    });
  }

  if (gymCheckbox && !gymCheckbox.dataset.bound) {
    gymCheckbox.dataset.bound = 'true';
    gymCheckbox.addEventListener('change', () => {
      if (selectedDateStr) saveRunBtnHandler();
    });
  }
}

function openCalendar() {
  initCalendarRefs();
  updateStreakUI();
  const today = new Date();
  calDate = new Date(today.getFullYear(), today.getMonth(), 1);
  safeRenderCalendar();
  if (calendarEl) {
    calendarEl.classList.add('open');
    calendarEl.setAttribute('aria-hidden', 'false');
  }
  if (overlay) overlay.classList.add('open');

  const todayStr = formatYYYYMMDD(today);
  const todayCell = calendarDaysEl && calendarDaysEl.querySelector('.calendar-day[data-date="' + todayStr + '"]');
  if (todayCell && typeof todayCell.click === 'function') {
    todayCell.click();
  } else {
    selectDate(todayStr, today);
  }
}

function closeCalendar() {
  if (calendarEl) {
    calendarEl.classList.remove('open');
    calendarEl.setAttribute('aria-hidden', 'true');
  }
  if (overlay) overlay.classList.remove('open');
  selectedDateStr = null;
  if (selectedDateLabel) {
    selectedDateLabel.classList.add('placeholder');
    selectedDateLabel.textContent = 'yyyy. mm. dd.';
  }
}

/* ==========================================================================
   10. INITIALIZATION & EVENT LISTENERS
   ========================================================================== */
// Wire main control buttons
if (toggleBtn) {
  toggleBtn.onclick = async () => {
    if (!isRunning) {
      if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume();
      }
      await requestWakeLock();
      isRunning = true;
      startTimerLoop();
    } else {
      isRunning = false;
      pauseTimerLoop();
      await releaseWakeLock();
    }
    updateToggle();
  };
}

if (resetBtn) {
  resetBtn.onclick = async () => {
    isRunning = false;
    resetTimerLoop();
    await releaseWakeLock();

    totalSeconds = 0;
    setCount = 1;
    currentMode = 'WARMUP';
    intervalSecondsLeft = settings.warmup;

    updateDisplay();
    updateToggle();
  };
}

if (settingsBtn) {
  settingsBtn.onclick = () => {
    settingsEl.classList.add('open');
    overlay.classList.add('open');
  };
}

function closeSettings() {
  settingsEl.classList.remove('open');
  overlay.classList.remove('open');

  if (!isRunning) {
    intervalSecondsLeft =
      currentMode === 'RUN'
        ? settings.run
        : currentMode === 'WALK'
        ? settings.walk
        : currentMode === 'WARMUP'
        ? settings.warmup
        : settings.finish;
    updateDisplay();
  }
}

if (closeSettingsBtn) closeSettingsBtn.onclick = closeSettings;
if (overlay) {
  overlay.onclick = () => {
    closeSettings();
    closeCalendar();
  };
}

if (calendarBtn) calendarBtn.onclick = openCalendar;

// Wire setting input change handlers
runInput.value = settings.run;
walkInput.value = settings.walk;
setInput.value = settings.sets;
warmupInput.value = settings.warmup;
finishInput.value = settings.finish;

runInput.addEventListener('change', () => {
  const v = Math.max(1, Number(runInput.value) || 1);
  runInput.value = v;
  settings.run = v;
  localStorage.setItem('runSec', v);
  if (!isRunning && currentMode === 'RUN') { intervalSecondsLeft = v; updateDisplay(); }
  renderPresetChips();
});

walkInput.addEventListener('change', () => {
  const v = Math.max(1, Number(walkInput.value) || 1);
  walkInput.value = v;
  settings.walk = v;
  localStorage.setItem('walkSec', v);
  if (!isRunning && currentMode === 'WALK') { intervalSecondsLeft = v; updateDisplay(); }
  renderPresetChips();
});

setInput.addEventListener('change', () => {
  const v = Math.max(1, Math.floor(Number(setInput.value) || 1));
  setInput.value = v;
  settings.sets = v;
  localStorage.setItem('setCount', v);
  updateDisplay();
  renderPresetChips();
});

warmupInput.addEventListener('change', () => {
  const v = Math.max(0, Number(warmupInput.value) || 0);
  warmupInput.value = v;
  settings.warmup = v;
  localStorage.setItem('warmupSec', v);
  if (!isRunning && currentMode === 'WARMUP') { intervalSecondsLeft = v; updateDisplay(); }
  renderPresetChips();
});

finishInput.addEventListener('change', () => {
  const v = Math.max(0, Number(finishInput.value) || 0);
  finishInput.value = v;
  settings.finish = v;
  localStorage.setItem('finishSec', v);
  if (!isRunning && currentMode === 'FINISH') { intervalSecondsLeft = v; updateDisplay(); }
  renderPresetChips();
});

// Wire Stepper Buttons (- / +)
document.querySelectorAll('.step-btn').forEach((btn) => {
  btn.onclick = () => {
    const targetId = btn.dataset.target;
    const step = Number(btn.dataset.step) || 0;
    const input = document.getElementById(targetId);
    if (!input) return;
    const min = Number(input.min) || 0;
    let val = (Number(input.value) || 0) + step;
    val = Math.max(min, val);
    input.value = val;
    input.dispatchEvent(new Event('change'));
  };
});

// Initial boot initialization
(function init() {
  initCalendarRefs();
  updateDisplay();
  updateToggle();
  renderPresetChips();
  safeRenderCalendar();
  updateSummaries();
  updateStreakUI();
})();

// Prevent double-tap-to-zoom on iOS Safari
let _lastTouchEnd = 0;
document.addEventListener('touchend', function (e) {
  const now = Date.now();
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
    _lastTouchEnd = now;
    return;
  }
  if (now - _lastTouchEnd <= 300) {
    e.preventDefault();
  }
  _lastTouchEnd = now;
}, { passive: false });

/* Universal Pointer & Touch Swipe Gestures (PC Mouse Drag & Mobile Touch Swipe) */
let pointerStartX = 0;
let pointerStartY = 0;
let pointerStartTime = 0;
let isPointerDragging = false;

document.addEventListener('pointerdown', (e) => {
  if (e.isPrimary === false) return;

  const t = e.target;
  // Exclude interactive form inputs, buttons, sliders, or specific clickable items
  if (t && (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.tagName === 'TEXTAREA' || t.closest('.step-btn') || t.closest('.preset-chip') || t.closest('.quick-adj-btn') || t.closest('.chip-delete-btn'))) {
    isPointerDragging = false;
    pointerStartX = 0;
    pointerStartY = 0;
    return;
  }

  pointerStartX = e.clientX;
  pointerStartY = e.clientY;
  pointerStartTime = Date.now();
  isPointerDragging = true;
}, { passive: true });

document.addEventListener('pointerup', (e) => {
  if (!isPointerDragging || !pointerStartX || !pointerStartY) {
    isPointerDragging = false;
    return;
  }

  const deltaX = e.clientX - pointerStartX;
  const deltaY = e.clientY - pointerStartY;
  const duration = Date.now() - pointerStartTime;

  pointerStartX = 0;
  pointerStartY = 0;
  isPointerDragging = false;

  // Swipe gesture criteria:
  // 1. Duration <= 700ms
  // 2. Horizontal movement abs(deltaX) >= 35px
  // 3. Dominant horizontal direction: abs(deltaX) > abs(deltaY) * 1.1
  if (duration <= 700 && Math.abs(deltaX) >= 35 && Math.abs(deltaX) > Math.abs(deltaY) * 1.1) {
    const isCalendarOpen = calendarEl && calendarEl.classList.contains('open');
    const isSettingsOpen = settingsEl && settingsEl.classList.contains('open');

    // Swipe Left (deltaX <= -35): Open Calendar
    if (deltaX <= -35 && !isCalendarOpen && !isSettingsOpen) {
      openCalendar();
    }
    // Swipe Right (deltaX >= 35): Close Calendar if calendar is open
    else if (deltaX >= 35 && isCalendarOpen) {
      closeCalendar();
    }
  }
}, { passive: true });

document.addEventListener('pointercancel', () => {
  isPointerDragging = false;
  pointerStartX = 0;
  pointerStartY = 0;
}, { passive: true });
