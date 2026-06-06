import { cancelJob, downloadJobResult, fetchJob, pollJob, submitJob } from './api/pipeline.js';
import { AudioEngine } from './audio/engine.js';
import {
  drawCrtStatic,
  drawCrtWaveform,
  progressFromClientX,
  resetCrtDisplay,
} from './components/crt-display.js';
import { RendersPanel } from './components/renders-panel.js';
import { TransportPlayer } from './components/transport-player.js';
import { ThemeManager } from './themes/manager.js';
import { LayoutScaler } from './layout/scaler.js';
import { ProfileDropdown, PROFILE_OPTIONS } from './components/profile-dropdown.js';
import { ThemeDropdown } from './components/theme-dropdown.js';

const engine = new AudioEngine();

// DOM refs — populated in initApp
let dropzone, fileInput, bayIdle, bayLoading, bayLoaded, fileNameSpan, titleWindow, clearFileBtn;
let decodePercent, decodeFileName, decodeStatus, decodeTrackFill, decodeSegmentBar;
let waveformCanvas, playBtn, masterVolume;
let lcdConsole, lcdTime;
let ledPower, ledProcess, ledActive;
let meterBass, meterTreble, meterOrbit, meterWidth;
let valMeterBass, valMeterTreble, valMeterOrbit, valMeterWidth;
let dialMarkerBpm, dialMarkerEnergy, valBpm, valEnergy;
let cassetteMetaBadge, cassetteBadgeRow, cassetteProfileBadge, cassetteGenreBadge;
let loadedCassette;
let decodeProgressTimer = null;
let activeJobId = null;
let lastRenderedJobId = null;
let lastTrackName = null;
let downloadBtn;
let trackMeta = null;
let lastConsoleTick = 0;
const PROFILE_LABELS = Object.fromEntries(PROFILE_OPTIONS.map((p) => [p.id, p.label]));

const PROFILE_WIDTH = {
  zenith: 1.85,
  hyper_immersive: 1.95,
  concert: 1.65,
  cinema: 2.5,
  audiophile: 1.25,
  basshead: 1.2,
};

const DECODE_STAGES = [
  { at: 0, text: 'INGESTING CASSETTE...' },
  { at: 12, text: 'UPLOADING TO PIPELINE...' },
  { at: 28, text: 'DEMUCS STEM SEPARATION...' },
  { at: 45, text: 'LIBROSA BRAIN ANALYSIS...' },
  { at: 62, text: 'PEDALBOARD DSP RENDER...' },
  { at: 78, text: 'MIXING DOWN MASTER...' },
  { at: 92, text: 'FINALIZING DECODE...' },
];

function showDecodeLoader(file) {
  bayIdle?.classList.add('hidden');
  bayLoaded?.classList.add('hidden');
  bayLoading?.classList.remove('hidden');
  dropzone?.classList.add('is-decoding');

  const lcdStatus = document.querySelector('.lcd-status');
  if (lcdStatus) lcdStatus.textContent = 'SYS STAT: DECODING';

  const name = (file?.name || 'UNKNOWN').toUpperCase();
  if (decodeFileName) decodeFileName.textContent = name;
  updateDecodeProgress(0, DECODE_STAGES[0].text);
}

function hideDecodeLoader() {
  bayLoading?.classList.add('hidden');
  dropzone?.classList.remove('is-decoding');

  const lcdStatus = document.querySelector('.lcd-status');
  if (lcdStatus) lcdStatus.textContent = 'SYS STAT: READY';

  if (decodeProgressTimer) {
    clearInterval(decodeProgressTimer);
    decodeProgressTimer = null;
  }
}

function updateDecodeProgress(percent, statusText) {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)));
  if (decodePercent) decodePercent.textContent = `${String(clamped).padStart(3, '0')}%`;
  if (decodeTrackFill) decodeTrackFill.style.width = `${clamped}%`;
  if (decodeStatus && statusText) decodeStatus.textContent = statusText;

  if (decodeSegmentBar) {
    const lit = Math.round((clamped / 100) * 10);
    decodeSegmentBar.querySelectorAll('.decode-segment').forEach((seg, i) => {
      seg.classList.toggle('is-lit', i < lit);
    });
  }
}

