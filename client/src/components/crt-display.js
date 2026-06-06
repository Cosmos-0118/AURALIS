/**
 * CRT waveform renderer — static preview, live trace, oscilloscope chrome.
 */

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

  smoothInPlace(mids, 4);
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

function ampScale(h) {
  return h * 0.36;
}

function valueToY(v, h, amp) {
  return h / 2 - v * amp;
}

function drawOscilloscopeChrome(ctx, w, h, colors, lineScale, alpha = 0.14) {
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
    ctx.moveTo(x, midY - 4 * lineScale);
    ctx.lineTo(x, midY + 4 * lineScale);
    ctx.stroke();
  }

  ctx.globalAlpha = alpha * 0.55;
  ctx.beginPath();
  ctx.moveTo(w * 0.5, 0);
  ctx.lineTo(w * 0.5, h);
  ctx.stroke();
  ctx.restore();
}

function drawEnvelope(ctx, w, h, samples, colors, { fillAlpha = 0.14, strokeAlpha = 0.9, glow = 4 } = {}) {
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

  ctx.globalAlpha = strokeAlpha * 0.35;
  ctx.strokeStyle = colors.glow;
  ctx.lineWidth = 1 * (w / 400);
  ctx.shadowBlur = glow;
  ctx.shadowColor = colors.shadow;
  ctx.stroke();
  ctx.restore();
}

function drawMidline(ctx, w, h, samples, colors, lineScale, { alpha = 0.95, width = 1.25, glow = 8 } = {}) {
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

function drawPlayhead(ctx, w, h, x, colors, lineScale) {
  const clamped = Math.max(0, Math.min(w, x));
  ctx.save();
  ctx.strokeStyle = colors.glow;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1 * lineScale;
  ctx.shadowBlur = 10 * lineScale;
  ctx.shadowColor = colors.shadow;
  ctx.beginPath();
  ctx.moveTo(clamped, 0);
  ctx.lineTo(clamped, h);
  ctx.stroke();

  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(clamped, h / 2, 2.5 * lineScale, 0, Math.PI * 2);
  ctx.fillStyle = colors.glow;
  ctx.fill();
  ctx.restore();
}

export function drawCrtStatic(ctx, w, h, colors, lineScale) {
  ctx.clearRect(0, 0, w, h);
  drawOscilloscopeChrome(ctx, w, h, colors, lineScale, 0.1);
}

export function drawCrtWaveform(ctx, w, h, buffer, colors, lineScale, { progress = null } = {}) {
  const samples = getWaveformSamples(buffer, Math.floor(w));
  if (!samples) return;

  ctx.clearRect(0, 0, w, h);
  drawOscilloscopeChrome(ctx, w, h, colors, lineScale);
  drawEnvelope(ctx, w, h, samples, colors, { fillAlpha: 0.1, strokeAlpha: 0.5, glow: 3 });
  drawMidline(ctx, w, h, samples, colors, lineScale, { alpha: 0.88, width: 1.1, glow: 6 });

  if (progress != null && progress > 0) {
    drawPlayhead(ctx, w, h, progress * w, colors, lineScale);
  }
}

export function drawCrtLive(ctx, w, h, buffer, dataArray, colors, lineScale, {
  beatPulse = 1,
  progress = null,
  phase = 0,
} = {}) {
  if (!liveTrail || liveTrail.length !== dataArray.length) {
    liveTrail = new Float32Array(dataArray.length);
    liveTrail.fill(128);
  }

  ctx.fillStyle = colors.decay;
  ctx.fillRect(0, 0, w, h);

  if (buffer) {
    const samples = getWaveformSamples(buffer, Math.floor(w));
    if (samples) {
      drawOscilloscopeChrome(ctx, w, h, colors, lineScale, 0.08);
      drawEnvelope(ctx, w, h, samples, colors, { fillAlpha: 0.06, strokeAlpha: 0.25, glow: 2 });
      drawMidline(ctx, w, h, samples, colors, lineScale, {
        alpha: 0.18,
        width: 0.9,
        glow: 2,
      });
    }
  } else {
    drawOscilloscopeChrome(ctx, w, h, colors, lineScale, 0.1);
  }

  const bufferLength = dataArray.length;
  const sliceWidth = w / bufferLength;
  const amp = h * 0.34 * (0.75 + beatPulse * 0.25);
  const midY = h / 2;

  ctx.save();
  ctx.strokeStyle = colors.glow;
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = 1 * lineScale;
  ctx.beginPath();
  let x = 0;
  for (let i = 0; i < bufferLength; i++) {
    const y = midY + ((liveTrail[i] - 128) / 128) * amp;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    x += sliceWidth;
  }
  ctx.stroke();
  ctx.restore();

  const scrollShift = Math.floor(phase * 18);
  ctx.save();
  ctx.beginPath();
  x = 0;
  for (let i = 0; i < bufferLength; i++) {
    const idx = (i + scrollShift) % bufferLength;
    const sample = (dataArray[idx] - 128) / 128;
    liveTrail[i] = liveTrail[i] * 0.82 + dataArray[idx] * 0.18;
    const y = midY + sample * amp;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    x += sliceWidth;
  }
  ctx.strokeStyle = colors.glow;
  ctx.globalAlpha = 0.92;
  ctx.lineWidth = (1.2 + beatPulse * 0.8) * lineScale;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowBlur = (5 + beatPulse * 8) * lineScale;
  ctx.shadowColor = colors.shadow;
  ctx.stroke();
  ctx.restore();

  if (progress != null) {
    drawPlayhead(ctx, w, h, progress * w, colors, lineScale);
  }
}

export function resetCrtDisplay() {
  clearWaveformCache();
  liveTrail = null;
}
