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
let runTimeInput, runDistInput, saveRunBtn, deleteRunBtn, gymCheckbox; // <- added gymCheckbox

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
let audioContext = null;
let wakeLock = null;

/* UTIL */
function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function updateDisplay() {
  intervalTimeEl.textContent = formatTime(intervalSecondsLeft);
  totalTimeEl.textContent = `Total ${formatTime(totalSeconds)}`;
  setCountEl.textContent = `Set ${setCount}`;
  statusEl.textContent = currentMode;
  statusEl.className = `status ${currentMode}`;
}

function updateToggle() {
  toggleBtn.textContent = isRunning ? 'PAUSE' : 'START';
  toggleBtn.style.background = isRunning ? '#ffaa00' : '#00ff99';
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

// ADDED: close calendar function (was missing, caused ReferenceError)
function closeCalendar() {
  // Ensure references exist
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
}

// overlay.onclick already calls closeCalendar; closeCalendar now defined above ensureCalendarMarkup

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

function openCalendar() {
  ensureCalendarMarkup(); // make sure DOM refs and handlers exist
  calendarEl.classList.add('open');
  overlay.classList.add('open');
  calendarEl.setAttribute('aria-hidden','false');
  renderCalendar(calDate.getFullYear(), calDate.getMonth());
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

  // wire handlers (idempotent)
  calendarBtn.onclick = openCalendar;
  closeCalendarBtn.onclick = closeCalendar;
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

    // number + gym placeholder
    dayEl.innerHTML = `<div class="day-number">${String(cellDate.getDate())}</div><div class="gym-badge" aria-hidden="true"></div>`;

    if (!inThisMonth) {
      dayEl.style.opacity = '0.45';
    } else {
      dayEl.onclick = () => selectDate(dateStr, cellDate);

      const entry = logs[dateStr];
      if (entry) {
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

        if (kmVal || minVal) {
          const rec = document.createElement('div');
          rec.className = 'day-record';

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

/* SOUND */
function playBeep(freq,dur) {
  if (!audioContext) return;
  const o = audioContext.createOscillator();
  const g = audioContext.createGain();
  o.frequency.value = freq;
  o.connect(g);
  g.connect(audioContext.destination);
  o.start();
  g.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime+dur);
  o.stop(audioContext.currentTime+dur);
}

/* INTERVAL / MODE SWITCH */
function switchMode() {
  if (currentMode === 'WARMUP') {
    currentMode = 'RUN';
    intervalSecondsLeft = settings.run;
    playBeep(800,0.15);
    setCount = 1;
    return;
  }

  if (currentMode === 'RUN') {
    currentMode = 'WALK';
    intervalSecondsLeft = settings.walk;
    playBeep(400,0.3);
  } else if (currentMode === 'WALK') {
    if (setCount >= settings.sets) {
      // 마지막 세트 끝 → FINISH
      currentMode = 'FINISH';
      intervalSecondsLeft = settings.finish;
      playBeep(1000,0.5);
    } else {
      currentMode = 'RUN';
      intervalSecondsLeft = settings.run;
      setCount++;
      playBeep(800,0.15);
      setTimeout(()=>playBeep(800,0.15),200);
    }
  } else if (currentMode==='FINISH') {
    // 운동 끝, 자동 멈춤
    isRunning=false;
    clearInterval(timerId);
    releaseWakeLock();
  }
}

/* WAKE LOCK */
async function requestWakeLock() {
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch{}
}
function releaseWakeLock() { if(wakeLock) wakeLock.release(); wakeLock=null; }

document.addEventListener('visibilitychange', async ()=>{
  if(document.visibilityState==='visible' && isRunning) await requestWakeLock();
});

/* START / PAUSE */
toggleBtn.onclick = async ()=>{
  if(!isRunning){
    if(!audioContext) audioContext=new (window.AudioContext || window.webkitAudioContext)();

    await requestWakeLock();
    isRunning=true;

    timerId = setInterval(()=>{
      totalSeconds++;
      intervalSecondsLeft--;
      if(intervalSecondsLeft<=0) switchMode();
      updateDisplay();
    },1000);
  }else{
    isRunning=false;
    clearInterval(timerId);
    releaseWakeLock();
  }
  updateToggle();
};

/* RESET */
resetBtn.onclick = ()=>{
  isRunning=false;
  clearInterval(timerId);
  releaseWakeLock();

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
});
walkInput.addEventListener('change', () => {
  const v = Math.max(1, Number(walkInput.value) || 1);
  walkInput.value = v;
  settings.walk = v;
  localStorage.setItem('walkSec', v);
  if (!isRunning && currentMode === 'WALK') { intervalSecondsLeft = v; updateDisplay(); }
});
setInput.addEventListener('change', () => {
  const v = Math.max(1, Math.floor(Number(setInput.value) || 1));
  setInput.value = v;
  settings.sets = v;
  localStorage.setItem('setCount', v);
});
warmupInput.addEventListener('change', () => {
  const v = Math.max(0, Number(warmupInput.value) || 0);
  warmupInput.value = v;
  settings.warmup = v;
  localStorage.setItem('warmupSec', v);
  if (!isRunning && currentMode === 'WARMUP') { intervalSecondsLeft = v; updateDisplay(); }
});
finishInput.addEventListener('change', () => {
  const v = Math.max(0, Number(finishInput.value) || 0);
  finishInput.value = v;
  settings.finish = v;
  localStorage.setItem('finishSec', v);
  if (!isRunning && currentMode === 'FINISH') { intervalSecondsLeft = v; updateDisplay(); }
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
