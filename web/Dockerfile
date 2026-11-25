# syntax=docker/dockerfile:1
FROM nginxinc/nginx-unprivileged:1.31-alpine

LABEL org.opencontainers.image.source="https://github.com/dangwii/sistemadistribuido3capas" \
      org.opencontainers.image.description="Mini-IMDb Web Frontend (Nginx Unprivileged)" \
      org.opencontainers.image.version="2.2.0"

ENV API_UPSTREAM=http://api:8080

COPY --chown=101:101 site1/index.html /usr/share/nginx/html/index.html
COPY --chown=101:101 catalog.js /usr/share/nginx/html/catalog.js
COPY --chown=101:101 catalog.css /usr/share/nginx/html/catalog.css
COPY --chown=101:101 nginx.k8s.conf.template /etc/nginx/templates/default.conf.template

USER 101

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
