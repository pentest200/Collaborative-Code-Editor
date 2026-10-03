FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY services/collab/package.json services/collab/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --no-audit --no-fund
COPY apps/web apps/web
COPY packages/protocol packages/protocol
RUN npm run build -w @cce/protocol && npm run build -w @cce/web
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@cce/web"]