function stageTextForProgress(percent) {
  let text = DECODE_STAGES[0].text;
  for (const stage of DECODE_STAGES) {
    if (percent >= stage.at) text = stage.text;
  }
  return text;
}

function getSelectedProfile() {
  return ProfileDropdown.getValue();
}

async function processViaBackend(file, profile) {
  const jobId = await submitJob(file, profile);
  activeJobId = jobId;

  const job = await pollJob(jobId, (status) => {
    updateDecodeProgress(status.percent ?? 0, status.message || stageTextForProgress(status.percent ?? 0));
    printConsoleLines([
      `JOB ${jobId.slice(0, 12)}...`,
      `STAGE: ${(status.status || 'working').toUpperCase()}`,
      status.message || 'PROCESSING...',
    ]);
  });

  const blob = await downloadJobResult(jobId);
  activeJobId = null;

  const meta = job.meta || {};
  const report = {
    bpm: parseFloat(meta.bpm ?? 120),
    genre: meta.genre || 'Server Rendered',
    mood: meta.mood || 'Pipeline Mix',
    profile: meta.profile || profile,
    ai_score: meta.ai_score || null,
    safeguard: meta.safeguard || null,
    safeguard_message: meta.safeguard_message || null,
  };

  const arrayBuffer = await blob.arrayBuffer();
  const buffer = await engine.loadProcessedAudio(arrayBuffer, report);
  return { buffer, report, meta, jobId };
}

async function cancelActiveJob() {
  if (!activeJobId) return;
  await cancelJob(activeJobId);
  activeJobId = null;
}

function finishDecodeProgress() {
  if (decodeProgressTimer) {
    clearInterval(decodeProgressTimer);
    decodeProgressTimer = null;
  }
  updateDecodeProgress(100, 'DECODE COMPLETE // LOCKED');
  return new Promise((resolve) => setTimeout(resolve, 450));
}

function getCanvasColors() {
  return {
    glow: ThemeManager.getToken('--theme-crt-glow'),
    dim: ThemeManager.getToken('--theme-crt-dim'),
    shadow: ThemeManager.getToken('--theme-crt-shadow'),
    decay: ThemeManager.getToken('--theme-crt-bg-decay'),
    accent: ThemeManager.getToken('--theme-accent-primary'),
  };
}



function syncPlaybackUi() {
  const progress = getPlaybackProgress();
  const duration = engine.decodedBuffer?.duration ?? 0;

  if (!TransportPlayer.isSeeking()) {
    TransportPlayer.sync({
      playing: engine.isPlaying,
      progress: progress ?? 0,
      duration,
    });
  }

  if (playBtn) {
    playBtn.classList.toggle('active', engine.isPlaying);
    playBtn.disabled = !engine.decodedBuffer;
  }



  if (progress != null && lcdTime && engine.decodedBuffer) {
    const elapsed = progress * engine.decodedBuffer.duration;
    const minutes = Math.floor(elapsed / 60);
    const seconds = Math.floor(elapsed % 60);
    const hundredths = Math.floor((elapsed % 1) * 100);
    const pad = (n) => (n < 10 ? '0' : '') + n;
    lcdTime.innerText = `${pad(minutes)}:${pad(seconds)}.${pad(hundredths)}`;
  }
}

function togglePlayback() {
  if (!engine.decodedBuffer) return;

  if (!engine.isPlaying) {
    engine.play();
    startCassetteSpindles();
  } else {
    engine.pause();
    stopCassetteSpindles();
  }
  syncPlaybackUi();
}

function seekPlayback(progress, { live = false } = {}) {
  if (!engine.decodedBuffer) return;
  const clamped = Math.max(0, Math.min(1, progress));
  engine.seek(clamped);


  if (!engine.isPlaying || live) {
    drawWaveform(engine.decodedBuffer);
  }

  syncPlaybackUi();
}

function attachPlaybackEndedHandler() {
  engine.onEndedCallback = () => {
    engine.pause();
    seekPlayback(0);
    stopCassetteSpindles();
    syncPlaybackUi();
    ledActive?.classList.remove('active');

    const report = engine.brainReport;
    printConsoleLines([
      'PLAYBACK COMPLETED.',
      `GENRE HISTOGRAM: ${(report.genre || 'UNKNOWN').toUpperCase()}`,
      'SYSTEM DOCKED // STANDBY MODE.',
    ]);
  };
}

