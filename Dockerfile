FROM node:26-bookworm-slim AS build

WORKDIR /app
# Native SQLite builds need this fallback toolchain; it stays out of runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
RUN install -d -m 0700 -o node -g node /data
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/http.js"]
