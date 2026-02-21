# Installation

## Requirements

- Node.js 20 or higher
- npm 9+

## Install from npm

```bash
npm install groklets
```

## Install from source

```bash
git clone https://github.com/Arbazxkr/Groklets.git
cd Groklets
npm install
npm run build
```

## Docker

```bash
docker build -t groklets .
docker run --env-file .env groklets
```

## CLI (Global Install)

```bash
npm install -g groklets
groklets --help
```

## Environment Setup

Create a `.env` file with your API keys:

```env
# At least one provider key is required
OPENAI_API_KEY=sk-xxx
ANTHROPIC_API_KEY=sk-ant-xxx
GOOGLE_API_KEY=AIza-xxx
XAI_API_KEY=xai-xxx
```

Groklets uses **Bring Your Own Key (BYOK)** — you provide your own API keys, your data stays on your machine.
