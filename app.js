"use strict";

const fileInput = document.getElementById("fileInput");
const themeToggle = document.getElementById("themeToggle");
const dbInput = document.getElementById("dbInput");
const trialCountInput = document.getElementById("trialCountInput");
const startBtn = document.getElementById("startBtn");
const setupStatus = document.getElementById("setupStatus");

const setupCard = document.getElementById("setupCard");
const testCard = document.getElementById("testCard");
const resultCard = document.getElementById("resultCard");

const trialIndexEl = document.getElementById("trialIndex");
const trialTotalEl = document.getElementById("trialTotal");
const playPauseBtn = document.getElementById("playPauseBtn");
const stopBtn = document.getElementById("stopBtn");
const seekBar = document.getElementById("seekBar");
const timelineTime = document.getElementById("timelineTime");
const listenABtn = document.getElementById("listenABtn");
const listenBBtn = document.getElementById("listenBBtn");
const guessALouderBtn = document.getElementById("guessALouderBtn");
const guessBLouderBtn = document.getElementById("guessBLouderBtn");
const cancelTestBtn = document.getElementById("cancelTestBtn");
const trialStatus = document.getElementById("trialStatus");

const resultBody = document.getElementById("resultBody");
const restartBtn = document.getElementById("restartBtn");

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let audioBuffer = null;
const FADE_TIME_SEC = 0.012;

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeToggle.checked = theme === "dark";
}

function initializeTheme() {
  const saved = localStorage.getItem("abTheme");
  if (saved === "light" || saved === "dark") {
    applyTheme(saved);
    return;
  }

  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(prefersDark ? "dark" : "light");
}

const state = {
  running: false,
  totalTrials: 0,
  currentTrial: 0,
  dbDifference: 0.1,
  loudIsA: [],
  guessesALouder: [],
  currentVariant: "A",
  currentSource: null,
  currentGainNode: null,
  startedAtCtxTime: 0,
  startedAtOffset: 0,
  pausedOffset: 0,
  rafId: null,
  pendingNextTrialTimer: null
};

function dbToLinearGain(db) {
  return Math.pow(10, db / 20);
}

function validateInputs() {
  const fileOk = fileInput.files && fileInput.files.length > 0;
  const db = Number(dbInput.value);
  const trials = Number(trialCountInput.value);
  const dbOk = Number.isFinite(db) && db > 0;
  const trialsOk = Number.isInteger(trials) && trials > 0;

  startBtn.disabled = !(fileOk && dbOk && trialsOk);

  if (!fileOk) {
    setupStatus.textContent = "Choose an audio file to begin.";
    return;
  }
  if (!dbOk) {
    setupStatus.textContent = "Enter a positive dB difference (e.g. 0.1 or 0.01).";
    return;
  }
  if (!trialsOk) {
    setupStatus.textContent = "Enter a whole-number trial count greater than 0.";
    return;
  }

  setupStatus.textContent = "Ready to start.";
}

async function loadAudioFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  return await audioCtx.decodeAudioData(arrayBuffer);
}

function stopCurrentPlayback() {
  if (state.currentSource) {
    try {
      state.currentSource.stop();
    } catch (_) {
      // Source might already be stopped.
    }
    state.currentSource.onended = null;
    state.currentSource.disconnect();
    state.currentSource = null;
  }

  if (state.currentGainNode) {
    state.currentGainNode.disconnect();
    state.currentGainNode = null;
  }

  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
}

function clearPendingTrialTimer() {
  if (state.pendingNextTrialTimer) {
    clearTimeout(state.pendingNextTrialTimer);
    state.pendingNextTrialTimer = null;
  }
}

function getCurrentVariantGain(variant) {
  const louderGain = dbToLinearGain(state.dbDifference);
  // Keep A/B ratio while preserving headroom: never amplify above unity gain.
  const baseGain = 1 / louderGain;
  const quieterGain = baseGain;
  const louderSafeGain = baseGain * louderGain;
  const aIsLouder = state.loudIsA[state.currentTrial - 1];

  if (variant === "A") {
    return aIsLouder ? louderSafeGain : quieterGain;
  }
  return aIsLouder ? quieterGain : louderSafeGain;
}

function stopPlaybackWithFadeOut(durationSec = FADE_TIME_SEC) {
  if (!state.currentSource || !state.currentGainNode) {
    stopCurrentPlayback();
    return;
  }

  const source = state.currentSource;
  const gainNode = state.currentGainNode;
  const now = audioCtx.currentTime;
  const fadeEnd = now + Math.max(0, durationSec);

  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(gainNode.gain.value, now);
  gainNode.gain.linearRampToValueAtTime(0, fadeEnd);

  try {
    source.stop(fadeEnd + 0.002);
  } catch (_) {
    // Source might already be stopped.
  }

  state.currentSource = null;
  state.currentGainNode = null;

  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }
}

