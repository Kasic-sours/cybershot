const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// ЛОКАЛЬНО БАЗА ЛЕЖИТ РЯДОМ, НА FLY - В /data
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/data' : __dirname;
const DATA_FILE = path.join(DATA_DIR, 'database.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadData() {
  try { 
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); 
    if (!d.chatHistory) d.chatHistory = [];
    if (!d.idToNick) d.idToNick = {};
    return d;
  } 
  catch { return { players: {}, guilds: {}, idToNick: {}, chatHistory: [] }; }
}
function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

let data = loadData();
app.use(express.static('public'));

function generateId() { return Math.random().toString(36).substring(2, 8).toUpperCase(); }

function migratePlayer(player) {
  if (!player.id) { player.id = generateId(); data.idToNick[player.id] = player.nickname; }
  if (!player.friends) player.friends = [];
  if (!player.friendRequests) player.friendRequests = [];
  if (!player.guildInvites) player.guildInvites = [];
  if (player.lastDaily === undefined) player.lastDaily = 0;
  if (player.lastRoulette === undefined) player.lastRoulette = 0;
  if (!player.quests) player.quests = { buildOnce: false, chatCount: 0, guildCreated: false, claimed: {} };
  if (!player.buildings) player.buildings = {};
  
  const defaultBuildings = ['house', 'forge', 'shrine', 'datacenter'];
  defaultBuildings.forEach(b => {
    if (!player.buildings[b]) {
      player.buildings[b] = { level: 1, upgrading: false, upgradeEnd: 0, helpReq: false, helped: false };
    } else {
      if (player.buildings[b].helpReq === undefined) player.buildings[b].helpReq = false;
      if (player.buildings[b].helped === undefined) player.buildings[b].helped = false;
    }
  });
  return player;
}

