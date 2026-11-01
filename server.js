const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));
const PORT = process.env.PORT || 3000;

io.on('connection', (socket) => {
  let user = null;

  const sendSync = async () => {
    if (!user) return;
    try {
      const freshUser = await prisma.user.findUnique({ 
        where: { id: user.id }, 
        include: { buildings: true, guild: true, quests: true } 
      });
      socket.emit('sync', freshUser);
    } catch (e) { console.error(e); }
  };

  // --- АВТОРИЗАЦИЯ ---
  socket.on('auth', async ({ nickname, token }) => {
    try {
      let dbUser;
      if (token) {
        dbUser = await prisma.user.findUnique({ 
          where: { token }, 
          include: { buildings: true, quests: true, guild: true } 
        });
      }
      
      if (!dbUser) {
        if (await prisma.user.findUnique({ where: { nickname } })) {
          return socket.emit('error', 'Этот ник занят. Если это вы, войдите с того же устройства.');
        }
        const newToken = uuidv4();
        dbUser = await prisma.user.create({
          data: {
            nickname, token: newToken,
            buildings: { 
              create: [
                { type: 'house' }, { type: 'forge' }, { type: 'shrine' }, { type: 'datacenter' },
                { type: 'powerplant', level: 1 }, { type: 'factory', level: 1 } // <--- НОВЫЕ ЗДАНИЯ
              ] 
            },
            quests: { create: [{ questKey: 'buildOnce' }, { questKey: 'chatCount' }, { questKey: 'guildCreated' }] }
          },
          include: { buildings: true, quests: true, guild: true }
        });
        socket.emit('newToken', newToken);
      }

      user = dbUser;
      socket.join(user.id);
      
      const now = new Date();
      const elapsedSec = (now - user.lastIncome) / 1000;
      let offline = 0;
      if (elapsedSec > 60) {
        offline = Math.floor(Math.min(elapsedSec, 43200) * (1 + (user.incomeLevel - 1) * 0.5));
        user = await prisma.user.update({
          where: { id: user.id },
          data: { credits: user.credits + offline, lastIncome: now },
          include: { buildings: true, quests: true, guild: true }
        });
      }

      socket.emit('authSuccess', { user, offline });
      
      const history = await prisma.chatMessage.findMany({ take: 50, orderBy: { createdAt: 'desc' }, include: { user: true } });
      socket.emit('chatHistory', history.reverse().map(m => ({ from: m.user.nickname, text: m.text })));
      
      const guilds = await prisma.guild.findMany({ include: { members: true } });
      socket.emit('allGuilds', guilds.map(g => ({ id: g.id, name: g.name, leader: g.leader, members: g.members.length })));
      
    } catch (e) { 
      console.error(e); 
      socket.emit('error', 'Ошибка входа.'); 
    }
  });

  socket.on('getGuilds', async () => {
    try {
      const guilds = await prisma.guild.findMany({ include: { members: true } });
      socket.emit('allGuilds', guilds.map(g => ({ id: g.id, name: g.name, leader: g.leader, members: g.members.length })));
    } catch(e) { console.error(e); }
  });

  socket.on('setClass', async (cls) => {
    if (!user) return;
    try {
      let upd = { playerClass: cls };
      if (cls === 'samurai') {
        const f = await prisma.building.findFirst({ where: { userId: user.id, type: 'forge' } });
        if (f) await prisma.building.update({ where: { id: f.id }, data: { level: 2 } });
      }
      if (cls === 'monk') { upd.maxEnergy = user.maxEnergy + 50; upd.energy = user.energy + 50; }
      if (cls === 'merchant') upd.credits = user.credits + 500;
      
      user = await prisma.user.update({ 
        where: { id: user.id }, 
        data: upd, 
        include: { buildings: true, quests: true, guild: true } 
      });
      socket.emit('classUpdated', user);
    } catch(e) { console.error(e); }
  });

  socket.on('syncPlayer', sendSync);

  // --- ЗДАНИЯ ---
  socket.on('upgradeBuilding', async (bid) => {
    if (!user) return;
    try {
      const b = await prisma.building.findFirst({ where: { userId: user.id, type: bid } });
      if (!b || b.upgrading) return;
      
      let costCredits = 0, costEnergy = 0, costMetal = 0, costParts = 0;

      // Новая экономика
      if (bid === 'powerplant') {
        costCredits = b.level * 500;
        costMetal = b.level * 10;
      } else if (bid === 'factory') {
        costCredits = b.level * 800;
        costMetal = b.level * 20;
        costParts = b.level * 5;
      } else {
        // Старые здания
        costCredits = b.level * 100;
        costEnergy = b.level * 10;
      }

      if (user.credits < costCredits || user.energy < costEnergy || user.metal < costMetal || user.parts < costParts) {
        return socket.emit('error', 'Не хватает ресурсов');
      }
      
      await prisma.$transaction([
        prisma.user.update({ 
          where: { id: user.id }, 
          data: { 
            credits: { decrement: costCredits }, 
            energy: { decrement: costEnergy },
            metal: { decrement: costMetal },
            parts: { decrement: costParts }
          } 
        }),
        prisma.building.update({ where: { id: b.id }, data: { upgrading: true, upgradeEnd: new Date(Date.now() + 30000) } }),
        prisma.userQuest.updateMany({ where: { userId: user.id, questKey: 'buildOnce' }, data: { isDone: true } })
      ]);
      sendSync();
    } catch(e) { console.error(e); }
  });

  socket.on('upgradeIncome', async () => {
    if (!user) return;
    try {
      const cost = user.incomeLevel * 500;
      if (user.credits < cost) return socket.emit('error', 'Мало кредитов');
      
      user = await prisma.user.update({ 
        where: { id: user.id }, 
        data: { credits: { decrement: cost }, incomeLevel: { increment: 1 } }, 
        include: { buildings: true, quests: true, guild: true } 
      });
      socket.emit('sync', user);
    } catch(e) { console.error(e); }
  });

  // --- РУЛЕТКА ---
  socket.on('spinRoulette', async () => {
    if (!user) return;
    try {
      if (user.lastRoulette && Date.now() - new Date(user.lastRoulette).getTime() < 60000) {
        return socket.emit('error', 'Рулетка перезаряжается');
      }
      if (user.credits < 200) return socket.emit('error', 'Нужно 200 кредитов');
      
      let text = 'Пусто', upd = { credits: { decrement: 200 }, lastRoulette: new Date() };
      const roll = Math.random();
      if (roll < 0.1) { upd.shards = { increment: 5 }; text = '5 Осколков!'; }
      else if (roll < 0.3) { upd.energy = { increment: 50 }; text = '50 Энергии!'; }
      else if (roll < 0.9) { upd.credits.increment = 500; text = '500 Кредитов!'; }
      
      user = await prisma.user.update({ 
        where: { id: user.id }, 
        data: upd, 
        include: { buildings: true, quests: true, guild: true } 
      });
      socket.emit('rouletteResult', { text });
      socket.emit('sync', user);
    } catch(e) { console.error(e); }
  });

  // --- ЧАТ ---
  socket.on('chatMessage', async (msg) => {
    if (!user || !msg.trim()) return;
    try {
      await prisma.chatMessage.create({ data: { text: msg, userId: user.id } });
      await prisma.userQuest.updateMany({ where: { userId: user.id, questKey: 'chatCount' }, data: { isDone: true } });
      io.emit('chatMessage', { from: user.nickname, text: msg });
    } catch(e) { console.error(e); }
  });

  // --- МАГАЗИН ---
  socket.on('buyItem', async (item) => {
    if (!user) return;
    try {
      const prices = { energy: 5, credits: 10, instantBuild: 15 };
      if (user.shards < prices[item]) return socket.emit('error', 'Мало осколков');
      
      let upd = { shards: { decrement: prices[item] } };
      if (item === 'energy') upd.energy = { increment: 50 };
      if (item === 'credits') upd.credits = { increment: 1000 };
      if (item === 'instantBuild') {
        await prisma.building.updateMany({ where: { userId: user.id, upgrading: true }, data: { upgradeEnd: new Date() } });
      }
      
      user = await prisma.user.update({ 
        where: { id: user.id }, 
        data: upd, 
        include: { buildings: true, quests: true, guild: true } 
      });
      socket.emit('sync', user);
    } catch(e) { console.error(e); }
  });

  // --- КВЕСТЫ И ПРОМО ---
  socket.on('claimQuest', async (qKey) => {
    if (!user) return;
    try {
      await prisma.userQuest.updateMany({ where: { userId: user.id, questKey: qKey }, data: { isClaimed: true } });
      let reward = qKey === 'buildOnce' ? 500 : qKey === 'chatCount' ? 5 : 2000;
      
      if (qKey === 'chatCount') {
        user = await prisma.user.update({ where: { id: user.id }, data: { shards: { increment: reward } }, include: { buildings: true, quests: true, guild: true } });
      } else {
        user = await prisma.user.update({ where: { id: user.id }, data: { credits: { increment: reward } }, include: { buildings: true, quests: true, guild: true } });
      }
      socket.emit('sync', user);
    } catch(e) { console.error(e); }
  });

  socket.on('redeemPromo', async (code) => {
    if (!user) return;
    try {
      if (code !== 'TEST100') return socket.emit('error', 'Неверный код');
      if (user.promoUsed) return socket.emit('error', 'Уже использован');
      
      user = await prisma.user.update({ 
        where: { id: user.id }, 
        data: { promoUsed: true, shards: { increment: 100 } }, 
        include: { buildings: true, quests: true, guild: true } 
      });
      socket.emit('success', 'Промокод активирован!');
      socket.emit('sync', user);
    } catch(e) { console.error(e); }
  });

  socket.on('claimDaily', async () => {
    if (!user) return;
    try {
      if (user.lastDaily && Date.now() - new Date(user.lastDaily).getTime() < 86400000) {
        return socket.emit('error', 'Награда еще не готова');
      }
      user = await prisma.user.update({ 
        where: { id: user.id }, 
        data: { lastDaily: new Date(), shards: { increment: 50 }, credits: { increment: 1000 } }, 
        include: { buildings: true, quests: true, guild: true } 
      });
      socket.emit('success', 'Ежедневная награда получена!');
      socket.emit('sync', user);
    } catch(e) { console.error(e); }
  });

  // --- ГИЛЬДИИ ---
  socket.on('createGuild', async (name) => {
    if (!user) return;
    try {
      if (user.credits < 500) return socket.emit('error', 'Нужно 500 кредитов');
      if (user.guildId) return socket.emit('error', 'Вы уже в гильдии');
      
      const existing = await prisma.guild.findUnique({ where: { name } });
      if (existing) return socket.emit('error', 'Это имя уже занято');

      const guild = await prisma.guild.create({ data: { name, leader: user.nickname } });
      
      user = await prisma.user.update({
        where: { id: user.id },
        data: { credits: { decrement: 500 }, guildId: guild.id, guildRole: 'leader' },
        include: { buildings: true, quests: true, guild: true }
      });
      
      await prisma.userQuest.updateMany({ where: { userId: user.id, questKey: 'guildCreated' }, data: { isDone: true } });
      
      socket.emit('success', 'Гильдия создана!');
      socket.emit('sync', user);
      
      const guilds = await prisma.guild.findMany({ include: { members: true } });
      io.emit('allGuilds', guilds.map(g => ({ id: g.id, name: g.name, leader: g.leader, members: g.members.length })));
    } catch (e) {
      console.error(e);
      socket.emit('error', 'Ошибка при создании гильдии');
    }
  });

  socket.on('requestJoinGuild', async (guildId) => {
    if (!user || user.guildId) return;
    try {
      const guild = await prisma.guild.findUnique({ where: { id: guildId } });
      if (!guild) return;
      
      user = await prisma.user.update({
        where: { id: user.id },
        data: { guildId: guild.id, guildRole: 'private' },
        include: { buildings: true, quests: true, guild: true }
      });
      socket.emit('success', `Вы вступили в гильдию ${guild.name}!`);
      socket.emit('sync', user);
      
      const guilds = await prisma.guild.findMany({ include: { members: true } });
      io.emit('allGuilds', guilds.map(g => ({ id: g.id, name: g.name, leader: g.leader, members: g.members.length })));
    } catch(e) { console.error(e); }
  });

  // --- ТОРГОВЛЯ ---
  socket.on('createTrade', async (data) => {
    if (!user) return;
    try {
      if (data.amount <= 0 || data.price <= 0) return socket.emit('error', 'Неверные данные');
      if (user.credits < data.amount) return socket.emit('error', 'Мало кредитов');
      
      await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: data.amount } } }),
        prisma.tradeOffer.create({ data: { sellerId: user.id, resource: 'credits', amount: data.amount, price: data.price } })
      ]);
      socket.emit('success', 'Ордер создан');
      sendSync();
    } catch(e) { console.error(e); }
  });

  socket.on('getTrades', async () => {
    try {
      const offers = await prisma.tradeOffer.findMany({ include: { seller: true } });
      socket.emit('tradesList', offers);
    } catch(e) { console.error(e); }
  });

  socket.on('buyTrade', async (offerId) => {
    if (!user) return;
    try {
      const offer = await prisma.tradeOffer.findUnique({ where: { id: offerId }, include: { seller: true } });
      if (!offer || offer.sellerId === user.id) return socket.emit('error', 'Недоступно');
      if (user.credits < offer.price) return socket.emit('error', 'Мало кредитов');

      await prisma.$transaction([
        prisma.user.update({ where: { id: user.id }, data: { credits: { decrement: offer.price } } }),
        prisma.user.update({ where: { id: offer.sellerId }, data: { credits: { increment: offer.price } } }),
        prisma.tradeOffer.delete({ where: { id: offer.id } })
      ]);
      socket.emit('success', 'Куплено!');
      sendSync();
    } catch(e) { console.error(e); }
  });

  socket.on('disconnect', () => { user = null; });
});

