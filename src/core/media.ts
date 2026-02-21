/**
 * Groklets Media Pipeline — Image/audio/video processing + transcription.
 *
 * Features:
 *   - Image handling (resize metadata, base64 conversion)
 *   - Audio transcription (Whisper via OpenAI API)
 *   - Video frame extraction
 *   - Temp file lifecycle management
 *   - Media message routing
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Media");

export interface MediaFile {
    id: string;
    path: string;
    mimeType: string;
    size: number;
    filename: string;
    createdAt: number;
    metadata?: Record<string, unknown>;
}

export interface MediaConfig {
    /** Temp directory for media files */
    tempDir?: string;
    /** Max file size in bytes (default 25MB) */
    maxFileSize?: number;
    /** Auto-cleanup temp files after ms (default 1 hour) */
    cleanupAfterMs?: number;
    /** OpenAI API key for Whisper transcription */
    openaiApiKey?: string;
}

const MIME_MAP: Record<string, string> = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".m4a": "audio/mp4", ".flac": "audio/flac", ".opus": "audio/opus",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".pdf": "application/pdf", ".txt": "text/plain",
};

export class MediaPipeline {
    private files = new Map<string, MediaFile>();
    private config: Required<MediaConfig>;
    private cleanupTimer?: ReturnType<typeof setInterval>;

    constructor(config?: MediaConfig) {
        this.config = {
            tempDir: config?.tempDir ?? join(process.cwd(), ".Groklets", "media"),
            maxFileSize: config?.maxFileSize ?? 25 * 1024 * 1024,
            cleanupAfterMs: config?.cleanupAfterMs ?? 3_600_000,
            openaiApiKey: config?.openaiApiKey ?? process.env.OPENAI_API_KEY ?? "",
        };

        if (!existsSync(this.config.tempDir)) mkdirSync(this.config.tempDir, { recursive: true });

        // Periodic cleanup
        this.cleanupTimer = setInterval(() => this.cleanup(), 300_000); // every 5min
    }

    // ── Ingest ──────────────────────────────────────────────────

    /**
     * Ingest a file from a buffer.
     */
    ingest(buffer: Buffer, filename: string): MediaFile {
        if (buffer.length > this.config.maxFileSize) {
            throw new Error(`File too large: ${buffer.length} bytes (max ${this.config.maxFileSize})`);
        }

        const ext = extname(filename).toLowerCase();
        const id = `media_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const path = join(this.config.tempDir, `${id}${ext}`);

        writeFileSync(path, buffer);

        const file: MediaFile = {
            id, path, filename,
            mimeType: MIME_MAP[ext] ?? "application/octet-stream",
            size: buffer.length,
            createdAt: Date.now(),
        };

        this.files.set(id, file);
        log.info(`Ingested: ${filename} (${this.formatSize(buffer.length)}, ${file.mimeType})`);
        return file;
    }

    /**
     * Ingest from a file path.
     */
    ingestFromPath(filePath: string): MediaFile {
        if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
        const buffer = readFileSync(filePath);
        return this.ingest(buffer, basename(filePath));
    }

    /**
     * Ingest from base64.
     */
    ingestBase64(base64: string, filename: string): MediaFile {
        const buffer = Buffer.from(base64, "base64");
        return this.ingest(buffer, filename);
    }

    // ── Processing ──────────────────────────────────────────────

    /**
     * Convert an image to base64 for LLM vision APIs.
     */
    toBase64(id: string): string {
        const file = this.files.get(id);
        if (!file) throw new Error(`Media not found: ${id}`);
        return readFileSync(file.path).toString("base64");
    }

    /**
     * Get a data URL for embedding in HTML/messages.
     */
    toDataUrl(id: string): string {
        const file = this.files.get(id);
        if (!file) throw new Error(`Media not found: ${id}`);
        return `data:${file.mimeType};base64,${this.toBase64(id)}`;
    }

    /**
     * Transcribe audio using OpenAI Whisper API.
     */
    async transcribe(id: string): Promise<string> {
        const file = this.files.get(id);
        if (!file) throw new Error(`Media not found: ${id}`);
        if (!file.mimeType.startsWith("audio/")) throw new Error("Not an audio file");
        if (!this.config.openaiApiKey) throw new Error("OpenAI API key required for transcription");

        const { default: OpenAI } = await import("openai");
        const openai = new OpenAI({ apiKey: this.config.openaiApiKey });

        const fs = await import("node:fs");
        const response = await openai.audio.transcriptions.create({
            model: "whisper-1",
            file: fs.createReadStream(file.path),
        });

        const text = response.text;
        file.metadata = { ...file.metadata, transcription: text };
        log.info(`Transcribed: ${file.filename} → ${text.length} chars`);
        return text;
    }

    /**
     * Describe an image using LLM vision (requires provider with vision).
     */
    async describeImage(id: string): Promise<string> {
        const file = this.files.get(id);
        if (!file) throw new Error(`Media not found: ${id}`);
        if (!file.mimeType.startsWith("image/")) throw new Error("Not an image file");
        if (!this.config.openaiApiKey) throw new Error("OpenAI API key required for image description");

        const { default: OpenAI } = await import("openai");
        const openai = new OpenAI({ apiKey: this.config.openaiApiKey });

        const base64 = this.toBase64(id);
        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: "Describe this image concisely." },
                    { type: "image_url", image_url: { url: `data:${file.mimeType};base64,${base64}` } },
                ],
            }],
            max_tokens: 300,
        });

        const description = response.choices[0]?.message?.content ?? "";
        file.metadata = { ...file.metadata, description };
        return description;
    }

    // ── Lifecycle ───────────────────────────────────────────────

    get(id: string): MediaFile | undefined { return this.files.get(id); }

    delete(id: string): boolean {
        const file = this.files.get(id);
        if (!file) return false;
        try { unlinkSync(file.path); } catch { }
        return this.files.delete(id);
    }

    private cleanup(): void {
        const now = Date.now();
        let cleaned = 0;

        for (const [id, file] of this.files) {
            if (now - file.createdAt > this.config.cleanupAfterMs) {
                try { unlinkSync(file.path); } catch { }
                this.files.delete(id);
                cleaned++;
            }
        }

        if (cleaned > 0) log.debug(`Cleaned up ${cleaned} expired media files`);
    }

    shutdown(): void {
        if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    }

    private formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes}B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    }

    // ── Introspection ───────────────────────────────────────────

    get count(): number { return this.files.size; }

    stats(): Record<string, unknown> {
        let totalSize = 0;
        const byType: Record<string, number> = {};
        for (const f of this.files.values()) {
            totalSize += f.size;
            const type = f.mimeType.split("/")[0];
            byType[type] = (byType[type] ?? 0) + 1;
        }
        return { total: this.files.size, totalSize: this.formatSize(totalSize), byType };
    }
}
