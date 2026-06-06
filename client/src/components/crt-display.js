export function progressFromClientX(clientX, canvas) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
}

function parseHexColor(color) {
  if (!color || typeof color !== 'string') return [255, 155, 0];
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

function mixColors(a, b, t) {
  const c1 = parseHexColor(a);
  const c2 = parseHexColor(b);
  const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
  const bl = Math.round(c1[2] + (c2[2] - c1[2]) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function beatPalette(colors, beatPulse) {
  const pulse = Math.max(0, Math.min(1, beatPulse));
  const accent = colors.accent || colors.glow;
  return {
    glow: mixColors(colors.glow, accent, pulse * 0.55),
    bright: mixColors(colors.glow, '#ffffff', pulse * 0.22),
    dim: colors.dim || colors.glow,
    shadow: colors.shadow,
    fill: mixColors(colors.dim || colors.glow, colors.glow, 0.35 + pulse * 0.25),
  };
}

function getPlotArea(w, h) {
  const padY = 6;
  return {
    x: 0,
    y: padY,
    w: Math.max(1, w),
    h: Math.max(1, h - padY * 2),
    midY: padY + Math.max(1, h - padY * 2) / 2,
  };
}

function drawOscilloscopeChrome(ctx, plot, palette, lineScale, alpha = 0.1) {
  const { x, w, midY } = plot;
  ctx.save();
  ctx.strokeStyle = palette.dim;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1 * lineScale;

  ctx.beginPath();
  ctx.moveTo(x, midY);
  ctx.lineTo(x + w, midY);
  ctx.stroke();

  for (const frac of [0.25, 0.5, 0.75]) {
    const tickX = x + w * frac;
    ctx.beginPath();
    ctx.moveTo(tickX, midY - 3 * lineScale);
    ctx.lineTo(tickX, midY + 3 * lineScale);
    ctx.stroke();
  }

  ctx.restore();
}

function drawOscilloscopeTrace(ctx, plot, dataArray, palette, lineScale, beatPulse) {
  if (!dataArray?.length) return;
  
  const { x, w, h, midY } = plot;
  const bufferLength = dataArray.length;
  const sliceWidth = w / bufferLength;
  const amp = h * 0.45; // Fill most of the height
  
  ctx.save();
  ctx.beginPath();
  
  let px = x;
  for (let i = 0; i < bufferLength; i++) {
    const sample = (dataArray[i] - 128) / 128;
    const y = midY + sample * amp;
    
    if (i === 0) {
      ctx.moveTo(px, y);
    } else {
      ctx.lineTo(px, y);
    }
    px += sliceWidth;
  }
  
  // Outer glow
  ctx.strokeStyle = palette.glow;
  ctx.globalAlpha = 0.4 + beatPulse * 0.2;
  ctx.lineWidth = 2.5 * lineScale;
  ctx.lineJoin = 'round';
  ctx.shadowBlur = (6 + beatPulse * 6) * lineScale;
  ctx.shadowColor = palette.shadow || palette.glow;
  ctx.stroke();

  // Thin bright inner line for a responsive, crisp look
  ctx.beginPath();
  let pxInner = x;
  for (let i = 0; i < bufferLength; i++) {
    const sample = (dataArray[i] - 128) / 128;
    const y = midY + sample * amp;
    
    if (i === 0) {
      ctx.moveTo(pxInner, y);
    } else {
      ctx.lineTo(pxInner, y);
    }
    pxInner += sliceWidth;
  }
  ctx.strokeStyle = palette.bright;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 1.0 * lineScale;
  ctx.shadowBlur = 0;
  ctx.stroke();
  
  ctx.restore();
}

function drawBufferWaveform(ctx, plot, buffer, palette, lineScale, { progress = null, dimmed = true } = {}) {
  if (!buffer?.numberOfChannels) return;

  const channel = buffer.getChannelData(0);
  if (!channel?.length) return;

  const { x, w, h, midY } = plot;
  const amp = h * 0.42;
  const step = Math.max(1, Math.floor(channel.length / w));

  ctx.save();
  ctx.beginPath();
  for (let px = 0; px < w; px += 1) {
    const idx = Math.min(channel.length - 1, px * step);
    const y = midY + channel[idx] * amp;
    if (px === 0) ctx.moveTo(x + px, y);
    else ctx.lineTo(x + px, y);
  }

  ctx.strokeStyle = dimmed ? palette.dim : palette.glow;
  ctx.globalAlpha = dimmed ? 0.62 : 0.88;
  ctx.lineWidth = (dimmed ? 1.1 : 1.6) * lineScale;
  ctx.lineJoin = 'round';
  ctx.shadowBlur = dimmed ? 0 : 4 * lineScale;
  ctx.shadowColor = palette.shadow || palette.glow;
  ctx.stroke();
  ctx.restore();

  if (progress != null && Number.isFinite(progress)) {
    const clamped = Math.max(0, Math.min(1, progress));
    const playheadX = x + w * clamped;
    ctx.save();
    ctx.strokeStyle = palette.glow;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1.5 * lineScale;
    ctx.shadowBlur = 5 * lineScale;
    ctx.shadowColor = palette.shadow || palette.glow;
    ctx.beginPath();
    ctx.moveTo(playheadX, plot.y);
    ctx.lineTo(playheadX, plot.y + plot.h);
    ctx.stroke();
    ctx.restore();
  }
}

export function drawCrtStatic(ctx, w, h, colors, lineScale) {
  ctx.clearRect(0, 0, w, h);
  const plot = getPlotArea(w, h);
  const palette = beatPalette(colors, 0);
  drawOscilloscopeChrome(ctx, plot, palette, lineScale, 0.08);
}

export function drawCrtWaveform(ctx, w, h, buffer, colors, lineScale, {
  playing = false,
  dataArray = null,
  beatPulse = 0,
  progress = null,
} = {}) {
  const plot = getPlotArea(w, h);
  const palette = beatPalette(colors, playing ? beatPulse : 0);

  if (playing) {
    ctx.fillStyle = colors.decay || 'rgba(22, 18, 11, 0.3)';
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.clearRect(0, 0, w, h);
  }

  drawOscilloscopeChrome(ctx, plot, palette, lineScale, playing ? 0.07 : 0.1);

  if (buffer && (!playing || !dataArray)) {
    drawBufferWaveform(ctx, plot, buffer, palette, lineScale, { progress, dimmed: !playing });
  }

  if (playing && dataArray) {
    drawOscilloscopeTrace(ctx, plot, dataArray, palette, lineScale, beatPulse);
  }
}

export function resetCrtDisplay() {
  // No-op
}
