// SwarmXApp.swift — macOS Menu Bar Application
// SwarmX Multi-Agent Orchestration Framework
// Requires: macOS 14+, Xcode 15+

import SwiftUI
import Combine
import Network

// MARK: - App Entry Point

@main
struct SwarmXApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var gateway = GatewayClient()
    @StateObject private var voiceEngine = VoiceEngine()

    var body: some Scene {
        MenuBarExtra {
            MenuBarView()
                .environmentObject(gateway)
                .environmentObject(voiceEngine)
        } label: {
            Image(systemName: "atom")
            Text("SwarmX")
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
                .environmentObject(gateway)
        }

        Window("Chat", id: "chat") {
            ChatView()
                .environmentObject(gateway)
                .environmentObject(voiceEngine)
        }
    }
}

// MARK: - App Delegate

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // Menu bar only
    }
}

// MARK: - Gateway WebSocket Client

class GatewayClient: ObservableObject {
    @Published var isConnected = false
    @Published var agents: [AgentInfo] = []
    @Published var events: [GatewayEvent] = []
    @Published var usage: UsageInfo = UsageInfo()
    @Published var engineRunning = false

    private var webSocket: URLSessionWebSocketTask?
    private let session = URLSession(configuration: .default)
    private var gatewayURL = "ws://127.0.0.1:18789"
    private var authToken: String?
    private var reconnectTimer: Timer?

    struct AgentInfo: Identifiable, Codable {
        var id: String
        var name: String
        var state: String
        var provider: String
        var contextPercent: Double
        var toolCount: Int
    }

    struct UsageInfo: Codable {
        var totalCalls: Int = 0
        var totalTokens: Int = 0
        var totalCost: String = "$0.0000"
    }

    struct GatewayEvent: Identifiable {
        let id = UUID()
        let topic: String
        let source: String
        let timestamp: Date
        let payload: [String: Any]
    }

    // MARK: - Connection

    func connect(url: String? = nil, token: String? = nil) {
        if let url = url { gatewayURL = url }
        if let token = token { authToken = token }

        guard let url = URL(string: gatewayURL) else { return }

        webSocket = session.webSocketTask(with: url)
        webSocket?.resume()

        // Authenticate if needed
        if let token = authToken {
            send(["type": "auth", "payload": ["token": token]])
        }

        // Subscribe to all events
        send(["type": "event.subscribe", "payload": ["topics": ["*"]]])

        isConnected = true
        receiveMessages()
        requestStatus()
    }

    func disconnect() {
        webSocket?.cancel(with: .goingAway, reason: nil)
        webSocket = nil
        isConnected = false
    }

    private func receiveMessages() {
        webSocket?.receive { [weak self] result in
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self?.handleMessage(text)
                default: break
                }
                self?.receiveMessages() // Continue receiving
            case .failure(let error):
                DispatchQueue.main.async {
                    self?.isConnected = false
                    self?.scheduleReconnect()
                }
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else { return }

        DispatchQueue.main.async { [weak self] in
            switch type {
            case "engine.status":
                self?.parseStatus(json["payload"] as? [String: Any] ?? [:])
            case "event.forward":
                if let payload = json["payload"] as? [String: Any] {
                    let event = GatewayEvent(
                        topic: payload["topic"] as? String ?? "",
                        source: payload["source"] as? String ?? "",
                        timestamp: Date(),
                        payload: payload
                    )
                    self?.events.insert(event, at: 0)
                    if (self?.events.count ?? 0) > 100 { self?.events.removeLast() }
                }
            default: break
            }
        }
    }

    private func parseStatus(_ status: [String: Any]) {
        engineRunning = status["running"] as? Bool ?? false

        if let agentsDict = status["agents"] as? [String: [String: Any]] {
            agents = agentsDict.map { (id, info) in
                AgentInfo(
                    id: id,
                    name: info["name"] as? String ?? id,
                    state: info["state"] as? String ?? "unknown",
                    provider: info["provider"] as? String ?? "—",
                    contextPercent: (info["contextUsage"] as? [String: Any])?["percent"] as? Double ?? 0,
                    toolCount: (info["tools"] as? [Any])?.count ?? 0
                )
            }
        }

        if let usageDict = status["usage"] as? [String: Any] {
            usage = UsageInfo(
                totalCalls: usageDict["totalCalls"] as? Int ?? 0,
                totalTokens: usageDict["totalTokens"] as? Int ?? 0,
                totalCost: usageDict["totalCost"] as? String ?? "$0.0000"
            )
        }
    }

