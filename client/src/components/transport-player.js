let root = null;
let playBtn = null;
let seekSlider = null;
let titleEl = null;
let timeCurrentEl = null;
let timeTotalEl = null;
let onPlayToggle = null;
let onSeek = null;
let isSeeking = false;
let enabled = false;

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return `${pad(mins)}:${pad(secs)}`;
}

function setPlaying(playing) {
  if (!playBtn) return;
  playBtn.classList.toggle('is-playing', playing);
  playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  playBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
}

function setEnabled(nextEnabled) {
  enabled = nextEnabled;
  if (playBtn) playBtn.disabled = !enabled;
  if (seekSlider) seekSlider.disabled = !enabled;
}

export class TransportPlayer {
  static init(options = {}) {
    onPlayToggle = options.onPlayToggle ?? null;
    onSeek = options.onSeek ?? null;

    root = document.getElementById('transportPlayer');
    playBtn = document.getElementById('transportPlayBtn');
    seekSlider = document.getElementById('transportSeek');
    titleEl = document.getElementById('transportTitle');
    timeCurrentEl = document.getElementById('transportTimeCurrent');
    timeTotalEl = document.getElementById('transportTimeTotal');

    if (!root || !playBtn || !seekSlider) {
      console.error('[TransportPlayer] Required elements not found');
      return false;
    }

    playBtn.addEventListener('click', () => {
      if (!enabled) return;
      onPlayToggle?.();
    });

    seekSlider.addEventListener('pointerdown', () => {
      isSeeking = true;
    });

    seekSlider.addEventListener('input', () => {
      if (!enabled) return;
      const progress = parseFloat(seekSlider.value);
      onSeek?.(progress, { live: true });
    });

    seekSlider.addEventListener('change', () => {
      if (!enabled) return;
      const progress = parseFloat(seekSlider.value);
      onSeek?.(progress, { live: false });
      isSeeking = false;
    });

    seekSlider.addEventListener('pointerup', () => {
      isSeeking = false;
    });

    setEnabled(false);
    return true;
  }

  static isSeeking() {
    return isSeeking;
  }

  static reset() {
    setEnabled(false);
    setPlaying(false);
    if (seekSlider) seekSlider.value = '0';
    if (titleEl) {
      titleEl.textContent = 'NO TRACK LOADED';
      titleEl.title = '';
    }
    if (timeCurrentEl) timeCurrentEl.textContent = '00:00';
    if (timeTotalEl) timeTotalEl.textContent = '00:00';
  }

  static setTrack(title) {
    const display = (title || 'UNKNOWN TRACK').toUpperCase();
    if (titleEl) {
      titleEl.textContent = display;
      titleEl.title = title || '';
    }
    setEnabled(true);
  }

  static sync({ playing = false, progress = 0, duration = 0 } = {}) {
    setPlaying(playing);

    if (timeTotalEl) timeTotalEl.textContent = formatTime(duration);
    if (timeCurrentEl) timeCurrentEl.textContent = formatTime(progress * duration);

    if (seekSlider && !isSeeking) {
      seekSlider.value = String(Math.max(0, Math.min(1, progress)));
    }
  }
}
