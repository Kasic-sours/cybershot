FROM node:18-alpine

WORKDIR /app

# Создаем папку /data и даем права
RUN mkdir -p /data && chown -R node:node /data

COPY package*.json ./
RUN npm ci --production

# Копируем все файлы
COPY . .

# Генерируем Prisma Client
RUN npx prisma generate

USER node

ENV PORT=8080
EXPOSE 8080

# При старте: создаем базу данных и запускаем сервер
CMD ["sh", "-c", "npx prisma db push && node server.js"]