    func requestStatus() {
        send(["type": "engine.status"])
    }

    func submitTask(_ content: String) {
        send(["type": "task.submit", "payload": ["content": content]])
    }

    func runDoctor() {
        send(["type": "engine.doctor"])
    }

    private func send(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let text = String(data: data, encoding: .utf8) else { return }
        webSocket?.send(.string(text)) { _ in }
    }

    private func scheduleReconnect() {
        reconnectTimer?.invalidate()
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: 3.0, repeats: false) { [weak self] _ in
            self?.connect()
        }
    }
}

// MARK: - Voice Engine (macOS STT + ElevenLabs TTS)

class VoiceEngine: ObservableObject {
    @Published var isListening = false
    @Published var isSpeaking = false
    @Published var lastTranscript = ""
    @Published var talkModeActive = false

    private var recognitionTask: Any? // SFSpeechRecognitionTask
    private var audioPlayer: Any? // AVAudioPlayer

    func startListening() {
        // Uses macOS Speech Recognition (SFSpeechRecognizer)
        // Requires: Privacy - Speech Recognition Usage Description in Info.plist
        isListening = true
        // Implementation uses Speech framework
    }

    func stopListening() {
        isListening = false
    }

    func speak(_ text: String, voiceId: String = "21m00Tcm4TlvDq8ikWAM") async {
        guard let apiKey = ProcessInfo.processInfo.environment["ELEVENLABS_API_KEY"] else { return }

        isSpeaking = true
        defer { isSpeaking = false }

        guard let url = URL(string: "https://api.elevenlabs.io/v1/text-to-speech/\(voiceId)") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "xi-api-key")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "text": text,
            "model_id": "eleven_monolingual_v1",
            "voice_settings": ["stability": 0.5, "similarity_boost": 0.75]
        ])

        guard let (data, _) = try? await URLSession.shared.data(for: request) else { return }

        // Play audio using AVAudioPlayer
        // let player = try? AVAudioPlayer(data: data)
        // player?.play()
    }

    func toggleTalkMode() {
        talkModeActive.toggle()
        if talkModeActive { startListening() }
        else { stopListening() }
    }
}

// MARK: - Menu Bar View

struct MenuBarView: View {
    @EnvironmentObject var gateway: GatewayClient
    @EnvironmentObject var voice: VoiceEngine

    var body: some View {
        VStack(spacing: 12) {
            // Header
            HStack {
                Image(systemName: "atom")
                    .foregroundColor(.blue)
                Text("SwarmX")
                    .font(.headline)
                Spacer()
                Circle()
                    .fill(gateway.isConnected ? Color.green : Color.red)
                    .frame(width: 8, height: 8)
                Text(gateway.isConnected ? "Online" : "Offline")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .padding(.horizontal)

            Divider()

            // Engine Status
            if gateway.isConnected {
                VStack(spacing: 8) {
                    StatusRow(label: "Engine", value: gateway.engineRunning ? "Running" : "Stopped")
                    StatusRow(label: "Agents", value: "\(gateway.agents.count)")
                    StatusRow(label: "Calls", value: "\(gateway.usage.totalCalls)")
                    StatusRow(label: "Tokens", value: "\(gateway.usage.totalTokens)")
                    StatusRow(label: "Cost", value: gateway.usage.totalCost)
                }
                .padding(.horizontal)

                Divider()

                // Agents
                if !gateway.agents.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("AGENTS")
                            .font(.caption2)
                            .foregroundColor(.secondary)

                        ForEach(gateway.agents) { agent in
                            HStack {
                                Circle()
                                    .fill(agentColor(agent.state))
                                    .frame(width: 6, height: 6)
                                Text(agent.name)
                                    .font(.caption)
                                Spacer()
                                Text(agent.provider)
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                            }
                        }
                    }
                    .padding(.horizontal)

                    Divider()
                }
            }

            // Actions
            VStack(spacing: 4) {
                Button(action: { voice.toggleTalkMode() }) {
                    Label(voice.talkModeActive ? "Stop Talk Mode" : "Talk Mode",
                          systemImage: voice.talkModeActive ? "mic.fill" : "mic")
                }
                .keyboardShortcut("t", modifiers: [.command, .shift])

                Button(action: { NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil) }) {
                    Label("Settings", systemImage: "gear")
                }
                .keyboardShortcut(",")

                Button(action: { gateway.runDoctor() }) {
                    Label("Run Doctor", systemImage: "stethoscope")
                }

                Divider()

                Button(action: { NSApplication.shared.terminate(nil) }) {
                    Label("Quit SwarmX", systemImage: "power")
                }
                .keyboardShortcut("q")
            }
            .padding(.horizontal)
        }
        .padding(.vertical, 12)
        .frame(width: 280)
    }

    func agentColor(_ state: String) -> Color {
        switch state {
        case "idle": return .green
        case "processing": return .yellow
        case "error": return .red
        default: return .gray
        }
    }
}

