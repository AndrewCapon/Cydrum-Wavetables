// Wavetable AudioWorkletProcessor
// Multi-voice wavetable synthesis with frame interpolation, scanning, and ADSR envelopes

class WavetableProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Frame data (Float32Array from SharedArrayBuffer)
    this.frameData = null;
    this.numFrames = 256;
    this.frameLen = 2048;
    this.wtSampleRate = 44100; // Original wavetable sample rate
    // this.sampleRate is provided by AudioWorkletProcessor (available in process())

    // Playback parameters
    this.frameRange = { start: 0, end: 255 };
    this.direction = 'forward';      // 'forward', 'backward', 'forward-backward', 'backward-forward'
    this.scanSpeed = 1.0;            // frames per second multiplier (relative to base scan rate)
    this.interpolation = true;       // Cross-fade between frames
    this.loop = true;                // Loop playback

    // Voice management (max 32 voices)
    this.maxVoices = 32;
    this.voices = new Array(this.maxVoices).fill(null).map(() => this.createVoice());

    // Message port handler
    this.port.onmessage = this.handleMessage.bind(this);
  }

  createVoice() {
    return {
      active: false,
      note: 0,
      frequency: 0,
      phase: 0,
      phaseIncrement: 0,
      scanPosition: 0,
      scanDirection: 1,  // +1 or -1
      velocity: 1.0,
      envelope: {
        state: 'idle',   // 'idle', 'attack', 'decay', 'sustain', 'release'
        level: 0,
        attack: 0.01,    // seconds
        decay: 0.1,      // seconds
        sustain: 0.7,    // level (0-1)
        release: 0.3     // seconds
      }
    };
  }

  handleMessage(event) {
    const { type, ...data } = event.data;
    switch (type) {
      case 'loadFrames':
        this.loadFrames(data);
        break;
      case 'setParams':
        this.setParams(data);
        break;
      case 'noteOn':
        console.log(`noteOn: note=${data.note}, velocity=${data.velocity}`);
        this.allocateVoice(data.note, data.velocity);
        break;
      case 'noteOff':
        this.releaseVoice(data.note);
        break;
      case 'setMaxVoices':
        this.maxVoices = Math.max(1, Math.min(32, data.maxVoices));
        break;
      case 'stopAll':
        this.stopAllVoices();
        break;
    }
  }

  loadFrames(data) {
    // frameData is a Float32Array backed by SharedArrayBuffer
    this.frameData = data.frameData;
    this.numFrames = data.numFrames;
    this.frameLen = data.frameLen;
    this.wtSampleRate = data.sampleRate;
    this.frameRange = data.frameRange;
    this.direction = data.direction;
    this.scanSpeed = data.scanSpeed;
    this.interpolation = data.interpolation;
    this.loop = data.loop;

    console.log(`loadFrames: numFrames=${this.numFrames}, frameLen=${this.frameLen}, wtSampleRate=${this.wtSampleRate}, range=${this.frameRange.start}-${this.frameRange.end}, speed=${this.scanSpeed}`);

    // Reset all voices when new frames loaded
    for (const voice of this.voices) {
      voice.active = false;
      voice.envelope.state = 'idle';
      voice.envelope.level = 0;
    }
  }

  setParams(data) {
    if (data.frameRange !== undefined) this.frameRange = data.frameRange;
    if (data.direction !== undefined) this.direction = data.direction;
    if (data.scanSpeed !== undefined) this.scanSpeed = data.scanSpeed;
    if (data.interpolation !== undefined) this.interpolation = data.interpolation;
    if (data.loop !== undefined) this.loop = data.loop;

    // Update scan direction for active voices based on new direction
    if (data.direction !== undefined) {
      for (const voice of this.voices) {
        if (voice.active) {
          voice.scanDirection = this.getInitialScanDirection();
        }
      }
    }
  }

  allocateVoice(note, velocity) {
    // Find free voice
    let voiceIdx = this.voices.findIndex(v => !v.active);

    if (voiceIdx === -1) {
      // Voice stealing: find oldest voice in sustain/release
      let oldestIdx = -1;
      let oldestTime = Infinity;

      for (let i = 0; i < this.maxVoices; i++) {
        const voice = this.voices[i];
        if (voice.active && (voice.envelope.state === 'sustain' || voice.envelope.state === 'release')) {
          // Simple heuristic: steal voice with lowest envelope level (closest to release)
          if (voice.envelope.level < oldestTime) {
            oldestTime = voice.envelope.level;
            oldestIdx = i;
          }
        }
      }

      if (oldestIdx !== -1) {
        voiceIdx = oldestIdx;
        this.voices[voiceIdx].active = false;
      } else {
        // All voices in attack/decay - steal the first active one
        voiceIdx = this.voices.findIndex(v => v.active);
        if (voiceIdx !== -1) {
          this.voices[voiceIdx].active = false;
        }
      }
    }

    if (voiceIdx === -1) return; // No voices available

    const voice = this.voices[voiceIdx];
    voice.active = true;
    voice.note = note;
    voice.frequency = 440 * Math.pow(2, (note - 69) / 12);
    // Phase increment: phase goes 0→1 over one period (one cycle)
    // At AUDIO sample rate: phaseInc = frequency / sampleRate
    // sampleRate may not be available yet (set in first process() call), use fallback
    const sr = this.getSampleRate();
    voice.phaseIncrement = voice.frequency / sr;
    voice.phase = 0;
    voice.scanPosition = this.frameRange.start;
    voice.scanDirection = this.getInitialScanDirection();
    voice.velocity = velocity;
    voice.envelope = {
      state: 'attack',
      level: 0,
      attack: 0.01,
      decay: 0.1,
      sustain: 0.7,
      release: 0.3
    };
    console.log(`allocateVoice: voice=${voiceIdx}, note=${note}, freq=${voice.frequency.toFixed(2)}, phaseInc=${voice.phaseIncrement.toFixed(6)}, sampleRate=${sr}`);
  }

  getSampleRate() {
    // sampleRate is available in process(), but message handlers may run before first process()
    // Use inherited property if available, else fallback to 48000 (common audio context rate)
    return this.sampleRate || 48000;
  }

  releaseVoice(note) {
    for (const voice of this.voices) {
      if (voice.active && voice.note === note) {
        voice.active = false;
        voice.envelope.state = 'idle';
        voice.envelope.level = 0;
      }
    }
  }

  stopAllVoices() {
    for (const voice of this.voices) {
      if (voice.active) {
        voice.active = false;
        voice.envelope.state = 'idle';
        voice.envelope.level = 0;
      }
    }
  }

  getInitialScanDirection() {
    switch (this.direction) {
      case 'forward': return 1;
      case 'backward': return -1;
      case 'forward-backward': return 1;
      case 'backward-forward': return -1;
      default: return 1;
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    const outL = output[0];
    const outR = output[1] || outL;
    const blockSize = outL.length;

    // Clear output
    outL.fill(0);
    if (outR !== outL) outR.fill(0);

    // No frame data loaded yet
    if (!this.frameData) {
      return true;
    }

    // Debug: log once when first processing
    if (!this._loggedOnce) {
      console.log(`AudioWorklet: sampleRate=${this.sampleRate}, frameLen=${this.frameLen}, frames=${this.numFrames}, range=${this.frameRange.start}-${this.frameRange.end}`);
      this._loggedOnce = true;
    }

    // Process each active voice
    for (const voice of this.voices) {
      if (!voice.active) continue;

      // Update envelope
      this.updateEnvelope(voice, blockSize);
      if (voice.envelope.state === 'idle') {
        voice.active = false;
        continue;
      }

      // Process block for this voice
      for (let i = 0; i < blockSize; i++) {
        // Calculate frame position and sample within frame
        const framePos = voice.scanPosition;
        const frameIdx = Math.floor(framePos);
        const frameFrac = framePos - frameIdx;

        // Get frame data pointers (clamped to valid range)
        const frameAIdx = this.clampFrameIndex(frameIdx);
        const frameBIdx = this.clampFrameIndex(this.getNextFrameIndex(frameIdx, voice.scanDirection));
        const frameA = this.getFrameData(frameAIdx);
        const frameB = this.getFrameData(frameBIdx);

        // Sample within frame using phase
        const samplePos = voice.phase * this.frameLen;
        const sampleIdx = Math.floor(samplePos);
        const sampleFrac = samplePos - sampleIdx;

        // Interpolate within frame (linear interpolation between adjacent samples)
        let sampleA, sampleB;
        if (this.interpolation && sampleIdx < this.frameLen - 1) {
          sampleA = frameA[sampleIdx] * (1 - sampleFrac) + frameA[sampleIdx + 1] * sampleFrac;
          sampleB = frameB[sampleIdx] * (1 - sampleFrac) + frameB[sampleIdx + 1] * sampleFrac;
        } else {
          sampleA = frameA[Math.min(sampleIdx, this.frameLen - 1)];
          sampleB = frameB[Math.min(sampleIdx, this.frameLen - 1)];
        }

        // Interpolate between frames (cross-fade)
        let sample = this.interpolation
          ? sampleA * (1 - frameFrac) + sampleB * frameFrac
          : sampleA;

        // Apply envelope and velocity
        sample *= voice.envelope.level * voice.velocity;

        // Add to output (sum all voices)
        outL[i] += sample;
        if (outR !== outL) outR[i] += sample;

        // Advance phase
        voice.phase += voice.phaseIncrement;

        // Advance scan position PER AUDIO SAMPLE (not just on phase wrap)
        // scanSpeed = "full scans per second" (1.0 = one full scan per second)
        // framesPerSecond = number of frames in range * scanSpeed
        // scanInc per audio sample = framesPerSecond / sampleRate
        const sr = this.getSampleRate();
        const framesPerSecond = (this.frameRange.end - this.frameRange.start + 1) * this.scanSpeed;
        const scanInc = framesPerSecond / sr;
        voice.scanPosition += voice.scanDirection * scanInc;
        this.handleScanBoundaries(voice);

        // Handle phase wrap for sampling within frame
        if (voice.phase >= 1.0) {
          voice.phase -= 1.0;
        }
      }
    }

    return true;
  }

  clampFrameIndex(idx) {
    const { start, end } = this.frameRange;
    return Math.max(start, Math.min(end, idx));
  }

  getNextFrameIndex(idx, direction) {
    const { start, end } = this.frameRange;
    const next = idx + direction;
    if (direction > 0) {
      return next > end ? (this.loop ? start : end) : next;
    } else {
      return next < start ? (this.loop ? end : start) : next;
    }
  }

  handleScanBoundaries(voice) {
    const { start, end } = this.frameRange;
    const hitEnd = voice.scanDirection > 0 && voice.scanPosition > end;
    const hitStart = voice.scanDirection < 0 && voice.scanPosition < start;

    if (hitEnd || hitStart) {
      switch (this.direction) {
        case 'forward':
          if (this.loop) {
            voice.scanPosition = start;
          } else {
            voice.envelope.state = 'release';
            voice.scanPosition = end;
          }
          break;
        case 'backward':
          if (this.loop) {
            voice.scanPosition = end;
          } else {
            voice.envelope.state = 'release';
            voice.scanPosition = start;
          }
          break;
        case 'forward-backward':
          voice.scanDirection *= -1;
          voice.scanPosition = hitEnd ? end : start;
          break;
        case 'backward-forward':
          voice.scanDirection *= -1;
          voice.scanPosition = hitStart ? start : end;
          break;
      }
    }
  }

  getFrameData(frameIdx) {
    const offset = frameIdx * this.frameLen;
    return this.frameData.subarray(offset, offset + this.frameLen);
  }

  updateEnvelope(voice, blockSize) {
    const env = voice.envelope;
    const sr = this.getSampleRate();

    switch (env.state) {
      case 'attack':
        env.level += blockSize / (env.attack * sr);
        if (env.level >= 1.0) {
          env.level = 1.0;
          env.state = 'decay';
        }
        break;
      case 'decay':
        env.level -= blockSize * (1.0 - env.sustain) / (env.decay * sr);
        if (env.level <= env.sustain) {
          env.level = env.sustain;
          env.state = 'sustain';
        }
        break;
      case 'sustain':
        // Hold at sustain level
        break;
      case 'release':
        env.level -= blockSize / (env.release * sr);
        if (env.level <= 0) {
          env.level = 0;
          env.state = 'idle';
        }
        break;
      case 'idle':
      default:
        env.level = 0;
        break;
    }
  }
}

registerProcessor('wavetable-processor', WavetableProcessor);