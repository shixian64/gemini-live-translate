# gemini-live-translate-macos

MeetingTranslator - 一個基於 macOS SwiftUI、原創 ScreenCaptureKit 與 Gemini 3.5 Live (Bi-directional) Translate API 的即時語音會議翻譯與播報工具。

---

## 🔗 參考資源

本專案基於 Google 於 2026 年 6 月 9 日正式發表的全新即時語音翻譯 API 技術開發。詳細資訊可參考以下官方資源：
- **官方發表部落格**：[Fluid, natural voice translation with Gemini 3.5 Live Translate](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-live-3-5-translate/)
- **開發者說明文件**：[使用 Gemini Live API 進行即時翻譯](https://ai.google.dev/gemini-api/docs/live-api/live-translate?hl=zh-tw)

---

## ✨ 核心特色

1. **零虛擬音效卡依賴**：完全採用 macOS 原生 **ScreenCaptureKit** 框架，無須下載與設定 BlackHole 或 Loopback 等第三方虛擬音訊驅動，即可單獨、精準且純淨地擷取選定應用程式的聲音。
2. **Gemini 3.5 Live Translate 支援**：整合最新 `gemini-3.5-live-translate-preview` 雙向 WebSocket API，實現超低延遲的語音對話式翻譯（落後說話者僅數秒），且保留說話者原本的節奏與語氣。
3. **繁體中文即時字幕**：透過雙向通道，即時接收 Gemini Live 回傳的語音識別文字與繁中翻譯字幕，並滾動呈現於懸浮視窗中。
4. **雙聲道音訊口譯播報**：接收 API 回傳的 24kHz Mono 16-bit PCM 翻譯語音，藉由 `AVAudioEngine` 即時播報，讓您邊看會議邊聽實時口譯。
5. **多聲道安全重採樣**：透過 `AVAudioConverter` 將擷取到的立體聲/多聲道 48kHz 音訊重採樣為符合 API 需求的 16kHz 單聲道 PCM，並採用「雙呼叫 (Double-Call)」動態記憶體分配，避免多聲道資料複製崩潰與靜音的問題。

---

## 📋 準備工作

在開始編譯與執行本專案前，請確認以下事項：

1. **系統需求**：macOS 13.0 Ventura 或以上版本（ScreenCaptureKit 的最低要求）。
2. **開發環境**：Xcode 14 或以上版本，或安裝有 Swift 編譯器的 Mac 終端機環境。
3. **Gemini API 金鑰**：請前往 [Google AI Studio](https://aistudio.google.com/apikey?hl=zh-tw) 取得您的 API 金鑰。請確認您的 API 金鑰已具備存取 Gemini 3.5 Live Translate 預覽模型的權限。
4. **目標測試程式**：準備一個播放有聲內容的應用程式（例如：使用 Chrome 播放 YouTube 影片，或開啟 Zoom、Google Meet 線上會議）。
5. **系統隱私權設定**：
   - 首次錄製時，macOS 系統會要求**「螢幕錄製」權限**。這是 `ScreenCaptureKit` 安全限制的一部分（即使本 App 僅擷取音訊，系統也視為錄製行為）。
   - 請前往 **系統設定 > 隱私權與安全性 > 螢幕錄製**，將本應用程式勾選啟用，隨後重新啟動 App。

---

## 🛠️ 安裝與建置步驟

本專案提供**命令行腳本**與 **Xcode IDE** 兩種編譯安裝方式。

### 方法一：使用命令行腳本（快速推薦 🚀）

如果您習慣在終端機操作，可以直接執行目錄下的 `build_app.sh`，無須手動開啟 Xcode：

```bash
# 1. 複製本專案並進入目錄
git clone https://github.com/<your-username>/gemini-live-translate-macos.git
cd gemini-live-translate-macos

# 2. 賦予建置腳本執行權限
chmod +x build_app.sh

# 3. 執行編譯打包
./build_app.sh

# 4. 編譯成功後會生成 MeetingTranslator.app，直接使用命令或在 Finder 中打開
open MeetingTranslator.app
```

---

### 方法二：使用 Xcode IDE 手動建置

1. 打開 **Xcode**，選擇 **File > New > Project...**
2. 選擇 **macOS** 平台，選擇 **App** 範本，點擊 Next。
3. 設定專案資訊：
   - **Product Name**: `MeetingTranslator`
   - **Interface**: `SwiftUI`
   - **Language**: `Swift`
4. 建立專案後，在 Xcode 左側導航欄刪除自動產生的 `ContentView.swift` 和 `MeetingTranslatorApp.swift`。
5. 將本專案目錄下的五個 `.swift` 核心程式碼檔案拖曳匯入至 Xcode 專案中：
   - [TranslatorApp.swift](file:///Users/al03034132/Documents/gemini-live-api-examples/gemini-live-translate-livekit/swift-demo/TranslatorApp.swift)
   - [ContentView.swift](file:///Users/al03034132/Documents/gemini-live-api-examples/gemini-live-translate-livekit/swift-demo/ContentView.swift)
   - [AudioCaptureManager.swift](file:///Users/al03034132/Documents/gemini-live-api-examples/gemini-live-translate-livekit/swift-demo/AudioCaptureManager.swift)
   - [AudioPlaybackManager.swift](file:///Users/al03034132/Documents/gemini-live-api-examples/gemini-live-translate-livekit/swift-demo/AudioPlaybackManager.swift)
   - [GeminiLiveConnection.swift](file:///Users/al03034132/Documents/gemini-live-api-examples/gemini-live-translate-livekit/swift-demo/GeminiLiveConnection.swift)

6. **設定最低 macOS 部署版本**：
   - 點擊 Xcode 頂端的 Project 節點。
   - 在 **General** -> **Minimum Deployments** 中，將 **macOS** 改為 **13.0**。
7. **配置 Sandbox 權限與連線權能 (Capabilities)**：
   - 選擇 **Signing & Capabilities** 標籤頁。
   - 在 **App Sandbox** 設定區塊下，請務必勾選以下兩項，否則連線或音訊會被沙盒阻擋：
     - **Outgoing Connections (Client)**：允許 WebSocket 對外連線至 Google 伺服器。
     - **Audio Input**：在部分系統安全規則下，擷取應用程式音訊需要獲得麥克風/音訊輸入權限。
8. 點擊 Xcode 左上角的 **Play 按鈕 (Cmd + R)** 編譯並測試。

---

## 💡 使用說明

1. 啟動 `MeetingTranslator` 應用程式。
2. 於輸入框中貼上您的 **Gemini API Key**。
3. 開啟您要翻譯的網頁或播放音訊的應用程式（例如播放英文影片的 Google Chrome）。
4. 在 App 中點擊「**重新整理**」按鈕，此時下拉選單會載入系統中所有正在運行的 App。
5. 選擇該應用程式（例如：`Google Chrome` 或 `Zoom`）。
6. 點擊「**開始翻譯**」：
   - 第一次執行時，系統會要求「螢幕錄製」隱私權限，請按照指示前往系統設定勾選後重啟 App。
7. 如果要聽到翻譯出來的繁體中文配音，請開啟「**啟用翻譯音訊播放**」開關。
8. 當該 App 有人說話或發出聲音時，App 視窗底部將會即時流暢地顯示繁體中文翻譯字幕，且音訊會同步同步播報！

---

## 🛠️ 開發細節與踩坑提示

本專案包含了許多在對接 Gemini Live 雙向 WebSockets API 及 macOS Core Audio 時的實戰排雷：

* **模型名稱限制**：Gemini Live WebSocket 雙向端點（`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`）**不支援** `gemini-3.5-flash`。必須指定 `gemini-3.5-live-translate-preview` 或是 `gemini-2.0-flash-exp` 才能完成連線協定握手（否則會報 `CloseCode 1008`）。
* **JSON Payload 位置陷阱**：在 `v1beta` 的 WebSocket Payload 中，`inputAudioTranscription` 和 `outputAudioTranscription` 控制參數應放在 `setup` 根目錄，而非包在 `generationConfig` 內部，否則會回報 `CloseCode 1007` (Invalid JSON payload... Unknown name at 'setup.generation_config')。
* **多聲道 AudioBufferList 記憶體安全**：ScreenCaptureKit 傳回的音訊格式可能是立體聲或多聲道。如果以靜態大小分配 `AudioBufferList`，複製時會造成記憶體不足而截斷成全為 0 的空值（造成 Gemini 沒回應，且日誌印出 `是否為靜音(全0): true`）。本專案實作了**雙呼叫 (Double-Call) 技巧**：先傳入 `nil` 獲取所需 size，再動態分配記憶體與 `memcpy` 拷貝，確保多聲道音訊完整複製並成功降頻轉換。

---

## 📝 授權條款

本專案採用 **MIT** 授權條款。
