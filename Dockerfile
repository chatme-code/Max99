# syntax=docker/dockerfile:1.6
# ^ Wajib di baris pertama supaya BuildKit cache mount aktif.

FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
# Cache mount: simpan ~/.npm antar build supaya download package
# tidak diulang dari nol setiap kali layer di-rebuild.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline --no-audit --progress=false

COPY . .
RUN npx tsx script/build-server.ts


FROM node:20-alpine AS production

WORKDIR /app

COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --prefer-offline --no-audit --progress=false

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/server/public ./server/public

EXPOSE 5000
EXPOSE 9119

ENV NODE_ENV=production

CMD ["node", "dist/index.cjs"]
