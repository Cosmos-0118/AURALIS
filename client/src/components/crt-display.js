/**
 * CRT waveform renderer — static preview, live trace, oscilloscope chrome.
 */

export const CRT_WAVE_INSET = 0.1;

let waveformCache = null;
let liveTrail = null;

function sampleWaveform(channelData, width) {
  const step = Math.ceil(channelData.length / width);
  const mins = new Float32Array(width);
  const maxs = new Float32Array(width);
  const mids = new Float32Array(width);

  for (let i = 0; i < width; i++) {
    let min = 1;
    let max = -1;
    let sum = 0;
    let count = 0;
    const start = i * step;
    const end = Math.min(channelData.length, start + step);

    for (let j = start; j < end; j++) {
      const v = channelData[j];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      count++;
    }

    mins[i] = min;
    maxs[i] = max;
    mids[i] = count ? sum / count : 0;
  }

  smoothInPlace(mins, 6);
  smoothInPlace(maxs, 6);
  smoothInPlace(mids, 8);
  return { mins, maxs, mids };
}

function smoothInPlace(values, radius) {
  const temp = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      sum += values[j];
      count++;
    }
    temp[i] = sum / count;
  }
  values.set(temp);
}

function getWaveformSamples(buffer, width) {
  if (!buffer) return null;
  if (waveformCache?.buffer === buffer && waveformCache.width === width) {
    return waveformCache;
  }
  const samples = sampleWaveform(buffer.getChannelData(0), width);
  waveformCache = { buffer, width, ...samples };
  return waveformCache;
}

function clearWaveformCache() {
  waveformCache = null;
}

function getDrawArea(w) {
  const inset = w * CRT_WAVE_INSET;
  return { inset, drawW: Math.max(1, w - inset * 2) };
}

function ampScale(h) {
  return h * 0.32;
}

function valueToY(v, h, amp) {
  return h / 2 - v * amp;
}

function withDrawArea(ctx, w, drawFn) {
  const { inset, drawW } = getDrawArea(w);
  ctx.save();
  ctx.translate(inset, 0);
  drawFn(drawW);
  ctx.restore();
}

function drawOscilloscopeChrome(ctx, w, h, colors, lineScale, alpha = 0.1) {
  const midY = h / 2;
  ctx.save();
  ctx.strokeStyle = colors.dim || colors.glow;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1 * lineScale;

  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(w, midY);
  ctx.stroke();

  for (const x of [w * 0.25, w * 0.5, w * 0.75]) {
    ctx.beginPath();
    ctx.moveTo(x, midY - 3 * lineScale);
    ctx.lineTo(x, midY + 3 * lineScale);
    ctx.stroke();
  }

  ctx.restore();
}

function drawEnvelope(ctx, w, h, samples, colors, { fillAlpha = 0.12 } = {}) {
  const { mins, maxs } = samples;
  const amp = ampScale(h);
  const midY = h / 2;

  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < w; i++) {
    const y = valueToY(maxs[i], h, amp);
    if (i === 0) ctx.moveTo(i, y);
    else ctx.lineTo(i, y);
  }
  for (let i = w - 1; i >= 0; i--) {
    ctx.lineTo(i, valueToY(mins[i], h, amp));
  }
  ctx.closePath();

  const gradient = ctx.createLinearGradient(0, midY - amp, 0, midY + amp);
  gradient.addColorStop(0, colors.glow);
  gradient.addColorStop(0.5, colors.glow);
  gradient.addColorStop(1, colors.dim || colors.glow);
  ctx.fillStyle = gradient;
  ctx.globalAlpha = fillAlpha;
  ctx.fill();
  ctx.restore();
}

function drawMidline(ctx, w, h, samples, colors, lineScale, { alpha = 0.92, width = 1.4, glow = 3 } = {}) {
  const { mids } = samples;
  const amp = ampScale(h);

  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < w; i++) {
    const y = valueToY(mids[i], h, amp);
    if (i === 0) ctx.moveTo(i, y);
    else ctx.lineTo(i, y);
  }
  ctx.strokeStyle = colors.glow;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width * lineScale;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowBlur = glow * lineScale;
  ctx.shadowColor = colors.shadow;
  ctx.stroke();
  ctx.restore();
}

export function drawCrtStatic(ctx, w, h, colors, lineScale) {
  ctx.clearRect(0, 0, w, h);
  withDrawArea(ctx, w, (drawW) => {
    drawOscilloscopeChrome(ctx, drawW, h, colors, lineScale, 0.08);
  });
}

export function drawCrtWaveform(ctx, w, h, buffer, colors, lineScale) {
  ctx.clearRect(0, 0, w, h);
  withDrawArea(ctx, w, (drawW) => {
    const samples = getWaveformSamples(buffer, Math.floor(drawW));
    if (!samples) return;

    drawOscilloscopeChrome(ctx, drawW, h, colors, lineScale);
    drawEnvelope(ctx, drawW, h, samples, colors, { fillAlpha: 0.1 });
    drawMidline(ctx, drawW, h, samples, colors, lineScale, { alpha: 0.9, width: 1.2, glow: 4 });
  });
}

export function drawCrtLive(ctx, w, h, buffer, dataArray, colors, lineScale, {
  beatPulse = 1,
  phase = 0,
} = {}) {
  if (!liveTrail || liveTrail.length !== dataArray.length) {
    liveTrail = new Float32Array(dataArray.length);
    liveTrail.fill(128);
  }

  ctx.fillStyle = colors.decay;
  ctx.fillRect(0, 0, w, h);

  withDrawArea(ctx, w, (drawW) => {
    if (buffer) {
      const samples = getWaveformSamples(buffer, Math.floor(drawW));
      if (samples) {
        drawOscilloscopeChrome(ctx, drawW, h, colors, lineScale, 0.06);
        drawEnvelope(ctx, drawW, h, samples, colors, { fillAlpha: 0.05 });
        drawMidline(ctx, drawW, h, samples, colors, lineScale, {
          alpha: 0.16,
          width: 0.85,
          glow: 1,
        });
      }
    } else {
      drawOscilloscopeChrome(ctx, drawW, h, colors, lineScale, 0.08);
    }

    const bufferLength = dataArray.length;
    const sliceWidth = drawW / bufferLength;
    const amp = h * 0.28 * (0.8 + beatPulse * 0.2);
    const midY = h / 2;

    const scrollShift = Math.floor(phase * 12);
    ctx.save();
    ctx.beginPath();
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
      const idx = (i + scrollShift) % bufferLength;
      const sample = (dataArray[idx] - 128) / 128;
      liveTrail[i] = liveTrail[i] * 0.88 + dataArray[idx] * 0.12;
      const y = midY + sample * amp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.strokeStyle = colors.glow;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = (1 + beatPulse * 0.4) * lineScale;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowBlur = (3 + beatPulse * 4) * lineScale;
    ctx.shadowColor = colors.shadow;
    ctx.stroke();
    ctx.restore();
  });
}

export function resetCrtDisplay() {
  clearWaveformCache();
  liveTrail = null;
}
