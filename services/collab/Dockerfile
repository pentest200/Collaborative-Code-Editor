FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/web/package.json apps/web/package.json
COPY services/collab/package.json services/collab/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci --no-audit --no-fund
COPY services/collab services/collab
COPY packages/protocol packages/protocol
RUN npm run build -w @cce/collab
ENV NODE_ENV=production
EXPOSE 8081
CMD ["npm", "run", "start", "-w", "@cce/collab"]
