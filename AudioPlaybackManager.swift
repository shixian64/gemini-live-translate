import Foundation
import AVFoundation

class AudioPlaybackManager {
    private let audioEngine = AVAudioEngine()
    private let playerNode = AVAudioPlayerNode()
    
    // Gemini Live API 的語音輸出格式是 24kHz, 16-bit PCM, 單聲道 (Mono)
    private let playbackFormat: AVAudioFormat
    private var isEngineStarted = false
    
    init() {
        playbackFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: false)!
        
        audioEngine.attach(playerNode)
        audioEngine.connect(playerNode, to: audioEngine.mainMixerNode, format: playbackFormat)
        
        startEngine()
    }
    
    private func startEngine() {
        guard !isEngineStarted else { return }
        do {
            try audioEngine.start()
            isEngineStarted = true
            print("🔊 音訊播放引擎已啟動成功 (24kHz Mono)")
        } catch {
            print("❌ 無法啟動播放引擎: \(error.localizedDescription)")
        }
    }
    
    /// 即時排程並播放收到的 PCM 音訊區塊
    func playAudioData(_ data: Data) {
        // 確保引擎正在運行
        if !audioEngine.isRunning {
            startEngine()
        }
        
        guard let buffer = audioBufferFromData(data) else { return }
        
        playerNode.play()
        // 將緩衝區排入播放佇列
        playerNode.scheduleBuffer(buffer, at: nil, options: [], completionHandler: nil)
    }
    
    func stop() {
        playerNode.stop()
        audioEngine.stop()
        isEngineStarted = false
        print("🔊 音訊播放引擎已停止")
    }
    
    private func audioBufferFromData(_ data: Data) -> AVAudioPCMBuffer? {
        let frameCount = AVAudioFrameCount(data.count / 2) // 16-bit = 2 bytes
        guard let buffer = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: frameCount) else { return nil }
        buffer.frameLength = frameCount
        
        data.withUnsafeBytes { rawBufferPointer in
            if let dst = buffer.int16ChannelData?[0],
               let src = rawBufferPointer.baseAddress?.assumingMemoryBound(to: Int16.self) {
                memcpy(dst, src, data.count)
            }
        }
        return buffer
    }
}