async function mountLoadedTrack({
  buffer,
  trackName,
  jobId,
  meta,
  autoplay = false,
  consoleLines = [],
}) {
  lastRenderedJobId = jobId;
  lastTrackName = trackName;

  resetCrtDisplay();
  drawWaveform(buffer);
  setupBrainConsoleSync();
  applyTrackMeta(meta);

  bayLoaded?.classList.remove('hidden');
  bayIdle?.classList.add('hidden');
  setUploadActive(false);
  setCassetteTitle(trackName);
  setDownloadAvailable(Boolean(jobId));
  TransportPlayer.setTrack(trackName);
  attachPlaybackEndedHandler();
  RendersPanel.refresh();

  if (consoleLines.length) printConsoleLines(consoleLines);

  ledActive?.classList.add('active');

  if (autoplay) {
    engine.play();
    startCassetteSpindles();
  }

  syncPlaybackUi();
}

async function loadRenderFromLibrary(render) {
  if (!render || render.status !== 'complete' || !render.hasOutput) {
    throw new Error('Selected render is not ready for playback.');
  }

  engine.stop();
  const [blob, job] = await Promise.all([
    downloadJobResult(render.jobId),
    fetchJob(render.jobId),
  ]);

  const metaPayload = job.meta || {};
  const report = {
    bpm: parseFloat(metaPayload.bpm ?? 120),
    genre: metaPayload.genre || 'Server Rendered',
    mood: metaPayload.mood || 'Pipeline Mix',
    profile: metaPayload.profile || render.profile || 'zenith',
    ai_score: metaPayload.ai_score || null,
    safeguard: metaPayload.safeguard || null,
    safeguard_message: metaPayload.safeguard_message || null,
  };

  const arrayBuffer = await blob.arrayBuffer();
  const buffer = await engine.loadProcessedAudio(arrayBuffer, report);
  const trackName = render.originalName || 'render';

  await mountLoadedTrack({
    buffer,
    trackName,
    jobId: render.jobId,
    meta: {
      bpm: report.bpm,
      genre: report.genre,
      mood: report.mood,
      profile: report.profile,
    },
    autoplay: true,
    consoleLines: [
      'RENDER LOADED FROM LIBRARY.',
      `TRACK: ${trackName.toUpperCase()}`,
      `PROFILE: ${(report.profile || render.profile || 'UNKNOWN').toUpperCase()}`,
      'PLAYBACK ENGAGED.',
    ],
  });
}

function getPlaybackProgress() {
  if (!engine.decodedBuffer) return null;
  const dur = engine.decodedBuffer.duration;
  if (dur <= 0) return null;
  const elapsed = engine.isPlaying && engine.ctx
    ? engine.ctx.currentTime - engine.startTime
    : engine.pauseOffset;
  return Math.min(1, Math.max(0, elapsed / dur));
}