io.on('connection', (socket) => {
  socket.on('register', (nickname) => {
    try {
      if (!nickname || nickname.length < 2) return socket.emit('error', 'Ник слишком короткий');
      let player = data.players[nickname];
      let offlineEarnings = 0;
      
      if (!player) {
        player = {
          id: generateId(), nickname, level: 1, credits: 100, energy: 50, maxEnergy: 50, shards: 0,
          incomeLevel: 1, playerClass: null, promoUsed: false, lastRoulette: 0,
          friends: [], friendRequests: [], guildInvites: [], lastDaily: 0,
          quests: { buildOnce: false, chatCount: 0, guildCreated: false, claimed: {} },
          buildings: {}, guildId: null, guildRole: null, lastIncome: Date.now()
        };
        data.players[nickname] = player;
        data.idToNick[player.id] = nickname;
        migratePlayer(player);
        saveData(data);
      } else {
        const now = Date.now();
        const elapsedSec = (now - player.lastIncome) / 1000;
        if (elapsedSec > 60) {
          const incomeRate = 1 + ((player.incomeLevel || 1) - 1) * 0.5;
          offlineEarnings = Math.floor(Math.min(elapsedSec, 12 * 3600) * incomeRate);
          player.credits += offlineEarnings;
        }
        player.lastIncome = now;
        migratePlayer(player);
        saveData(data);
      }
      
      socket.nickname = nickname;
      if (player.guildId) socket.join(player.guildId); // ВАЖНО: Подключаем к комнате гильдии

      const guild = player.guildId ? data.guilds[player.guildId] : null;
      socket.emit('registered', { player, guild, offlineEarnings });
      socket.emit('chatHistory', data.chatHistory);
    } catch (e) { console.error(e); socket.emit('error', 'Ошибка сервера'); }
  });

  socket.on('setClass', (className) => {
    try {
      const player = data.players[socket.nickname];
      if (!player) return socket.emit('error', 'Ошибка: игрок не найден');
      if (player.playerClass) return socket.emit('classUpdated', player);
      
      player.playerClass = className;
      if (className === 'samurai') player.buildings.forge.level = 2;
      if (className === 'monk') { player.maxEnergy += 50; player.energy += 50; }
      if (className === 'merchant') player.credits += 500;
      
      saveData(data); 
      socket.emit('classUpdated', player);
    } catch (e) { console.error(e); socket.emit('error', 'Ошибка при выборе класса'); }
  });

  socket.on('requestGuildHelp', (buildingId) => {
    try {
      const player = data.players[socket.nickname];
      if (!player || !player.guildId) return socket.emit('error', 'Вы не в гильдии');
      const b = player.buildings[buildingId];
      if (!b || !b.upgrading) return;
      
      b.helpReq = true;
      saveData(data);
      // Отправляем ВСЕМ в комнате гильдии
      socket.to(player.guildId).emit('guildHelpRequested', { nickname: player.nickname, buildingId });
      socket.emit('error', 'Запрос на помощь отправлен!');
    } catch (e) { console.error(e); }
  });

  socket.on('helpGuildMember', ({ nickname, buildingId }) => {
    try {
      const helper = data.players[socket.nickname];
      const target = data.players[nickname];
      if (!target || !target.guildId || target.guildId !== helper.guildId) return;
      
      const b = target.buildings[buildingId];
      if (!b || !b.upgrading || b.helped) return;

      const remaining = b.upgradeEnd - Date.now();
      b.upgradeEnd = Date.now() + Math.floor(remaining / 2);
      b.helped = true;
      b.helpReq = false;
      
      saveData(data);
      io.to(target.nickname).emit('buildingHelped', { id: buildingId });
      socket.emit('error', 'Вы помогли союзнику!');
    } catch (e) { console.error(e); }
  });

  // --- УПРАВЛЕНИЕ ГИЛЬДИЕЙ ---
  socket.on('promoteMember', ({ guildId, nickname }) => {
    const guild = data.guilds[guildId]; const player = data.players[socket.nickname];
    if (!guild || !player || player.guildRole !== 'leader') return;
    
    const roles = ['private', 'officer', 'general'];
    const idx = roles.indexOf(guild.members[nickname]);
    if (idx !== -1 && idx < roles.length - 1) {
      guild.members[nickname] = roles[idx + 1];
      saveData(data);
      io.to(guildId).emit('guildUpdated', guild);
    }
  });

  socket.on('demoteMember', ({ guildId, nickname }) => {
    const guild = data.guilds[guildId]; const player = data.players[socket.nickname];
    if (!guild || !player || player.guildRole !== 'leader') return;
    
    const roles = ['private', 'officer', 'general'];
    const idx = roles.indexOf(guild.members[nickname]);
    if (idx > 0) {
      guild.members[nickname] = roles[idx - 1];
      saveData(data);
      io.to(guildId).emit('guildUpdated', guild);
    }
  });

  socket.on('kickMember', ({ guildId, nickname }) => {
    const guild = data.guilds[guildId]; const player = data.players[socket.nickname];
    if (!guild || !player || player.guildRole !== 'leader' || nickname === player.nickname) return;
    
    delete guild.members[nickname];
    if (data.players[nickname]) {
      data.players[nickname].guildId = null;
      data.players[nickname].guildRole = null;
    }
    saveData(data);
    io.to(guildId).emit('guildUpdated', guild);
    io.to(nickname).emit('kickedFromGuild');
  });

  socket.on('spinRoulette', () => {
    try {
      const player = data.players[socket.nickname];
      const now = Date.now();
      if (now - player.lastRoulette < 60000) return socket.emit('error', 'Рулетка перезаряжается!');
      if (player.credits < 200) return socket.emit('error', 'Нужно 200 кредитов!');
      
      player.credits -= 200;
      player.lastRoulette = now;
      
      const roll = Math.random();
      let rewardText = '';
      if (roll < 0.1) { player.shards += 5; rewardText = '5 Осколков! 💎'; }
      else if (roll < 0.3) { player.energy += 50; rewardText = '50 Энергии! ⚡'; }
      else if (roll < 0.6) { player.credits += 500; rewardText = '500 Кредитов! 💰'; }
      else if (roll < 0.9) { player.credits += 100; rewardText = '100 Кредитов 💰'; }
      else { rewardText = 'Пусто... 😢'; }

      saveData(data);
      socket.emit('rouletteResult', { rewardText, player });
    } catch (e) { console.error(e); }
  });

  // --- ОСТАЛЬНОЕ ---
  socket.on('chatMessage', (msg) => {
    if (!socket.nickname || !msg.trim()) return;
    const player = data.players[socket.nickname];
    if(!player) return;
    player.quests.chatCount += 1;
    const msgData = { from: socket.nickname, text: msg, time: Date.now() };
    data.chatHistory.push(msgData);
    if (data.chatHistory.length > 50) data.chatHistory.shift();
    saveData(data);
    io.emit('chatMessage', msgData);
  });

  socket.on('syncPlayer', () => {
    const player = data.players[socket.nickname];
    if (player) socket.emit('playerSync', player);
  });

  socket.on('getAllGuilds', () => {
    const list = Object.values(data.guilds).map(g => ({ id: g.id, name: g.name, leader: g.leader, members: Object.keys(g.members).length }));
    socket.emit('allGuildsList', list);
  });

  socket.on('requestJoinGuild', (guildId) => {
    const player = data.players[socket.nickname]; const guild = data.guilds[guildId];
    if (!guild || player.guildId) return socket.emit('error', 'Вы уже в гильдии');
    if (!guild.requests) guild.requests = [];
    if (!guild.requests.includes(player.nickname)) {
      guild.requests.push(player.nickname); saveData(data);
      socket.emit('error', 'Заявка отправлена!');
      io.emit('guildRequestReceived', { leader: guild.leader, guildId });
    }
  });

  socket.on('acceptJoinRequest', ({ guildId, nickname }) => {
    const guild = data.guilds[guildId], player = data.players[nickname], leader = data.players[socket.nickname];
    if (!guild || !player || leader.guildRole !== 'leader') return;
    guild.requests = guild.requests.filter(n => n !== nickname);
    player.guildId = guildId; player.guildRole = 'private'; guild.members[nickname] = 'private';
    saveData(data); 
    socket.join(guildId); // Новый участник подключается к комнате
    io.to(guildId).emit('guildUpdated', guild); 
    io.emit('guildMemberJoined', { guildId, nickname });
  });

  socket.on('getLeaderRequests', () => {
    const player = data.players[socket.nickname]; if (!player || !player.guildId || player.guildRole !== 'leader') return;
    const guild = data.guilds[player.guildId]; if (guild) socket.emit('leaderRequestsList', guild.requests || []);
  });

  socket.on('getMyGuild', () => {
    const player = data.players[socket.nickname];
    if (player && player.guildId && data.guilds[player.guildId]) socket.emit('guildUpdated', data.guilds[player.guildId]);
  });

  socket.on('createGuild', (guildName) => {
    const player = data.players[socket.nickname];
    if (!player || player.credits < 500 || player.guildId) return socket.emit('error', 'Ошибка создания');
    const guildId = 'g_' + Date.now();
    data.guilds[guildId] = { id: guildId, name: guildName, leader: socket.nickname, members: { [socket.nickname]: 'leader' }, requests: [] };
    player.credits -= 500; player.guildId = guildId; player.guildRole = 'leader'; player.quests.guildCreated = true;
    saveData(data); 
    socket.join(guildId);
    socket.emit('guildUpdated', data.guilds[guildId]);
  });

  socket.on('inviteToGuild', (targetId) => {
    const player = data.players[socket.nickname];
    if (!player.guildId || player.guildRole !== 'leader') return socket.emit('error', 'Вы не лидер');
    const targetNick = data.idToNick[targetId]; if (!targetNick) return socket.emit('error', 'Игрок не найден');
    const target = data.players[targetNick];
    if (target.guildId) return socket.emit('error', 'Игрок уже в гильдии');
    if (!target.guildInvites.includes(player.guildId)) {
      target.guildInvites.push(player.guildId); saveData(data);
      io.emit('guildInviteReceived', targetNick); socket.emit('error', 'Приглашение отправлено!');
    }
  });

  socket.on('acceptGuildInvite', (guildId) => {
    const player = data.players[socket.nickname]; const guild = data.guilds[guildId]; if (!guild) return;
    player.guildInvites = player.guildInvites.filter(id => id !== guildId);
    player.guildId = guildId; player.guildRole = 'private'; guild.members[player.nickname] = 'private';
    saveData(data); 
    socket.join(guildId);
    io.to(guildId).emit('guildUpdated', guild); 
    io.emit('guildMemberJoined', { guildId, nickname: player.nickname });
  });

  socket.on('getProfile', (nickname) => {
    const p = data.players[nickname]; if (!p) return;
    const guild = p.guildId ? data.guilds[p.guildId] : null;
    socket.emit('profileData', { nickname: p.nickname, id: p.id, level: p.level, guild: guild ? guild.name : 'Нет', playerClass: p.playerClass || 'Не выбран', credits: p.credits, shards: p.shards, promoUsed: p.promoUsed, lastDaily: p.lastDaily });
  });

  socket.on('addFriend', (targetId) => {
    const player = data.players[socket.nickname]; if (targetId === player.id) return socket.emit('error', 'Это ваш ID');
    const targetNick = data.idToNick[targetId]; if (!targetNick) return socket.emit('error', 'Игрок не найден');
    const target = data.players[targetNick];
    if (!target.friendRequests.includes(player.id)) { target.friendRequests.push(player.id); saveData(data); io.emit('friendRequestReceived', targetNick); }
    socket.emit('error', 'Запрос отправлен!');
  });

  socket.on('acceptFriend', (senderId) => {
    const player = data.players[socket.nickname]; const senderNick = data.idToNick[senderId]; if (!senderNick) return;
    const sender = data.players[senderNick];
    player.friendRequests = player.friendRequests.filter(id => id !== senderId);
    if (!player.friends.includes(senderId)) player.friends.push(senderId);
    if (!sender.friends.includes(player.id)) sender.friends.push(player.id);
    saveData(data); socket.emit('friendsUpdated'); io.emit('friendRequestReceived', senderNick);
  });

  socket.on('getFriends', () => {
    const player = data.players[socket.nickname]; if(!player) return;
    socket.emit('friendsData', { friends: player.friends.map(id => ({ id, nickname: data.idToNick[id] })), requests: player.friendRequests.map(id => ({ id, nickname: data.idToNick[id] })), invites: player.guildInvites.map(gid => ({ id: gid, name: data.guilds[gid]?.name })) });
  });

  socket.on('claimDaily', () => {
    const player = data.players[socket.nickname]; if (Date.now() - player.lastDaily < 24 * 3600 * 1000) return socket.emit('error', 'Не готово');
    player.lastDaily = Date.now(); player.shards += 50; player.credits += 1000; saveData(data); socket.emit('dailyClaimed', player);
  });

  socket.on('redeemPromo', (code) => {
    const player = data.players[socket.nickname]; if (code === 'TEST100') { if (player.promoUsed) return socket.emit('error', 'Использован'); player.promoUsed = true; player.shards += 100; saveData(data); socket.emit('promoSuccess'); } else socket.emit('error', 'Неверный промокод');
  });

  socket.on('upgradeIncome', () => {
    const player = data.players[socket.nickname]; const cost = player.incomeLevel * 500;
    if (player.credits < cost) return socket.emit('error', 'Нужно больше кредитов!');
    player.credits -= cost; player.incomeLevel += 1; saveData(data); socket.emit('incomeUpdated', player.incomeLevel);
  });

  socket.on('buyItem', (itemId) => {
    const player = data.players[socket.nickname]; const prices = { energy: 5, credits: 10, instantBuild: 15 };
    if (player.shards < prices[itemId]) return socket.emit('error', 'Не хватает осколков!');
    player.shards -= prices[itemId];
    if (itemId === 'energy') player.energy = Math.min(player.maxEnergy, player.energy + 50);
    if (itemId === 'credits') player.credits += 1000;
    if (itemId === 'instantBuild') for (let id in player.buildings) if (player.buildings[id].upgrading) player.buildings[id].upgradeEnd = Date.now();
    saveData(data); socket.emit('shopSuccess');
  });

  socket.on('upgradeBuilding', (buildingId) => {
    const player = data.players[socket.nickname];
    const b = player.buildings[buildingId];
    if (b.upgrading) return;
    const cost = b.level * 100, energyCost = b.level * 10;
    if (player.credits < cost || player.energy < energyCost) return socket.emit('error', 'Не хватает ресурсов!');
    player.credits -= cost; player.energy -= energyCost;
    b.upgrading = true; b.upgradeEnd = Date.now() + 60000;
    b.helpReq = false; b.helped = false;
    player.quests.buildOnce = true;
    saveData(data); socket.emit('buildingUpdated', { id: buildingId, building: b });
  });

  socket.on('claimQuest', (questId) => {
    const player = data.players[socket.nickname]; const q = player.quests; if (q.claimed[questId]) return;
    if (questId === 'q1' && q.buildOnce) { player.credits += 500; q.claimed.q1 = true; }
    else if (questId === 'q2' && q.chatCount >= 3) { player.shards += 5; q.claimed.q2 = true; }
    else if (questId === 'q3' && q.guildCreated) { player.credits += 2000; q.claimed.q3 = true; }
    else return;
    saveData(data); socket.emit('questClaimed', { questId, player });
  });
});

setInterval(() => {
  let changed = false;
  for (const nick in data.players) {
    const p = data.players[nick];
    const elapsed = (Date.now() - p.lastIncome) / 1000;
    if (elapsed >= 1) {
      p.credits += Math.floor(elapsed * (1 + (p.incomeLevel - 1) * 0.5));
      p.lastIncome = Date.now(); changed = true;
      if (Math.random() < 0.015) { p.shards += 1; io.to(nick).emit('shardFound'); }
    }
    for (const bid in p.buildings) {
      const b = p.buildings[bid];
      if (b.upgrading && Date.now() >= b.upgradeEnd) {
        b.upgrading = false; b.level += 1; b.helpReq = false; b.helped = false; changed = true;
        io.to(nick).emit('buildingCompleted', { id: bid, building: b });
      }
    }
  }
  if (changed) saveData(data);
}, 5000);

server.listen(PORT, () => console.log(`Server started on port ${PORT}`));