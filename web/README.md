# 跨平台 Web/PWA 适配（Linux / Windows / Android）

这个目录提供不依赖 macOS `ScreenCaptureKit` / `AVFoundation` 的浏览器版本，用 Web Audio API 完成：

1. 捕获屏幕/标签页音频或麦克风音频。
2. 将输入重采样为 Gemini Live 需要的 `16kHz mono Int16 PCM`。
3. 通过 Gemini Live WebSocket 发送音频并接收字幕/翻译语音。
4. 将返回的 `24kHz mono Int16 PCM` 在浏览器中排队播放。

## 运行方式（不需要构建）

Windows PowerShell：

```powershell
py -m http.server 8080 -d .\web
```

Linux：

```bash
python3 -m http.server 8080 --directory ./web
```

然后打开：<http://localhost:8080>

> 不建议直接双击 `index.html`。浏览器媒体采集通常要求 HTTPS 或 localhost，AudioWorklet 也可能在 `file://` 下被拦截。

## 平台能力说明

| 平台 | 推荐来源 | 说明 |
| --- | --- | --- |
| Windows | 屏幕/标签页音频 | 推荐 Chrome/Edge；分享时需要勾选共享音频。 |
| Linux | 屏幕/标签页音频 | 推荐 Chromium/Chrome；系统音频是否可共享取决于浏览器、Wayland/X11、PipeWire/PulseAudio 配置。 |
| Android | 麦克风音频 | 多数 Android 浏览器不开放系统音频采集；如需真正系统音频，后续应做 Android 原生 `MediaProjection + AudioRecord` 适配。 |

## Android 真机调试提示

如果页面在电脑上用 `localhost:8080` 提供服务，可在 Windows 上使用：

```powershell
adb reverse tcp:8080 tcp:8080
```

然后在手机浏览器打开：<http://localhost:8080>

## 注意事项

- API Key 会在浏览器端直接用于 WebSocket 连接；只有勾选“记住 API Key”时才会写入 `localStorage`。
- Gemini Live 返回的字段可能随模型变化；当前实现兼容 `inputTranscription`、`outputTranscription` 和 `modelTurn.parts[].inlineData`。
- Web 版是跨平台适配入口，不替代原 macOS SwiftUI 版本。
