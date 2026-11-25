# syntax=docker/dockerfile:1
FROM node:26-alpine AS deps

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

FROM node:26-alpine AS runtime

LABEL org.opencontainers.image.source="https://github.com/dangwii/sistemadistribuido3capas" \
      org.opencontainers.image.description="Mini-IMDb Distributed API (Node.js)" \
      org.opencontainers.image.version="2.2.0"

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json index.js init-db.js tracing.js ./

USER node

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "--import", "./tracing.js", "index.js"]
