/**
 * Link Understanding — defaults.
 */

/** Maximum number of links to process per message. */
export const DEFAULT_MAX_LINKS = 3;

/** Default timeout for fetching a single link (seconds). */
export const DEFAULT_LINK_TIMEOUT_SECONDS = 30;

/** Maximum response size in bytes (500KB). */
export const DEFAULT_MAX_RESPONSE_BYTES = 512_000;

/** User-Agent header for HTTP requests. */
export const DEFAULT_USER_AGENT = "Groklets/0.6 (Link Understanding)";
