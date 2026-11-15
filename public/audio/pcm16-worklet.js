/**
 * AudioWorklet: เสียงไมค์ (sample rate ของเครื่อง เช่น 48kHz) → PCM16 LE 16kHz mono
 * ส่งออกทีละ 100ms (1600 samples) ให้หน้า live ส่งต่อทาง WebSocket ไปถอดเสียงสด
 *
 * ลด sample rate เองในนี้ (ไม่ตั้ง AudioContext เป็น 16kHz) เพราะ Firefox ต่อไมค์เข้ากับ
 * AudioContext ที่ sample rate ไม่ตรงกับอุปกรณ์ไม่ได้ — ใช้ค่าเฉลี่ยของ sample ในแต่ละช่วง
 * (box filter) กัน aliasing ซึ่งพอสำหรับเสียงพูด
 */
const TARGET_RATE = 16000;
const FRAME_SAMPLES = 1600;

class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE;
    this.pos = 0;
    this.acc = 0;
    this.count = 0;
    this.out = new Int16Array(FRAME_SAMPLES);
    this.outLen = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    const n = channels[0].length;
    const nch = channels.length;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < nch; c++) s += channels[c][i];
      this.acc += s / nch;
      this.count += 1;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        let v = this.acc / this.count;
        this.acc = 0;
        this.count = 0;
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        this.out[this.outLen++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.outLen === FRAME_SAMPLES) {
          this.port.postMessage(this.out.buffer, [this.out.buffer]);
          this.out = new Int16Array(FRAME_SAMPLES);
          this.outLen = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm16-downsampler", Pcm16Downsampler);
