# The storefront demo as a Containers app: the built SPA plus a small Node
# server (/config.js, /api/views, /api/trending) on port 8080, as a non-root user.
# The setup script ships too, so a project can be set up without a checkout:
#   docker run --rm -e EXCALIBASE_API=... <image> node setup/setup.mjs
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm test && npm run build && npm prune --omit=dev && rm -f server/*.test.mjs setup/*.test.mjs

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
# The server needs node only: no package managers in the running image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/setup ./setup
USER 1000:1000
EXPOSE 8080
CMD ["node", "server/server.mjs"]
