// GrokletsApp.swift — iOS Companion Node
// Groklets Multi-Agent Orchestration Framework
// Requires: iOS 17+, Xcode 15+

import SwiftUI
import Combine
import AVFoundation
import Speech

// MARK: - App Entry Point

@main
struct GrokletsApp: App {
    @StateObject private var gateway = GatewayClient()
    @StateObject private var canvas = CanvasHost()
    @StateObject private var voice = VoiceEngine()
    @StateObject private var camera = CameraManager()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(gateway)
                .environmentObject(canvas)
                .environmentObject(voice)
                .environmentObject(camera)
        }
    }
}

// MARK: - Gateway Client (shared with macOS)

class GatewayClient: ObservableObject {
    @Published var isConnected = false
    @Published var agents: [AgentInfo] = []
    @Published var messages: [ChatMessage] = []
    @Published var engineRunning = false

    private var webSocket: URLSessionWebSocketTask?
    @AppStorage("gatewayURL") var gatewayURL = "ws://192.168.1.100:18789"

    struct AgentInfo: Identifiable, Codable {
        var id: String
        var name: String
        var state: String
    }

    struct ChatMessage: Identifiable {
        let id = UUID()
        let role: String
        let content: String
        let timestamp = Date()
    }

    func connect() {
        guard let url = URL(string: gatewayURL) else { return }
        webSocket = URLSession.shared.webSocketTask(with: url)
        webSocket?.resume()
        isConnected = true
        send(["type": "event.subscribe", "payload": ["topics": ["*"]]])
        receiveMessages()
    }

    func disconnect() {
        webSocket?.cancel(with: .goingAway, reason: nil)
        isConnected = false
    }

    func submitTask(_ content: String) {
        messages.append(ChatMessage(role: "user", content: content))
        send(["type": "task.submit", "payload": ["content": content]])
    }

    private func receiveMessages() {
        webSocket?.receive { [weak self] result in
            if case .success(let message) = result,
               case .string(let text) = message {
                self?.handleMessage(text)
            }
            self?.receiveMessages()
        }
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        DispatchQueue.main.async { [weak self] in
            if let type = json["type"] as? String {
                switch type {
                case "event.forward":
                    if let payload = json["payload"] as? [String: Any],
                       let topic = payload["topic"] as? String,
                       topic.hasPrefix("agent.response"),
                       let inner = payload["payload"] as? [String: Any],
                       let content = inner["content"] as? String {
                        self?.messages.append(ChatMessage(role: "agent", content: content))
                    }
                case "canvas.push":
                    if let payload = json["payload"] as? [String: Any],
                       let html = payload["html"] as? String {
                        self?.objectWillChange.send()
                    }
                default: break
                }
            }
        }
    }

    private func send(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let text = String(data: data, encoding: .utf8) else { return }
        webSocket?.send(.string(text)) { _ in }
    }
}

// MARK: - Canvas Host (A2UI)

class CanvasHost: ObservableObject {
    @Published var currentHTML: String = ""
    @Published var isActive = false

    func pushHTML(_ html: String) {
        currentHTML = html
        isActive = true
    }

    func reset() {
        currentHTML = ""
        isActive = false
    }
}

// MARK: - Voice Engine (iOS)

class VoiceEngine: ObservableObject {
    @Published var isListening = false
    @Published var transcript = ""
    @Published var talkModeActive = false

    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let audioEngine = AVAudioEngine()

    func startListening() {
        guard let recognizer = speechRecognizer, recognizer.isAvailable else { return }

        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        recognitionRequest?.shouldReportPartialResults = true

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { [weak self] buffer, _ in
            self?.recognitionRequest?.append(buffer)
        }

        recognitionTask = recognizer.recognitionTask(with: recognitionRequest!) { [weak self] result, error in
            if let result = result {
                DispatchQueue.main.async {
                    self?.transcript = result.bestTranscription.formattedString
                }
            }
            if error != nil || result?.isFinal == true {
                self?.stopListening()
            }
        }

        audioEngine.prepare()
        try? audioEngine.start()
        isListening = true
    }

    func stopListening() {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        isListening = false
    }

    func toggleTalkMode() {
        talkModeActive.toggle()
        if talkModeActive { startListening() }
        else { stopListening() }
    }
}

// MARK: - Camera Manager

class CameraManager: ObservableObject {
    @Published var lastPhoto: Data?

    func capturePhoto() {
        // Uses AVCaptureSession for photo capture
        // Sends photo to Gateway as media
    }

    func startScreenRecording() {
        // Uses ReplayKit for screen recording
    }
}

// MARK: - Content View

