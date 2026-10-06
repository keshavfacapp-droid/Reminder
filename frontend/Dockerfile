# Build context: repository root (see docker-compose.yml).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci --workspace frontend --ignore-scripts
COPY frontend frontend
RUN npm run build --workspace frontend

# Caddy (Apache-2.0): static files, reverse proxy and automatic HTTPS.
FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/frontend/dist /srv
