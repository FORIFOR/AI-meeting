FROM node:22-bookworm-slim AS workspace
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm --filter @rcai/web... --filter @rcai/token-broker... install --frozen-lockfile --ignore-scripts

FROM workspace AS web-build
ENV VITE_RCAI_CLOUD=true
ENV VITE_RCAI_RELEASE_CHANNEL=beta
RUN pnpm build

FROM caddy:2-alpine AS web
COPY deploy/cloud/Caddyfile /etc/caddy/Caddyfile
COPY --from=web-build /app/apps/web/dist /srv

FROM workspace AS broker
ENV HOST=0.0.0.0 PORT=8787 NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["pnpm", "--filter", "@rcai/token-broker", "start"]
