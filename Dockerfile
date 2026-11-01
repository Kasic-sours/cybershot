FROM node:18-slim

WORKDIR /app

# Устанавливаем openssl для работы Prisma на Debian
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --production

COPY . .

# Генерируем Prisma Client
RUN npx prisma generate

ENV PORT=8080
EXPOSE 8080

# Запускаем создание базы и сервер
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node server.js"]