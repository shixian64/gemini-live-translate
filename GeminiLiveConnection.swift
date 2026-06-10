import Foundation

protocol GeminiLiveConnectionDelegate: AnyObject {
    func didReceiveInputTranscription(_ text: String)
    func didReceiveOutputTranscription(_ text: String)
    func didReceiveAudioData(_ data: Data)
    func didUpdateConnectionStatus(_ status: String)
}

class GeminiLiveConnection: NSObject, URLSessionWebSocketDelegate {
    weak var delegate: GeminiLiveConnectionDelegate?
    
    private var webSocketTask: URLSessionWebSocketTask?
    private var isConnected = false
    private var chunkCount = 0
    
    private let apiKey: String
    private let modelName: String
    
    private let host = "generativelanguage.googleapis.com"
    private let path = "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
    
    private lazy var session: URLSession = {
        return URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    }()
    
    init(apiKey: String, modelName: String) {
        self.apiKey = apiKey
        self.modelName = modelName
        super.init()
    }
    
    func connect() {
        guard !isConnected else { return }
        
        var urlComponents = URLComponents()
        urlComponents.scheme = "https"
        urlComponents.host = host
        urlComponents.path = path
        urlComponents.queryItems = [URLQueryItem(name: "key", value: apiKey)]
        
        guard let url = urlComponents.url else {
            print("無效的 API URL")
            return
        }
        
        let wsUrlString = url.absoluteString.replacingOccurrences(of: "https://", with: "wss://")
        guard let wsUrl = URL(string: wsUrlString) else { return }
        
        delegate?.didUpdateConnectionStatus("連線中...")
        webSocketTask = session.webSocketTask(with: wsUrl)
        webSocketTask?.resume()
        
        receiveMessage()
        sendSetupConfig()
    }
    
    func disconnect() {
        guard isConnected else { return }
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        isConnected = false
        delegate?.didUpdateConnectionStatus("已斷線")
    }
    
    func sendAudioChunk(_ data: Data) {
        guard isConnected else { return }
        
        chunkCount += 1
        if chunkCount % 100 == 0 {
            // 靜音檢查：看資料是否全為 0
            let isSilent = data.allSatisfy { $0 == 0 }
            print("📊 [WebSocket] 已發送 \(chunkCount) 個音訊區塊 | 大小: \(data.count) bytes | 是否為靜音(全0): \(isSilent)")
        }
        
        let base64Audio = data.base64EncodedString()
        
        let message: [String: Any] = [
            "realtimeInput": [
                "audio": [
                    "data": base64Audio,
                    "mimeType": "audio/pcm;rate=16000"
                ]
            ]
        ]
        
        do {
            let jsonData = try JSONSerialization.data(withJSONObject: message, options: [])
            if let jsonString = String(data: jsonData, encoding: .utf8) {
                let wsMessage = URLSessionWebSocketTask.Message.string(jsonString)
                webSocketTask?.send(wsMessage) { error in
                    if let error = error {
                        print("發送音訊至 Gemini 失敗: \(error.localizedDescription)")
                    }
                }
            }
        } catch {
            print("音訊資料 JSON 序列化失敗: \(error)")
        }
    }
    
    // MARK: - 私有方法
    
