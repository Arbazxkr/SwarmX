# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Groklets, please report it responsibly.

**Do NOT open a public issue.**

Email: [arbazxkr@gmail.com](mailto:arbazxkr@gmail.com)

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Assessment**: Within 7 days
- **Fix**: Depending on severity, typically within 14 days

## Scope

The following are in scope:
- Input sanitization bypass
- Sandbox escape (VM execution)
- Rate limiter bypass
- Skill trust verification bypass
- Authentication/authorization issues in Gateway
- Path traversal in file operations
- Injection attacks (SQL, shell, script)

The following are out of scope:
- Issues in third-party dependencies (report to the dependency maintainer)
- Denial of service via resource exhaustion (expected behavior at scale)
- Issues requiring physical access to the machine

## Supported Versions

| Version | Supported |
|---|---|
| 0.6.x | ✅ |
| < 0.6.0 | ❌ |

## Security Design

Groklets includes several security layers:

- **Input sanitization** — blocks script/shell/SQL injection and path traversal
- **Rate limiting** — token bucket per sender
- **Skill trust** — SHA-256 hash verification before loading
- **Tool guard** — allowlist/blocklist for tool execution
- **Sandbox** — VM-based code execution with timeout, no fs/network access
