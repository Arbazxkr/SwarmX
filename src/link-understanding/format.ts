/**
 * Link Understanding — format results into message body.
 */

/**
 * Appends link understanding outputs to the original message body.
 * Used to enrich agent context with fetched content.
 */
export function formatLinkUnderstandingBody(params: {
    body?: string;
    outputs: string[];
}): string {
    const outputs = params.outputs.map((o) => o.trim()).filter(Boolean);
    if (outputs.length === 0) {
        return params.body ?? "";
    }

    const base = (params.body ?? "").trim();
    const section = "---\n## Referenced Links\n\n" + outputs.join("\n\n");

    if (!base) return section;
    return `${base}\n\n${section}`;
}