    private func sendSetupConfig() {
        let isTranslateModel = modelName.contains("live-translate")
        
        var setupMessage: [String: Any] = [:]
        
        if isTranslateModel {
            setupMessage = [
                "setup": [
                    "model": "models/\(modelName)",
                    "inputAudioTranscription": [:],
                    "outputAudioTranscription": [:],
                    "generationConfig": [
                        "responseModalities": ["AUDIO"],
                        "translationConfig": [
                            "targetLanguageCode": "zh-TW",
                            "echoTargetLanguage": true
                        ]
                    ]
                ]
            ]
        } else {
            setupMessage = [
                "setup": [
                    "model": "models/\(modelName)",
                    "generationConfig": [
                        "responseModalities": ["AUDIO"]
                    ],
                    "systemInstruction": [
                        "parts": [
                            [
                                "text": "你是一個專業的即時口譯機器人。請聽取輸入的音訊（可能是英文、日文等各國語言），並將其即時、通順地翻譯成台灣繁體中文語音輸出。"
                            ]
                        ]
                    ]
                ]
            ]
        }
        
        do {
            let jsonData = try JSONSerialization.data(withJSONObject: setupMessage, options: [])
            if let jsonString = String(data: jsonData, encoding: .utf8) {
                let wsMessage = URLSessionWebSocketTask.Message.string(jsonString)
                webSocketTask?.send(wsMessage) { [weak self] error in
                    if let error = error {
                        print("發送 Setup Config 失敗: \(error.localizedDescription)")
                        self?.delegate?.didUpdateConnectionStatus("連線錯誤")
                    } else {
                        print("Live Setup Config 發送成功 (模型: \(self?.modelName ?? ""))")
                        self?.isConnected = true
                        self?.delegate?.didUpdateConnectionStatus("已連線 (即時翻譯中)")
                    }
                }
            }
        } catch {
            print("建構 Setup Config 失敗: \(error)")
        }
    }
    
    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            guard let self = self else { return }
            
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    print("📩 收到伺服器訊息: \(text)")
                    self.parseServerResponse(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        print("📩 收到伺服器訊息 (Data): \(text)")
                        self.parseServerResponse(text)
                    }
                @unknown default:
                    break
                }
                self.receiveMessage()
                
            case .failure(let error):
                if self.isConnected {
                    print("接收 WebSocket 失敗: \(error.localizedDescription)")
                    self.isConnected = false
                    self.delegate?.didUpdateConnectionStatus("連線中斷")
                }
            }
        }
    }
    
    private func parseServerResponse(_ jsonString: String) {
        guard let jsonData = jsonString.data(using: .utf8) else { return }
        
        do {
            if let json = try JSONSerialization.jsonObject(with: jsonData, options: []) as? [String: Any],
               let serverContent = json["serverContent"] as? [String: Any] {
                
                // 1. 取得會議原文字幕
                if let inputTranscription = serverContent["inputTranscription"] as? [String: Any],
                   let text = inputTranscription["text"] as? String, !text.isEmpty {
                    DispatchQueue.main.async {
                        self.delegate?.didReceiveInputTranscription(text)
                    }
                }
                
                // 2. 取得翻譯後繁中字幕
                if let outputTranscription = serverContent["outputTranscription"] as? [String: Any],
                   let text = outputTranscription["text"] as? String, !text.isEmpty {
                    DispatchQueue.main.async {
                        self.delegate?.didReceiveOutputTranscription(text)
                    }
                }
                
                // 3. 取得翻譯後語音 PCM 資料與通用模型文字
                if let modelTurn = serverContent["modelTurn"] as? [String: Any],
                   let parts = modelTurn["parts"] as? [[String: Any]] {
                    
                    for part in parts {
                        if let inlineData = part["inlineData"] as? [String: Any],
                           let mimeType = inlineData["mimeType"] as? String, mimeType.hasPrefix("audio/pcm"),
                           let base64Audio = inlineData["data"] as? String,
                           let audioData = Data(base64Encoded: base64Audio) {
                            
                            DispatchQueue.main.async {
                                self.delegate?.didReceiveAudioData(audioData)
                            }
                        }
                        
                        if let text = part["text"] as? String, !text.isEmpty {
                            DispatchQueue.main.async {
                                self.delegate?.didReceiveOutputTranscription(text)
                            }
                        }
                    }
                }
            }
        } catch {
            print("解析 Gemini 伺服器回傳失敗: \(error)")
        }
    }
}

// MARK: - URLSessionWebSocketDelegate & URLSessionTaskDelegate

extension GeminiLiveConnection: URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocolName: String?) {
        print("🟢 WebSocket 連線已成功開啟 (Protocol: \(protocolName ?? "無"))")
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        var reasonString = ""
        if let reason = reason {
            reasonString = String(data: reason, encoding: .utf8) ?? ""
        }
        print("❌ WebSocket 被 Gemini 伺服器關閉 (CloseCode: \(closeCode.rawValue), 原因: \(reasonString))")
        isConnected = false
        
        DispatchQueue.main.async {
            self.delegate?.didUpdateConnectionStatus("已斷開 (Code: \(closeCode.rawValue))")
        }
    }
    
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            print("❌ WebSocket 連線錯誤: \(error.localizedDescription)")
            isConnected = false
            
            DispatchQueue.main.async {
                self.delegate?.didUpdateConnectionStatus("連線失敗")
            }
        }
    }
}
