/* ELEMENTS */
const statusEl = document.getElementById('status');
const intervalTimeEl = document.getElementById('intervalTime');
const totalTimeEl = document.getElementById('totalTime');
const setCountEl = document.getElementById('setCount');

const toggleBtn = document.getElementById('toggleBtn');
const resetBtn = document.getElementById('resetBtn');

const settingsBtn = document.getElementById('settingsBtn');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const settingsEl = document.getElementById('settings');
const overlay = document.getElementById('overlay');

const calendarBtn = document.getElementById('calendarBtn');

// make calendar-related refs mutable so we can re-query / create them if they are missing
let calendarEl, closeCalendarBtn, prevMonthBtn, nextMonthBtn, calendarMonthYear, calendarDaysEl, selectedDateLabel;
let runTimeInput, runDistInput, saveRunBtn, deleteRunBtn, gymCheckbox;
let calendarExportImportEl, exportCalendarBtn, importCalendarBtn, importCalendarFileInput;
let importCalendarFileListenerAdded = false;
let calendarBtnLongPressTimer = null;
let calendarBtnLongPressTriggered = false;
const CALENDAR_BTN_LONG_PRESS_MS = 700;

const runInput = document.getElementById('runInput');
const walkInput = document.getElementById('walkInput');
const setInput = document.getElementById('setInput');
const warmupInput = document.getElementById('warmupInput');
const finishInput = document.getElementById('finishInput');

const weekSummaryEl = document.getElementById('weekSummary');
const monthSummaryEl = document.getElementById('monthSummary');

/* STATE */
let settings = {
  run: Number(localStorage.getItem('runSec')) || 60,
  walk: Number(localStorage.getItem('walkSec')) || 120,
  sets: Number(localStorage.getItem('setCount')) || 4,
  warmup: Number(localStorage.getItem('warmupSec')) || 30,
  finish: Number(localStorage.getItem('finishSec')) || 60
};

let totalSeconds = 0;
let intervalSecondsLeft = settings.warmup;
let currentMode = 'WARMUP';
let setCount = 1;
let isRunning = false;
let timerId = null;
let timerWorker = null;
let audioContext = null;
let wakeLock = null;
let lastTick = 0; // ms timestamp used for accurate ticking

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

/* UTIL */
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

const progressCircle = document.getElementById('progressCircle');
const RING_CIRCUMFERENCE = 2 * Math.PI * 125; // 785.398

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
  if (!progressCircle) return;
  const total = getModeTotalSeconds(currentMode);
  const ratio = Math.max(0, Math.min(1, intervalSecondsLeft / total));
  const offset = RING_CIRCUMFERENCE * (1 - ratio);
  progressCircle.style.strokeDashoffset = offset;
}

function updateThemeClass() {
  document.body.className = `theme-${currentMode}`;
}

const pipBtn = document.getElementById('pipBtn');
const pipCanvas = document.getElementById('pipCanvas');
const pipVideo = document.getElementById('pipVideo');
let pipCtx = pipCanvas ? pipCanvas.getContext('2d') : null;
let pipStream = null;

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
      if (!isRunning) toggleBtn.click();
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      if (isRunning) toggleBtn.click();
    });
  } catch (err) {
    console.warn('MediaSession error:', err);
  }
}

