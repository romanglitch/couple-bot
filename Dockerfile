# ---- Build Stage ----
FROM node:20-alpine AS builder

WORKDIR /app

# Копируем только файлы зависимостей для кеширования слоёв
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && \
    # sharp требует пересборки под alpine/musl
    npm rebuild sharp

# ---- Production Stage ----
FROM node:20-alpine AS production

# Tini для корректной обработки SIGINT/SIGTERM в контейнере
RUN apk add --no-cache tini

WORKDIR /app

# Копируем node_modules из builder и исходники
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY bot.js ./

# Создаём директорию для данных (volume mount point)
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

# Tini как PID 1 для graceful shutdown
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "bot.js"]