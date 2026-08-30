// rcai-tts-daemon — resident macOS TTS (AVSpeechSynthesizer) streaming PCM16 over stdout.
//
// stdin  : one JSON object per line
//          {"id":1,"text":"こんにちは、","voice":"com.apple.voice.compact.ja-JP.Kyoko","rate":0.5}
//          {"id":1,"cancel":true}        → stop everything queued (barge-in)
//          {"ping":true}                 → {"pong":true} header record
// stdout : binary records  [uint32 LE id][uint8 kind][uint32 LE len][payload]
//          kind 0 = header  payload = JSON {"id":..,"sampleRate":..,"channels":1,"format":"pcm16"}
//          kind 1 = audio   payload = PCM16 LE mono samples (streamed as the synthesizer produces them)
//          kind 2 = done    payload = JSON {"id":..,"done":true,"samples":N}
//          kind 3 = error   payload = JSON {"id":..,"error":".."}
// The synthesizer is pre-warmed at start so the first request does not pay voice-loading cost.
import AVFoundation
import Foundation

final class Daemon: NSObject {
    let synth = AVSpeechSynthesizer()
    let out = FileHandle.standardOutput
    let outLock = NSLock()
    var cancelled = Set<Int>()

    func write(id: Int, kind: UInt8, payload: Data) {
        var rec = Data(capacity: 9 + payload.count)
        var idLE = UInt32(id).littleEndian
        var lenLE = UInt32(payload.count).littleEndian
        rec.append(Data(bytes: &idLE, count: 4))
        rec.append(kind)
        rec.append(Data(bytes: &lenLE, count: 4))
        rec.append(payload)
        outLock.lock()
        out.write(rec)
        outLock.unlock()
    }

    func json(_ obj: [String: Any]) -> Data {
        return (try? JSONSerialization.data(withJSONObject: obj)) ?? Data()
    }

    func speak(id: Int, text: String, voiceId: String?, rate: Float?, pitch: Float?, silent: Bool = false) {
        let utt = AVSpeechUtterance(string: text)
        if let v = voiceId, let voice = AVSpeechSynthesisVoice(identifier: v) {
            utt.voice = voice
        } else {
            utt.voice = AVSpeechSynthesisVoice(language: "ja-JP")
        }
        utt.rate = rate ?? AVSpeechUtteranceDefaultSpeechRate
        if let p = pitch { utt.pitchMultiplier = p }
        utt.preUtteranceDelay = 0
        utt.postUtteranceDelay = 0
        var headerSent = false
        var total = 0
        var conv: AVAudioConverter? = nil
        var outFormat: AVAudioFormat? = nil
        synth.write(utt) { [weak self] buffer in
            guard let self = self else { return }
            if silent { return }
            if self.cancelled.contains(id) { return }
            guard let pcm = buffer as? AVAudioPCMBuffer else { return }
            let sr = Int(pcm.format.sampleRate)
            if !headerSent {
                headerSent = true
                self.write(id: id, kind: 0, payload: self.json(["id": id, "sampleRate": sr, "channels": 1, "format": "pcm16", "sourceFormat": pcm.format.commonFormat.rawValue]))
            }
            if pcm.frameLength == 0 {
                self.write(id: id, kind: 2, payload: self.json(["id": id, "done": true, "samples": total]))
                return
            }
            // Convert whatever the voice produces (usually Float32 or Int16, 22050 Hz mono) to Int16 mono.
            if outFormat == nil {
                outFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: pcm.format.sampleRate, channels: 1, interleaved: true)
                conv = AVAudioConverter(from: pcm.format, to: outFormat!)
            }
            var payload = Data()
            if pcm.format.commonFormat == .pcmFormatInt16 && pcm.format.channelCount == 1, let ch = pcm.int16ChannelData {
                payload = Data(bytes: ch[0], count: Int(pcm.frameLength) * 2)
            } else if let conv = conv, let of = outFormat, let dst = AVAudioPCMBuffer(pcmFormat: of, frameCapacity: pcm.frameLength) {
                var err: NSError? = nil
                var consumed = false
                conv.convert(to: dst, error: &err) { _, status in
                    if consumed { status.pointee = .noDataNow; return nil }
                    consumed = true
                    status.pointee = .haveData
                    return pcm
                }
                if let ch = dst.int16ChannelData { payload = Data(bytes: ch[0], count: Int(dst.frameLength) * 2) }
            }
            if payload.count > 0 {
                total += payload.count / 2
                self.write(id: id, kind: 1, payload: payload)
            }
        }
    }

    func handle(line: String) {
        guard let data = line.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if obj["ping"] != nil {
            write(id: 0, kind: 0, payload: json(["pong": true, "voices": AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("ja") }.map { $0.identifier }]))
            return
        }
        guard let id = obj["id"] as? Int else { return }
        if obj["cancel"] as? Bool == true {
            cancelled.insert(id)
            synth.stopSpeaking(at: .immediate)
            write(id: id, kind: 3, payload: json(["id": id, "error": "cancelled"]))
            return
        }
        guard let text = obj["text"] as? String else { return }
        let voice = obj["voice"] as? String
        let rate = (obj["rate"] as? NSNumber)?.floatValue
        let pitch = (obj["pitch"] as? NSNumber)?.floatValue
        speak(id: id, text: text, voiceId: voice, rate: rate, pitch: pitch)
    }
}

let daemon = Daemon()
setvbuf(stdout, nil, _IONBF, 0)
// Pre-warm: load the default Japanese voice so the first real request is fast.
daemon.speak(id: 0, text: "はい。", voiceId: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "com.apple.voice.compact.ja-JP.Kyoko", rate: nil, pitch: nil, silent: true)

let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        let l = line.trimmingCharacters(in: .whitespaces)
        if l.isEmpty { continue }
        DispatchQueue.main.async { daemon.handle(line: l) }
    }
    DispatchQueue.main.async { exit(0) }
}
reader.start()
RunLoop.main.run()
