# Dockerfile
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS run
WORKDIR /app
ENV NODE_ENV=production
# create non-root user
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# if you serve static IDL, copy it too:
COPY --from=build /app/src/idl ./dist/idl
USER app
EXPOSE 8080
CMD ["node", "dist/index.js"]