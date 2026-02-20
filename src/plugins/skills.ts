/**
 * SwarmX Skills / Plugin System
 *
 * Installable tool packs that agents can load dynamically.
 * A skill = a directory with a manifest.json + tool implementations.
 *
 * Structure:
 *   skills/
 *     web-search/
 *       manifest.json   — { name, version, description, tools: [...] }
 *       index.js         — exports tool functions
 */

import { readFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { type ToolFunction } from "../core/tool-executor.js";
import { type ToolDefinition } from "../core/provider.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("Skills");

export interface SkillManifest {
    name: string;
    version: string;
    description: string;
    author?: string;
    tools: Array<{
        name: string;
        description: string;
        parameters: Record<string, unknown>;
        handler: string; // function name to call from index.js
    }>;
}

export interface LoadedSkill {
    manifest: SkillManifest;
    tools: Map<string, { definition: ToolDefinition; fn: ToolFunction }>;
    path: string;
}

export class SkillRegistry {
    private skills = new Map<string, LoadedSkill>();
    private skillsDir: string;

    constructor(skillsDir?: string) {
        this.skillsDir = skillsDir ?? join(process.cwd(), "skills");
    }

    /**
     * Load a single skill from a directory.
     */
    async loadSkill(skillPath: string): Promise<LoadedSkill> {
        const absPath = resolve(skillPath);
        const manifestPath = join(absPath, "manifest.json");

        if (!existsSync(manifestPath)) {
            throw new Error(`No manifest.json found in ${absPath}`);
        }

        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as SkillManifest;

        // Load the module
        const modulePath = join(absPath, "index.js");
        if (!existsSync(modulePath)) {
            throw new Error(`No index.js found in ${absPath}`);
        }

        const mod = await import(modulePath);
        const tools = new Map<string, { definition: ToolDefinition; fn: ToolFunction }>();

        for (const toolDef of manifest.tools) {
            const fn = mod[toolDef.handler];
            if (typeof fn !== "function") {
                log.warn(`Skill ${manifest.name}: handler '${toolDef.handler}' not found, skipping`);
                continue;
            }

            tools.set(toolDef.name, {
                definition: {
                    type: "function",
                    function: {
                        name: toolDef.name,
                        description: toolDef.description,
                        parameters: toolDef.parameters,
                    },
                },
                fn: fn as ToolFunction,
            });
        }

        const loaded: LoadedSkill = { manifest, tools, path: absPath };
        this.skills.set(manifest.name, loaded);

        log.info(`Loaded skill: ${manifest.name} v${manifest.version} (${tools.size} tools)`);
        return loaded;
    }

    /**
     * Auto-discover and load all skills from the skills directory.
     */
    async loadAll(): Promise<number> {
        if (!existsSync(this.skillsDir)) {
            mkdirSync(this.skillsDir, { recursive: true });
            return 0;
        }

        const entries = readdirSync(this.skillsDir, { withFileTypes: true });
        let count = 0;

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const skillPath = join(this.skillsDir, entry.name);
            try {
                await this.loadSkill(skillPath);
                count++;
            } catch (err) {
                log.warn(`Failed to load skill '${entry.name}': ${err}`);
            }
        }

        if (count > 0) log.info(`Loaded ${count} skills from ${this.skillsDir}`);
        return count;
    }

    /**
     * Get a loaded skill by name.
     */
    get(name: string): LoadedSkill | undefined {
        return this.skills.get(name);
    }

    /**
     * Get all tool definitions across all loaded skills.
     */
    getAllTools(): Array<{ definition: ToolDefinition; fn: ToolFunction; skillName: string }> {
        const all: Array<{ definition: ToolDefinition; fn: ToolFunction; skillName: string }> = [];
        for (const [skillName, skill] of this.skills) {
            for (const [, tool] of skill.tools) {
                all.push({ ...tool, skillName });
            }
        }
        return all;
    }

    /**
     * Register all tools from a skill into an agent's ToolExecutor.
     */
    applyToAgent(skillName: string, agent: { registerTool: (name: string, desc: string, params: Record<string, unknown>, fn: ToolFunction) => void }): void {
        const skill = this.skills.get(skillName);
        if (!skill) throw new Error(`Skill not found: ${skillName}`);

        for (const [name, tool] of skill.tools) {
            agent.registerTool(name, tool.definition.function.description ?? "", tool.definition.function.parameters ?? {}, tool.fn);
        }
        log.debug(`Applied skill '${skillName}' tools to agent`);
    }

    /**
     * Apply all loaded skills to an agent.
     */
    applyAllToAgent(agent: { registerTool: (name: string, desc: string, params: Record<string, unknown>, fn: ToolFunction) => void }): void {
        for (const name of this.skills.keys()) {
            this.applyToAgent(name, agent);
        }
    }

    /**
     * Unload a skill.
     */
    unload(name: string): boolean {
        return this.skills.delete(name);
    }

    get loaded(): string[] { return [...this.skills.keys()]; }
    get count(): number { return this.skills.size; }

    /**
     * Generate a manifest template for creating a new skill.
     */
    static generateTemplate(name: string): { manifest: string; index: string } {
        const manifest = JSON.stringify({
            name,
            version: "1.0.0",
            description: `${name} skill for SwarmX`,
            tools: [
                {
                    name: `${name}_action`,
                    description: "TODO: describe what this tool does",
                    parameters: {
                        type: "object",
                        properties: {
                            input: { type: "string", description: "Input parameter" },
                        },
                        required: ["input"],
                    },
                    handler: "handleAction",
                },
            ],
        }, null, 2);

        const index = `// ${name} skill for SwarmX
export async function handleAction(args) {
  const { input } = args;
  // TODO: implement tool logic
  return JSON.stringify({ result: \`Processed: \${input}\` });
}
`;

        return { manifest, index };
    }
}
