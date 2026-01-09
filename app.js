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

const runInput = document.getElementById('runInput');
const walkInput = document.getElementById('walkInput');
const setInput = document.getElementById('setInput');
const warmupInput = document.getElementById('warmupInput');
const finishInput = document.getElementById('finishInput');

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
overlay.onclick = closeSettings;

/* LOCAL STORAGE */
runInput.value = settings.run;
walkInput.value = settings.walk;
setInput.value = settings.sets;
warmupInput.value = settings.warmup;
finishInput.value = settings.finish;

runInput.onchange = () => {
  settings.run = Number(runInput.value);
  localStorage.setItem('runSec', settings.run);
  if (!isRunning && currentMode==='RUN') intervalSecondsLeft = settings.run;
  updateDisplay();
};

walkInput.onchange = () => {
  settings.walk = Number(walkInput.value);
  localStorage.setItem('walkSec', settings.walk);
  if (!isRunning && currentMode==='WALK') intervalSecondsLeft = settings.walk;
  updateDisplay();
};

setInput.onchange = () => {
  settings.sets = Number(setInput.value);
  localStorage.setItem('setCount', settings.sets);
};

warmupInput.onchange = () => {
  settings.warmup = Number(warmupInput.value);
  localStorage.setItem('warmupSec', settings.warmup);
  if (!isRunning && currentMode==='WARMUP') intervalSecondsLeft = settings.warmup;
  updateDisplay();
};

finishInput.onchange = () => {
  settings.finish = Number(finishInput.value);
  localStorage.setItem('finishSec', settings.finish);
};

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
