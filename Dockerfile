FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Production ────────────────────────────────────────────────

FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY install.sh ./
COPY README.md ./

# Default ports: Gateway 18789, WebChat 3737, Dashboard 3838, Webhooks 9876
EXPOSE 18789 3737 3838 9876

ENV NODE_ENV=production
ENV SWARMX_LOG_LEVEL=info

ENTRYPOINT ["node", "dist/cli/main.js"]
CMD ["--help"]
