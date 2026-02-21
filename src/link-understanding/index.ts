/**
 * Link Understanding — public API.
 */

export { applyLinkUnderstanding, enrichMessagesWithLinks } from "./apply.js";
export { extractLinksFromMessage } from "./detect.js";
export { formatLinkUnderstandingBody } from "./format.js";
export { runLinkUnderstanding } from "./runner.js";
export type { LinkConfig, LinkResult, LinkUnderstandingResult } from "./runner.js";
export type { ApplyLinkUnderstandingResult } from "./apply.js";
