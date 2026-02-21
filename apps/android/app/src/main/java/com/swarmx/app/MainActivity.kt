// Groklets Android Companion Node
// Kotlin + Jetpack Compose
// Requires: Android Studio, minSdk 26, targetSdk 34

package com.Groklets.app

import android.os.Bundle
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.*
import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.TimeUnit

// ── Main Activity ─────────────────────────────────────────────

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            GrokletsTheme {
                GrokletsApp()
            }
        }
    }
}

// ── Theme ─────────────────────────────────────────────────────

@Composable
fun GrokletsTheme(content: @Composable () -> Unit) {
    val darkColors = darkColorScheme(
        primary = Color(0xFF3B82F6),
        onPrimary = Color.White,
        surface = Color(0xFF18181B),
        onSurface = Color(0xFFFAFAFA),
        background = Color(0xFF09090B),
        onBackground = Color(0xFFFAFAFA),
    )
    MaterialTheme(colorScheme = darkColors, content = content)
}

// ── Gateway Client ────────────────────────────────────────────

class GatewayClient {
    var isConnected by mutableStateOf(false)
    var messages = mutableStateListOf<ChatMessage>()
    var agents = mutableStateListOf<AgentInfo>()
    var engineRunning by mutableStateOf(false)

    private var webSocket: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    data class ChatMessage(val role: String, val content: String)
    data class AgentInfo(val id: String, val name: String, val state: String)

    fun connect(url: String = "ws://192.168.1.100:18789") {
        val request = Request.Builder().url(url).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                isConnected = true
                ws.send("""{"type":"event.subscribe","payload":{"topics":["*"]}}""")
                ws.send("""{"type":"engine.status"}""")
            }

            override fun onMessage(ws: WebSocket, text: String) {
                try {
                    val json = JSONObject(text)
                    when (json.optString("type")) {
                        "event.forward" -> {
                            val payload = json.optJSONObject("payload") ?: return
                            val topic = payload.optString("topic")
                            if (topic.startsWith("agent.response")) {
                                val inner = payload.optJSONObject("payload") ?: return
                                val content = inner.optString("content")
                                if (content.isNotEmpty()) {
                                    messages.add(ChatMessage("agent", content))
                                }
                            }
                        }
                        "engine.status" -> {
                            val payload = json.optJSONObject("payload") ?: return
                            engineRunning = payload.optBoolean("running")
                        }
                    }
                } catch (_: Exception) {}
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                isConnected = false
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                isConnected = false
                // Auto-reconnect after 3s
                CoroutineScope(Dispatchers.IO).launch {
                    delay(3000)
                    connect(url)
                }
            }
        })
    }

    fun submitTask(content: String) {
        messages.add(ChatMessage("user", content))
        webSocket?.send("""{"type":"task.submit","payload":{"content":"$content"}}""")
    }

    fun disconnect() {
        webSocket?.close(1000, "User disconnect")
        isConnected = false
    }
}

// ── Main App ──────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GrokletsApp() {
    val gateway = remember { GatewayClient() }
    var selectedTab by remember { mutableIntStateOf(0) }

    LaunchedEffect(Unit) { gateway.connect() }

    Scaffold(
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = selectedTab == 0,
                    onClick = { selectedTab = 0 },
                    icon = { Icon(Icons.Default.ChatBubble, "Chat") },
                    label = { Text("Chat") }
                )
                NavigationBarItem(
                    selected = selectedTab == 1,
                    onClick = { selectedTab = 1 },
                    icon = { Icon(Icons.Default.Brush, "Canvas") },
                    label = { Text("Canvas") }
                )
                NavigationBarItem(
                    selected = selectedTab == 2,
                    onClick = { selectedTab = 2 },
                    icon = { Icon(Icons.Default.Dashboard, "Status") },
                    label = { Text("Status") }
                )
                NavigationBarItem(
                    selected = selectedTab == 3,
                    onClick = { selectedTab = 3 },
                    icon = { Icon(Icons.Default.Settings, "Settings") },
                    label = { Text("Settings") }
                )
            }
        }
    ) { padding ->
        Box(modifier = Modifier.padding(padding)) {
            when (selectedTab) {
                0 -> ChatScreen(gateway)
                1 -> CanvasScreen()
                2 -> StatusScreen(gateway)
                3 -> SettingsScreen(gateway)
            }
        }
    }
}

// ── Chat Screen ───────────────────────────────────────────────