function initApp() {
  dropzone = document.getElementById('dropzone');
  fileInput = document.getElementById('fileInput');
  bayIdle = document.getElementById('bayIdle');
  bayLoading = document.getElementById('bayLoading');
  bayLoaded = document.getElementById('bayLoaded');
  fileNameSpan = document.getElementById('fileName');
  titleWindow = document.getElementById('titleWindow');
  clearFileBtn = document.getElementById('clearFileBtn');
  decodePercent = document.getElementById('decodePercent');
  decodeFileName = document.getElementById('decodeFileName');
  decodeStatus = document.getElementById('decodeStatus');
  decodeTrackFill = document.getElementById('decodeTrackFill');
  decodeSegmentBar = document.getElementById('decodeSegmentBar');
  waveformCanvas = document.getElementById('waveformCanvas');
  playBtn = document.getElementById('playBtn');
  masterVolume = document.getElementById('masterVolume');
  lcdConsole = document.getElementById('lcdConsole');
  lcdTime = document.getElementById('lcdTime');
  ledPower = document.getElementById('ledPower');
  ledProcess = document.getElementById('ledProcess');
  ledActive = document.getElementById('ledActive');
  meterBass = document.getElementById('meterBass');
  meterTreble = document.getElementById('meterTreble');
  meterOrbit = document.getElementById('meterOrbit');
  meterWidth = document.getElementById('meterWidth');
  valMeterBass = document.getElementById('valMeterBass');
  valMeterTreble = document.getElementById('valMeterTreble');
  valMeterOrbit = document.getElementById('valMeterOrbit');
  valMeterWidth = document.getElementById('valMeterWidth');
  dialMarkerBpm = document.getElementById('dialMarkerBpm');
  dialMarkerEnergy = document.getElementById('dialMarkerEnergy');
  valBpm = document.getElementById('valBpm');
  valEnergy = document.getElementById('valEnergy');
  cassetteMetaBadge = document.getElementById('cassetteMetaBadge');
  cassetteBadgeRow = document.getElementById('cassetteBadgeRow');
  cassetteProfileBadge = document.getElementById('cassetteProfileBadge');
  cassetteGenreBadge = document.getElementById('cassetteGenreBadge');
  loadedCassette = document.getElementById('loadedCassette');
  downloadBtn = document.getElementById('downloadBtn');

  ThemeManager.init();
  LayoutScaler.init();
  ThemeDropdown.init();
  ProfileDropdown.init();
  TransportPlayer.init({
    onPlayToggle: togglePlayback,
    onSeek: seekPlayback,
  });
  RendersPanel.init({
    onDeleted: handleRendersDeleted,
    onLoadPlay: loadRenderFromLibrary,
  });
  bindEvents();

  setUploadActive(true);
  if (ledPower) ledPower.classList.add('active');
  refreshCanvas();

  window.addEventListener('auralisConsole', (e) => {
    if (e.detail?.lines) printConsoleLines(e.detail.lines);
  });
  window.addEventListener('themeChanged', refreshCanvas);
  window.addEventListener('layoutScaled', refreshCanvas);
  window.addEventListener('resize', refreshCanvas);

  requestAnimationFrame(animationLoop);
}

function bindEvents() {
  if (dropzone) {
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('is-dragover');
    });
    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('is-dragover');
    });
    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('is-dragover');
      if (e.dataTransfer.files.length > 0) loadCassette(e.dataTransfer.files[0]);
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      if (e.target.files?.length > 0) {
        loadCassette(e.target.files[0]);
        fileInput.value = '';
      }
    });
  }

  if (clearFileBtn) {
    clearFileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      resetCassette();
    });
  }

  if (playBtn) {
    playBtn.addEventListener('click', togglePlayback);
  }

  if (masterVolume) {
    masterVolume.addEventListener('input', (e) => {
      engine.setMasterVolume(parseFloat(e.target.value));
    });
  }

  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      downloadRenderedTrack();
    });
  }


}

function handleRendersDeleted(deletedIds = []) {
  if (lastRenderedJobId && deletedIds.includes(lastRenderedJobId)) {
    lastRenderedJobId = null;
    setDownloadAvailable(false);
  }

  if (activeJobId && deletedIds.includes(activeJobId)) {
    activeJobId = null;
    if (bayLoading && !bayLoading.classList.contains('hidden')) {
      hideDecodeLoader();
      bayIdle?.classList.remove('hidden');
      setUploadActive(true);
      ledProcess?.classList.remove('active');
    }
  }
}

function setDownloadAvailable(available) {
  if (downloadBtn) downloadBtn.disabled = !available;
}

async function downloadRenderedTrack() {
  if (!lastRenderedJobId) return;

  try {
    downloadBtn.disabled = true;
    const blob = await downloadJobResult(lastRenderedJobId);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    const base = (lastTrackName || 'track').replace(/\.[^.]+$/, '');
    anchor.download = `${base}_Auralis.wav`;
    anchor.click();
    URL.revokeObjectURL(url);
    printConsoleLines([
      'EXPORT COMPLETE.',
      `${base.toUpperCase()}_AURALIS.WAV SAVED TO DISK.`,
    ]);
  } catch (err) {
    printConsoleLines([
      'EXPORT FAILED.',
      String(err.message || err).toUpperCase(),
    ]);
    console.error('[Auralis] download failed:', err);
  } finally {
    setDownloadAvailable(Boolean(lastRenderedJobId));
  }
}

