/**
 * SwarmX Logger — Structured logging with levels and color output.
 */

import chalk from "chalk";

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    SILENT = 4,
}

const LEVEL_LABELS: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: chalk.dim("DEBUG"),
    [LogLevel.INFO]: chalk.cyan("INFO "),
    [LogLevel.WARN]: chalk.yellow("WARN "),
    [LogLevel.ERROR]: chalk.red("ERROR"),
    [LogLevel.SILENT]: "",
};

export class Logger {
    private level: LogLevel;
    private prefix: string;

    constructor(prefix: string, level: LogLevel = LogLevel.INFO) {
        this.prefix = prefix;
        this.level = level;
    }

    setLevel(level: LogLevel): void {
        this.level = level;
    }

    private format(level: LogLevel, msg: string): string {
        const ts = new Date().toISOString().slice(11, 23);
        return `${chalk.dim(ts)} ${LEVEL_LABELS[level]} ${chalk.dim("[")}${chalk.bold(this.prefix)}${chalk.dim("]")} ${msg}`;
    }

    debug(msg: string, ...args: unknown[]): void {
        if (this.level <= LogLevel.DEBUG) {
            console.log(this.format(LogLevel.DEBUG, msg), ...args);
        }
    }

    info(msg: string, ...args: unknown[]): void {
        if (this.level <= LogLevel.INFO) {
            console.log(this.format(LogLevel.INFO, msg), ...args);
        }
    }

    warn(msg: string, ...args: unknown[]): void {
        if (this.level <= LogLevel.WARN) {
            console.warn(this.format(LogLevel.WARN, msg), ...args);
        }
    }

    error(msg: string, ...args: unknown[]): void {
        if (this.level <= LogLevel.ERROR) {
            console.error(this.format(LogLevel.ERROR, msg), ...args);
        }
    }

    child(prefix: string): Logger {
        return new Logger(`${this.prefix}:${prefix}`, this.level);
    }
}

/** Global log level — set via SWARMX_LOG_LEVEL env or programmatically */
let globalLevel = LogLevel.INFO;

const envLevel = process.env.SWARMX_LOG_LEVEL?.toUpperCase();
if (envLevel === "DEBUG") globalLevel = LogLevel.DEBUG;
else if (envLevel === "WARN") globalLevel = LogLevel.WARN;
else if (envLevel === "ERROR") globalLevel = LogLevel.ERROR;
else if (envLevel === "SILENT") globalLevel = LogLevel.SILENT;

export function createLogger(prefix: string): Logger {
    return new Logger(prefix, globalLevel);
}

export function setGlobalLogLevel(level: LogLevel): void {
    globalLevel = level;
}
