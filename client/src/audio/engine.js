/**
 * Auralis Audio DSP Engine (v4 — Professional Mastering R&D)
 *
 * Architecture Additions (v4):
 *  1. Multiband Widener (Mid-only <300Hz, Widened >300Hz)
 *  2. Psychoacoustic Bass Exciter (isolated 40-80Hz harmonic generation)
 *  3. Spectral Masking / Transient Ducking (via Lookahead timeline)
 *  4. Stem Failure Fallback (Confidence tracking)
 *  5. Self-correcting AI Audio Quality Score
 *  6. Robustness (Seek state-resets, strict mono-compatibility limits)
 */

// ────────────────────────────────────────────────────────────────────
// Safety Rails
// ────────────────────────────────────────────────────────────────────
const SAFETY = Object.freeze({
  eqLowGain:      { min: -3,   max: 4    },
  eqMidGain:      { min: -3,   max: 3    },
  eqHighGain:     { min: -2,   max: 3    },
  eqPresenceGain: { min: -2,   max: 3    },
  satWet:         { min: 0,    max: 0.22  },
  widthL:         { min: 0.7,  max: 1.35  },
  widthR:         { min: 0.7,  max: 1.35  },
  reverbMix:      { min: 0.01, max: 0.35  },
  orbitRadius:    { min: 0,    max: 6     },
  crossfeedAmt:   { min: 0.1,  max: 0.55  },
});

function clampSafe(key, value) {
  const r = SAFETY[key];
  if (!r) return value;
  return Math.max(r.min, Math.min(r.max, value));
}

const DEADBAND = Object.freeze({
  gain: 0.3, pan: 0.02, width: 0.03, reverbMix: 0.01, satWet: 0.005,
});