struct ContentView: View {
    @EnvironmentObject var gateway: GatewayClient
    @EnvironmentObject var canvas: CanvasHost
    @EnvironmentObject var voice: VoiceEngine
    @State private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            // Chat Tab
            ChatTab()
                .tabItem {
                    Image(systemName: "bubble.left.fill")
                    Text("Chat")
                }
                .tag(0)

            // Canvas Tab
            CanvasTab()
                .tabItem {
                    Image(systemName: "paintbrush.fill")
                    Text("Canvas")
                }
                .tag(1)

            // Status Tab
            StatusTab()
                .tabItem {
                    Image(systemName: "gauge.medium")
                    Text("Status")
                }
                .tag(2)

            // Settings Tab
            SettingsTab()
                .tabItem {
                    Image(systemName: "gear")
                    Text("Settings")
                }
                .tag(3)
        }
        .onAppear { gateway.connect() }
    }
}

// MARK: - Chat Tab

struct ChatTab: View {
    @EnvironmentObject var gateway: GatewayClient
    @EnvironmentObject var voice: VoiceEngine
    @State private var input = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 12) {
                            ForEach(gateway.messages) { msg in
                                HStack {
                                    if msg.role == "user" { Spacer() }
                                    Text(msg.content)
                                        .padding(12)
                                        .background(msg.role == "user" ? Color.blue : Color(.systemGray6))
                                        .foregroundColor(msg.role == "user" ? .white : .primary)
                                        .cornerRadius(16)
                                        .frame(maxWidth: 280, alignment: msg.role == "user" ? .trailing : .leading)
                                    if msg.role != "user" { Spacer() }
                                }
                            }
                        }
                        .padding()
                    }
                }

                // Input bar
                HStack(spacing: 8) {
                    Button(action: { voice.toggleTalkMode() }) {
                        Image(systemName: voice.talkModeActive ? "mic.fill" : "mic")
                            .foregroundColor(voice.talkModeActive ? .red : .gray)
                            .font(.title2)
                    }

                    TextField("Message...", text: $input)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { sendMessage() }

                    Button(action: sendMessage) {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                            .foregroundColor(.blue)
                    }
                    .disabled(input.isEmpty)
                }
                .padding()
                .background(Color(.systemBackground))
            }
            .navigationTitle("Groklets")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Circle()
                        .fill(gateway.isConnected ? Color.green : Color.red)
                        .frame(width: 8, height: 8)
                }
            }
        }
    }

    func sendMessage() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        gateway.submitTask(text)
        input = ""
    }
}

// MARK: - Canvas Tab (A2UI)

struct CanvasTab: View {
    @EnvironmentObject var canvas: CanvasHost

    var body: some View {
        NavigationStack {
            if canvas.isActive {
                // WebView to render agent-pushed HTML
                Text("Canvas Active")
                    .font(.headline)
                // In production: WKWebView rendering canvas.currentHTML
            } else {
                VStack(spacing: 16) {
                    Image(systemName: "paintbrush")
                        .font(.system(size: 48))
                        .foregroundColor(.gray)
                    Text("Canvas")
                        .font(.headline)
                    Text("Agents can push UI here")
                        .foregroundColor(.secondary)
                }
            }
        }
        .navigationTitle("Canvas")
    }
}

// MARK: - Status Tab

struct StatusTab: View {
    @EnvironmentObject var gateway: GatewayClient

    var body: some View {
        NavigationStack {
            List {
                Section("Connection") {
                    HStack {
                        Text("Status")
                        Spacer()
                        Text(gateway.isConnected ? "Connected" : "Disconnected")
                            .foregroundColor(gateway.isConnected ? .green : .red)
                    }
                }

                Section("Agents") {
                    if gateway.agents.isEmpty {
                        Text("No agents").foregroundColor(.secondary)
                    }
                    ForEach(gateway.agents) { agent in
                        HStack {
                            Circle()
                                .fill(agent.state == "idle" ? Color.green : .yellow)
                                .frame(width: 8, height: 8)
                            Text(agent.name)
                            Spacer()
                            Text(agent.state)
                                .font(.caption)
                                .foregroundColor(.secondary)
                        }
                    }
                }
            }
            .navigationTitle("Status")
        }
    }
}

// MARK: - Settings Tab

struct SettingsTab: View {
    @EnvironmentObject var gateway: GatewayClient
    @AppStorage("gatewayURL") var gatewayURL = "ws://192.168.1.100:18789"

    var body: some View {
        NavigationStack {
            Form {
                Section("Gateway") {
                    TextField("URL", text: $gatewayURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Button(gateway.isConnected ? "Reconnect" : "Connect") {
                        gateway.disconnect()
                        gateway.gatewayURL = gatewayURL
                        gateway.connect()
                    }
                }

                Section("About") {
                    HStack {
                        Text("Version")
                        Spacer()
                        Text("0.4.0")
                    }
                }
            }
            .navigationTitle("Settings")
        }
    }
}
