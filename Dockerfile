# syntax=docker/dockerfile:1.7

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
USER node
# HTTP transport listens on 3000 when started with `node dist/http.js`.
# Default CMD remains the Nostr/ContextVM transport for backward compatibility;
# override CMD (or run a sibling service) to expose HTTP.
EXPOSE 3000
CMD ["node", "dist/index.js"]
