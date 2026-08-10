/* timer-worker.js - Background Timer Web Worker */

let timerId = null;
let lastTick = 0;
const TICK_INTERVAL_MS = 250; // Check every 250ms for low latency and high accuracy

self.onmessage = function (e) {
  const data = e.data || {};
  const command = data.command;

  switch (command) {
    case 'start':
      startTimer();
      break;
    case 'pause':
      pauseTimer();
      break;
    case 'reset':
      resetTimer();
      break;
    default:
      break;
  }
};

function startTimer() {
  if (timerId) {
    clearInterval(timerId);
  }
  lastTick = Date.now();
  self.postMessage({ type: 'started' });

  timerId = setInterval(() => {
    const now = Date.now();
    let elapsedMs = now - lastTick;
    if (elapsedMs < 0) elapsedMs = 0;

    const elapsedSec = Math.floor(elapsedMs / 1000);
    if (elapsedSec >= 1) {
      lastTick += elapsedSec * 1000;
      self.postMessage({ type: 'tick', elapsedSec: elapsedSec });
    }
  }, TICK_INTERVAL_MS);
}

function pauseTimer() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
  self.postMessage({ type: 'paused' });
}

function resetTimer() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
  lastTick = 0;
  self.postMessage({ type: 'reset' });
}
