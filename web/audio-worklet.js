class PcmDownsamplerProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    const processorOptions = options.processorOptions || {};
    this.targetSampleRate = Number(processorOptions.targetSampleRate || 16000);
    this.chunkFrameCount = Number(processorOptions.chunkFrameCount || 1600);
    this.ratio = sampleRate / this.targetSampleRate;
    this.source = new Float32Array(0);
    this.readIndex = 0;
    this.output = new Int16Array(this.chunkFrameCount);
    this.outputOffset = 0;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'flush') {
        this.flush();
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0].length > 0) {
      this.pushInput(input);
    }

    const output = outputs[0];
    if (output) {
      for (const channel of output) {
        channel.fill(0);
      }
    }
    return true;
  }

  pushInput(channels) {
    const frameCount = channels[0].length;
    const mono = new Float32Array(frameCount);
    const channelCount = channels.length;

    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      const channel = channels[channelIndex];
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        mono[frameIndex] += channel[frameIndex] / channelCount;
      }
    }

    const merged = new Float32Array(this.source.length + mono.length);
    merged.set(this.source, 0);
    merged.set(mono, this.source.length);
    this.source = merged;
    this.drain();
  }

  drain() {
    while (this.readIndex + 1 < this.source.length) {
      const base = Math.floor(this.readIndex);
      const fraction = this.readIndex - base;
      const current = this.source[base];
      const next = this.source[base + 1];
      const sample = current + (next - current) * fraction;
      this.writeSample(sample);
      this.readIndex += this.ratio;
    }

    const consumed = Math.floor(this.readIndex);
    if (consumed > 0) {
      this.source = this.source.slice(consumed);
      this.readIndex -= consumed;
    }
  }

  writeSample(sample) {
    const clamped = Math.max(-1, Math.min(1, sample));
    this.output[this.outputOffset] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    this.outputOffset += 1;

    if (this.outputOffset >= this.output.length) {
      this.emitChunk();
    }
  }

  emitChunk() {
    const chunk = this.output;
    this.port.postMessage({ type: 'pcm', buffer: chunk.buffer }, [chunk.buffer]);
    this.output = new Int16Array(this.chunkFrameCount);
    this.outputOffset = 0;
  }

  flush() {
    if (this.outputOffset === 0) {
      return;
    }
    const chunk = this.output.slice(0, this.outputOffset);
    this.port.postMessage({ type: 'pcm', buffer: chunk.buffer }, [chunk.buffer]);
    this.output = new Int16Array(this.chunkFrameCount);
    this.outputOffset = 0;
  }
}

registerProcessor('pcm-downsampler', PcmDownsamplerProcessor);
