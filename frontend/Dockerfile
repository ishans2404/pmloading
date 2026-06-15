# ── Build stage ────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --legacy-peer-deps || npm install --legacy-peer-deps

COPY . .
RUN npm run build

# ── Serve stage ────────────────────────────────────────────────────
FROM nginx:alpine

# Copy the Vite build into a /pmloading/ subdirectory so that the
# asset paths emitted by the build (/pmloading/assets/…) resolve
# directly to real files on disk under nginx's root.
COPY --from=builder /app/dist /usr/share/nginx/html/pmloading

# Drop in the custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8705

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8705/pmloading/ | grep -q '<div id="root">' || exit 1

CMD ["nginx", "-g", "daemon off;"]