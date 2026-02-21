/**
 * Tests for Link Understanding module.
 */

import { describe, it, expect } from "vitest";
import { extractLinksFromMessage } from "../src/link-understanding/detect.js";
import { formatLinkUnderstandingBody } from "../src/link-understanding/format.js";

// ── URL Detection ──────────────────────────────────────────────

describe("extractLinksFromMessage", () => {
    it("should extract bare URLs", () => {
        const links = extractLinksFromMessage("Check this out https://example.com");
        expect(links).toEqual(["https://example.com"]);
    });

    it("should extract multiple URLs", () => {
        const links = extractLinksFromMessage(
            "See https://example.com and https://github.com/test"
        );
        expect(links).toHaveLength(2);
        expect(links).toContain("https://example.com");
        expect(links).toContain("https://github.com/test");
    });

    it("should deduplicate URLs", () => {
        const links = extractLinksFromMessage(
            "https://example.com is cool. Visit https://example.com again."
        );
        expect(links).toHaveLength(1);
    });

    it("should respect maxLinks", () => {
        const links = extractLinksFromMessage(
            "https://a.com https://b.com https://c.com https://d.com",
            { maxLinks: 2 },
        );
        expect(links).toHaveLength(2);
    });

    it("should handle markdown links (strip and detect)", () => {
        const links = extractLinksFromMessage(
            "Check [this](https://markdown.com) and also https://bare.com"
        );
        // markdown link URL is stripped so only bare URL is detected
        expect(links).toEqual(["https://bare.com"]);
    });

    it("should return empty for no URLs", () => {
        const links = extractLinksFromMessage("Hello world, no links here!");
        expect(links).toEqual([]);
    });

    it("should return empty for empty input", () => {
        expect(extractLinksFromMessage("")).toEqual([]);
        expect(extractLinksFromMessage("   ")).toEqual([]);
    });

    // ── SSRF Protection ────────────────────────────────────────

    it("should block localhost", () => {
        const links = extractLinksFromMessage("http://localhost:3000/admin");
        expect(links).toEqual([]);
    });

    it("should block 127.0.0.1", () => {
        const links = extractLinksFromMessage("http://127.0.0.1:8080/secret");
        expect(links).toEqual([]);
    });

    it("should block private IPs (192.168.x.x)", () => {
        const links = extractLinksFromMessage("http://192.168.1.1/router");
        expect(links).toEqual([]);
    });

    it("should block private IPs (10.x.x.x)", () => {
        const links = extractLinksFromMessage("http://10.0.0.1/internal");
        expect(links).toEqual([]);
    });

    it("should block metadata endpoints", () => {
        const links = extractLinksFromMessage("http://169.254.169.254/latest/meta-data/");
        expect(links).toEqual([]);
    });

    it("should block .internal domains", () => {
        const links = extractLinksFromMessage("https://api.service.internal/data");
        expect(links).toEqual([]);
    });

    it("should allow valid public URLs", () => {
        const links = extractLinksFromMessage("https://github.com/Arbazxkr/Groklets");
        expect(links).toEqual(["https://github.com/Arbazxkr/Groklets"]);
    });

    it("should strip trailing punctuation", () => {
        const links = extractLinksFromMessage("Visit https://example.com.");
        expect(links).toEqual(["https://example.com"]);
    });

    it("should handle URLs in parentheses", () => {
        const links = extractLinksFromMessage("(see https://example.com)");
        expect(links).toEqual(["https://example.com"]);
    });
});

// ── Format ─────────────────────────────────────────────────────

describe("formatLinkUnderstandingBody", () => {
    it("should append outputs to body", () => {
        const result = formatLinkUnderstandingBody({
            body: "User message",
            outputs: ["[Content from https://example.com]\nHello world"],
        });
        expect(result).toContain("User message");
        expect(result).toContain("Referenced Links");
        expect(result).toContain("Hello world");
    });

    it("should return body unchanged when no outputs", () => {
        const result = formatLinkUnderstandingBody({
            body: "User message",
            outputs: [],
        });
        expect(result).toBe("User message");
    });

    it("should handle empty body with outputs", () => {
        const result = formatLinkUnderstandingBody({
            body: "",
            outputs: ["Content here"],
        });
        expect(result).toContain("Content here");
    });

    it("should handle undefined body", () => {
        const result = formatLinkUnderstandingBody({
            outputs: ["Some content"],
        });
        expect(result).toContain("Some content");
    });

    it("should join multiple outputs", () => {
        const result = formatLinkUnderstandingBody({
            body: "msg",
            outputs: ["Output 1", "Output 2"],
        });
        expect(result).toContain("Output 1");
        expect(result).toContain("Output 2");
    });
});
