/**
 * Auralis Audio DSP Engine (Fully Automatic AI Brain)
 * Implements high-end headphone sound enhancements using Web Audio API.
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.decodedBuffer = null;
    
    // Nodes
    this.source = null;
    this.masterGain = null;
    this.analyser = null;
    
    // Virtual Stems Nodes
    this.stems = {
      vocals: { filter: null, gain: null, panner: null, mute: false, baseGain: 1.0 },
      bass: { filter: null, gain: null, panner: null, mute: false, baseGain: 1.0 },
      melody: { filter: null, gain: null, panner: null, mute: false, baseGain: 1.0 },
      drums: { filter: null, gain: null, panner: null, mute: false, baseGain: 1.0 }
    };
    
    // FX Nodes
    this.eqLow = null;
    this.eqMid = null;
    this.eqHigh = null;
    this.saturation = null;
    this.widener = null;
    
    // Crossfeed Nodes
    this.crossfeed = {
      splitter: null,
      directL: null,
      directR: null,
      delayLtoR: null,
      delayRtoL: null,
      filterLtoR: null,
      filterRtoL: null,
      gainLtoR: null,
      gainRtoL: null,
      merger: null,
      active: true,
      amount: 0.3
    };
    
    // Reverb Nodes
    this.reverb = {
      convolver: null,
      dryGain: null,
      wetGain: null,
      mix: 0.15,
      decay: 1.8
    };
    
    // Dynamics Compressor / Limiter
    this.limiter = null;
    
    // Playback state
    this.isPlaying = false;
    this.startTime = 0;
    this.pauseOffset = 0;
    
    // Orbiting State (Auto-controlled)
    this.orbiting = true;
    this.orbitAngles = { vocals: 0, bass: 0, melody: Math.PI, drums: Math.PI * 0.5 };
    this.orbitSpeeds = { vocals: 0.003, bass: 0.001, melody: 0.008, drums: 0.005 };
    this.orbitRadii = { vocals: 3, bass: 1.5, melody: 6, drums: 5 };
    
    this.defaultPositions = {
      vocals: { x: 0, y: 0, z: -3 },     // Front center
      bass: { x: 0, y: -0.5, z: -1.5 },   // Close, centered
      melody: { x: -5, y: 0, z: -2.5 },   // Left
      drums: { x: 5, y: 0, z: -2.5 }      // Right
    };
    
    this.currentPositions = JSON.parse(JSON.stringify(this.defaultPositions));
    
    // Intelligent Brain Results Cache
    this.brainReport = {
      bpm: 120,
      genre: 'Calibrating...',
      mood: 'Analyzing dynamic balance...',
      avgRMS: 0.15,
      crestFactor: 4.0,
      activeSection: 'STANDBY',
      bassBoostDb: 0,
      reverbDecaySec: 1.8,
      stereoWidthCoeff: 1.0,
      crossfeedCoeff: 0.3
    };

    // Callback when brain updates diagnostic states
    this.onDiagnosticCallback = null;

    // True when playing a server-rendered mix (bypass in-browser DSP chain)
    this.directPlayback = false;
  }

  /**
   * Initialize the AudioContext on user interaction
   */
  async init() {
    if (this.ctx) return;
    
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContextClass();
    
    this.setupDSPNodes();
  }

  /**
   * Create DSP routing layout
   */
  setupDSPNodes() {
    const ctx = this.ctx;
    
    // 1. Outputs
    this.masterGain = ctx.createGain();
    this.masterGain.gain.setValueAtTime(1.0, ctx.currentTime);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.75;
    
    // 2. EQ Block
    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 150;
    this.eqLow.gain.value = 0;
    
    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 0.8;
    this.eqMid.gain.value = 0;
    
    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 4000;
    this.eqHigh.gain.value = 0;

    // 3. Saturation Matrix
    this.saturation = ctx.createWaveShaper();
    this.saturation.curve = this.makeSaturationCurve(0);
    this.saturation.oversample = '4x';
    
    this.satDry = ctx.createGain();
    this.satWet = ctx.createGain();
    this.satDry.gain.value = 1.0;
    this.satWet.gain.value = 0.0;

    // 4. Stereo Widener
    this.setupMidSideWidener();

    // 5. Headphone Crossfeed
    this.setupCrossfeed();

    // 6. Convolver Reverb
    this.reverb.convolver = ctx.createConvolver();
    this.reverb.convolver.buffer = this.generateReverbIR(this.reverb.decay);
    this.reverb.dryGain = ctx.createGain();
    this.reverb.wetGain = ctx.createGain();
    
    this.reverb.dryGain.gain.value = 1.0 - this.reverb.mix;
    this.reverb.wetGain.gain.value = this.reverb.mix;

    // 7. Peak Limiter
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.setValueAtTime(-1.0, ctx.currentTime);
    this.limiter.knee.setValueAtTime(4.0, ctx.currentTime);
    this.limiter.ratio.setValueAtTime(12.0, ctx.currentTime);
    this.limiter.attack.setValueAtTime(0.003, ctx.currentTime);
    this.limiter.release.setValueAtTime(0.08, ctx.currentTime);

    // 8. Connect DSP components
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    
    this.eqHigh.connect(this.satDry);
    this.eqHigh.connect(this.saturation);
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

    // 9. Set Up Stem Nodes
    this.setupStems();
  }

  setupStems() {
    const ctx = this.ctx;
    for (const [name, stem] of Object.entries(this.stems)) {
      stem.filter = ctx.createBiquadFilter();
      if (name === 'bass') {
        stem.filter.type = 'lowpass';
        stem.filter.frequency.value = 150;
      } else if (name === 'vocals') {
        stem.filter.type = 'bandpass';
        stem.filter.frequency.value = 1100;
        stem.filter.Q.value = 0.55;
      } else if (name === 'melody') {
        stem.filter.type = 'bandpass';
        stem.filter.frequency.value = 1800;
        stem.filter.Q.value = 0.35;
      } else if (name === 'drums') {
        stem.filter.type = 'highpass';
        stem.filter.frequency.value = 3500;
      }
      
      stem.gain = ctx.createGain();
      stem.gain.gain.value = stem.baseGain;
      
      stem.panner = ctx.createPanner();
      stem.panner.panningModel = 'HRTF';
      stem.panner.distanceModel = 'inverse';
      stem.panner.refDistance = 1;
      
      const pos = this.defaultPositions[name];
      stem.panner.positionX.setValueAtTime(pos.x, ctx.currentTime);
      stem.panner.positionY.setValueAtTime(pos.y, ctx.currentTime);
      stem.panner.positionZ.setValueAtTime(pos.z, ctx.currentTime);
      
      stem.filter.connect(stem.gain);
      stem.gain.connect(stem.panner);
      stem.panner.connect(this.eqLow);
    }
  }

  setupMidSideWidener() {
    const ctx = this.ctx;
    this.widener = {
      input: ctx.createGain(),
      output: ctx.createGain(),
      splitter: ctx.createChannelSplitter(2),
      merger: ctx.createChannelMerger(2),
      midSum: ctx.createGain(),
      midToL: ctx.createGain(),
      midToR: ctx.createGain(),
      sideDiff: ctx.createGain(),
      invertR: ctx.createGain(),
      sideToL: ctx.createGain(),
      sideToR: ctx.createGain(),
      widthGainL: ctx.createGain(),
      widthGainR: ctx.createGain(),
      width: 1.0
    };
    
    const w = this.widener;
    w.midSum.gain.value = 0.5;
    w.sideDiff.gain.value = 0.5;
    w.invertR.gain.value = -1.0;
    
    w.midToL.gain.value = 1.0;
    w.midToR.gain.value = 1.0;
    w.sideToL.gain.value = 1.0;
    w.sideToR.gain.value = -1.0;
    
    w.input.connect(w.splitter);
    
    w.splitter.connect(w.midSum, 0);
    w.splitter.connect(w.midSum, 1);
    
    w.splitter.connect(w.sideDiff, 0);
    w.splitter.connect(w.invertR, 1);
    w.invertR.connect(w.sideDiff);
    
    w.widthGainL.gain.value = w.width;
    w.widthGainR.gain.value = w.width;
    
    w.sideDiff.connect(w.widthGainL);
    w.sideDiff.connect(w.widthGainR);
    
    w.midSum.connect(w.midToL);
    w.widthGainL.connect(w.sideToL);
    const sumL = ctx.createGain();
    w.midToL.connect(sumL);
    w.sideToL.connect(sumL);
    sumL.connect(w.merger, 0, 0);
    
    w.midSum.connect(w.midToR);
    w.widthGainR.connect(w.sideToR);
    const sumR = ctx.createGain();
    w.midToR.connect(sumR);
    w.sideToR.connect(sumR);
    sumR.connect(w.merger, 0, 1);
    
    w.merger.connect(w.output);
  }

  setupCrossfeed() {
    const ctx = this.ctx;
    const c = this.crossfeed;
    
    c.input = ctx.createGain();
    c.output = ctx.createGain();
    
    c.splitter = ctx.createChannelSplitter(2);
    c.merger = ctx.createChannelMerger(2);
    
    c.directL = ctx.createGain();
    c.directR = ctx.createGain();
    
    c.delayLtoR = ctx.createDelay(0.01);
    c.delayRtoL = ctx.createDelay(0.01);
    
    c.filterLtoR = ctx.createBiquadFilter();
    c.filterRtoL = ctx.createBiquadFilter();
    
    c.gainLtoR = ctx.createGain();
    c.gainRtoL = ctx.createGain();
    
    c.delayLtoR.delayTime.value = 0.0003;
    c.delayRtoL.delayTime.value = 0.0003;
    
    c.filterLtoR.type = 'lowpass';
    c.filterLtoR.frequency.value = 700;
    c.filterRtoL.type = 'lowpass';
    c.filterRtoL.frequency.value = 700;
    
    this.updateCrossfeedGains();
    
    c.input.connect(c.splitter);
    
    c.splitter.connect(c.directL, 0);
    c.splitter.connect(c.directR, 1);
    
    c.directL.connect(c.merger, 0, 0);
    c.directR.connect(c.merger, 0, 1);
    
    c.splitter.connect(c.delayLtoR, 0);
    c.delayLtoR.connect(c.filterLtoR);
    c.filterLtoR.connect(c.gainLtoR);
    c.gainLtoR.connect(c.merger, 0, 1);
    
    c.splitter.connect(c.delayRtoL, 1);
    c.delayRtoL.connect(c.filterRtoL);
    c.filterRtoL.connect(c.gainRtoL);
    c.gainRtoL.connect(c.merger, 0, 0);
    
    c.merger.connect(c.output);
  }

  updateCrossfeedGains() {
    if (!this.ctx) return;
    const c = this.crossfeed;
    const t = this.ctx.currentTime;
    
    if (!c.active) {
      c.directL.gain.setValueAtTime(1.0, t);
      c.directR.gain.setValueAtTime(1.0, t);
      c.gainLtoR.gain.setValueAtTime(0.0, t);
      c.gainRtoL.gain.setValueAtTime(0.0, t);
      return;
    }
    
    const amount = c.amount;
    const directGain = 1.0 - (amount * 0.15);
    const crossGain = amount * 0.35;
    
    c.directL.gain.setValueAtTime(directGain, t);
    c.directR.gain.setValueAtTime(directGain, t);
    c.gainLtoR.gain.setValueAtTime(crossGain, t);
    c.gainRtoL.gain.setValueAtTime(crossGain, t);
  }

  generateReverbIR(decaySec) {
    const sampleRate = this.ctx ? this.ctx.sampleRate : 44100;
    const duration = decaySec;
    const length = sampleRate * duration;
    
    const tempBufferCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = tempBufferCtx.createBuffer(2, length, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    
    for (let i = 0; i < length; i++) {
      const time = i / sampleRate;
      const envelope = Math.exp(-time * (6 / decaySec));
      left[i] = (Math.random() * 2 - 1) * envelope;
      right[i] = (Math.random() * 2 - 1) * envelope;
    }
    tempBufferCtx.close();
    return buffer;
  }

  makeSaturationCurve(amount) {
    const n_samples = 44100;
    const curve = new Float32Array(n_samples);
    for (let i = 0; i < n_samples; ++i) {
      const x = (i * 2) / n_samples - 1;
      if (amount === 0) {
        curve[i] = x;
      } else {
        const k = amount / 10;
        curve[i] = Math.tanh(x * (1 + k)) / Math.tanh(1 + k);
      }
    }
    return curve;
  }

  /**
   * Load a server-rendered WAV and bypass the in-browser pseudo-stem DSP chain.
   */
  async loadProcessedAudio(arrayBuffer, report = {}) {
    await this.init();

    const buffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    this.decodedBuffer = buffer;
    this.directPlayback = true;
    this.orbiting = false;

    this.brainReport = {
      ...this.brainReport,
      bpm: report.bpm ?? this.brainReport.bpm,
      genre: report.genre ?? 'Server Rendered',
      mood: report.mood ?? 'Pipeline Mix',
      profile: report.profile ?? 'audiophile',
      activeSection: 'RENDERED',
      bassBoostDb: 0,
      reverbDecaySec: 0,
      stereoWidthCoeff: this._profileWidthHint(report.profile),
      crossfeedCoeff: 0,
    };

    return buffer;
  }

  _profileWidthHint(profile) {
    const widths = {
      zenith: 1.85,
      hyper_immersive: 1.55,
      concert: 1.35,
      cinema: 1.45,
      audiophile: 1.1,
      basshead: 0.85,
    };
    return widths[profile] ?? 1.0;
  }

  /**
   * Tap master analyser for live RMS + spectral energy (directPlayback safe).
   */
  getLiveMetrics() {
    if (!this.analyser) {
      return { rms: 0, bass: 0, treble: 0, peak: 0 };
    }

    const timeData = new Uint8Array(this.analyser.fftSize);
    const freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(timeData);
    this.analyser.getByteFrequencyData(freqData);

    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < timeData.length; i++) {
      const sample = (timeData[i] - 128) / 128;
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
      sumSq += sample * sample;
    }
    const rms = Math.sqrt(sumSq / timeData.length);

    const binCount = freqData.length;
    const bassEnd = Math.max(1, Math.floor(binCount * 0.12));
    const trebleStart = Math.floor(binCount * 0.55);
    let bassSum = 0;
    let trebleSum = 0;
    for (let i = 0; i < binCount; i++) {
      if (i < bassEnd) bassSum += freqData[i];
      else if (i >= trebleStart) trebleSum += freqData[i];
    }

    return {
      rms,
      peak,
      bass: bassSum / bassEnd / 255,
      treble: trebleSum / (binCount - trebleStart) / 255,
    };
  }

  getBeatPhase() {
    const bpm = this.brainReport?.bpm || 120;
    if (!this.ctx) return 0;
    const beatHz = bpm / 60;
    const t = this.isPlaying
      ? this.ctx.currentTime - this.startTime
      : this.pauseOffset;
    return (t * beatHz) % 1;
  }

  /**
   * Load audio file, analyze it, and cache the buffer
   */
  async loadAudioFile(file) {
    this.directPlayback = false;
    this.orbiting = true;
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
        } catch (err) {
          reject(new Error('Web Audio decoding error: ' + (err.message || err)));
        }
      };
      
      reader.onerror = (err) => reject(err);
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Run the Intelligent Analyzer to classify BPM, Genre, Mood, and Dynamic thresholds
   */
  runBrainAnalyzer(buffer) {
    const data = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    const length = data.length;
    
    // 1. BPM DETECTOR (Autocorrelation peak picker over a 20s chunk)
    let bpm = 120;
    try {
      const duration = buffer.duration;
      const startOffset = Math.max(0, Math.floor(duration * 0.2) * sampleRate);
      const endOffset = Math.min(length, startOffset + 20 * sampleRate);
      const winSize = Math.floor(sampleRate / 100); // 10ms bins
      
      const envelope = [];
      let sum = 0;
      for (let i = startOffset; i < endOffset; i += winSize) {
        let maxVal = 0;
        const limit = Math.min(endOffset, i + winSize);
        for (let j = i; j < limit; j++) {
          const absVal = Math.abs(data[j]);
          if (absVal > maxVal) maxVal = absVal;
        }
        envelope.push(maxVal);
        sum += maxVal;
      }
      
      const avg = sum / envelope.length;
      const threshold = Math.max(0.12, avg * 1.4);
      
      const peakIndices = [];
      for (let i = 1; i < envelope.length - 1; i++) {
        if (envelope[i] > threshold && envelope[i] > envelope[i - 1] && envelope[i] > envelope[i + 1]) {
          peakIndices.push(i);
        }
      }
      
      if (peakIndices.length >= 2) {
        const intervals = {};
        for (let i = 1; i < peakIndices.length; i++) {
          const diff = peakIndices[i] - peakIndices[i - 1];
          if (diff >= 30 && diff <= 110) {
            const bin = Math.round(diff / 2) * 2;
            intervals[bin] = (intervals[bin] || 0) + 1;
          }
        }
        
        let maxCount = 0;
        let bestInterval = 50;
        for (const [interval, count] of Object.entries(intervals)) {
          if (count > maxCount) {
            maxCount = count;
            bestInterval = parseInt(interval);
          }
        }
        bpm = Math.round(6000 / bestInterval);
        if (bpm < 60) bpm *= 2;
        if (bpm > 180) bpm /= 2;
      }
    } catch (e) {
      console.warn("BPM Engine failed, falling back to 120", e);
    }
    
    // 2. GENRE AND MOOD CLASSIFIER (Spectral Energy Ratio analysis)
    let genre = "Balanced Pop";
    let mood = "Warm & Calibrated";
    let totalSq = 0;
    let bassSq = 0;
    let highSq = 0;
    let peak = 0;
    
    const testPoints = 12000;
    const step = Math.floor(length / testPoints);
    let lp = 0;
    let hp = 0;
    const lpAlpha = 0.02; // cutoff ~150Hz
    const hpAlpha = 0.45; // cutoff ~5000Hz
    
    for (let i = 0; i < length; i += step) {
      const x = data[i];
      const absVal = Math.abs(x);
      if (absVal > peak) peak = absVal;
      
      totalSq += x * x;
      
      lp = lp + lpAlpha * (x - lp);
      bassSq += lp * lp;
      
      hp = hpAlpha * (hp + x - (i > 0 ? data[i - step] : 0));
      highSq += hp * hp;
    }
    
    const rms = Math.sqrt(totalSq / testPoints);
    const bassRms = Math.sqrt(bassSq / testPoints);
    const highRms = Math.sqrt(highSq / testPoints);
    const crestFactor = rms > 0 ? peak / rms : 4.0;
    
    if (crestFactor > 5.2) {
      genre = "Classical / Acoustic";
      mood = "Pure Dynamic Range";
    } else if (bassRms / rms > 0.78) {
      genre = "Electronic / Dance";
      mood = "Heavy Sub Bass";
    } else if (highRms / rms > 0.38) {
      genre = "Rock / High-Energy";
      mood = "Bright & Dynamic";
    } else if (bassRms / rms < 0.42 && highRms / rms < 0.12) {
      genre = "Acoustic / Vocal";
      mood = "Intimate Centered";
    } else {
      genre = "Pop / Balanced";
      mood = "Warm Harmonized";
    }
    
    // Apply automatic baseline configurations based on genre
    this.brainReport.bpm = bpm;
    this.brainReport.genre = genre;
    this.brainReport.mood = mood;
    this.brainReport.avgRMS = rms;
    this.brainReport.crestFactor = crestFactor;
    
    // Configure default spatial orbiting speeds based on BPM
    const bps = bpm / 60; // beats per second
    this.orbitSpeeds.melody = (bps * 2 * Math.PI) / 800; // Orbit speed synced to beat
    this.orbitSpeeds.drums = (bps * 2 * Math.PI) / 600;
    this.orbitSpeeds.vocals = (bps * 2 * Math.PI) / 1200;
    
    // Apply baseline DSP presets
    this.applyAutomaticBaseline(genre);
  }

  applyAutomaticBaseline(genre) {
    const t = this.ctx.currentTime;
    
    if (genre.includes("Electronic")) {
      this.eqLow.gain.setValueAtTime(3.5, t);
      this.eqMid.gain.setValueAtTime(-1.0, t);
      this.eqHigh.gain.setValueAtTime(1.0, t);
      
      this.satDry.gain.setValueAtTime(0.85, t);
      this.satWet.gain.setValueAtTime(0.15, t); // Mild tube saturation
      this.saturation.curve = this.makeSaturationCurve(15);
      
      this.widener.widthGainL.gain.setValueAtTime(1.25, t);
      this.widener.widthGainR.gain.setValueAtTime(1.25, t);
      
      this.crossfeed.amount = 0.25;
      this.reverb.mix = 0.12;
      this.reverb.decay = 1.4;
    } else if (genre.includes("Rock")) {
      this.eqLow.gain.setValueAtTime(2.0, t);
      this.eqMid.gain.setValueAtTime(1.0, t);
      this.eqHigh.gain.setValueAtTime(2.0, t);
      
      this.satDry.gain.setValueAtTime(0.75, t);
      this.satWet.gain.setValueAtTime(0.25, t); // High warm harmonics
      this.saturation.curve = this.makeSaturationCurve(25);
      
      this.widener.widthGainL.gain.setValueAtTime(1.15, t);
      this.widener.widthGainR.gain.setValueAtTime(1.15, t);
      
      this.crossfeed.amount = 0.35;
      this.reverb.mix = 0.10;
      this.reverb.decay = 1.2;
    } else if (genre.includes("Classical")) {
      this.eqLow.gain.setValueAtTime(0.5, t);
      this.eqMid.gain.setValueAtTime(0.5, t);
      this.eqHigh.gain.setValueAtTime(1.5, t);
      
      this.satDry.gain.setValueAtTime(1.0, t);
      this.satWet.gain.setValueAtTime(0.0, t); // Zero saturation distortion
      
      this.widener.widthGainL.gain.setValueAtTime(1.4, t); // Wide acoustic field
      this.widener.widthGainR.gain.setValueAtTime(1.4, t);
      
      this.crossfeed.amount = 0.45;
      this.reverb.mix = 0.25; // Rich hall reverb
      this.reverb.decay = 2.6;
    } else if (genre.includes("Acoustic")) {
      this.eqLow.gain.setValueAtTime(-1.0, t);
      this.eqMid.gain.setValueAtTime(3.0, t); // Vocal presence boost
      this.eqHigh.gain.setValueAtTime(1.0, t);
      
      this.satDry.gain.setValueAtTime(0.95, t);
      this.satWet.gain.setValueAtTime(0.05, t);
      this.saturation.curve = this.makeSaturationCurve(5);
      
      this.widener.widthGainL.gain.setValueAtTime(0.9, t); // Focus voice center
      this.widener.widthGainR.gain.setValueAtTime(0.9, t);
      
      this.crossfeed.amount = 0.50; // Max crossfeed for comfort
      this.reverb.mix = 0.08;
      this.reverb.decay = 1.0;
    } else {
      // Pop / Balanced
      this.eqLow.gain.setValueAtTime(2.0, t);
      this.eqMid.gain.setValueAtTime(0.5, t);
      this.eqHigh.gain.setValueAtTime(1.5, t);
      
      this.satDry.gain.setValueAtTime(0.9, t);
      this.satWet.gain.setValueAtTime(0.1, t);
      this.saturation.curve = this.makeSaturationCurve(10);
      
      this.widener.widthGainL.gain.setValueAtTime(1.15, t);
      this.widener.widthGainR.gain.setValueAtTime(1.15, t);
      
      this.crossfeed.amount = 0.3;
      this.reverb.mix = 0.15;
      this.reverb.decay = 1.8;
    }
    
    // Apply changes
    this.updateCrossfeedGains();
    this.reverb.convolver.buffer = this.generateReverbIR(this.reverb.decay);
    this.reverb.dryGain.gain.setValueAtTime(1.0 - this.reverb.mix, t);
    this.reverb.wetGain.gain.setValueAtTime(this.reverb.mix, t);
  }

  /**
   * Monitor running audio features and automatically alter settings in real-time
   */
  processAutomaticBraintick() {
    if (!this.ctx || !this.isPlaying || !this.decodedBuffer) return;
    
    const t = this.ctx.currentTime;
    
    // 1. Get live time-domain values to calculate current RMS energy
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteTimeDomainData(dataArray);
    
    let sumSquares = 0;
    for (let i = 0; i < bufferLength; i++) {
      const normalized = (dataArray[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const currentRMS = Math.sqrt(sumSquares / bufferLength);
    
    // 2. Identify Dynamic Section (Intro/Drop/Outro)
    const baseRMS = this.brainReport.avgRMS;
    let section = 'VERSE';
    
    // Section thresholds
    if (currentRMS > baseRMS * 1.35) {
      section = 'CHORUS / DROP';
    } else if (currentRMS < baseRMS * 0.5 && (this.ctx.currentTime - this.startTime) < 25) {
      section = 'INTRO';
    } else if (currentRMS < baseRMS * 0.5 && (this.ctx.currentTime - this.startTime) > this.decodedBuffer.duration - 25) {
      section = 'OUTRO';
    }
    
    this.brainReport.activeSection = section;
    
    // 3. Dynamic Auto-DSP Modifications based on active section (Kinetic Engine)
    if (section === 'CHORUS / DROP') {
      // Dynamic Chorus Lift / Drop Enhancement
      // Boost bass by extra +2dB
      this.eqLow.gain.setValueAtTime(Math.min(10, this.eqLow.gain.value + 0.1), t);
      // Widen soundstage on drops
      const currentWidth = this.widener.widthGainL.gain.value;
      const targetWidth = Math.min(1.5, currentWidth + 0.05);
      this.widener.widthGainL.gain.setValueAtTime(targetWidth, t);
      this.widener.widthGainR.gain.setValueAtTime(targetWidth, t);
      // Slight increase in saturation warmth
      this.satWet.gain.setValueAtTime(Math.min(0.35, this.satWet.gain.value + 0.02), t);
      
      // Speed up orbiting orbits on peak energy
      this.orbitRadii.melody = 7.0; // wider orbit
      this.orbitRadii.drums = 6.0;
    } else if (section === 'INTRO') {
      // Clean, spatial, quiet intro
      this.eqLow.gain.setValueAtTime(Math.max(-2, this.eqLow.gain.value - 0.1), t);
      // Normal widening
      this.widener.widthGainL.gain.setValueAtTime(1.1, t);
      this.widener.widthGainR.gain.setValueAtTime(1.1, t);
      // Quiet decay
      this.satWet.gain.setValueAtTime(Math.max(0.0, this.satWet.gain.value - 0.02), t);
    } else if (section === 'OUTRO') {
      // Clean spatial fade out
      this.widener.widthGainL.gain.setValueAtTime(Math.max(1.0, this.widener.widthGainL.gain.value - 0.02), t);
      this.widener.widthGainR.gain.setValueAtTime(Math.max(1.0, this.widener.widthGainR.gain.value - 0.02), t);
      this.eqLow.gain.setValueAtTime(Math.max(-2, this.eqLow.gain.value - 0.2), t);
    } else {
      // VERSE (gradually ease back to baseline)
      this.applyAutomaticBaseline(this.brainReport.genre);
    }
    
    // Save report data for UI matching
    this.brainReport.bassBoostDb = Math.round(this.eqLow.gain.value * 10) / 10;
    this.brainReport.reverbDecaySec = this.reverb.decay;
    this.brainReport.stereoWidthCoeff = Math.round(this.widener.widthGainL.gain.value * 100) / 100;
    this.brainReport.crossfeedCoeff = Math.round(this.crossfeed.amount * 100) / 100;
    
    // Push updates to UI
    if (this.onDiagnosticCallback) {
      this.onDiagnosticCallback(this.brainReport, currentRMS);
    }
  }

  /**
   * Playback
   */
  play() {
    if (!this.decodedBuffer || this.isPlaying) return;
    
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    
    const ctx = this.ctx;
    this.source = ctx.createBufferSource();
    this.source.buffer = this.decodedBuffer;
    
    if (this.directPlayback) {
      this.source.connect(this.masterGain);
    } else {
      for (const stem of Object.values(this.stems)) {
        this.source.connect(stem.filter);
      }
    }
    
    this.startTime = ctx.currentTime - this.pauseOffset;
    this.source.start(0, this.pauseOffset % this.decodedBuffer.duration);
    this.isPlaying = true;
    
    this.source.onended = () => {
      if (this.isPlaying && (ctx.currentTime - this.startTime) >= this.decodedBuffer.duration) {
        this.isPlaying = false;
        this.pauseOffset = 0;
        if (this.onEndedCallback) this.onEndedCallback();
      }
    };
  }

  pause() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    this.pauseOffset = this.ctx.currentTime - this.startTime;
    
    if (this.source) {
      this.source.stop();
      this.source.disconnect();
      this.source = null;
    }
  }

  seek(percent) {
    if (!this.decodedBuffer) return;
    const wasPlaying = this.isPlaying;
    if (wasPlaying) {
      this.pause();
    }
    this.pauseOffset = percent * this.decodedBuffer.duration;
    if (wasPlaying) {
      this.play();
    }
  }

  stop() {
    this.isPlaying = false;
    this.pauseOffset = 0;
    if (this.source) {
      try {
        this.source.stop();
      } catch (e) {}
      this.source.disconnect();
      this.source = null;
    }
  }

  setMasterVolume(val) {
    if (!this.masterGain) return;
    this.masterGain.gain.setValueAtTime(val, this.ctx.currentTime);
  }

  /**
   * Continuous spatial orbiting ticker loop
   */
  orbitTick() {
    if (!this.orbiting || !this.ctx || !this.isPlaying) return;
    
    const t = this.ctx.currentTime;
    
    for (const [name, stem] of Object.entries(this.stems)) {
      this.orbitAngles[name] += this.orbitSpeeds[name];
      
      const r = this.orbitRadii[name];
      const theta = this.orbitAngles[name];
      
      const x = r * Math.cos(theta);
      const z = r * Math.sin(theta);
      
      stem.panner.positionX.setValueAtTime(x, t);
      stem.panner.positionZ.setValueAtTime(z, t);
      
      this.currentPositions[name].x = x;
      this.currentPositions[name].z = z;
    }
  }
}