function setUploadActive(active) {
  const label = document.querySelector('label.cassette-slot');
  if (label) label.style.pointerEvents = active ? 'auto' : 'none';
  if (fileInput) fileInput.disabled = !active;
}

function refreshCanvas() {
  if (!waveformCanvas) return;
  resizeCanvas(waveformCanvas);
  if (engine.decodedBuffer && !engine.isPlaying) {
    drawWaveform(engine.decodedBuffer);
  } else {
    drawStaticScreen();
  }
}

function resizeCanvas(canvas) {
  const host = canvas?.parentElement;
  if (!host) return;

  const w = Math.max(1, host.clientWidth);
  const h = Math.max(1, host.clientHeight);
  const dpr = window.devicePixelRatio || 1;

  const bitmapW = Math.round(w * dpr);
  const bitmapH = Math.round(h * dpr);

  if (canvas.width !== bitmapW || canvas.height !== bitmapH) {
    canvas.width = bitmapW;
    canvas.height = bitmapH;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
}

function printConsoleLines(lines) {
  if (!lcdConsole) return;
  lcdConsole.innerHTML = '';
  lines.forEach((line) => {
    const el = document.createElement('div');
    el.className = 'console-line text-amber font-mono';
    el.innerText = `> ${line}`;
    lcdConsole.appendChild(el);
  });
}

function drawStaticScreen() {
  if (!waveformCanvas) return;
  const canvas = waveformCanvas;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  const lineScale = Math.max(1, w / 400);
  drawCrtStatic(ctx, w, h, getCanvasColors(), lineScale);
}

function formatBpm(bpm) {
  return String(Math.round(bpm || 0)).padStart(3, '0');
}

function applyBpmTiming(bpm) {
  const safeBpm = Math.min(200, Math.max(60, bpm || 120));
  const beatSec = 60 / safeBpm;
  const spindleDuration = `${(beatSec * 2.2).toFixed(2)}s`;
  const spindleRight = `${(beatSec * 1.75).toFixed(2)}s`;
  const tapeDrift = `${(beatSec * 0.45).toFixed(2)}s`;
  const orbitHz = (safeBpm / 60) * 0.125;

  if (loadedCassette) {
    loadedCassette.style.setProperty('--spindle-duration', spindleDuration);
    loadedCassette.style.setProperty('--spindle-duration-right', spindleRight);
    loadedCassette.style.setProperty('--tape-drift-duration', tapeDrift);
    loadedCassette.style.setProperty('--orbit-hz', orbitHz.toFixed(2));
  }

  if (valMeterOrbit) valMeterOrbit.innerText = `${orbitHz.toFixed(2)}Hz`;
}

function applyCassetteBadges(meta) {
  if (!meta) return;

  const profileLabel = PROFILE_LABELS[meta.profile] || (meta.profile || '').toUpperCase();
  const genreShort = (meta.genre || '').split('/')[0].trim().toUpperCase();

  if (cassetteMetaBadge) {
    cassetteMetaBadge.textContent = profileLabel
      ? `${profileLabel} · PIPELINE`
      : 'TYPE II · HI-FI';
  }

  if (cassetteProfileBadge) cassetteProfileBadge.textContent = profileLabel;
  if (cassetteGenreBadge) cassetteGenreBadge.textContent = genreShort;

  if (cassetteBadgeRow) {
    cassetteBadgeRow.hidden = !(profileLabel || genreShort);
  }

  document.body.dataset.auralisProfile = meta.profile || '';
  document.body.dataset.auralisGenre = genreShort || '';
}

function applyTrackMeta(meta) {
  trackMeta = meta;
  applyCassetteBadges(meta);
  applyBpmTiming(meta.bpm);

  if (valBpm) valBpm.innerText = formatBpm(meta.bpm);
  const bpmPercent = Math.min(1.0, Math.max(0.0, ((meta.bpm || 120) - 60) / 120));
  const bpmAngle = bpmPercent * 270 - 135;
  if (dialMarkerBpm) {
    dialMarkerBpm.style.transform = `translate(-50%, -50%) rotate(${bpmAngle}deg)`;
  }

  const widthCoeff = PROFILE_WIDTH[meta.profile] ?? 1.0;
  if (valMeterWidth) valMeterWidth.innerText = `${widthCoeff}x`;
  if (meterWidth) meterWidth.style.width = `${Math.min(100, ((widthCoeff - 0.8) / 1.1) * 100)}%`;
}

function updateDirectPlaybackMeters() {
  if (!engine.directPlayback || !engine.isPlaying) return;

  const metrics = engine.getLiveMetrics();
  const report = engine.brainReport;
  const beatPhase = engine.getBeatPhase();
  const beatPulse = 0.55 + 0.45 * Math.sin(beatPhase * Math.PI * 2);

  if (meterBass) meterBass.style.width = `${Math.min(100, metrics.bass * 120 * beatPulse)}%`;
  if (valMeterBass) {
    const db = Math.round((metrics.bass * 12 - 6) * 10) / 10;
    valMeterBass.innerText = `${db > 0 ? '+' : ''}${db}dB`;
  }

  if (meterTreble) meterTreble.style.width = `${Math.min(100, metrics.treble * 130)}%`;
  if (valMeterTreble) {
    const db = Math.round((metrics.treble * 10 - 4) * 10) / 10;
    valMeterTreble.innerText = `${db > 0 ? '+' : ''}${db}dB`;
  }

  if (meterOrbit) meterOrbit.style.width = `${Math.min(100, beatPulse * 100)}%`;

  if (valEnergy) valEnergy.innerText = `${Math.min(100, Math.round(metrics.rms * 280))}%`;
  const energyAngle = Math.min(1.0, metrics.rms * 2.4) * 270 - 135;
  if (dialMarkerEnergy) {
    dialMarkerEnergy.style.transform = `translate(-50%, -50%) rotate(${energyAngle}deg)`;
  }

  if (loadedCassette) {
    loadedCassette.classList.toggle('is-beat-pulse', engine.isPlaying);
    loadedCassette.style.setProperty('--beat-glow', beatPulse.toFixed(2));
  }

  const now = performance.now();
  if (now - lastConsoleTick > 900) {
    lastConsoleTick = now;
    printConsoleLines([
      'PIPELINE PLAYBACK: LIVE',
      `GENRE: ${(report.genre || '').toUpperCase()}`,
      `BPM SYNC: ${formatBpm(report.bpm)} // ${(report.profile || '').toUpperCase()}`,
      `ENERGY: ${Math.min(100, Math.round(metrics.rms * 280))}% RMS`,
    ]);
  }
}

function setCassetteTitle(name) {
  if (!fileNameSpan) return;
  const display = (name || 'UNKNOWN').toUpperCase();
  fileNameSpan.textContent = display;
  fileNameSpan.title = name || '';
  fileNameSpan.classList.remove('is-marquee');
  titleWindow?.classList.remove('is-overflow', 'is-marquee');
  titleWindow?.style.removeProperty('--marquee-distance');
  titleWindow?.style.removeProperty('--marquee-duration');

  if (!titleWindow) return;

  requestAnimationFrame(() => {
    const overflow = fileNameSpan.scrollWidth - titleWindow.clientWidth;
    if (overflow > 4) {
      titleWindow.classList.add('is-overflow', 'is-marquee');
      fileNameSpan.classList.add('is-marquee');
      titleWindow.style.setProperty('--marquee-distance', `${overflow}px`);
      const duration = Math.min(16, Math.max(7, overflow / 14));
      titleWindow.style.setProperty('--marquee-duration', `${duration}s`);
    }
  });
}

async function loadCassette(file) {
  if (!file) return;

  try {
    setUploadActive(false);
    showDecodeLoader(file);
    ledProcess?.classList.add('active');
    ledActive?.classList.remove('active');
    const profile = getSelectedProfile();
    printConsoleLines([
      'LOADING CASSETTE TAPE...',
      `ROUTING TO PYTHON PIPELINE (${profile.toUpperCase()})...`,
      'ASYNC JOB QUEUED — POLLING FOR STATUS...',
    ]);

    updateDecodeProgress(2, 'UPLOADING TO PIPELINE...');
    const { buffer, report: serverReport, meta: jobMeta, jobId } = await processViaBackend(file, profile);

    await finishDecodeProgress();
    hideDecodeLoader();
    ledProcess?.classList.remove('active');

    const r = engine.brainReport;
    const meta = {
      bpm: serverReport.bpm ?? r.bpm,
      genre: serverReport.genre ?? r.genre,
      mood: serverReport.mood ?? r.mood,
      profile: serverReport.profile || profile,
      safeguard: jobMeta?.safeguard ?? serverReport.safeguard ?? null,
      safeguard_message: jobMeta?.safeguard_message ?? serverReport.safeguard_message ?? null,
    };

    await mountLoadedTrack({
      buffer,
      trackName: file.name,
      jobId,
      meta,
      consoleLines: [
        'PIPELINE RENDER COMPLETE.',
        `PROFILE: ${(meta.profile || profile).toUpperCase()}`,
        `GENRE DETECTED: ${(meta.genre || r.genre).toUpperCase()}`,
        `DYNAMIC REGIME: ${(meta.mood || r.mood).toUpperCase()}`,
        `BPM CALCULATED: ${formatBpm(meta.bpm)} BEATS/MIN`,
        meta.safeguard_message || null,
        'SERVER MIX LOADED // DIRECT PLAYBACK.',
      ].filter(Boolean),
    });
  } catch (err) {
    await cancelActiveJob();
    hideDecodeLoader();
    bayIdle?.classList.remove('hidden');
    setUploadActive(true);
    ledProcess?.classList.remove('active');
    printConsoleLines([
      'CRITICAL: CASSETTE DECODING ERROR.',
      String(err.message || err).toUpperCase(),
      'SYSTEM DOCKED IN SAFE MODE.',
    ]);
    console.error('[Auralis] loadCassette failed:', err);
  }
}

async function resetCassette() {
  await cancelActiveJob();
  engine.stop();
  engine.decodedBuffer = null;
  engine.directPlayback = false;
  engine.orbiting = true;
  trackMeta = null;
  lastRenderedJobId = null;
  lastTrackName = null;
  lastConsoleTick = 0;
  resetCrtDisplay();
  setDownloadAvailable(false);
  TransportPlayer.reset();

  if (cassetteBadgeRow) cassetteBadgeRow.hidden = true;
  if (cassetteMetaBadge) cassetteMetaBadge.textContent = 'TYPE II · HI-FI';
  if (loadedCassette) loadedCassette.classList.remove('is-beat-pulse');
  document.body.removeAttribute('data-auralis-profile');
  document.body.removeAttribute('data-auralis-genre');

  hideDecodeLoader();
  bayLoaded?.classList.add('hidden');
  bayIdle?.classList.remove('hidden');
  if (playBtn) {
    playBtn.disabled = true;
    playBtn.classList.remove('active');
  }
  ledActive?.classList.remove('active');
  ledProcess?.classList.remove('active');


  if (meterBass) meterBass.style.width = '0%';
  if (meterTreble) meterTreble.style.width = '0%';
  if (meterOrbit) meterOrbit.style.width = '0%';
  if (meterWidth) meterWidth.style.width = '0%';

  if (valMeterBass) valMeterBass.innerText = '0.0dB';
  if (valMeterTreble) valMeterTreble.innerText = '0.0dB';
  if (valMeterOrbit) valMeterOrbit.innerText = '0.0Hz';
  if (valMeterWidth) valMeterWidth.innerText = '1.0x';

  if (valBpm) valBpm.innerText = '000';
  if (valEnergy) valEnergy.innerText = '0%';
  if (dialMarkerBpm) dialMarkerBpm.style.transform = 'translate(-50%, -50%) rotate(-135deg)';
  if (dialMarkerEnergy) dialMarkerEnergy.style.transform = 'translate(-50%, -50%) rotate(-135deg)';
  if (lcdTime) lcdTime.innerText = '00:00.00';

  printConsoleLines([
    'AURALIS HI-FI AUTOMATIC INITIALIZED.',
    'INSERT AUDIO CASSETTE TO DECODE PATHS.',
  ]);

  setUploadActive(true);
  drawStaticScreen();
}

function drawWaveform(buffer) {
  if (!waveformCanvas || !buffer) return;
  const canvas = waveformCanvas;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  const lineScale = Math.max(1, w / 400);

  const opts = {
    playing: false,
    progress: getPlaybackProgress() ?? 0,
  };

  if (engine.isPlaying && engine.analyser) {
    const dataArray = new Uint8Array(engine.analyser.frequencyBinCount);
    engine.analyser.getByteTimeDomainData(dataArray);
    const beatPhase = engine.getBeatPhase();
    opts.playing = true;
    opts.dataArray = dataArray;
    opts.beatPhase = beatPhase;
    opts.beatPulse = 0.55 + 0.45 * Math.sin(beatPhase * Math.PI * 2);
  }

  drawCrtWaveform(ctx, w, h, buffer, getCanvasColors(), lineScale, opts);
}

function startCassetteSpindles() {
  document.querySelector('.retro-cassette')?.classList.add('playing');
}

function stopCassetteSpindles() {
  document.querySelector('.retro-cassette')?.classList.remove('playing');
}

function setupBrainConsoleSync() {
  if (engine.directPlayback) {
    engine.onDiagnosticCallback = null;
    return;
  }

  engine.onDiagnosticCallback = (report, currentRMS) => {
    const bassPct = Math.min(100, Math.max(0, (report.bassBoostDb / 8) * 100));
    if (meterBass) meterBass.style.width = `${bassPct}%`;
    if (valMeterBass) {
      valMeterBass.innerText = `${report.bassBoostDb > 0 ? '+' : ''}${report.bassBoostDb}dB`;
    }

    const treblePct = Math.min(100, Math.max(0, ((engine.eqHigh.gain.value + 2) / 7) * 100));
    if (meterTreble) meterTreble.style.width = `${treblePct}%`;
    if (valMeterTreble) {
      valMeterTreble.innerText = `${engine.eqHigh.gain.value > 0 ? '+' : ''}${Math.round(engine.eqHigh.gain.value * 10) / 10}dB`;
    }

    const speedRatio = engine.orbitSpeeds.melody * 1000;
    if (meterOrbit) meterOrbit.style.width = `${Math.min(100, speedRatio * 8)}%`;
    if (valMeterOrbit) valMeterOrbit.innerText = `${Math.round(speedRatio * 5 * 10) / 10}Hz`;

    const widthPct = Math.min(100, Math.max(0, ((report.stereoWidthCoeff - 0.8) / 0.7) * 100));
    if (meterWidth) meterWidth.style.width = `${widthPct}%`;
    if (valMeterWidth) valMeterWidth.innerText = `${report.stereoWidthCoeff}x`;

    printConsoleLines([
      'PLAYING SOURCE: ENGAGED',
      `GENRE REGIME: ${report.genre.toUpperCase()}`,
      `SECTION DETECT: [${report.activeSection}]`,
      `AUTO-EQ CORRECTION: ${report.bassBoostDb > 0 ? 'BOOST' : 'FLAT'}`,
      `CROSSFEED PROFILE: ${Math.round(report.crossfeedCoeff * 100)}% COEF`,
    ]);

    if (valEnergy) valEnergy.innerText = `${Math.min(100, Math.round(currentRMS * 250))}%`;
    const energyPct = Math.min(1.0, currentRMS * 2.2);
    const energyAngle = energyPct * 270 - 135;
    if (dialMarkerEnergy) {
      dialMarkerEnergy.style.transform = `translate(-50%, -50%) rotate(${energyAngle}deg)`;
    }
  };
}

function animationLoop() {
  if (engine.directPlayback) {
    if (engine.isPlaying) updateDirectPlaybackMeters();
  } else {
    if (engine.orbiting && engine.isPlaying) engine.orbitTick();
    if (engine.isPlaying) engine.processAutomaticBraintick();
  }

  if (engine.decodedBuffer) {
    drawWaveform(engine.decodedBuffer);
  } else {
    drawStaticScreen();
  }

  syncPlaybackUi();
  requestAnimationFrame(animationLoop);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
