FROM node:18-alpine

WORKDIR /app

# Устанавливаем зависимости
COPY package*.json ./
RUN npm ci --production

# Копируем проект
COPY . .

# Генерируем Prisma Client
RUN npx prisma generate

ENV PORT=8080
EXPOSE 8080

# При старте создаём базу и запускаем сервер (от root, чтобы точно были права на /data)
CMD ["sh", "-c", "npx prisma db push && node server.js"]