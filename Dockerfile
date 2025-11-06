# ───────────────────────────────
# 🍂 Automn Dockerfile
# ───────────────────────────────
FROM node:22-slim AS base
WORKDIR /app
# Host runners now execute remotely; keep the base image minimal.

# ───────────────────────────────
# Build frontend (Vite)
# ───────────────────────────────
FROM base AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ .
RUN npm run build

# ───────────────────────────────
# Build backend
# ───────────────────────────────
FROM base AS backend
WORKDIR /app

# Copy backend (everything except node_modules)
COPY package*.json ./
RUN npm install --production
COPY . .

# Copy built frontend into public folder for serving
RUN mkdir -p /app/public
COPY --from=frontend-builder /app/frontend/dist /app/public

# Persist database/logs
VOLUME ["/app/data", "/app/logs"]

EXPOSE 8088
ENV NODE_ENV=production
ENV PORT=8088

CMD ["node", "server.js"]
