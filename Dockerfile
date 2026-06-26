# ── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# npm_config_registry overrides user/project .npmrc AND the resolved URLs
# cached in package-lock.json — both must be bypassed because
# Replit's internal package-firewall.replit.local is unreachable inside Docker.
# The --registry flag on the RUN command provides a second layer of enforcement.
ENV npm_config_registry=https://registry.npmjs.org

WORKDIR /app

COPY package*.json ./
RUN npm install \
      --registry=https://registry.npmjs.org \
      --no-audit \
      --no-fund

COPY . .
RUN npm run build

# ── Stage 2: Production runner ────────────────────────────────────────────────
FROM node:22-alpine AS runner

# Belt-and-suspenders: env var takes precedence over any .npmrc that
# might be copied in, and --registry flag overrides lockfile resolved URLs.
ENV NODE_ENV=production \
    npm_config_registry=https://registry.npmjs.org

WORKDIR /app

COPY package*.json ./
RUN npm install \
      --omit=dev \
      --registry=https://registry.npmjs.org \
      --no-audit \
      --no-fund

COPY --from=builder /app/dist ./dist

# Non-root user: limits blast radius if the container is compromised.
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && mkdir -p /uploads \
    && chown -R appuser:appgroup /app /uploads

USER appuser

EXPOSE 5000

# Graceful shutdown: node handles SIGTERM cleanly with Express 5.
CMD ["node", "dist/server/index.js"]