function updateDisplay() {
  intervalTimeEl.textContent = formatTime(intervalSecondsLeft);
  totalTimeEl.textContent = `Total ${formatTime(totalSeconds)}`;
  setCountEl.textContent = `Set ${setCount}`;
  statusEl.textContent = currentMode;
  statusEl.className = `status ${currentMode}`;

  updateProgressRing();
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

// helpers
function secToMMSS(sec = 0) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function mmssToSec(str) {
  if (!str) return 0;
  const s = String(str).trim();
  if (s.includes(':')) {
    const [min, sec] = s.split(':').map(x => Number(x) || 0);
    return Math.max(0, Math.floor(min) * 60 + Math.floor(sec));
  }
  // allow entering seconds directly
  const n = Number(s);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
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
  const ref = forDateObj ? new Date(forDateObj) : new Date();
  const week = getWeekRange(ref);
  const month = getMonthRange(ref);
  const w = sumLogsBetween(week.start, week.end);
  const m = sumLogsBetween(month.start, month.end);

  weekSummaryEl.textContent = `Week: ${secToMMSS(w.time)} · ${w.dist.toFixed(2)} km`;
  monthSummaryEl.textContent = `Month: ${secToMMSS(m.time)} · ${m.dist.toFixed(2)} km`;
}

/* SETTINGS PANEL */
settingsBtn.onclick = () => {
  settingsEl.classList.add('open');
  overlay.classList.add('open');
};

function closeSettings() {
  settingsEl.classList.remove('open');
  overlay.classList.remove('open');

  // 즉시 반영
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

closeSettingsBtn.onclick = closeSettings;
// overlay.onclick = closeSettings;
overlay.onclick = () => { closeSettings(); closeCalendar(); };

/* CALENDAR (날짜별 런 기록) */
/* calendar logic kept once later in the file */

let calDate = new Date();
let selectedDateStr = null;

function loadRunLogs() { try { return JSON.parse(localStorage.getItem('runLogs') || '{}'); } catch { return {}; } }
function saveRunLogs(obj) { localStorage.setItem('runLogs', JSON.stringify(obj)); }
function getLogFor(dateStr) { return loadRunLogs()[dateStr] || null; }

function formatYYYYMMDD(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
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
    customPresets: typeof getCustomPresets === 'function' ? getCustomPresets() : [],
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

    if (Array.isArray(parsed.customPresets) && typeof saveCustomPresets === 'function') {
      saveCustomPresets(parsed.customPresets);
      if (typeof renderPresetChips === 'function') renderPresetChips();
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

function showCalendarExportImport() {
  ensureCalendarMarkup();
  hideCalendarExportImport();
  if (calendarExportImportEl) {
    calendarExportImportEl.style.display = 'flex';
    calendarExportImportEl.setAttribute('aria-hidden', 'false');
  }
  if (calendarEl) {
    calendarEl.classList.add('open');
    calendarEl.setAttribute('aria-hidden','false');
  }
  if (overlay) overlay.classList.add('open');
}

function hideCalendarExportImport() {
  if (calendarExportImportEl) {
    calendarExportImportEl.style.display = 'none';
    calendarExportImportEl.setAttribute('aria-hidden', 'true');
  }
}

function startCalendarBtnLongPress() {
  calendarBtnLongPressTriggered = false;
  cancelCalendarBtnLongPress();
  calendarBtnLongPressTimer = window.setTimeout(() => {
    calendarBtnLongPressTriggered = true;
    showCalendarExportImport();
  }, CALENDAR_BTN_LONG_PRESS_MS);
}

function cancelCalendarBtnLongPress() {
  if (calendarBtnLongPressTimer) {
    window.clearTimeout(calendarBtnLongPressTimer);
    calendarBtnLongPressTimer = null;
  }
}

function openCalendar() {
  hideCalendarExportImport();
  ensureCalendarMarkup(); // make sure DOM refs and handlers exist
  updateStreakUI();
  // Ensure calendar shows current month and select today's date
  const today = new Date();
  calDate = new Date(today.getFullYear(), today.getMonth(), 1);
  renderCalendar(calDate.getFullYear(), calDate.getMonth());
  calendarEl.classList.add('open');
  overlay.classList.add('open');
  calendarEl.setAttribute('aria-hidden','false');
  const todayStr = formatYYYYMMDD(today);
  // mimic a user click on today's cell so we run the same handler
  const todayCell = calendarDaysEl && calendarDaysEl.querySelector('.calendar-day[data-date="' + todayStr + '"]');
  if (todayCell && typeof todayCell.click === 'function') {
    todayCell.click();
  } else {
    // fallback to direct selection
    selectDate(todayStr, today);
  }
}

// show minutes value when selecting a date
function formatDateLabel(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}. ${m}. ${d}.`;
}

// when selecting a date show formatted label and remove placeholder style
function selectDate(dateStr, dateObj) {
  selectedDateStr = dateStr;
  if (selectedDateLabel) {
    selectedDateLabel.classList.remove('placeholder');
    selectedDateLabel.textContent = formatDateLabel(dateObj);
  }
  const log = getLogFor(dateStr);
  runTimeInput.value = log ? String(Math.round((log.timeSec || 0) / 60)) : '';
  runDistInput.value = log && log.distanceKm != null ? log.distanceKm : '';
  if (gymCheckbox) gymCheckbox.checked = !!(log && log.gym);
  renderCalendar(calDate.getFullYear(), calDate.getMonth());
  updateSummaries(dateObj);
}

// close should reset to placeholder (prevents layout jump)
function closeCalendar() {
  if (!calendarEl) calendarEl = document.getElementById('calendar');
  if (!overlay) overlay = document.getElementById('overlay');

  if (!calendarEl) return;
  calendarEl.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
  calendarEl.setAttribute('aria-hidden', 'true');
  selectedDateStr = null;
  if (selectedDateLabel) {
    selectedDateLabel.classList.add('placeholder');
    selectedDateLabel.textContent = 'yyyy. mm. dd.';
  }
  hideCalendarExportImport();
}

// ensureCalendarMarkup: after re-query set placeholder if empty
function ensureCalendarMarkup() {
  if (!document.getElementById('calendar')) {
    const tpl = `
      <div id="calendar" class="calendar" aria-hidden="true">
        <div class="calendar-header">
          <div class="calendar-nav">
            <button id="prevMonthBtn" class="cal-nav" aria-label="Previous month">◀</button>
            <div id="calendarMonthYear" class="calendar-month-year"></div>
            <button id="nextMonthBtn" class="cal-nav" aria-label="Next month">▶</button>
          </div>
          <button id="closeCalendarBtn" class="settings-header-button" aria-label="Close calendar">✕</button>
        </div>

        <div class="calendar-grid">
          <div class="calendar-weekdays">
            <div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div>
          </div>
          <div id="calendarDays" class="calendar-days"></div>
        </div>

        <div id="calendarDetails" class="calendar-details">
          <div id="selectedDateLabel" class="settings-group-title"></div>

          <div class="calendar-summary">
            <div id="weekSummary" class="calendar-summary-item">Week: 00:00 · 0.00 km</div>
            <div id="monthSummary" class="calendar-summary-item">Month: 00:00 · 0.00 km</div>
          </div>

          <div class="setting-item">
            <label>Run Time (min)</label>
            <input id="runTimeInput" type="number" inputmode="numeric" min="0" step="1" placeholder="mm" />
          </div>

          <div class="setting-item">
            <label>Run Distance (km)</label>
            <!-- type="text" + inputmode="decimal" (no pattern) so iOS always allows '.' -->
            <input id="runDistInput" type="text" inputmode="decimal" placeholder="0.00" />
          </div>

          <div class="setting-item">
            <label for="gymCheckbox">Gym</label>
            <div class="toggle" aria-hidden="false">
              <input id="gymCheckbox" type="checkbox" />
              <span class="toggle-slider" aria-hidden="true"></span>
            </div>
          </div>

          <div class="controls">
            <button id="saveRunBtn">SAVE</button>
            <button id="deleteRunBtn">DELETE</button>
          </div>
        </div>
      </div>
    `;
    // append to body before script tag so styles apply
    document.body.insertAdjacentHTML('beforeend', tpl);
  }

  // re-query all calendar elements (now guaranteed to exist)
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

  // wire handlers (idempotent)
  calendarBtn.onclick = () => {
    if (!calendarBtnLongPressTriggered) {
      openCalendar();
    }
    calendarBtnLongPressTriggered = false;
  };
  calendarBtn.addEventListener('pointerdown', startCalendarBtnLongPress);
  calendarBtn.addEventListener('pointerup', cancelCalendarBtnLongPress);
  calendarBtn.addEventListener('pointerleave', cancelCalendarBtnLongPress);
  calendarBtn.addEventListener('pointercancel', cancelCalendarBtnLongPress);

  closeCalendarBtn.onclick = () => {
    closeCalendar();
    hideCalendarExportImport();
  };
  prevMonthBtn.onclick = () => {
    calDate = new Date(calDate.getFullYear(), calDate.getMonth() - 1, 1);
    safeRenderCalendar();
  };
  nextMonthBtn.onclick = () => {
    calDate = new Date(calDate.getFullYear(), calDate.getMonth() + 1, 1);
    safeRenderCalendar();
  };
  saveRunBtn.onclick = saveRunBtnHandler;
  deleteRunBtn.onclick = deleteRunBtnHandler;

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
  if (importCalendarFileInput && !importCalendarFileListenerAdded) {
    importCalendarFileListenerAdded = true;
    importCalendarFileInput.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result;
        if (!importCalendar(text)) {
          alert('Import failed.');
          return;
        }
        alert('Calendar data imported.');
        hideCalendarExportImport();
      };
      reader.readAsText(file);
    });
  }

  // ensure gym checkbox exists and doesn't break tabbing; auto-save on change
  if (gymCheckbox) {
    gymCheckbox.checked = false;
    gymCheckbox.addEventListener('change', () => {
      // if a date is selected, save immediately for instant feedback
      if (selectedDateStr) saveRunBtnHandler();
    });
  }
}

// small helper to show distance nicely
function formatDistanceDisplay(d) {
  if (d == null || d === '') return '';
  const n = Number(d) || 0;
  if (n >= 1000) return `${(n/1000).toFixed(1).replace(/\.0$/,'')}k`; // e.g. 1500 -> 1.5k
  if (n >= 100) return `${Math.round(n)}km`; // 125 -> 125km (integer)
  const s = n.toFixed(2).replace(/\.00$/,'').replace(/(\.\d)0$/,'$1');
  return `${s}km`; // e.g. 5.5km or 3km
}

/* RENDER CALENDAR - builds day cells and per-day record lines */
function renderCalendar(year, month) {
  if (!calendarDaysEl || !calendarMonthYear) {
    console.warn('renderCalendar skipped: missing DOM refs');
    return;
  }

  calDate = new Date(year, month, 1);
  calendarMonthYear.textContent = calDate.toLocaleString(undefined, { month: 'long', year: 'numeric' });

  calendarDaysEl.innerHTML = '';
  const firstDay = new Date(year, month, 1);
  const startDay = firstDay.getDay();
  const daysInMonth = new Date(year, month+1, 0).getDate();
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
    // expose date on element so we can programmatically click it later
    dayEl.setAttribute('data-date', dateStr);

    // number + gym placeholder
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

        // set the placeholder badge text (keeps consistent cell height)
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
          } else if (kmVal) {
            const kmEl = document.createElement('div');
            kmEl.className = 'km';
            kmEl.textContent = kmVal;
            rec.appendChild(kmEl);
          }

          if (minVal && !isRunCompleted) {
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

/* Safe render wrapper to avoid uncaught exceptions if DOM missing for any reason */
function safeRenderCalendar() {
  try {
    if (!calendarDaysEl) throw new Error('calendarDaysEl missing');
    renderCalendar(calDate.getFullYear(), calDate.getMonth());
  } catch (err) {
    console.error('renderCalendar skipped:', err);
  }
}

/* Extracted small handlers so we can hook them after ensureCalendarMarkup() */
function saveRunBtnHandler() {
  if (!selectedDateStr) return;
  const minutes = Number(runTimeInput.value) || 0;
  const timeSec = Math.max(0, Math.floor(minutes)) * 60;
  const distanceKm = runDistInput && runDistInput.value !== '' ? Number(String(runDistInput.value).replace(',', '.')) : null;
  const logs = loadRunLogs();
  const gym = !!(gymCheckbox && gymCheckbox.checked); // ensure boolean
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
  console.log('Saved run log', selectedDateStr, logs[selectedDateStr]); // debug helper
  if (gymCheckbox) gymCheckbox.checked = !!logs[selectedDateStr]?.gym;
  safeRenderCalendar();
  updateSummaries(new Date(selectedDateStr + 'T00:00:00'));
}

function deleteRunBtnHandler() {
  if (!selectedDateStr) return;
  const logs = loadRunLogs();
  delete logs[selectedDateStr];
  saveRunLogs(logs);
  runTimeInput.value = '';
  runDistInput.value = '';
  if (gymCheckbox) gymCheckbox.checked = false;
  safeRenderCalendar();
  updateSummaries(new Date(selectedDateStr + 'T00:00:00'));
}

// ensure calendar exists before any calendar action
ensureCalendarMarkup();

// replace prior direct calls with safeRenderCalendar when needed
(function initCalendar() {
  const today = new Date();
  calDate = new Date(today.getFullYear(), today.getMonth(), 1);
  safeRenderCalendar();
  updateSummaries();
})();

/* MUTE & SOUND & VIBRATION */
const muteBtn = document.getElementById('muteBtn');
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

/* INTERVAL / MODE SWITCH */
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
      // 마지막 세트 끝 → FINISH
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
    // 운동 끝, 자동 멈춤
    isRunning = false;
    pauseTimerLoop();
    releaseWakeLock();
    autoStampCompletedRun();
  }
}

/* Handle consuming N whole seconds (may cross multiple modes) */
function consumeElapsedSeconds(seconds) {
  let sec = seconds;
  while (sec > 0 && isRunning) {
    if (sec >= intervalSecondsLeft) {
      // consume to the end of this mode
      totalSeconds += intervalSecondsLeft;
      sec -= intervalSecondsLeft;
      intervalSecondsLeft = 0;
      switchMode();
      if (!isRunning) break; // stopped at FINISH
    } else {
      totalSeconds += sec;
      intervalSecondsLeft -= sec;
      sec = 0;
      playCountdownBeep(intervalSecondsLeft);
    }
  }
}

/* CUSTOM PRESETS ENGINE */
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
  localStorage.setItem('customPresets', JSON.stringify(presets));
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

const savePresetBtn = document.getElementById('savePresetBtn');
if (savePresetBtn) {
  savePresetBtn.onclick = saveCurrentAsPreset;
}
renderPresetChips();

/* WAKE LOCK */
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

document.addEventListener('visibilitychange', async ()=>{
  if (document.visibilityState === 'visible' && isRunning) {
    await requestWakeLock();
    // immediately catch up any elapsed time while hidden/suspended
    const now = Date.now();
    const elapsedSec = lastTick ? Math.floor((now - lastTick) / 1000) : 0;
    if (elapsedSec >= 1) {
      lastTick = now;
      consumeElapsedSeconds(elapsedSec);
      updateDisplay();
    }
  }
});

/* START / PAUSE */
toggleBtn.onclick = async ()=>{
  if(!isRunning){
    if(!audioContext) audioContext=new (window.AudioContext || window.webkitAudioContext)();
    if(audioContext && audioContext.state === 'suspended') {
      audioContext.resume();
    }

    await requestWakeLock();
    isRunning=true;
    startTimerLoop();
  }else{
    isRunning=false;
    pauseTimerLoop();
    await releaseWakeLock();
  }
  updateToggle();
};

/* RESET */
resetBtn.onclick = async ()=>{
  isRunning=false;
  resetTimerLoop();
  await releaseWakeLock();

  totalSeconds=0;
  setCount=1;
  currentMode='WARMUP';
  intervalSecondsLeft=settings.warmup;

  updateDisplay();
  updateToggle();
};

/* INIT */
updateDisplay();
updateToggle();

// --- ADDED: wire settings inputs so they persist and immediately apply ---
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

/* CALENDAR (날짜별 런 기록) */
/* calendar logic kept once later in the file */

/* initialize calendar month (hidden) */
(function initCalendar() {
  const today = new Date();
  calDate = new Date(today.getFullYear(), today.getMonth(), 1);
  safeRenderCalendar();
  updateSummaries();
})();

// Prevent double-tap-to-zoom on iOS Safari (prevents the UI from jumping)
let _lastTouchEnd = 0;
document.addEventListener('touchend', function (e) {
  const now = Date.now();
  // ignore taps inside form controls / contenteditable so inputs still behave normally
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
    _lastTouchEnd = now;
    return;
  }
  if (now - _lastTouchEnd <= 300) {
    // must use passive: false to allow preventDefault
    e.preventDefault();
  }
  _lastTouchEnd = now;
}, { passive: false });
