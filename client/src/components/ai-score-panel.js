/**
 * Zenith AI Score — native canvas radar + metric bars (no chart library).
 */

const METRICS = [
  { key: 'immersion', label: 'IMMERSION', color: '#00e5a0' },
  { key: 'clarity', label: 'CLARITY', color: '#4db8ff' },
  { key: 'punch', label: 'PUNCH', color: '#ffa200' },
  { key: 'warmth', label: 'WARMTH', color: '#ff6b4a' },
];

export class AiScorePanel {
  constructor(root) {
    this.root = root;
    this.canvas = root?.querySelector('[data-ai-score-radar]');
    this.bars = root ? [...root.querySelectorAll('[data-ai-score-bar]')] : [];
  }

  update(score, { safeguard } = {}) {
    if (!this.root || !score) {
      this.hide();
      return;
    }

    this.root.hidden = false;

    for (const bar of this.bars) {
      const key = bar.dataset.aiScoreBar;
      const value = score[key] ?? 0;
      const fill = bar.querySelector('[data-ai-score-fill]');
      const val = bar.querySelector('[data-ai-score-val]');
      if (fill) fill.style.width = `${value}%`;
      if (val) val.textContent = String(value);
    }

    this._drawRadar(score);

    const note = this.root.querySelector('[data-ai-score-note]');
    if (note) {
      if (safeguard?.tripped) {
        note.hidden = false;
        note.textContent = safeguard.safeguard_message
          || `Safeguard: width rollback ${Math.round((safeguard.rollback_factor || 0.7) * 100)}%`;
      } else {
        note.hidden = true;
        note.textContent = '';
      }
    }
  }

  hide() {
    if (this.root) this.root.hidden = true;
  }

  _drawRadar(score) {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext('2d');
    const { width, height } = this.canvas;
    const cx = width / 2;
    const cy = height / 2;
    const maxR = Math.min(cx, cy) - 8;

    ctx.clearRect(0, 0, width, height);

    const values = METRICS.map((m) => (score[m.key] ?? 0) / 100);
    const n = values.length;
    const angles = values.map((_, i) => -Math.PI / 2 + (i * 2 * Math.PI) / n);

    // grid rings
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    for (const ring of [0.25, 0.5, 0.75, 1.0]) {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = cx + Math.cos(angles[i]) * maxR * ring;
        const y = cy + Math.sin(angles[i]) * maxR * ring;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }

    // axes
    for (let i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(angles[i]) * maxR, cy + Math.sin(angles[i]) * maxR);
      ctx.stroke();
    }

    // filled polygon
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const r = maxR * values[i];
      const x = cx + Math.cos(angles[i]) * r;
      const y = cy + Math.sin(angles[i]) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 229, 160, 0.22)';
    ctx.fill();
    ctx.strokeStyle = '#00e5a0';
    ctx.lineWidth = 2;
    ctx.stroke();

    // vertex dots
    for (let i = 0; i < n; i++) {
      const r = maxR * values[i];
      const x = cx + Math.cos(angles[i]) * r;
      const y = cy + Math.sin(angles[i]) * r;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = METRICS[i].color;
      ctx.fill();
    }
  }
}
