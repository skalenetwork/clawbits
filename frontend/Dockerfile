# syntax=docker/dockerfile:1.7

FROM oven/bun:1-alpine AS build
WORKDIR /fe
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . ./
RUN bun run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /fe/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