function formatTime(seconds) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const whole = Math.floor(safeSeconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function updateTimelineText(currentSeconds) {
  if (!audioBuffer) {
    timelineTime.textContent = "00:00 / 00:00";
    return;
  }
  timelineTime.textContent = `${formatTime(currentSeconds)} / ${formatTime(audioBuffer.duration)}`;
}

function updateSeekUI() {
  if (!state.running || !audioBuffer) {
    return;
  }

  let pos = state.pausedOffset;
  if (state.currentSource) {
    const elapsed = audioCtx.currentTime - state.startedAtCtxTime;
    pos = state.startedAtOffset + Math.max(elapsed, 0);
  }

  if (pos >= audioBuffer.duration) {
    pos = audioBuffer.duration;
  }

  state.pausedOffset = pos;
  const normalized = audioBuffer.duration > 0 ? pos / audioBuffer.duration : 0;
  seekBar.value = String(Math.round(normalized * 1000));
  updateTimelineText(pos);

  if (state.currentSource) {
    state.rafId = requestAnimationFrame(updateSeekUI);
  }
}

function playVariant(variant, preservePausedOffset = false) {
  if (!audioBuffer) {
    return;
  }

  const wasPlaying = Boolean(state.currentSource);
  if (wasPlaying) {
    if (!preservePausedOffset) {
      const elapsed = audioCtx.currentTime - state.startedAtCtxTime;
      state.pausedOffset = Math.min(audioBuffer.duration, state.startedAtOffset + Math.max(elapsed, 0));
    }
    stopPlaybackWithFadeOut();
  } else {
    stopCurrentPlayback();
  }

  state.currentVariant = variant;

  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;

  const gainNode = audioCtx.createGain();
  const now = audioCtx.currentTime;
  const targetGain = getCurrentVariantGain(variant);
  gainNode.gain.setValueAtTime(0, now);
  gainNode.gain.linearRampToValueAtTime(targetGain, now + FADE_TIME_SEC);

  source.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  state.currentSource = source;
  state.currentGainNode = gainNode;
  state.startedAtOffset = Math.min(state.pausedOffset, Math.max(audioBuffer.duration - 0.001, 0));
  state.startedAtCtxTime = audioCtx.currentTime;

  source.onended = () => {
    source.disconnect();
    gainNode.disconnect();

    if (state.currentSource === source) {
      state.pausedOffset = Math.min(audioBuffer.duration, state.startedAtOffset + (audioCtx.currentTime - state.startedAtCtxTime));
      state.currentSource = null;
      state.currentGainNode = null;
      playPauseBtn.textContent = "Play";
      if (state.rafId) {
        cancelAnimationFrame(state.rafId);
        state.rafId = null;
      }
      updateSeekUI();
    }
  };

  source.start(0, state.startedAtOffset);
  playPauseBtn.textContent = "Pause";
  updateSeekUI();
}

function pausePlayback() {
  if (!state.currentSource) {
    return;
  }
  const elapsed = audioCtx.currentTime - state.startedAtCtxTime;
  state.pausedOffset = Math.min(audioBuffer.duration, state.startedAtOffset + Math.max(elapsed, 0));
  stopPlaybackWithFadeOut();
  playPauseBtn.textContent = "Play";
  updateSeekUI();
}

function restartCurrentVariant() {
  playVariant(state.currentVariant, true);
}

function nextTrial() {
  state.currentTrial += 1;

  if (state.currentTrial > state.totalTrials) {
    finishTest();
    return;
  }

  trialIndexEl.textContent = String(state.currentTrial);
  trialTotalEl.textContent = String(state.totalTrials);
  state.pausedOffset = 0;
  stopCurrentPlayback();
  playPauseBtn.textContent = "Play";
  trialStatus.textContent = "Listen to A and B as much as you want, then make your guess.";
  seekBar.value = "0";
  updateTimelineText(0);
}

function chooseLouderGuess(aLouderGuess) {
  if (!state.running) {
    return;
  }

  state.guessesALouder.push(aLouderGuess);
  const trialIdx = state.currentTrial - 1;
  const correct = state.loudIsA[trialIdx] === aLouderGuess;

  trialStatus.textContent = correct ? "Correct. Moving to next trial..." : "Incorrect. Moving to next trial...";

  clearPendingTrialTimer();
  state.pendingNextTrialTimer = setTimeout(() => {
    state.pendingNextTrialTimer = null;
    if (!state.running) {
      return;
    }
    nextTrial();
  }, 450);
}

function cancelTest() {
  if (!state.running) {
    return;
  }

  clearPendingTrialTimer();
  state.running = false;
  stopPlaybackWithFadeOut();
  state.currentTrial = 0;
  state.totalTrials = 0;
  state.loudIsA = [];
  state.guessesALouder = [];
  state.pausedOffset = 0;
  seekBar.value = "0";
  updateTimelineText(0);

  testCard.classList.add("hidden");
  resultCard.classList.add("hidden");
  setupCard.classList.remove("hidden");
  setupStatus.textContent = "Test cancelled. You can adjust settings and start again.";
  startBtn.disabled = false;
}

function combinations(n, k) {
  if (k < 0 || k > n) {
    return 0;
  }
  if (k === 0 || k === n) {
    return 1;
  }
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= kk; i += 1) {
    result = result * (n - kk + i) / i;
  }
  return result;
}

