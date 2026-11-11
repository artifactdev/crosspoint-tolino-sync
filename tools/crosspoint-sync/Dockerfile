FROM node:24-alpine AS source

RUN apk add --no-cache ca-certificates git
WORKDIR /source
COPY upstream-revision tolino.patch ./
RUN REF="$(cat upstream-revision)" \
    && echo "$REF" | grep -Eq '^[0-9a-f]{40}$' \
    && git init \
    && git remote add origin https://github.com/crosspoint-reader/crosspoint-sync.git \
    && git fetch --depth 1 origin "$REF" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "$REF" \
    && git apply --check tolino.patch \
    && git apply tolino.patch

FROM node:24-alpine AS build
WORKDIR /app
COPY --from=source /source/package.json /source/package-lock.json ./
RUN npm ci
COPY --from=source /source/tsconfig.json ./tsconfig.json
COPY --from=source /source/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine AS web
WORKDIR /web
COPY --from=source /source/app/package.json /source/app/package-lock.json ./
RUN npm ci
COPY --from=source /source/app/index.html /source/app/vite.config.js ./
COPY --from=source /source/app/public ./public
COPY --from=source /source/app/src ./src
RUN npx vite build

FROM node:24-alpine
ENV NODE_ENV=production \
    DATABASE_PATH=/data/crosspoint.db \
    PORT=8080 \
    WEB_APP_DIR=/app/web \
    LISTEN_ADDRESS=::
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./web
COPY --from=source /source/migrations ./migrations
COPY --from=source /source/assets ./assets
COPY --from=source /source/extension ./extension
COPY --from=source /source/package.json ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- "http://127.0.0.1:${PORT}$(printf '%s' "$BASE_PATH" | sed 's:/*$::')/healthz" || exit 1
CMD ["node", "dist/index.js"]
