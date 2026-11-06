# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

ARG APP_COMMIT_SHA=unknown

ENV NODE_ENV=production \
    PORT=8080 \
    APP_COMMIT_SHA=${APP_COMMIT_SHA}

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); if (major !== 22 || minor < 22 || (minor === 22 && patch < 2)) process.exit(1)' \
    && npm ci --omit=dev --engine-strict && npm cache clean --force

COPY --chown=node:node . .

USER node

EXPOSE 8080

CMD ["npm", "start"]
