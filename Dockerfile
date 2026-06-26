FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN npm config set registry https://registry.npmjs.org
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=builder /app/dist ./dist

# BUL-09: run as non-root user to limit blast radius if container is compromised
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
    && mkdir -p /uploads \
    && chown -R appuser:appgroup /app /uploads
USER appuser

EXPOSE 5000
CMD ["node", "dist/server/index.js"]
