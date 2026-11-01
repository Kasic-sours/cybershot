const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } 
  catch { return { players: {}, guilds: {}, idToNick: {} }; }
}
function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

let data = loadData();
if (!data.idToNick) data.idToNick = {};
app.use(express.static('public'));

// Генерация короткого ID (например: A1B2C3)
function generateId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
  socket.on('register', (nickname) => {
    if (!nickname || nickname.length < 2) return socket.emit('error', 'Ник слишком короткий');
    
    let player = data.players[nickname];
    let offlineEarnings = 0;
    
    if (!player) {
      const newId = generateId();
      player = {
        id: newId, nickname, level: 1, exp: 0, credits: 100, energy: 50, maxEnergy: 50, shards: 0,
        incomeLevel: 1, playerClass: null, promoUsed: false,
        friends: [], friendRequests: [], guildInvites: [], lastDaily: 0,
        quests: { buildOnce: false, chatCount: 0, guildCreated: false, claimed: {} },
        buildings: {
          house: { level: 1, upgrading: false, upgradeEnd: 0 },
          forge: { level: 1, upgrading: false, upgradeEnd: 0 },
          shrine: { level: 1, upgrading: false, upgradeEnd: 0 },
          datacenter: { level: 1, upgrading: false, upgradeEnd: 0 }
        },
        guildId: null, guildRole: null, lastIncome: Date.now()
      };
      data.players[nickname] = player;
      data.idToNick[newId] = nickname;
      saveData(data);
    } else {
      // --- Офлайн доход (максимум 12 часов) ---
      const now = Date.now();
      const elapsedSec = (now - player.lastIncome) / 1000;
      if (elapsedSec > 60) { // Если отсутствовал больше минуты
        const incomeRate = 1 + (player.incomeLevel - 1) * 0.5;
        const cappedSec = Math.min(elapsedSec, 12 * 3600); // Кап 12 часов
        offlineEarnings = Math.floor(cappedSec * incomeRate);
        player.credits += offlineEarnings;
      }
      player.lastIncome = now;
      
      // Миграция на случай старых данных
      if (!player.id) { player.id = generateId(); data.idToNick[player.id] = nickname; }
      if (!player.friends) player.friends = [];
      if (!player.friendRequests) player.friendRequests = [];
      if (!player.guildInvites) player.guildInvites = [];
      if (player.lastDaily === undefined) player.lastDaily = 0;
      if (!player.quests) player.quests = { buildOnce: false, chatCount: 0, guildCreated: false, claimed: {} };
      saveData(data);
    }
    
    socket.nickname = nickname;
    socket.emit('registered', { player, offlineEarnings });
  });

  socket.on('setClass', (className) => {
    const player = data.players[socket.nickname];
    if (!player || player.playerClass) return;
    player.playerClass = className;
    if (className === 'samurai') player.buildings.forge.level = 2;
    if (className === 'monk') { player.maxEnergy += 50; player.energy += 50; }
    if (className === 'merchant') player.credits += 500;
    saveData(data);
    socket.emit('classUpdated', player);
  });

  socket.on('setOnline', (nickname) => {
    socket.nickname = nickname;
  });

  socket.on('chatMessage', (msg) => {
    if (!socket.nickname || !msg.trim()) return;
    const player = data.players[socket.nickname];
    const guildName = player?.guildId ? data.guilds[player.guildId]?.name : null;
    player.quests.chatCount += 1;
    saveData(data);
    io.emit('chatMessage', { from: socket.nickname, guild: guildName, text: msg, time: Date.now() }); 
  });

  socket.on('syncPlayer', () => {
    const player = data.players[socket.nickname];
    if (player) socket.emit('playerSync', player);
  });

  // --- Друзья ---
  socket.on('addFriend', (targetId) => {
    const player = data.players[socket.nickname];
    if (targetId === player.id) return socket.emit('error', 'Это ваш ID');
    
    const targetNick = data.idToNick[targetId];
    if (!targetNick) return socket.emit('error', 'Игрок с таким ID не найден');
    
    const target = data.players[targetNick];
    if (player.friends.includes(targetId)) return socket.emit('error', 'Он уже у вас в друзьях');
    
    if (!target.friendRequests.includes(player.id)) {
      target.friendRequests.push(player.id);
      saveData(data);
      io.to(targetNick).emit('friendRequestReceived', { id: player.id, nickname: player.nickname });
    }
    socket.emit('error', 'Запрос в друзья отправлен!');
  });

  socket.on('acceptFriend', (senderId) => {
    const player = data.players[socket.nickname];
    const senderNick = data.idToNick[senderId];
    if (!senderNick) return;
    const sender = data.players[senderNick];
    
    // Убираем из запросов
    player.friendRequests = player.friendRequests.filter(id => id !== senderId);
    // Добавляем друг друга
    if (!player.friends.includes(senderId)) player.friends.push(senderId);
    if (!sender.friends.includes(player.id)) sender.friends.push(player.id);
    
    saveData(data);
    socket.emit('friendsUpdated', player.friends.map(id => ({ id, nickname: data.idToNick[id] })));
    io.to(senderNick).emit('error', `${player.nickname} принял ваш запрос в друзья!`);
  });

  socket.on('getFriends', () => {
    const player = data.players[socket.nickname];
    const friendsList = player.friends.map(id => ({ id, nickname: data.idToNick[id] }));
    const reqsList = player.friendRequests.map(id => ({ id, nickname: data.idToNick[id] }));
    const guildInvs = player.guildInvites.map(gid => ({ id: gid, name: data.guilds[gid]?.name }));
    socket.emit('friendsData', { friends: friendsList, requests: reqsList, invites: guildInvs });
  });

  // --- Гильдии и Приглашения ---
  socket.on('createGuild', (guildName) => {
    const player = data.players[socket.nickname];
    if (!player || player.credits < 500) return socket.emit('error', 'Нужно 500 кредитов!');
    if (player.guildId) return socket.emit('error', 'Вы уже в гильдии');
    
    const guildId = 'g_' + Date.now();
    data.guilds[guildId] = { id: guildId, name: guildName, leader: socket.nickname, members: { [socket.nickname]: 'leader' } };
    player.credits -= 500; player.guildId = guildId; player.guildRole = 'leader';
    player.quests.guildCreated = true;
    saveData(data); 
    socket.emit('guildUpdated', data.guilds[guildId]);
  });

  socket.on('inviteToGuild', (targetId) => {
    const player = data.players[socket.nickname];
    if (!player.guildId || player.guildRole !== 'leader') return socket.emit('error', 'Вы не лидер гильдии');
    
    const targetNick = data.idToNick[targetId];
    if (!targetNick) return socket.emit('error', 'Игрок с таким ID не найден');
    
    const target = data.players[targetNick];
    if (target.guildId) return socket.emit('error', 'Игрок уже в другой гильдии');
    
    if (!target.guildInvites.includes(player.guildId)) {
      target.guildInvites.push(player.guildId);
      saveData(data);
      io.to(targetNick).emit('guildInviteReceived', { guildId: player.guildId, guildName: data.guilds[player.guildId].name });
      socket.emit('error', 'Приглашение отправлено!');
    } else {
      socket.emit('error', 'Приглашение уже отправлено');
    }
  });

  socket.on('acceptGuildInvite', (guildId) => {
    const player = data.players[socket.nickname];
    const guild = data.guilds[guildId];
    if (!guild) return;
    
    player.guildInvites = player.guildInvites.filter(id => id !== guildId);
    player.guildId = guildId;
    player.guildRole = 'private';
    guild.members[player.nickname] = 'private';
    
    saveData(data);
    socket.emit('guildUpdated', guild);
    io.to(guild.leader).emit('guildUpdated', guild); // Обновляем лидера
  });

  // --- Профиль ---
  socket.on('getProfile', (nickname) => {
    const p = data.players[nickname];
    if (!p) return;
    const guild = p.guildId ? data.guilds[p.guildId] : null;
    socket.emit('profileData', { 
      nickname: p.nickname, id: p.id, level: p.level, guild: guild ? guild.name : 'Нет', playerClass: p.playerClass || 'Не выбран',
      credits: p.credits, shards: p.shards, incomeLevel: p.incomeLevel, promoUsed: p.promoUsed, lastDaily: p.lastDaily
    });
  });

  // --- Ежедневная награда ---
  socket.on('claimDaily', () => {
    const player = data.players[socket.nickname];
    const now = Date.now();
    if (now - player.lastDaily < 24 * 3600 * 1000) return socket.emit('error', 'Награда еще не готова');
    player.lastDaily = now;
    player.shards += 50; // 50 алмазов
    player.credits += 1000;
    saveData(data);
    socket.emit('dailyClaimed', player);
  });

  // --- Промокод ---
  socket.on('redeemPromo', (code) => {
    const player = data.players[socket.nickname];
    if (code === 'TEST100') {
      if (player.promoUsed) return socket.emit('error', 'Вы уже использовали этот промокод!');
      player.promoUsed = true; player.shards += 100;
      saveData(data); socket.emit('promoSuccess');
    } else { socket.emit('error', 'Неверный промокод'); }
  });

  // --- Остальное (постройки, квесты) ---
  socket.on('upgradeBuilding', (buildingId) => {
    const player = data.players[socket.nickname];
    const b = player.buildings[buildingId];
    if (b.upgrading) return;
    const cost = b.level * 100, energyCost = b.level * 10;
    if (player.credits < cost || player.energy < energyCost) return socket.emit('error', 'Не хватает ресурсов!');
    player.credits -= cost; player.energy -= energyCost;
    b.upgrading = true; b.upgradeEnd = Date.now() + 30000;
    player.quests.buildOnce = true;
    saveData(data); socket.emit('buildingUpdated', { id: buildingId, building: b });
  });

  socket.on('upgradeIncome', () => {
    const player = data.players[socket.nickname];
    const cost = player.incomeLevel * 500;
    if (player.credits < cost) return socket.emit('error', 'Не хватает кредитов!');
    player.credits -= cost; player.incomeLevel += 1;
    saveData(data); socket.emit('incomeUpdated', player.incomeLevel);
  });

  socket.on('buyItem', (itemId) => {
    const player = data.players[socket.nickname];
    const prices = { energy: 5, credits: 10, instantBuild: 15 };
    if (player.shards < prices[itemId]) return socket.emit('error', 'Не хватает осколков!');
    player.shards -= prices[itemId];
    if (itemId === 'energy') player.energy = Math.min(player.maxEnergy, player.energy + 50);
    if (itemId === 'credits') player.credits += 1000;
    if (itemId === 'instantBuild') for (let id in player.buildings) if (player.buildings[id].upgrading) player.buildings[id].upgradeEnd = Date.now();
    saveData(data); socket.emit('shopSuccess');
  });

  socket.on('claimQuest', (questId) => {
    const player = data.players[socket.nickname];
    const q = player.quests;
    if (q.claimed[questId]) return;

    if (questId === 'q1' && q.buildOnce) { player.credits += 500; q.claimed.q1 = true; }
    else if (questId === 'q2' && q.chatCount >= 3) { player.shards += 5; q.claimed.q2 = true; }
    else if (questId === 'q3' && q.guildCreated) { player.credits += 2000; q.claimed.q3 = true; }
    else return;

    saveData(data); socket.emit('questClaimed', { questId, player });
  });
});

// Фоновый цикл (доход и стройка)
setInterval(() => {
  let changed = false;
  for (const nick in data.players) {
    const p = data.players[nick];
    const now = Date.now();
    const elapsed = (now - p.lastIncome) / 1000;
    
    if (elapsed >= 1) {
      p.credits += Math.floor(elapsed * (1 + (p.incomeLevel - 1) * 0.5));
      p.lastIncome = now;
      changed = true;
      if (Math.random() < 0.015) { p.shards += 1; io.to(nick).emit('shardFound'); }
    }
    for (const bid in p.buildings) {
      const b = p.buildings[bid];
      if (b.upgrading && Date.now() >= b.upgradeEnd) {
        b.upgrading = false; b.level += 1; changed = true;
        io.to(nick).emit('buildingCompleted', { id: bid, building: b });
      }
    }
  }
  if (changed) saveData(data);
}, 5000);

server.listen(PORT, () => console.log(`Server started on port ${PORT}`));