// Завершение строек и ПРОИЗВОДСТВО РЕСУРСОВ
setInterval(async () => {
  try {
    const now = new Date();
    const doneBuildings = await prisma.building.findMany({ where: { upgrading: true, upgradeEnd: { lte: now } } });
    for (const b of doneBuildings) {
      await prisma.building.update({ where: { id: b.id }, data: { upgrading: false, level: { increment: 1 } } });
      io.to(b.userId).emit('buildingDone', b.type);
    }

    // Производство (только для тех, у кого есть Завод или Электростанция)
    const activeUsers = await prisma.user.findMany({ 
      where: { buildings: { some: { type: { in: ['factory', 'powerplant'] }, level: { gt: 1 } } } },
      include: { buildings: true } 
    });

    for (const u of activeUsers) {
      const pLevel = u.buildings.find(b => b.type === 'powerplant')?.level || 0;
      const fLevel = u.buildings.find(b => b.type === 'factory')?.level || 0;
      
      if (pLevel > 0 || fLevel > 0) {
        await prisma.user.update({
          where: { id: u.id },
          data: {
            metal: { increment: Math.floor(fLevel * 1.5) },
            parts: { increment: Math.floor(fLevel * 0.5) },
            energy: { increment: Math.floor(pLevel * 2) }
          }
        });
        io.to(u.id).emit('syncPlayer'); // Обновляем интерфейс онлайн-игрокам
      }
    }
  } catch(e) { console.error(e); }
}, 5000);

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));