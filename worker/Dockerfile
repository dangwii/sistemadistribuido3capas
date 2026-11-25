# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

FROM node:22-alpine AS runtime

LABEL org.opencontainers.image.source="https://github.com/dangwii/sistemadistribuido3capas" \
      org.opencontainers.image.description="Mini-IMDb Async Queue Worker (RabbitMQ -> MongoDB/Redis)" \
      org.opencontainers.image.version="2.2.0"

ENV NODE_ENV=production \
    WORKER_PORT=8081

WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json index.js tracing.js ./

USER node

EXPOSE 8081

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8081/healthz || exit 1

CMD ["node", "--import", "./tracing.js", "index.js"]
