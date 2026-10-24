import { EventEmitter } from "events";
export const OUTPUT_FORMAT = { AUDIO_24KHZ_48KBITRATE_MONO_MP3: 1 };
export class MsEdgeTTS {
  async setMetadata(voice) { this.voice = voice; }
  async toStream() {
    globalThis.__edgeCalls = (globalThis.__edgeCalls || 0) + 1;
    if (globalThis.__edgeFail) throw new Error("403 forbidden (simulated Edge block)");
    const s = new EventEmitter();
    setTimeout(() => { s.emit("data", Buffer.from("ID3-fake-mp3-audio-bytes-" + this.voice)); s.emit("end"); }, 20);
    return { audioStream: s };
  }
  close() {}
}
