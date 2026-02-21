/**
 * Groklets Voice — Text-to-Speech (ElevenLabs) + Speech-to-Text (Whisper).
 *
 * Features:
 *   - ElevenLabs TTS (streaming audio)
 *   - OpenAI Whisper STT
 *   - Voice profiles (voice ID, stability, similarity)
 *   - Talk Mode integration
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("Voice");

export interface VoiceConfig {
    /** ElevenLabs API key */
    elevenLabsKey?: string;
    /** OpenAI API key (for Whisper STT) */
    openaiKey?: string;
    /** Default voice ID */
    defaultVoiceId?: string;
    /** Voice stability (0-1) */
    stability?: number;
    /** Similarity boost (0-1) */
    similarityBoost?: number;
    /** Output format */
    outputFormat?: "mp3_44100_128" | "pcm_16000" | "pcm_24000";
}

export interface VoiceProfile {
    id: string;
    name: string;
    voiceId: string;
    stability: number;
    similarityBoost: number;
}

export class VoiceEngine {
    private config: VoiceConfig;
    private profiles = new Map<string, VoiceProfile>();

    constructor(config?: VoiceConfig) {
        this.config = {
            elevenLabsKey: config?.elevenLabsKey ?? process.env.ELEVENLABS_API_KEY ?? "",
            openaiKey: config?.openaiKey ?? process.env.OPENAI_API_KEY ?? "",
            defaultVoiceId: config?.defaultVoiceId ?? "21m00Tcm4TlvDq8ikWAM", // Rachel
            stability: config?.stability ?? 0.5,
            similarityBoost: config?.similarityBoost ?? 0.75,
            outputFormat: config?.outputFormat ?? "mp3_44100_128",
        };
    }

    // ── Text-to-Speech ──────────────────────────────────────────

    /**
     * Convert text to speech using ElevenLabs.
     * Returns audio buffer.
     */
    async speak(text: string, voiceId?: string): Promise<Buffer> {
        if (!this.config.elevenLabsKey) throw new Error("ElevenLabs API key required");

        const vid = voiceId ?? this.config.defaultVoiceId;

        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "xi-api-key": this.config.elevenLabsKey!,
            },
            body: JSON.stringify({
                text,
                model_id: "eleven_monolingual_v1",
                voice_settings: {
                    stability: this.config.stability,
                    similarity_boost: this.config.similarityBoost,
                },
            }),
        });

        if (!response.ok) {
            throw new Error(`ElevenLabs TTS failed: ${response.status} ${response.statusText}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        log.info(`TTS: ${text.length} chars → ${(buffer.length / 1024).toFixed(1)}KB audio`);
        return buffer;
    }

    /**
     * Stream TTS audio chunks.
     */
    async *speakStream(text: string, voiceId?: string): AsyncIterable<Buffer> {
        if (!this.config.elevenLabsKey) throw new Error("ElevenLabs API key required");

        const vid = voiceId ?? this.config.defaultVoiceId;

        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "xi-api-key": this.config.elevenLabsKey!,
            },
            body: JSON.stringify({
                text,
                model_id: "eleven_monolingual_v1",
                voice_settings: {
                    stability: this.config.stability,
                    similarity_boost: this.config.similarityBoost,
                },
            }),
        });

        if (!response.ok) {
            throw new Error(`ElevenLabs stream failed: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            yield Buffer.from(value);
        }
    }

    // ── Speech-to-Text ──────────────────────────────────────────

    /**
     * Transcribe audio buffer using OpenAI Whisper.
     */
    async listen(audioBuffer: Buffer, language = "en"): Promise<string> {
        if (!this.config.openaiKey) throw new Error("OpenAI API key required for STT");

        const { default: OpenAI, toFile } = await import("openai");
        const openai = new OpenAI({ apiKey: this.config.openaiKey });

        const file = await toFile(audioBuffer, "audio.wav");
        const response = await openai.audio.transcriptions.create({
            model: "whisper-1",
            file,
            language,
        });

        log.info(`STT: ${(audioBuffer.length / 1024).toFixed(1)}KB → "${response.text.slice(0, 60)}..."`);
        return response.text;
    }

    // ── Voice Profiles ──────────────────────────────────────────

    addProfile(name: string, voiceId: string, stability?: number, similarityBoost?: number): VoiceProfile {
        const profile: VoiceProfile = {
            id: name.toLowerCase().replace(/\s+/g, "-"),
            name,
            voiceId,
            stability: stability ?? this.config.stability ?? 0.5,
            similarityBoost: similarityBoost ?? this.config.similarityBoost ?? 0.75,
        };
        this.profiles.set(profile.id, profile);
        return profile;
    }

    getProfile(id: string): VoiceProfile | undefined {
        return this.profiles.get(id);
    }

    /**
     * List available ElevenLabs voices.
     */
    async listVoices(): Promise<Array<{ voice_id: string; name: string }>> {
        if (!this.config.elevenLabsKey) throw new Error("ElevenLabs API key required");

        const response = await fetch("https://api.elevenlabs.io/v1/voices", {
            headers: { "xi-api-key": this.config.elevenLabsKey! },
        });

        if (!response.ok) throw new Error(`Failed to list voices: ${response.status}`);
        const data = await response.json() as { voices: Array<{ voice_id: string; name: string }> };
        return data.voices;
    }
}
