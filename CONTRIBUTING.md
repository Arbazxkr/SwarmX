# Contributing to Groklets

Thank you for your interest in contributing to Groklets.

## Getting Started

```bash
git clone https://github.com/Arbazxkr/Groklets.git
cd Groklets
npm install
npm run dev
```

## Development

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm test` | Run all tests |
| `npm run test:watch` | Run tests in watch mode |
| `npm run typecheck` | TypeScript type checking |
| `npm run lint` | Run ESLint |
| `npm run build` | Build for production |
| `npm run clean` | Remove dist/ |

## Project Structure

```
src/
├── core/          # Engine, agents, workflows, events, providers
├── channels/      # Messaging platforms (WhatsApp, Telegram, etc.)
├── providers/     # LLM provider adapters
├── plugins/       # Skills, browser, cron, dashboard
├── cli/           # CLI commands
└── utils/         # Config, logger, retry
```

## Code Style

- TypeScript strict mode
- ESLint for linting
- Use descriptive variable names
- Add JSDoc comments for public APIs
- Keep files under 500 lines

## Testing

Write tests for all new features. Tests go in `tests/` and use Vitest.

```bash
# Run all tests
npm test

# Run specific test file
npx vitest run tests/workflow.test.ts

# Watch mode
npm run test:watch
```

## Pull Requests

1. Fork the repo and create a branch from `main`
2. Add tests for new functionality
3. Ensure all tests pass: `npm test`
4. Ensure type checking passes: `npm run typecheck`
5. Write a clear PR description
6. Submit the PR

## Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Node.js version
- OS

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