const ORBIT_HZ_LIMITS = Object.freeze({
  vocals: { min: 0, max: 0.08 },
  bass:   { min: 0, max: 0 },
  melody: { min: 0.03, max: 0.12 },
  drums:  { min: 0.02, max: 0.06 },
});

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.decodedBuffer = null;

    // Nodes
    this.source = null;
    this.masterGain = null;
    this.analyser = null;
    this.dryAnalyser = null; // V7: For Original Score
    this.waveformAnalyser = null;
    this.monoCheckNode = null;

    // Virtual Stems Nodes
    this.stems = {
      vocals: { filter: null, gain: null, panner: null, mute: false, baseGain: 1.0 },
      bass:   { filter: null, gain: null, panner: null, mute: false, baseGain: 1.0 },
      melody: { filter: null, gain: null, panner: null, mute: false, baseGain: 1.0 },
      drums:  { filter: null, gain: null, panner: null, mute: false, baseGain: 1.0 }
    };

    // FX Nodes
    this.eqLow = null;
    this.eqMid = null;
    this.eqHigh = null;
    this.eqPresence = null;
    this.saturation = null;
    this.widener = null;        // Now Multiband
    this.psychoBass = null;     // Psychoacoustic Bass Exciter

    // Crossfeed Nodes
    this.crossfeed = {
      splitter: null, directL: null, directR: null,
      delayLtoR: null, delayRtoL: null, filterLtoR: null, filterRtoL: null,
      gainLtoR: null, gainRtoL: null, merger: null, active: true, amount: 0.3
    };

    // Reverb
    this.reverb = {
      convolver: null, dryGain: null, wetGain: null, mix: 0.15,
      currentIR: 'studio', irBank: {}
    };

    this.limiter = null;

    // Playback state
    this.isPlaying = false;
    this.startTime = 0;
    this.pauseOffset = 0;

    // Orbiting State
    this.orbiting = true;
    this.orbitAngles = { vocals: 0, bass: 0, melody: Math.PI, drums: Math.PI * 0.5 };
    this.orbitSpeeds = { vocals: 0.001, bass: 0, melody: 0.004, drums: 0.003 };
    this.orbitRadii = { vocals: 0.8, bass: 0, melody: 4, drums: 3.5 };

    this.defaultPositions = {
      vocals: { x: 0, y: 0.3, z: -2 },
      bass:   { x: 0, y: -0.3, z: -1 },
      melody: { x: -3.5, y: 0.5, z: -1.5 },
      drums:  { x: 2.5, y: 1.2, z: -2 }
    };
    this.currentPositions = JSON.parse(JSON.stringify(this.defaultPositions));

    // Diagnostic / Tracking
    this.brainReport = {
      bpm: 120, genre: 'Calibrating...', mood: 'Analyzing...',
      avgRMS: 0.15, crestFactor: 4.0, activeSection: 'STANDBY',
      sectionConfidence: 0, stemConfidence: 1.0, qualityScore: 100, originalScore: 100,
      bassBoostDb: 0, reverbDecaySec: 1.8, stereoWidthCoeff: 1.0,
      crossfeedCoeff: 0.3, momentaryLUFS: -14, shortTermLUFS: -14,
    };

    this._lastBrainTickTime = 0;
    this._brainTickIntervalMs = 150;

    this._sectionHoldTimer = 0;
    this._sectionHoldMinMs = 800;
    this._rmsHistory = [];
    this._rmsHistoryMax = 20;

    // Timeline + Ducking state
    this._timeline = null;
    this._timelineResolutionMs = 50;
    this._lookAheadMs = 200;
    this._transientDucked = false;

    // LUFS & Scoring state
    this._lufsShortTermWindow = [];
    this._lufsMomentaryWindow = [];
    this._fatigueAccumulator = 0;

    this._targets = {
      eqLowGain: 0, eqMidGain: 0, eqHighGain: 0, eqPresenceGain: 0,
      satWet: 0, psychoBassWet: 0, widthL: 1.0, widthR: 1.0, reverbMix: 0.15,
    };
    this._current = { ...this._targets };
    this._baselines = { ...this._targets };

    this._inTransient = false;
    this._transientDecayTimer = 0;
    this.onDiagnosticCallback = null;
    this.directPlayback = false;

    // V5 Processing Budget Manager state
    this._budgetState = {
      cpuMs: 0,
      psychoBassEnabled: true,
      maskingEnabled: true,
      orbitEnabled: true,
      consecutiveHighTicks: 0,
      consecutiveLowTicks: 0
    };

    // V6/V7 Hill-Climbing Optimizer State
    this._optimizerState = {
      tickCounter: 0,
      lastScore: 100,
      lastMutation: null, // { param: 'eqLowGain', delta: 0.2, previousValue: 0 }
      optimizationTimer: 0 // V7: Section-Locked Optimization limit
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Init & DSP Graph
  // ──────────────────────────────────────────────────────────────────

  async init() {
    if (this.ctx) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContextClass();
    this.setupDSPNodes();
  }

  setupDSPNodes() {
    const ctx = this.ctx;

    // Output & Analysers
    this.masterGain = ctx.createGain();
    this.masterGain.gain.setValueAtTime(1.0, ctx.currentTime);
    
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.75;
    
    // V7: Dry Analyser for A/B Score tracking
    this.dryAnalyser = ctx.createAnalyser();
    this.dryAnalyser.fftSize = 2048;
    this.dryAnalyser.smoothingTimeConstant = 0.75;

    this.waveformAnalyser = ctx.createAnalyser();
    this.waveformAnalyser.fftSize = 2048;
    this.waveformAnalyser.smoothingTimeConstant = 0;

    // EQ
    this.eqLow = ctx.createBiquadFilter(); this.eqLow.type = 'lowshelf'; this.eqLow.frequency.value = 200; this.eqLow.gain.value = 0;
    this.eqMid = ctx.createBiquadFilter(); this.eqMid.type = 'peaking'; this.eqMid.frequency.value = 1000; this.eqMid.Q.value = 0.7; this.eqMid.gain.value = 0;
    this.eqHigh = ctx.createBiquadFilter(); this.eqHigh.type = 'highshelf'; this.eqHigh.frequency.value = 5000; this.eqHigh.gain.value = 0;
    this.eqPresence = ctx.createBiquadFilter(); this.eqPresence.type = 'peaking'; this.eqPresence.frequency.value = 10000; this.eqPresence.Q.value = 0.5; this.eqPresence.gain.value = 0;

    // Psychoacoustic Bass Exciter (V4)
    this.setupPsychoacousticBass();

    // Saturation
    this.saturation = ctx.createWaveShaper();
    this.saturation.curve = this.makeSaturationCurve(0);
    this.saturation.oversample = '4x';
    this.satDry = ctx.createGain(); this.satDry.gain.value = 1.0;
    this.satWet = ctx.createGain(); this.satWet.gain.value = 0.0;

    // Multiband Mid/Side Widener (V4)
    this.setupMultibandWidener();

    // Crossfeed
    this.setupCrossfeed();

    // Precomputed Reverb
    this._buildIRBank();
    this.reverb.convolver = ctx.createConvolver();
    this.reverb.convolver.buffer = this.reverb.irBank['studio'];
    this.reverb.currentIR = 'studio';
    this.reverb.dryGain = ctx.createGain(); this.reverb.dryGain.gain.value = 1.0 - this.reverb.mix;
    this.reverb.wetGain = ctx.createGain(); this.reverb.wetGain.gain.value = this.reverb.mix;

    // Limiter
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.setValueAtTime(-3.0, ctx.currentTime);
    this.limiter.knee.setValueAtTime(6.0, ctx.currentTime);
    this.limiter.ratio.setValueAtTime(8.0, ctx.currentTime);
    this.limiter.attack.setValueAtTime(0.005, ctx.currentTime);
    this.limiter.release.setValueAtTime(0.15, ctx.currentTime);

    // Mono Checker (for internal metrics)
    this.monoCheckNode = ctx.createChannelMerger(1);

    // -- Signal Chain --
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.eqPresence);

    // Split signal: to Psycho Bass and to main Saturation
    this.eqPresence.connect(this.psychoBass.input);
    this.psychoBass.output.connect(this.satDry);
    
    this.eqPresence.connect(this.satDry);
    this.eqPresence.connect(this.saturation);
    this.saturation.connect(this.satWet);

    const satOutputNode = ctx.createGain();
    this.satDry.connect(satOutputNode);
    this.satWet.connect(satOutputNode);

    satOutputNode.connect(this.widener.input);
    this.widener.output.connect(this.crossfeed.input);

    this.crossfeed.output.connect(this.reverb.dryGain);
    this.crossfeed.output.connect(this.reverb.convolver);
    this.reverb.convolver.connect(this.reverb.wetGain);

    const reverbOutputNode = ctx.createGain();
    this.reverb.dryGain.connect(reverbOutputNode);
    this.reverb.wetGain.connect(reverbOutputNode);

    reverbOutputNode.connect(this.limiter);
    this.limiter.connect(this.masterGain);
    
    this.masterGain.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    
    this.masterGain.connect(this.waveformAnalyser);
    this.masterGain.connect(this.monoCheckNode);

    this.calibrateListener();
    this.setupStems();
  }

  // ──────────────────────────────────────────────────────────────────
  // V4/V5: Psychoacoustic Bass Exciter
  // Tricks small speakers into hearing sub-bass by generating upper harmonics
  // ──────────────────────────────────────────────────────────────────
  setupPsychoacousticBass() {
    const ctx = this.ctx;
    this.psychoBass = {
      input: ctx.createGain(),
      output: ctx.createGain(),
      lowpass: ctx.createBiquadFilter(),
      shaper: ctx.createWaveShaper(),
      highpass: ctx.createBiquadFilter(),
      wetGain: ctx.createGain()
    };

    const pb = this.psychoBass;
    
    // Isolate 40-80Hz
    pb.lowpass.type = 'lowpass';
    pb.lowpass.frequency.value = 85;
    
    // Distort heavily to generate harmonics (2nd = 80-160Hz, 3rd = 120-240Hz)
    pb.shaper.curve = this.makeSaturationCurve(25);  // V5: Slightly reduced to prevent mud
    pb.shaper.oversample = '4x';
    
    // Highpass to remove the original fundamental (avoid mud)
    pb.highpass.type = 'highpass';
    pb.highpass.frequency.value = 100; // V5: Tighter highpass so harmonics don't bleed into low-mids too much
    
    pb.wetGain.gain.value = 0.0;

    pb.input.connect(pb.lowpass);
    pb.lowpass.connect(pb.shaper);
    pb.shaper.connect(pb.highpass);
    pb.highpass.connect(pb.wetGain);
    pb.wetGain.connect(pb.output);
  }

  // ──────────────────────────────────────────────────────────────────
  // V4: Multiband Mid/Side Widener
  // Only widens >300Hz. <300Hz stays mono/mid to retain punch.
  // ──────────────────────────────────────────────────────────────────
  setupMultibandWidener() {
    const ctx = this.ctx;
    this.widener = {
      input: ctx.createGain(),
      output: ctx.createGain(),
      
      // Crossover
      lowpass: ctx.createBiquadFilter(),
      highpass: ctx.createBiquadFilter(),
      lowMidPass: ctx.createGain(), // Unwidened lows
      
      // M/S matrix for Highs
      splitter: ctx.createChannelSplitter(2),
      merger: ctx.createChannelMerger(2),
      midSum: ctx.createGain(), midToL: ctx.createGain(), midToR: ctx.createGain(),
      sideDiff: ctx.createGain(), invertR: ctx.createGain(), sideToL: ctx.createGain(), sideToR: ctx.createGain(),
      widthGainL: ctx.createGain(), widthGainR: ctx.createGain(),
      width: 1.0
    };

    const w = this.widener;
    
    // Crossover at 300Hz
    w.lowpass.type = 'lowpass'; w.lowpass.frequency.value = 300;
    w.highpass.type = 'highpass'; w.highpass.frequency.value = 300;
    
    w.input.connect(w.lowpass);
    w.input.connect(w.highpass);
    w.lowpass.connect(w.lowMidPass);
    w.lowMidPass.connect(w.output); // Lows go straight to output (Mono-safe)

    // Highs go into M/S Widener
    w.midSum.gain.value = 0.5; w.sideDiff.gain.value = 0.5; w.invertR.gain.value = -1.0;
    w.midToL.gain.value = 1.0; w.midToR.gain.value = 1.0; w.sideToL.gain.value = 1.0; w.sideToR.gain.value = -1.0;

    w.highpass.connect(w.splitter);
    w.splitter.connect(w.midSum, 0); w.splitter.connect(w.midSum, 1);
    w.splitter.connect(w.sideDiff, 0); w.splitter.connect(w.invertR, 1); w.invertR.connect(w.sideDiff);

    w.widthGainL.gain.value = w.width; w.widthGainR.gain.value = w.width;
    w.sideDiff.connect(w.widthGainL); w.sideDiff.connect(w.widthGainR);

    w.midSum.connect(w.midToL); w.widthGainL.connect(w.sideToL);
    const sumL = ctx.createGain(); w.midToL.connect(sumL); w.sideToL.connect(sumL); sumL.connect(w.merger, 0, 0);

    w.midSum.connect(w.midToR); w.widthGainR.connect(w.sideToR);
    const sumR = ctx.createGain(); w.midToR.connect(sumR); w.sideToR.connect(sumR); sumR.connect(w.merger, 0, 1);

    w.merger.connect(w.output);
  }

  // ──────────────────────────────────────────────────────────────────
  // Precomputed IR Bank
  // ──────────────────────────────────────────────────────────────────
  _buildIRBank() {
    const presets = {
      small_room: { decay: 0.6,  earlyMs: 30,  damping: 0.7 },
      studio:     { decay: 1.2,  earlyMs: 50,  damping: 0.5 },
      hall:       { decay: 2.0,  earlyMs: 80,  damping: 0.35 },
      arena:      { decay: 3.0,  earlyMs: 120, damping: 0.25 },
      cathedral:  { decay: 4.5,  earlyMs: 180, damping: 0.15 },
    };
    for (const [name, cfg] of Object.entries(presets)) {
      this.reverb.irBank[name] = this._generateIR(cfg.decay, cfg.earlyMs, cfg.damping);
    }
  }

  _generateIR(decaySec, earlyMs, damping) {
    const sr = this.ctx.sampleRate;
    const length = Math.floor(sr * decaySec);
    const buffer = this.ctx.createBuffer(2, length, sr);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const earlyEnd = (earlyMs / 1000) * sr;
    const dampDecay = 3.0 + damping * 8.0;

    for (let i = 0; i < length; i++) {
      const t = i / sr;
      const earlyGain = i < earlyEnd ? (i / earlyEnd) * 0.5 : 1.0;
      const envelope = Math.exp(-t * (dampDecay / decaySec)) * earlyGain;
      const hfDamp = 1.0 - (t / decaySec) * damping;
      const noise = (Math.random() * 2 - 1) * envelope * Math.max(0.2, hfDamp);
      left[i] = noise;
      right[i] = (Math.random() * 2 - 1) * envelope * Math.max(0.2, hfDamp);
    }
    return buffer;
  }

  _switchReverb(name) {
    if (name === this.reverb.currentIR) return;
    const ir = this.reverb.irBank[name];
    if (!ir) return;

    const t = this.ctx.currentTime;
    const wetParam = this.reverb.wetGain.gain;
    const currentWet = this._targets.reverbMix;

    wetParam.cancelScheduledValues(t);
    wetParam.setValueAtTime(wetParam.value, t);
    wetParam.linearRampToValueAtTime(0, t + 0.08);

    setTimeout(() => {
      try {
        this.reverb.convolver.buffer = ir;
        this.reverb.currentIR = name;
        const t2 = this.ctx.currentTime;
        wetParam.cancelScheduledValues(t2);
        wetParam.setValueAtTime(0, t2);
        wetParam.linearRampToValueAtTime(currentWet, t2 + 0.12);
      } catch (e) {
        console.warn('Reverb swap error:', e);
      }
    }, 100);
  }

  calibrateListener() {
    const listener = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (listener.positionX) {
      listener.positionX.setValueAtTime(0, t); listener.positionY.setValueAtTime(0, t); listener.positionZ.setValueAtTime(0, t);
      listener.forwardX.setValueAtTime(0, t); listener.forwardY.setValueAtTime(0, t); listener.forwardZ.setValueAtTime(-1, t);
      listener.upX.setValueAtTime(0, t); listener.upY.setValueAtTime(1, t); listener.upZ.setValueAtTime(0, t);
    } else {
      listener.setPosition(0, 0, 0); listener.setOrientation(0, 0, -1, 0, 1, 0);
    }
  }

  setupStems() {
    const ctx = this.ctx;
    this._bodyFilter = ctx.createBiquadFilter();
    this._bodyFilter.type = 'bandpass';
    this._bodyFilter.frequency.value = 450;
    this._bodyFilter.Q.value = 0.5;
    this._bodyGain = ctx.createGain();
    this._bodyGain.gain.value = 0.4;
    this._bodyFilter.connect(this._bodyGain);
    this._bodyGain.connect(this.eqLow);

    for (const [name, stem] of Object.entries(this.stems)) {
      stem.filter = ctx.createBiquadFilter();
      if (name === 'bass') { stem.filter.type = 'lowpass'; stem.filter.frequency.value = 220; stem.filter.Q.value = 0.707; }
      else if (name === 'vocals') { stem.filter.type = 'bandpass'; stem.filter.frequency.value = 1200; stem.filter.Q.value = 0.3; }
      else if (name === 'melody') { stem.filter.type = 'bandpass'; stem.filter.frequency.value = 3000; stem.filter.Q.value = 0.25; }
      else if (name === 'drums') { stem.filter.type = 'highpass'; stem.filter.frequency.value = 6000; }

      stem.gain = ctx.createGain();
      stem.gain.gain.value = stem.baseGain * 0.45;
      
      stem.panner = ctx.createPanner();
      stem.panner.panningModel = 'HRTF';
      stem.panner.distanceModel = 'exponential';
      stem.panner.refDistance = 1; stem.panner.maxDistance = 20; stem.panner.rolloffFactor = 1.5;
      stem.panner.coneInnerAngle = 360; stem.panner.coneOuterAngle = 360;

      const pos = this.defaultPositions[name];
      stem.panner.positionX.setValueAtTime(pos.x, ctx.currentTime);
      stem.panner.positionY.setValueAtTime(pos.y, ctx.currentTime);
      stem.panner.positionZ.setValueAtTime(pos.z, ctx.currentTime);

      stem.filter.connect(stem.gain);
      stem.gain.connect(stem.panner);
      stem.panner.connect(this.eqLow);
    }
  }

  setupCrossfeed() {
    const ctx = this.ctx;
    const c = this.crossfeed;
    c.input = ctx.createGain(); c.output = ctx.createGain(); c.splitter = ctx.createChannelSplitter(2); c.merger = ctx.createChannelMerger(2);
    c.directL = ctx.createGain(); c.directR = ctx.createGain(); c.delayLtoR = ctx.createDelay(0.01); c.delayRtoL = ctx.createDelay(0.01);
    c.filterLtoR = ctx.createBiquadFilter(); c.filterRtoL = ctx.createBiquadFilter(); c.gainLtoR = ctx.createGain(); c.gainRtoL = ctx.createGain();
    
    c.delayLtoR.delayTime.value = 0.00065; c.delayRtoL.delayTime.value = 0.00065;
    c.filterLtoR.type = 'lowpass'; c.filterLtoR.frequency.value = 1200;
    c.filterRtoL.type = 'lowpass'; c.filterRtoL.frequency.value = 1200;
    
    this.updateCrossfeedGains();
    c.input.connect(c.splitter);
    c.splitter.connect(c.directL, 0); c.splitter.connect(c.directR, 1);
    c.directL.connect(c.merger, 0, 0); c.directR.connect(c.merger, 0, 1);
    c.splitter.connect(c.delayLtoR, 0); c.delayLtoR.connect(c.filterLtoR); c.filterLtoR.connect(c.gainLtoR); c.gainLtoR.connect(c.merger, 0, 1);
    c.splitter.connect(c.delayRtoL, 1); c.delayRtoL.connect(c.filterRtoL); c.filterRtoL.connect(c.gainRtoL); c.gainRtoL.connect(c.merger, 0, 0);
    c.merger.connect(c.output);
  }

  updateCrossfeedGains() {
    if (!this.ctx) return;
    const c = this.crossfeed;
    const t = this.ctx.currentTime;
    if (!c.active) {
      c.directL.gain.setValueAtTime(1.0, t); c.directR.gain.setValueAtTime(1.0, t); c.gainLtoR.gain.setValueAtTime(0.0, t); c.gainRtoL.gain.setValueAtTime(0.0, t);
      return;
    }
    const amount = c.amount;
    const directGain = 1.0 - (amount * 0.12); const crossGain = amount * 0.28;
    c.directL.gain.setValueAtTime(directGain, t); c.directR.gain.setValueAtTime(directGain, t);
    c.gainLtoR.gain.setValueAtTime(crossGain, t); c.gainRtoL.gain.setValueAtTime(crossGain, t);
  }

  makeSaturationCurve(amount) {
    const n_samples = 44100; const curve = new Float32Array(n_samples);
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      if (amount === 0) curve[i] = x;
      else { const k = amount / 10; curve[i] = Math.tanh(x * (1 + k)) / Math.tanh(1 + k); }
    }
    return curve;
  }

  _smoothRamp(param, targetValue, durationSec = 0.2, deadband = DEADBAND.gain) {
    if (!param || !this.ctx) return;
    if (Math.abs(param.value - targetValue) < deadband) return;
    const t = this.ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(targetValue, t + durationSec);
  }

  async loadProcessedAudio(arrayBuffer, report = {}) {
    await this.init();
    const buffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    this.decodedBuffer = buffer;
    this.directPlayback = true; this.orbiting = false;
    this.brainReport = {
      ...this.brainReport,
      bpm: report.bpm ?? this.brainReport.bpm,
      genre: report.genre ?? 'Server Rendered',
      mood: report.mood ?? 'Pipeline Mix',
      profile: report.profile ?? 'audiophile',
      activeSection: 'RENDERED', sectionConfidence: 1.0, stemConfidence: 1.0, qualityScore: 100,
      bassBoostDb: 0, reverbDecaySec: 0,
      stereoWidthCoeff: this._profileWidthHint(report.profile), crossfeedCoeff: 0,
    };
    return buffer;
  }

  _profileWidthHint(profile) {
    const widths = { zenith: 1.85, hyper_immersive: 1.55, concert: 1.35, cinema: 1.45, audiophile: 1.1, basshead: 0.85 };
    return widths[profile] ?? 1.0;
  }

  getLiveMetrics() {
    if (!this.analyser) return { rms: 0, bass: 0, treble: 0, peak: 0 };
    const timeData = new Uint8Array(this.analyser.fftSize);
    const freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(timeData); this.analyser.getByteFrequencyData(freqData);

    let sumSq = 0; let peak = 0;
    for (let i = 0; i < timeData.length; i++) {
      const sample = (timeData[i] - 128) / 128;
      const abs = Math.abs(sample); if (abs > peak) peak = abs;
      sumSq += sample * sample;
    }
    const rms = Math.sqrt(sumSq / timeData.length);
    const binCount = freqData.length;
    const bassEnd = Math.max(1, Math.floor(binCount * 0.12)); const trebleStart = Math.floor(binCount * 0.55);
    let bassSum = 0; let trebleSum = 0;
    for (let i = 0; i < binCount; i++) {
      if (i < bassEnd) bassSum += freqData[i]; else if (i >= trebleStart) trebleSum += freqData[i];
    }
    return { rms, peak, bass: bassSum / bassEnd / 255, treble: trebleSum / (binCount - trebleStart) / 255 };
  }

  getBeatPhase() {
    const bpm = this.brainReport?.bpm || 120;
    if (!this.ctx) return 0;
    const beatHz = bpm / 60;
    const t = this.isPlaying ? this.ctx.currentTime - this.startTime : this.pauseOffset;
    return (t * beatHz) % 1;
  }

  _updateLUFS(rms) {
    const lufs = rms > 0.0001 ? 20 * Math.log10(rms) - 0.691 : -60;
    this._lufsMomentaryWindow.push(lufs);
    if (this._lufsMomentaryWindow.length > this._lufsMomentaryMaxSamples) this._lufsMomentaryWindow.shift();
    const momentary = this._lufsMomentaryWindow.reduce((a, b) => a + b, 0) / this._lufsMomentaryWindow.length;

    this._lufsShortTermWindow.push(lufs);
    if (this._lufsShortTermWindow.length > this._lufsShortTermMaxSamples) this._lufsShortTermWindow.shift();
    const shortTerm = this._lufsShortTermWindow.reduce((a, b) => a + b, 0) / this._lufsShortTermWindow.length;

    this.brainReport.momentaryLUFS = Math.round(momentary * 10) / 10;
    this.brainReport.shortTermLUFS = Math.round(shortTerm * 10) / 10;
    return { momentary, shortTerm };
  }

  // ──────────────────────────────────────────────────────────────────
  // V4/V5/V6: AI Audio Quality Score Loop (Fitness Function)
  // ──────────────────────────────────────────────────────────────────
  _calculateQualityScore(momentaryLUFS, rms, peak, currentWidth, eqLowGain) {
    // 1. Fatigue Score: Penalize sustained hot LUFS > -8
    if (momentaryLUFS > -8) {
      this._fatigueAccumulator += 0.5;
    } else {
      this._fatigueAccumulator = Math.max(0, this._fatigueAccumulator - 0.2);
    }
    const fatiguePenalty = Math.min(40, this._fatigueAccumulator);

    // 2. Punch/Clarity: Crest factor (Peak / RMS). Low crest = crushed dynamic range.
    const crest = rms > 0.0001 ? peak / rms : 4.0;
    const crestPenalty = crest < 3.0 ? (3.0 - crest) * 10 : 0; // Penalize sausage waveforms

    // 3. Stereo Image (V6): Reward width up to 1.2x, penalize heavily above 1.25x (phase issues)
    let imageScore = 0;
    if (currentWidth > 1.0 && currentWidth <= 1.2) imageScore = (currentWidth - 1.0) * 20;
    else if (currentWidth > 1.2) imageScore = 4 - ((currentWidth - 1.2) * 50); // Sharp dropoff
    
    // 4. Spectral Masking (V6): Penalize extreme bass boosts which cause mud
    const maskingPenalty = eqLowGain > 2.5 ? (eqLowGain - 2.5) * 5 : 0;

    let rawScore = 100 - fatiguePenalty - crestPenalty + imageScore - maskingPenalty;
    rawScore = Math.max(0, Math.min(100, rawScore));

    // Exponential smoothing to prevent oscillation pumping
    const currentScore = this.brainReport.qualityScore || 100;
    const alpha = 0.1; // Smooth over ~10 frames
    const smoothedScore = currentScore + alpha * (rawScore - currentScore);

    this.brainReport.qualityScore = Math.round(smoothedScore * 10) / 10;
    return smoothedScore;
  }

  // ──────────────────────────────────────────────────────────────────
  // Buffer Pre-analysis + Look-ahead Timeline + Confidence
  // ──────────────────────────────────────────────────────────────────
  _buildTimeline(buffer) {
    const data = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const duration = buffer.duration;
    const hopSamples = Math.floor(sr * (this._timelineResolutionMs / 1000));
    const frameCount = Math.ceil(data.length / hopSamples);
    const timeline = new Array(frameCount);

    let totalRms = 0;
    let maxVariance = 0;
    let minVariance = Infinity;

    for (let i = 0; i < frameCount; i++) {
      const start = i * hopSamples;
      const end = Math.min(start + hopSamples, data.length);
      let sumSq = 0; let peak = 0;
      for (let j = start; j < end; j++) {
        sumSq += data[j] * data[j];
        const abs = Math.abs(data[j]); if (abs > peak) peak = abs;
      }
      const rms = Math.sqrt(sumSq / (end - start));
      totalRms += rms;
      
      // Compute rough variance (pseudo stem-confidence proxy for single-channel mixdown)
      // A mix with high variance between frames implies distinct instruments. 
      // Low variance implies wall-of-sound (poor separation candidate).
      if (rms > 0.01) {
        maxVariance = Math.max(maxVariance, rms);
        minVariance = Math.min(minVariance, rms);
      }

      timeline[i] = { timeSec: (i * hopSamples) / sr, rms, peak, section: 'VERSE', confidence: 0, isTransient: false };
    }

    const avgRms = totalRms / frameCount;
    const dynamicRangeProxy = maxVariance / (minVariance + 0.001);
    
    // Stem failure handling: if track is too squashed (wall of sound), separation will be poor.
    // Scale confidence. If confidence is low, spatial widening is restricted.
    let stemConfidence = 1.0;
    if (dynamicRangeProxy < 2.0) stemConfidence = 0.5; // Very squashed, likely poor stems
    if (dynamicRangeProxy < 1.2) stemConfidence = 0.2; // Brickwalled mono
    this.brainReport.stemConfidence = stemConfidence;

    for (let i = 1; i < frameCount; i++) {
      const prev = timeline[i - 1].rms; const curr = timeline[i].rms;
      if (prev > 0.001 && curr / prev > 3.0) timeline[i].isTransient = true;
      else if (timeline[i].peak > avgRms * 4.0 && timeline[i].rms < avgRms * 0.8) timeline[i].isTransient = true;
    }

    const smoothWindow = Math.max(1, Math.floor(800 / this._timelineResolutionMs));
    for (let i = 0; i < frameCount; i++) {
      let sum = 0; let count = 0;
      for (let j = Math.max(0, i - smoothWindow); j <= Math.min(frameCount - 1, i + smoothWindow); j++) {
        sum += timeline[j].rms; count++;
      }
      const smoothed = sum / count;
      const timeSec = timeline[i].timeSec;
      const ratio = smoothed / (avgRms + 0.0001);

      let section = 'VERSE'; let confidence = 0.5;
      if (ratio > 1.5) { section = 'CHORUS / DROP'; confidence = Math.min(1.0, 0.6 + (ratio - 1.5) * 0.4); }
      else if (ratio > 1.15) { section = 'BUILD'; confidence = 0.5 + (ratio - 1.15) / 0.35 * 0.3; }
      else if (ratio < 0.45 && timeSec < 20) { section = 'INTRO'; confidence = 0.7 + (0.45 - ratio) * 0.5; }
      else if (ratio < 0.45 && timeSec > duration - 20) { section = 'OUTRO'; confidence = 0.7 + (0.45 - ratio) * 0.5; }
      else if (ratio < 0.6) { section = 'BREAKDOWN'; confidence = 0.5 + (0.6 - ratio) * 0.5; }
      else { section = 'VERSE'; confidence = 0.4 + ratio * 0.2; }

      timeline[i].section = section; timeline[i].confidence = Math.min(1.0, confidence);
    }
    return timeline;
  }

  _lookAhead(playbackTimeSec) {
    if (!this._timeline || this._timeline.length === 0) return null;
    const aheadSec = playbackTimeSec + (this._lookAheadMs / 1000);
    const resolution = this._timelineResolutionMs / 1000;
    const idx = Math.min(this._timeline.length - 1, Math.max(0, Math.floor(aheadSec / resolution)));
    return this._timeline[idx];
  }

  _currentTimelineFrame(playbackTimeSec) {
    if (!this._timeline || this._timeline.length === 0) return null;
    const resolution = this._timelineResolutionMs / 1000;
    const idx = Math.min(this._timeline.length - 1, Math.max(0, Math.floor(playbackTimeSec / resolution)));
    return this._timeline[idx];
  }

  async loadAudioFile(file) {
    this.directPlayback = false; this.orbiting = true;
    await this.init();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const arrayBuffer = e.target.result;
          const buffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
          this.decodedBuffer = buffer;
          this.runBrainAnalyzer(buffer);
          resolve(buffer);
        } catch (err) { reject(new Error('Web Audio decoding error: ' + (err.message || err))); }
      };
      reader.onerror = (err) => reject(err);
      reader.readAsArrayBuffer(file);
    });
  }

  runBrainAnalyzer(buffer) {
    const data = buffer.getChannelData(0); const sampleRate = buffer.sampleRate; const length = data.length;
    let bpm = 120;
    try {
      const duration = buffer.duration;
      const startSample = Math.max(0, Math.floor(duration * 0.15) * sampleRate);
      const endSample = Math.min(length, startSample + 25 * sampleRate);
      const hopSize = Math.floor(sampleRate * 0.01);
      const fftSize = 1024; const onsetEnvelope = []; let prevEnergy = null;

      for (let i = startSample; i < endSample - fftSize; i += hopSize) {
        let energy = 0;
        for (let j = 0; j < fftSize; j++) { energy += data[i + j] * data[i + j]; }
        energy = Math.sqrt(energy / fftSize);
        if (prevEnergy !== null) onsetEnvelope.push(Math.max(0, energy - prevEnergy));
        prevEnergy = energy;
      }
      if (onsetEnvelope.length > 100) {
        const minLag = Math.floor(60 / 200 / 0.01); const maxLag = Math.floor(60 / 55 / 0.01);
        let bestLag = minLag; let bestCorr = -Infinity;
        for (let lag = minLag; lag <= Math.min(maxLag, onsetEnvelope.length / 2); lag++) {
          let corr = 0; let count = 0;
          for (let j = 0; j < onsetEnvelope.length - lag; j++) { corr += onsetEnvelope[j] * onsetEnvelope[j + lag]; count++; }
          corr /= count; if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
        }
        bpm = Math.round(60 / (bestLag * 0.01));
        if (bpm < 60) bpm *= 2; if (bpm > 180) bpm = Math.round(bpm / 2);
      }
    } catch (e) { console.warn("BPM fallback", e); }

    let genre = "Pop / Balanced"; let mood = "Warm Harmonized";
    let totalEnergy = 0; let bassEnergy = 0; let highEnergy = 0; let peak = 0;
    const numSegments = 16; const segmentLen = 2048;

    for (let seg = 0; seg < numSegments; seg++) {
      const offset = Math.floor((seg / numSegments) * (length - segmentLen));
      for (let i = 0; i < segmentLen; i++) {
        const idx = offset + i; if (idx >= length) break;
        const sample = data[idx]; const absSample = Math.abs(sample);
        if (absSample > peak) peak = absSample;
        const energy = sample * sample; totalEnergy += energy;
        if (i > 0 && idx < length - 1) {
          const delta = Math.abs(data[idx] - data[idx - 1]);
          const normalizedDelta = delta / (absSample + 0.001);
          if (normalizedDelta < 0.3) bassEnergy += energy;
          else if (normalizedDelta > 0.8) highEnergy += energy;
        }
      }
    }

    const totalSamples = numSegments * segmentLen;
    const rms = Math.sqrt(totalEnergy / totalSamples);
    const bassRatio = bassEnergy / (totalEnergy + 0.0001);
    const highRatio = highEnergy / (totalEnergy + 0.0001);
    const crestFactor = rms > 0 ? peak / rms : 4.0;

    if (crestFactor > 5.5 && bassRatio < 0.4) { genre = "Classical / Acoustic"; mood = "Pure Dynamic Range"; }
    else if (bassRatio > 0.55 && bpm > 110) { genre = "Electronic / Dance"; mood = "Heavy Sub Bass"; }
    else if (bassRatio > 0.50 && bpm <= 110) { genre = "Hip-Hop / R&B"; mood = "Warm Low-End"; }
    else if (highRatio > 0.25 && crestFactor > 3.5) { genre = "Rock / High-Energy"; mood = "Bright & Dynamic"; }
    else if (bassRatio < 0.30 && highRatio < 0.15 && crestFactor > 4.0) { genre = "Acoustic / Vocal"; mood = "Intimate Centered"; }
    else if (highRatio > 0.20) { genre = "Indie / Alternative"; mood = "Textured & Airy"; }

    this.brainReport.bpm = bpm; this.brainReport.genre = genre; this.brainReport.mood = mood;
    this.brainReport.avgRMS = rms; this.brainReport.crestFactor = crestFactor;

    const bps = bpm / 60;
    const clampOrbit = (name, hz) => Math.max(ORBIT_HZ_LIMITS[name].min, Math.min(ORBIT_HZ_LIMITS[name].max, hz));
    const hzToRadPerFrame = (hz) => (hz * 2 * Math.PI) / 60;
    this.orbitSpeeds.vocals = hzToRadPerFrame(clampOrbit('vocals', bps * 0.02));
    this.orbitSpeeds.bass = 0;
    this.orbitSpeeds.melody = hzToRadPerFrame(clampOrbit('melody', bps * 0.06));
    this.orbitSpeeds.drums = hzToRadPerFrame(clampOrbit('drums', bps * 0.04));

    this._timeline = this._buildTimeline(buffer);
    const integratedLUFS = rms > 0.0001 ? 20 * Math.log10(rms) - 0.691 : -30;
    this.applyAutomaticBaseline(genre, integratedLUFS);
  }

  applyAutomaticBaseline(genre, integratedLUFS = -14) {
    const rampTime = 0.3;
    const lufsFactor = Math.max(0.4, Math.min(1.0, (integratedLUFS + 22) / 15));
    // Apply stem failure penalty: if separation is terrible, limit width expansion
    const widthScale = this.brainReport.stemConfidence; 

    if (genre.includes("Electronic") || genre.includes("Hip-Hop")) {
      this._baselines = {
        eqLowGain: 2.5 * lufsFactor, eqMidGain: -0.5, eqHighGain: 1.0, eqPresenceGain: 0.5,
        satWet: 0.10 * lufsFactor, psychoBassWet: 0.15 * lufsFactor, // Drive psycho bass hard on EDM
        widthL: 1.0 + (0.2 * lufsFactor * widthScale), widthR: 1.0 + (0.2 * lufsFactor * widthScale),
        reverbMix: 0.10,
      };
      this.crossfeed.amount = clampSafe('crossfeedAmt', 0.25);
      this._selectReverbPreset('studio');
      this.saturation.curve = this.makeSaturationCurve(12 * lufsFactor);
    } else if (genre.includes("Rock")) {
      this._baselines = {
        eqLowGain: 1.5 * lufsFactor, eqMidGain: 1.0, eqHighGain: 1.5, eqPresenceGain: 1.0,
        satWet: 0.18 * lufsFactor, psychoBassWet: 0.05,
        widthL: 1.0 + (0.1 * lufsFactor * widthScale), widthR: 1.0 + (0.1 * lufsFactor * widthScale),
        reverbMix: 0.08,
      };
      this.crossfeed.amount = clampSafe('crossfeedAmt', 0.35);
      this._selectReverbPreset('small_room');
      this.saturation.curve = this.makeSaturationCurve(20 * lufsFactor);
    } else if (genre.includes("Classical")) {
      this._baselines = {
        eqLowGain: 0.5, eqMidGain: 0.3, eqHighGain: 1.0, eqPresenceGain: 1.5,
        satWet: 0.0, psychoBassWet: 0.0,
        widthL: 1.0 + (0.3 * lufsFactor * widthScale), widthR: 1.0 + (0.3 * lufsFactor * widthScale),
        reverbMix: 0.18 + 0.06 * lufsFactor,
      };
      this.crossfeed.amount = clampSafe('crossfeedAmt', 0.45);
      this._selectReverbPreset('hall');
    } else if (genre.includes("Acoustic") || genre.includes("Vocal")) {
      this._baselines = {
        eqLowGain: -0.5, eqMidGain: 2.0, eqHighGain: 0.5, eqPresenceGain: 1.0,
        satWet: 0.03 * lufsFactor, psychoBassWet: 0.0,
        widthL: 0.9, widthR: 0.9,
        reverbMix: 0.06,
      };
      this.crossfeed.amount = clampSafe('crossfeedAmt', 0.50);
      this._selectReverbPreset('small_room');
      this.saturation.curve = this.makeSaturationCurve(3);
    } else if (genre.includes("Indie")) {
      this._baselines = {
        eqLowGain: 1.0 * lufsFactor, eqMidGain: 0.5, eqHighGain: 1.5, eqPresenceGain: 1.5,
        satWet: 0.08 * lufsFactor, psychoBassWet: 0.05,
        widthL: 1.0 + (0.15 * lufsFactor * widthScale), widthR: 1.0 + (0.15 * lufsFactor * widthScale),
        reverbMix: 0.14,
      };
      this.crossfeed.amount = clampSafe('crossfeedAmt', 0.30);
      this._selectReverbPreset('studio');
      this.saturation.curve = this.makeSaturationCurve(10 * lufsFactor);
    } else {
      this._baselines = {
        eqLowGain: 1.5 * lufsFactor, eqMidGain: 0.3, eqHighGain: 1.0, eqPresenceGain: 0.5,
        satWet: 0.06 * lufsFactor, psychoBassWet: 0.08,
        widthL: 1.0 + (0.1 * lufsFactor * widthScale), widthR: 1.0 + (0.1 * lufsFactor * widthScale),
        reverbMix: 0.12,
      };
      this.crossfeed.amount = clampSafe('crossfeedAmt', 0.30);
      this._selectReverbPreset('studio');
      this.saturation.curve = this.makeSaturationCurve(8 * lufsFactor);
    }

    for (const key of Object.keys(this._baselines)) {
      this._baselines[key] = clampSafe(key, this._baselines[key]);
    }
    this._targets = { ...this._baselines };
    this._current = { ...this._baselines };

    this._smoothRamp(this.eqLow.gain, this._targets.eqLowGain, rampTime);
    this._smoothRamp(this.eqMid.gain, this._targets.eqMidGain, rampTime);
    this._smoothRamp(this.eqHigh.gain, this._targets.eqHighGain, rampTime);
    this._smoothRamp(this.eqPresence.gain, this._targets.eqPresenceGain, rampTime);
    this._smoothRamp(this.satDry.gain, 1.0 - this._targets.satWet, rampTime, DEADBAND.satWet);
    this._smoothRamp(this.satWet.gain, this._targets.satWet, rampTime, DEADBAND.satWet);
    
    // V4 Psycho Bass
    if (this.psychoBass) {
      const wet = this._budgetState.psychoBassEnabled ? this._targets.psychoBassWet : 0.0;
      this._smoothRamp(this.psychoBass.wetGain.gain, wet, rampTime);
    }

    this._smoothRamp(this.widener.widthGainL.gain, this._targets.widthL, rampTime, DEADBAND.width);
    this._smoothRamp(this.widener.widthGainR.gain, this._targets.widthR, rampTime, DEADBAND.width);
    this.updateCrossfeedGains();
    this._smoothRamp(this.reverb.dryGain.gain, 1.0 - this._targets.reverbMix, rampTime, DEADBAND.reverbMix);
    this._smoothRamp(this.reverb.wetGain.gain, this._targets.reverbMix, rampTime, DEADBAND.reverbMix);
  }

  _selectReverbPreset(name) {
    if (this.reverb.irBank[name] && name !== this.reverb.currentIR) this._switchReverb(name);
  }

  // ──────────────────────────────────────────────────────────────────
  // V4/V5 Brain Tick
  // ──────────────────────────────────────────────────────────────────
  processAutomaticBraintick() {
    if (!this.ctx || !this.isPlaying || !this.decodedBuffer) return;
    const now = performance.now();
    if (now - this._lastBrainTickTime < this._brainTickIntervalMs) return;
    this._lastBrainTickTime = now;
    
    const tickStartTime = performance.now();

    // RMS (Processed)
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteTimeDomainData(dataArray);
    let sumSquares = 0; let peak = 0;
    for (let i = 0; i < bufferLength; i++) {
      const normalized = (dataArray[i] - 128) / 128;
      if (Math.abs(normalized) > peak) peak = Math.abs(normalized);
      sumSquares += normalized * normalized;
    }
    const currentRMS = Math.sqrt(sumSquares / bufferLength);

    const lufs = this._updateLUFS(currentRMS);
    const score = this._calculateQualityScore(lufs.momentary, currentRMS, peak, this._targets.widthL, this._targets.eqLowGain);
    
    // RMS (Original / Dry) for A/B Validation
    if (this.dryAnalyser) {
      const dryData = new Uint8Array(bufferLength);
      this.dryAnalyser.getByteTimeDomainData(dryData);
      let drySum = 0; let dryPeak = 0;
      for (let i = 0; i < bufferLength; i++) {
        const norm = (dryData[i] - 128) / 128;
        if (Math.abs(norm) > dryPeak) dryPeak = Math.abs(norm);
        drySum += norm * norm;
      }
      const dryRMS = Math.sqrt(drySum / bufferLength);
      // Rough approximation of original LUFS and score (assumes flat width/gain)
      const dryLufs = -23 + 20 * Math.log10(dryRMS + 0.0001) + 2.0; 
      
      const crest = dryRMS > 0.0001 ? dryPeak / dryRMS : 4.0;
      const crestPenalty = crest < 3.0 ? (3.0 - crest) * 10 : 0;
      const fatiguePenalty = dryLufs > -8 ? 10 : 0;
      
      let rawOriginal = 100 - fatiguePenalty - crestPenalty;
      rawOriginal = Math.max(0, Math.min(100, rawOriginal));
      
      const currOrig = this.brainReport.originalScore || 100;
      this.brainReport.originalScore = Math.round((currOrig + 0.1 * (rawOriginal - currOrig)) * 10) / 10;
    }
    
    // AI Self-Correction: If score drops < 80, scale back enhancements linearly.
    const correctionFactor = score < 80 ? (score / 80) : 1.0;

    const playbackTime = this.ctx.currentTime - this.startTime;
    const aheadFrame = this._lookAhead(playbackTime);
    const currentFrame = this._currentTimelineFrame(playbackTime);

    // V4: Spectral Masking (Ducking) via Lookahead
    // If transient ahead, trigger an EQ duck specifically on bass.
    if (this._budgetState.maskingEnabled && aheadFrame && aheadFrame.isTransient && !this._transientDucked) {
      this._transientDucked = true;
      // Schedule precise bass dip at exact transient time
      const t = this.ctx.currentTime + (this._lookAheadMs / 1000);
      this.eqLow.gain.cancelScheduledValues(t);
      this.eqLow.gain.setValueAtTime(this._targets.eqLowGain, t);
      this.eqLow.gain.linearRampToValueAtTime(this._targets.eqLowGain - 1.5, t + 0.01); // Fast attack duck
      this.eqLow.gain.linearRampToValueAtTime(this._targets.eqLowGain, t + 0.09);       // V5: 80ms release (gentler)
    } else if (aheadFrame && !aheadFrame.isTransient) {
      this._transientDucked = false;
    }

    if (currentFrame && currentFrame.isTransient) {
      this._inTransient = true; this._transientDecayTimer = now + 80;
    } else if (now > this._transientDecayTimer) {
      this._inTransient = false;
    }

    let section = 'VERSE'; let confidence = 0.5;
    if (aheadFrame) { section = aheadFrame.section; confidence = aheadFrame.confidence; }
    else {
      this._rmsHistory.push(currentRMS);
      if (this._rmsHistory.length > this._rmsHistoryMax) this._rmsHistory.shift();
      const smoothedRMS = this._rmsHistory.reduce((a, b) => a + b, 0) / this._rmsHistory.length;
      const baseRMS = this.brainReport.avgRMS; const ratio = smoothedRMS / (baseRMS + 0.001);
      if (ratio > 1.45) { section = 'CHORUS / DROP'; confidence = Math.min(1, 0.6 + (ratio - 1.45) * 0.4); }
      else if (ratio > 1.15) { section = 'BUILD'; confidence = 0.5 + (ratio - 1.15) / 0.3 * 0.3; }
      else if (ratio < 0.45) { section = playbackTime < 20 ? 'INTRO' : 'OUTRO'; confidence = 0.7; }
      else if (ratio < 0.6) { section = 'BREAKDOWN'; confidence = 0.6; }
    }

    if (now - this._sectionHoldTimer > this._sectionHoldMinMs) {
      if (section !== this.brainReport.activeSection) this._sectionHoldTimer = now;
      this.brainReport.activeSection = section; this.brainReport.sectionConfidence = Math.round(confidence * 100) / 100;
    } else {
      section = this.brainReport.activeSection; confidence = this.brainReport.sectionConfidence;
    }

    // V6: Stage 1 - Initial Seed Logic
    // Instead of forcing static values every frame, we only push a seed when the section changes.
    // The optimizer will take it from here.
    if (section !== this.brainReport.activeSection || this._optimizerState.tickCounter === 0) {
      this._applySectionSeed(section, confidence);
      this._optimizerState.lastScore = score;
    }

    // V6: Stage 2 - Hill-Climbing Self-Optimization
    this._optimizeBraintick(score);

    if (this._inTransient) {
      this._targets.widthL = clampSafe('widthL', Math.min(this._targets.widthL, 1.0));
      this._targets.widthR = clampSafe('widthR', Math.min(this._targets.widthR, 1.0));
    }

    const ramp = 0.2;
    // Don't ramp eqLowGain here if we just ducked it (prevent override), but since ducking schedules via absolute time, it's safer to just let the ducking command ride if transient, or smoothramp if not.
    if (!this._inTransient) {
      this._smoothRamp(this.eqLow.gain, this._targets.eqLowGain, ramp, DEADBAND.gain);
    }
    
    this._smoothRamp(this.eqMid.gain, this._targets.eqMidGain, ramp, DEADBAND.gain);
    this._smoothRamp(this.eqHigh.gain, this._targets.eqHighGain, ramp, DEADBAND.gain);
    this._smoothRamp(this.eqPresence.gain, this._targets.eqPresenceGain, ramp, DEADBAND.gain);
    this._smoothRamp(this.satDry.gain, 1.0 - this._targets.satWet, ramp, DEADBAND.satWet);
    this._smoothRamp(this.satWet.gain, this._targets.satWet, ramp, DEADBAND.satWet);
    this._smoothRamp(this.widener.widthGainL.gain, this._targets.widthL, ramp, DEADBAND.width);
    this._smoothRamp(this.widener.widthGainR.gain, this._targets.widthR, ramp, DEADBAND.width);
    this._smoothRamp(this.reverb.dryGain.gain, 1.0 - this._targets.reverbMix, ramp, DEADBAND.reverbMix);
    this._smoothRamp(this.reverb.wetGain.gain, this._targets.reverbMix, ramp, DEADBAND.reverbMix);

    this.brainReport.bassBoostDb = Math.round(this._targets.eqLowGain * 10) / 10;
    this.brainReport.reverbDecaySec = this.reverb.currentIR;
    this.brainReport.stereoWidthCoeff = Math.round(this._targets.widthL * 100) / 100;
    this.brainReport.crossfeedCoeff = Math.round(this.crossfeed.amount * 100) / 100;

    if (this.onDiagnosticCallback) {
      // Pass budget state for diagnostic overlay
      this.brainReport.cpuMs = this._budgetState.cpuMs;
      this.brainReport.orbitEnabled = this._budgetState.orbitEnabled;
      this.brainReport.psychoBassEnabled = this._budgetState.psychoBassEnabled;
      this.onDiagnosticCallback(this.brainReport, currentRMS);
    }
    
    // V5: Processing Budget Manager
    const tickDuration = performance.now() - tickStartTime;
    this._budgetState.cpuMs = Math.round(tickDuration * 10) / 10;
    
    if (tickDuration > 8) {
      this._budgetState.consecutiveHighTicks++;
      this._budgetState.consecutiveLowTicks = 0;
    } else if (tickDuration < 5) {
      this._budgetState.consecutiveLowTicks++;
      this._budgetState.consecutiveHighTicks = 0;
    }

    // Gracefully degrade features if CPU spikes
    if (this._budgetState.consecutiveHighTicks > 3 && this._budgetState.psychoBassEnabled) {
      this._budgetState.psychoBassEnabled = false; // Disable psycho bass first
      this._smoothRamp(this.psychoBass.wetGain.gain, 0.0, 0.5);
    } else if (this._budgetState.consecutiveHighTicks > 6 && this._budgetState.maskingEnabled) {
      this._budgetState.maskingEnabled = false; // Disable masking ducking second
    } else if (this._budgetState.consecutiveHighTicks > 10 && this._budgetState.orbitEnabled) {
      this._budgetState.orbitEnabled = false; // Disable orbit calculations last
    }

    // Recover features slowly if CPU is resting
    if (this._budgetState.consecutiveLowTicks > 30) {
      if (!this._budgetState.orbitEnabled) this._budgetState.orbitEnabled = true;
      else if (!this._budgetState.maskingEnabled) this._budgetState.maskingEnabled = true;
      else if (!this._budgetState.psychoBassEnabled) this._budgetState.psychoBassEnabled = true;
      this._budgetState.consecutiveLowTicks = 0; // Reset so they stage back slowly
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // V6 Hill-Climbing Optimizer Logic
  // ──────────────────────────────────────────────────────────────────
  
  _applySectionSeed(section, confidence) {
    const baselines = this._baselines;
    const c = confidence;

    if (section === 'CHORUS / DROP') {
      this._targets.eqLowGain = clampSafe('eqLowGain', baselines.eqLowGain + c * 1.0);
      this._targets.widthL = clampSafe('widthL', baselines.widthL + c * 0.08);
      this._targets.widthR = clampSafe('widthR', baselines.widthR + c * 0.08);
      this._targets.reverbMix = clampSafe('reverbMix', baselines.reverbMix - c * 0.02);
    } else if (section === 'INTRO' || section === 'BREAKDOWN') {
      this._targets.eqLowGain = clampSafe('eqLowGain', baselines.eqLowGain - c * 0.5);
      this._targets.reverbMix = clampSafe('reverbMix', baselines.reverbMix + c * 0.05);
      this._targets.widthL = clampSafe('widthL', baselines.widthL);
      this._targets.widthR = clampSafe('widthR', baselines.widthR);
    } else {
      this._targets.eqLowGain = baselines.eqLowGain;
      this._targets.widthL = baselines.widthL;
      this._targets.widthR = baselines.widthR;
      this._targets.reverbMix = baselines.reverbMix;
    }
    this._optimizerState.lastMutation = null; // Clear out mutations on section change
    this._optimizerState.optimizationTimer = performance.now() + 3000; // V7: Allow 3 seconds of search
  }

  _optimizeBraintick(currentScore) {
    const st = this._optimizerState;
    
    // V7: Section-Locked Optimization
    // If the timer has expired, we lock the settings and stop mutating.
    if (performance.now() > st.optimizationTimer) return;
    
    st.tickCounter++;

    // Only mutate every 4 ticks (~600ms) to let audio buffer reflect changes
    if (st.tickCounter % 4 !== 0) return;

    // 1. Evaluate previous mutation
    if (st.lastMutation) {
      if (currentScore >= st.lastScore) {
        // Mutation improved or maintained score -> Keep it!
      } else {
        // Score dropped -> Revert mutation
        this._targets[st.lastMutation.param] = st.lastMutation.previousValue;
        
        // If it was widthL, revert widthR too to maintain symmetry
        if (st.lastMutation.param === 'widthL') {
           this._targets.widthR = st.lastMutation.previousValue;
        }
      }
    }

    // 2. Propose new mutation
    const paramsToMutate = [
      { name: 'eqLowGain', step: 0.2 },
      { name: 'widthL', step: 0.02 },
      { name: 'reverbMix', step: 0.01 },
      { name: 'psychoBassWet', step: 0.01 }
    ];

    const pick = paramsToMutate[Math.floor(Math.random() * paramsToMutate.length)];
    const direction = Math.random() > 0.5 ? 1 : -1;
    const delta = pick.step * direction;
    const prev = this._targets[pick.name];

    // Apply mutation
    let newVal = clampSafe(pick.name, prev + delta);
    this._targets[pick.name] = newVal;
    
    // Maintain stereo symmetry if we mutated width
    if (pick.name === 'widthL') this._targets.widthR = newVal;

    st.lastMutation = { param: pick.name, delta, previousValue: prev };
    st.lastScore = currentScore;
  }

  // ──────────────────────────────────────────────────────────────────
  // Seek & Playback Control (Robustness Fixes)
  // ──────────────────────────────────────────────────────────────────
  play() {
    if (!this.decodedBuffer || this.isPlaying) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    
    const ctx = this.ctx;
    this.source = ctx.createBufferSource();
    this.source.buffer = this.decodedBuffer;

    // V7: Connect to dry analyser
    if (this.dryAnalyser) this.source.connect(this.dryAnalyser);

    if (this.directPlayback) {
      this.source.connect(this.masterGain);
    } else {
      for (const stem of Object.values(this.stems)) this.source.connect(stem.filter);
      if (this._bodyFilter) this.source.connect(this._bodyFilter);
    }

    this.startTime = ctx.currentTime - this.pauseOffset;
    this.source.start(0, this.pauseOffset % this.decodedBuffer.duration);
    this.isPlaying = true;

    // Flush states on play
    this._rmsHistory = [];
    this._sectionHoldTimer = 0;
    this._lastBrainTickTime = 0;
    this._lufsShortTermWindow = [];
    this._lufsMomentaryWindow = [];
    this._fatigueAccumulator = 0;
    this._inTransient = false;
    this._transientDucked = false;

    this.source.onended = () => {
      if (this.isPlaying && (ctx.currentTime - this.startTime) >= this.decodedBuffer.duration) {
        this.isPlaying = false; this.pauseOffset = 0;
        if (this.onEndedCallback) this.onEndedCallback();
      }
    };
  }

  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.pauseOffset = this.ctx.currentTime - this.startTime;
    if (this.source) { this.source.stop(); this.source.disconnect(); this.source = null; }
  }

  seek(percent) {
    if (!this.decodedBuffer) return;
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.pause();
    
    this.pauseOffset = percent * this.decodedBuffer.duration;
    
    // Hard reset all timeline/hysteresis states to prevent drift or logic desync on seek
    this._sectionHoldTimer = 0;
    this._rmsHistory = [];
    this._inTransient = false;
    this._transientDucked = false;
    this._lufsMomentaryWindow = [];
    this._lufsShortTermWindow = [];
    
    // Clear scheduled AudioParam automations to avoid parameter rubber-banding
    if (this.ctx) {
      const t = this.ctx.currentTime;
      const params = [
        this.eqLow.gain, this.eqMid.gain, this.eqHigh.gain, this.eqPresence.gain,
        this.satDry.gain, this.satWet.gain, this.psychoBass?.wetGain.gain,
        this.widener.widthGainL.gain, this.widener.widthGainR.gain,
        this.reverb.dryGain.gain, this.reverb.wetGain.gain, this.masterGain.gain
      ];
      params.forEach(p => {
        if (p) {
          p.cancelScheduledValues(t);
          p.setValueAtTime(p.value, t);
        }
      });
    }
    
    if (wasPlaying) this.play();
  }

  stop() {
    this.isPlaying = false; this.pauseOffset = 0;
    if (this.source) { try { this.source.stop(); } catch (e) {} this.source.disconnect(); this.source = null; }
  }

  setMasterVolume(val) {
    if (!this.masterGain) return;
    this._smoothRamp(this.masterGain.gain, val, 0.05);
  }

  orbitTick() {
    if (!this.orbiting || !this.ctx || !this.isPlaying || !this._budgetState.orbitEnabled) return;
    const t = this.ctx.currentTime;
    const beatPhase = this.getBeatPhase();
    const beatPulse = 0.7 + 0.3 * Math.sin(beatPhase * Math.PI * 2);
    const transientDamp = this._inTransient ? 0.2 : 1.0;

    // Stem failure handling: if stems are mush, orbiting will sound messy. Dampen orbits if confidence is low.
    const confidenceDamp = this.brainReport.stemConfidence < 0.5 ? 0.1 : 1.0;

    for (const [name, stem] of Object.entries(this.stems)) {
      this.orbitAngles[name] += this.orbitSpeeds[name] * transientDamp * confidenceDamp;
      const r = Math.min(this.orbitRadii[name], SAFETY.orbitRadius.max) * beatPulse * confidenceDamp;
      const theta = this.orbitAngles[name];
      const defaultPos = this.defaultPositions[name];

      let x, y, z;
      if (name === 'bass') {
        x = defaultPos.x; y = defaultPos.y; z = defaultPos.z;
      } else if (name === 'vocals') {
        x = defaultPos.x + r * Math.sin(theta) * 0.3; y = defaultPos.y; z = defaultPos.z + r * Math.sin(theta * 2) * 0.15;
      } else if (name === 'melody') {
        x = defaultPos.x + r * Math.cos(theta); y = defaultPos.y + r * 0.15 * Math.sin(theta * 2); z = defaultPos.z + r * 0.5 * Math.sin(theta);
      } else if (name === 'drums') {
        x = defaultPos.x + r * 0.7 * Math.cos(theta); y = defaultPos.y + Math.abs(r * 0.3 * Math.sin(theta)); z = defaultPos.z + r * 0.4 * Math.sin(theta);
      } else {
        x = defaultPos.x + r * Math.cos(theta); z = defaultPos.z + r * Math.sin(theta); y = defaultPos.y;
      }

      stem.panner.positionX.setTargetAtTime(x, t, 0.05);
      stem.panner.positionY.setTargetAtTime(y, t, 0.05);
      stem.panner.positionZ.setTargetAtTime(z, t, 0.05);
      this.currentPositions[name] = { x, y, z };
    }
  }
}
