const BAR_COUNT = 48;

function parseColor(color) {
  if (!color) return [255, 155, 0];
  const hex = color.trim();
  if (hex.startsWith('#') && hex.length >= 7) {
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }
  const match = hex.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (match) return [Number(match[1]), Number(match[2]), Number(match[3])];
  return [255, 155, 0];
}

function rgb([r, g, b], alpha = 1) {
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function readThemeColors() {
  const root = getComputedStyle(document.documentElement);
  return {
    glow: parseColor(root.getPropertyValue('--theme-crt-glow')),
    dim: parseColor(root.getPropertyValue('--theme-crt-dim')),
    accent: parseColor(root.getPropertyValue('--theme-accent-primary')),
    accent2: parseColor(root.getPropertyValue('--theme-accent-secondary')),
  };
}

export class AmbientBackground {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas?.getContext('2d') ?? null;
    this.themeId = 'braun';
    this.smoothBars = new Float32Array(BAR_COUNT);
    this.time = 0;
    this.isPlaying = false;
    this.beatPulse = 0;
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  setTheme(themeId) {
    this.themeId = themeId || 'braun';
  }

  setAudioState({ isPlaying = false, freqData = null, beatPulse = 0 } = {}) {
    this.isPlaying = isPlaying;
    this.beatPulse = beatPulse;
    this._freqData = freqData;
  }

  resize() {
    if (!this.canvas || !this.ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
  }

  draw() {
    if (!this.ctx || !this.w) return;

    this.time += 16;
    this.ctx.clearRect(0, 0, this.w, this.h);
    this._updateBars();
    this._drawSpectrum(readThemeColors(), this.themeId);
  }

  _updateBars() {
    const data = this._freqData;
    const binStep = data ? Math.max(1, Math.floor(data.length / BAR_COUNT)) : 1;

    for (let i = 0; i < BAR_COUNT; i += 1) {
      let target = 0.06;

      if (data && this.isPlaying) {
        let sum = 0;
        const start = i * binStep;
        for (let b = 0; b < binStep; b += 1) sum += data[start + b] || 0;
        target = (sum / binStep / 255) * (0.55 + this.beatPulse * 0.45);
        target = Math.max(0.04, Math.min(1, target * 1.35));
      } else if (!this.reducedMotion) {
        target = 0.05 + Math.sin(this.time * 0.0018 + i * 0.38) * 0.025;
      }

      const ease = this.isPlaying ? 0.38 : 0.1;
      this.smoothBars[i] += (target - this.smoothBars[i]) * ease;
    }
  }

  _drawSpectrum(colors, mode) {
    const { ctx, w, h } = this;
    const bandTop = h * (mode === 'nordic' ? 0.74 : 0.68);
    const bandHeight = h - bandTop;
    const gap = mode === 'nordic' ? 3 : 2;
    const barWidth = (w * 0.84) / BAR_COUNT;
    const startX = w * 0.08;

    for (let i = 0; i < BAR_COUNT; i += 1) {
      const level = this.smoothBars[i];
      const barH = level * bandHeight * (mode === 'nordic' ? 0.75 : 0.92);
      const x = startX + i * barWidth;
      const y = bandTop + bandHeight - barH;

      if (mode === 'nordic') {
        ctx.fillStyle = rgb(mix(colors.dim, colors.accent, level), 0.35 + level * 0.65);
        ctx.fillRect(x, y, Math.max(1, barWidth - gap), barH);
        continue;
      }

      if (mode === 'cyberpunk') {
        const grad = ctx.createLinearGradient(x, y + barH, x, y);
        grad.addColorStop(0, rgb(colors.accent2, 0.15 + level * 0.35));
        grad.addColorStop(0.5, rgb(colors.accent, 0.45 + level * 0.45));
        grad.addColorStop(1, rgb(mix(colors.accent, [255, 255, 255], 0.4), 0.85));
        ctx.fillStyle = grad;
        ctx.shadowBlur = 6 + level * 18;
        ctx.shadowColor = rgb(colors.accent, 0.55);
      } else if (mode === 'vaporwave') {
        ctx.fillStyle = rgb(mix(colors.accent, colors.accent2, i / BAR_COUNT), 0.25 + level * 0.55);
        ctx.shadowBlur = 10 + level * 14;
        ctx.shadowColor = rgb(colors.accent, 0.35);
      } else {
        const grad = ctx.createLinearGradient(x, y + barH, x, y);
        grad.addColorStop(0, rgb(colors.dim, 0.2 + level * 0.3));
        grad.addColorStop(0.6, rgb(colors.glow, 0.55 + level * 0.35));
        grad.addColorStop(1, rgb(mix(colors.glow, [255, 240, 200], 0.35), 0.95));
        ctx.fillStyle = grad;
        ctx.shadowBlur = 4 + level * 12;
        ctx.shadowColor = rgb(colors.glow, 0.45);
      }

      const radius = mode === 'vaporwave' ? barWidth * 0.45 : barWidth * 0.35;
      this._roundBar(x, y, Math.max(2, barWidth - gap), barH, radius);
      ctx.shadowBlur = 0;
    }
  }

  _roundBar(x, y, width, height, radius) {
    if (height <= 0) return;
    const { ctx } = this;
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height);
    ctx.lineTo(x, y + height);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
  }
}
