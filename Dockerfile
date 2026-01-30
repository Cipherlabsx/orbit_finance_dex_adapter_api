# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
WORKDIR /app

# pnpm needs corepack on alpine
RUN corepack enable

# deps
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
# If you use a pnpm workspace, also copy:
# COPY pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# build
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build

# run
FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production

# create non-root user
RUN addgroup -S app && adduser -S app -G app

# Copy only what runtime needs
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# if you serve static IDL, copy it too:
COPY --from=build /app/src/idl ./dist/idl

USER app
EXPOSE 8080
CMD ["node", "dist/index.js"]