@Composable
fun ChatScreen(gateway: GatewayClient) {
    var input by remember { mutableStateOf("") }
    val listState = rememberLazyListState()

    LaunchedEffect(gateway.messages.size) {
        if (gateway.messages.isNotEmpty()) {
            listState.animateScrollToItem(gateway.messages.size - 1)
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        // Header
        TopAppBar(
            title = {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("⚛ Groklets", fontWeight = FontWeight.Bold)
                    Spacer(modifier = Modifier.width(8.dp))
                    Box(
                        modifier = Modifier
                            .size(8.dp)
                            .clip(CircleShape)
                            .background(if (gateway.isConnected) Color.Green else Color.Red)
                    )
                }
            }
        )

        // Messages
        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(gateway.messages) { msg ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = if (msg.role == "user") Arrangement.End else Arrangement.Start
                ) {
                    Surface(
                        shape = RoundedCornerShape(16.dp),
                        color = if (msg.role == "user") MaterialTheme.colorScheme.primary
                               else MaterialTheme.colorScheme.surface,
                        modifier = Modifier.widthIn(max = 280.dp)
                    ) {
                        Text(
                            msg.content,
                            modifier = Modifier.padding(12.dp),
                            color = if (msg.role == "user") Color.White
                                   else MaterialTheme.colorScheme.onSurface
                        )
                    }
                }
            }
        }

        // Input bar
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            IconButton(onClick = { /* Toggle voice */ }) {
                Icon(Icons.Default.Mic, "Voice", tint = Color.Gray)
            }

            OutlinedTextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier.weight(1f),
                placeholder = { Text("Message...") },
                shape = RoundedCornerShape(24.dp),
                singleLine = true
            )

            Spacer(modifier = Modifier.width(8.dp))

            IconButton(
                onClick = {
                    if (input.isNotBlank()) {
                        gateway.submitTask(input.trim())
                        input = ""
                    }
                }
            ) {
                Icon(Icons.Default.Send, "Send", tint = MaterialTheme.colorScheme.primary)
            }
        }
    }
}

// ── Canvas Screen ─────────────────────────────────────────────

@Composable
fun CanvasScreen() {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(
                Icons.Default.Brush,
                contentDescription = "Canvas",
                modifier = Modifier.size(64.dp),
                tint = Color.Gray
            )
            Spacer(modifier = Modifier.height(16.dp))
            Text("Canvas", fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Text("Agents can push UI here", color = Color.Gray, fontSize = 14.sp)
        }
    }
}

// ── Status Screen ─────────────────────────────────────────────

@Composable
fun StatusScreen(gateway: GatewayClient) {
    LazyColumn(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        item {
            Text("Connection", fontWeight = FontWeight.Bold, fontSize = 16.sp)
            Spacer(modifier = Modifier.height(8.dp))
            Row {
                Text("Status")
                Spacer(modifier = Modifier.weight(1f))
                Text(
                    if (gateway.isConnected) "Connected" else "Disconnected",
                    color = if (gateway.isConnected) Color.Green else Color.Red
                )
            }
            Spacer(modifier = Modifier.height(8.dp))
            Row {
                Text("Engine")
                Spacer(modifier = Modifier.weight(1f))
                Text(if (gateway.engineRunning) "Running" else "Stopped")
            }
            Spacer(modifier = Modifier.height(24.dp))
        }

        item {
            Text("Agents", fontWeight = FontWeight.Bold, fontSize = 16.sp)
            Spacer(modifier = Modifier.height(8.dp))
        }

        if (gateway.agents.isEmpty()) {
            item { Text("No agents", color = Color.Gray) }
        }

        items(gateway.agents) { agent ->
            Row(
                modifier = Modifier.padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(
                            when (agent.state) {
                                "idle" -> Color.Green
                                "processing" -> Color.Yellow
                                else -> Color.Gray
                            }
                        )
                )
                Spacer(modifier = Modifier.width(12.dp))
                Text(agent.name)
                Spacer(modifier = Modifier.weight(1f))
                Text(agent.state, color = Color.Gray, fontSize = 12.sp)
            }
        }
    }
}

// ── Settings Screen ───────────────────────────────────────────

@Composable
fun SettingsScreen(gateway: GatewayClient) {
    var url by remember { mutableStateOf("ws://192.168.1.100:18789") }

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        Text("Gateway", fontWeight = FontWeight.Bold, fontSize = 16.sp)
        Spacer(modifier = Modifier.height(12.dp))

        OutlinedTextField(
            value = url,
            onValueChange = { url = it },
            label = { Text("Gateway URL") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true
        )

        Spacer(modifier = Modifier.height(12.dp))

        Button(
            onClick = {
                gateway.disconnect()
                gateway.connect(url)
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(if (gateway.isConnected) "Reconnect" else "Connect")
        }

        Spacer(modifier = Modifier.height(24.dp))

        Text("About", fontWeight = FontWeight.Bold, fontSize = 16.sp)
        Spacer(modifier = Modifier.height(8.dp))
        Row {
            Text("Version")
            Spacer(modifier = Modifier.weight(1f))
            Text("0.4.0", color = Color.Gray)
        }
    }
}
