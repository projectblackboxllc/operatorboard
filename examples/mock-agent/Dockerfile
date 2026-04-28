FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY examples/mock-agent/package.json ./examples/mock-agent/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY examples/mock-agent ./examples/mock-agent
RUN pnpm --filter @operatorboard/shared build
RUN pnpm --filter @operatorboard/mock-agent build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY examples/mock-agent/package.json ./examples/mock-agent/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/examples/mock-agent/dist ./examples/mock-agent/dist

EXPOSE 4200
CMD ["node", "examples/mock-agent/dist/index.js"]