function binomialTailPValue(n, kOrMore, p) {
  let sum = 0;
  for (let k = kOrMore; k <= n; k += 1) {
    sum += combinations(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
  }
  return Math.min(1, Math.max(0, sum));
}

function wilsonCI(successes, n, z = 1.96) {
  if (n === 0) {
    return [0, 1];
  }
  const phat = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (phat + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function finishTest() {
  state.running = false;
  stopCurrentPlayback();

  const n = state.totalTrials;
  let correct = 0;
  for (let i = 0; i < n; i += 1) {
    if (state.loudIsA[i] === state.guessesALouder[i]) {
      correct += 1;
    }
  }

  const accuracy = n > 0 ? correct / n : 0;
  const pValue = binomialTailPValue(n, correct, 0.5);
  const ci = wilsonCI(correct, n);

  resultBody.innerHTML = `
    <div class="resultList">
      <div>Trials: <span class="resultValue">${n}</span></div>
      <div>dB difference tested: <span class="resultValue">${state.dbDifference.toFixed(4)} dB</span></div>
      <div>Correct: <span class="resultValue">${correct}</span></div>
      <div>Accuracy: <span class="resultValue">${(accuracy * 100).toFixed(2)}%</span></div>
      <div>One-sided binomial p-value (chance = 50%): <span class="resultValue">${pValue.toExponential(4)}</span></div>
      <div>95% Wilson CI for true accuracy: <span class="resultValue">[${(ci[0] * 100).toFixed(1)}%, ${(ci[1] * 100).toFixed(1)}%]</span></div>
    </div>
    <p>
      Interpretation: lower p-value means stronger evidence that performance is above chance.
      A common cutoff is p &lt; 0.05.
    </p>
  `;

  testCard.classList.add("hidden");
  resultCard.classList.remove("hidden");
  setupCard.classList.remove("hidden");
  startBtn.disabled = false;
  setupStatus.textContent = "Test complete. You can run another test.";
}

async function startTest() {
  const file = fileInput.files && fileInput.files[0];
  const db = Number(dbInput.value);
  const trials = Number(trialCountInput.value);

  if (!file || !Number.isFinite(db) || db <= 0 || !Number.isInteger(trials) || trials <= 0) {
    validateInputs();
    return;
  }

  startBtn.disabled = true;
  setupStatus.textContent = "Loading audio...";

  try {
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    audioBuffer = await loadAudioFile(file);
    state.running = true;
    state.totalTrials = trials;
    state.currentTrial = 0;
    state.dbDifference = db;
    state.loudIsA = Array.from({ length: trials }, () => Math.random() < 0.5);
    state.guessesALouder = [];
    state.currentVariant = "A";
    state.pausedOffset = 0;

    resultCard.classList.add("hidden");
    testCard.classList.remove("hidden");

    nextTrial();
    updateTimelineText(0);
    setupStatus.textContent = "Test running.";
  } catch (err) {
    startBtn.disabled = false;
    setupStatus.textContent = `Could not load this file: ${err && err.message ? err.message : "Unknown error"}`;
  }
}

fileInput.addEventListener("change", validateInputs);
dbInput.addEventListener("input", validateInputs);
trialCountInput.addEventListener("input", validateInputs);
startBtn.addEventListener("click", startTest);

themeToggle.addEventListener("change", () => {
  const next = themeToggle.checked ? "dark" : "light";
  applyTheme(next);
  localStorage.setItem("abTheme", next);
});

listenABtn.addEventListener("click", () => {
  state.currentVariant = "A";
  playVariant("A");
});

listenBBtn.addEventListener("click", () => {
  state.currentVariant = "B";
  playVariant("B");
});

playPauseBtn.addEventListener("click", () => {
  if (!state.running || !audioBuffer) {
    return;
  }

  if (state.currentSource) {
    pausePlayback();
  } else {
    playVariant(state.currentVariant);
  }
});

stopBtn.addEventListener("click", () => {
  state.pausedOffset = 0;
  stopCurrentPlayback();
  playPauseBtn.textContent = "Play";
  seekBar.value = "0";
  updateTimelineText(0);
});

seekBar.addEventListener("input", () => {
  if (!audioBuffer) {
    return;
  }
  const normalized = Number(seekBar.value) / 1000;
  state.pausedOffset = Math.max(0, Math.min(audioBuffer.duration, normalized * audioBuffer.duration));
  updateTimelineText(state.pausedOffset);

  if (state.currentSource) {
    restartCurrentVariant();
  }
});

guessALouderBtn.addEventListener("click", () => chooseLouderGuess(true));
guessBLouderBtn.addEventListener("click", () => chooseLouderGuess(false));

restartBtn.addEventListener("click", () => {
  resultCard.classList.add("hidden");
  setupCard.classList.remove("hidden");
  testCard.classList.add("hidden");
  setupStatus.textContent = "Adjust settings and start again.";
  validateInputs();
});

cancelTestBtn.addEventListener("click", cancelTest);

validateInputs();
updateTimelineText(0);
initializeTheme();