struct StatusRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundColor(.secondary)
            Spacer()
            Text(value)
                .font(.caption)
                .fontWeight(.medium)
                .monospacedDigit()
        }
    }
}

// MARK: - Chat View

struct ChatView: View {
    @EnvironmentObject var gateway: GatewayClient
    @EnvironmentObject var voice: VoiceEngine
    @State private var input = ""
    @State private var messages: [(role: String, content: String)] = []

    var body: some View {
        VStack(spacing: 0) {
            // Messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(Array(messages.enumerated()), id: \.offset) { idx, msg in
                            ChatBubble(role: msg.role, content: msg.content)
                                .id(idx)
                        }
                    }
                    .padding()
                }
                .onChange(of: messages.count) { _ in
                    proxy.scrollTo(messages.count - 1, anchor: .bottom)
                }
            }

            Divider()

            // Input
            HStack(spacing: 8) {
                Button(action: { voice.toggleTalkMode() }) {
                    Image(systemName: voice.talkModeActive ? "mic.fill" : "mic")
                        .foregroundColor(voice.talkModeActive ? .red : .secondary)
                }
                .buttonStyle(.plain)

                TextField("Message...", text: $input)
                    .textFieldStyle(.plain)
                    .onSubmit { sendMessage() }

                Button("Send") { sendMessage() }
                    .keyboardShortcut(.return)
                    .disabled(input.isEmpty)
            }
            .padding(12)
            .background(.ultraThinMaterial)
        }
        .frame(minWidth: 400, minHeight: 500)
    }

    func sendMessage() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        messages.append(("user", text))
        gateway.submitTask(text)
        input = ""
    }
}

struct ChatBubble: View {
    let role: String
    let content: String

    var body: some View {
        HStack {
            if role == "user" { Spacer() }

            Text(content)
                .padding(12)
                .background(role == "user" ? Color.blue : Color(.controlBackgroundColor))
                .foregroundColor(role == "user" ? .white : .primary)
                .cornerRadius(16)
                .frame(maxWidth: 300, alignment: role == "user" ? .trailing : .leading)

            if role != "user" { Spacer() }
        }
    }
}

// MARK: - Settings View

struct SettingsView: View {
    @EnvironmentObject var gateway: GatewayClient
    @AppStorage("gatewayURL") var gatewayURL = "ws://127.0.0.1:18789"
    @AppStorage("authToken") var authToken = ""
    @AppStorage("elevenLabsKey") var elevenLabsKey = ""

    var body: some View {
        TabView {
            Form {
                Section("Gateway") {
                    TextField("URL", text: $gatewayURL)
                    SecureField("Auth Token", text: $authToken)
                    Button("Connect") {
                        gateway.connect(url: gatewayURL, token: authToken.isEmpty ? nil : authToken)
                    }
                }
            }
            .tabItem { Label("General", systemImage: "gear") }

            Form {
                Section("Voice") {
                    SecureField("ElevenLabs API Key", text: $elevenLabsKey)
                }
            }
            .tabItem { Label("Voice", systemImage: "mic") }
        }
        .padding()
        .frame(width: 400, height: 200)
    }
}
