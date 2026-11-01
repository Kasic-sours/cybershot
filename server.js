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
  catch { return { players: {}, guilds: {}, online: {} }; }
}
function saveData(data) { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); }

let data = loadData();
app.use(express.static('public'));

io.on('connection', (socket) => {
  socket.on('register', (nickname) => {
    if (!nickname || nickname.length < 2) return socket.emit('error', 'Ник слишком короткий');
    let player = data.players[nickname];
    
    if (!player) {
      player = {
        nickname, level: 1, exp: 0, credits: 100, energy: 50, maxEnergy: 50, shards: 0,
        incomeLevel: 1, playerClass: null,
        buildings: {
          house: { level: 1, upgrading: false, upgradeEnd: 0 },
          forge: { level: 1, upgrading: false, upgradeEnd: 0 },
          shrine: { level: 1, upgrading: false, upgradeEnd: 0 },
          datacenter: { level: 1, upgrading: false, upgradeEnd: 0 }
        },
        guildId: null, guildRole: null, lastIncome: Date.now()
      };
      data.players[nickname] = player;
      saveData(data);
    }
    
    socket.nickname = nickname;
    socket.emit('registered', player);
  });

  // Выбор класса
  socket.on('setClass', (className) => {
    const player = data.players[socket.nickname];
    if (!player || player.playerClass) return;
    
    player.playerClass = className;
    
    // Бонусы за класс
    if (className === 'samurai') {
      player.buildings.forge.level = 2;
    } else if (className === 'monk') {
      player.maxEnergy += 50;
      player.energy += 50;
    } else if (className === 'merchant') {
      player.credits += 500;
    }

    saveData(data);
    socket.emit('classUpdated', player);
  });

  socket.on('setOnline', (nickname) => {
    data.online[socket.id] = nickname;
    socket.nickname = nickname;
    io.emit('onlineList', Object.values(data.online).filter(Boolean));
  });

  socket.on('disconnect', () => {
    delete data.online[socket.id];
    io.emit('onlineList', Object.values(data.online).filter(Boolean));
  });

  socket.on('chatMessage', (msg) => {
    if (!socket.nickname || !msg.trim()) return;
    const player = data.players[socket.nickname];
    const guildName = player?.guildId ? data.guilds[player.guildId]?.name : null;
    const msgData = { from: socket.nickname, guild: guildName, text: msg, time: Date.now() };
    io.emit('chatMessage', msgData); 
  });

  // Профиль
  socket.on('getProfile', (nickname) => {
    const p = data.players[nickname];
    if (!p) return;
    const guild = p.guildId ? data.guilds[p.guildId] : null;
    socket.emit('profileData', { 
      nickname: p.nickname, level: p.level, guild: guild ? guild.name : 'Нет', playerClass: p.playerClass,
      buildings: p.buildings, credits: p.credits, shards: p.shards, incomeLevel: p.incomeLevel 
    });
  });

  // Постройки и доход
  socket.on('upgradeBuilding', (buildingId) => {
    const player = data.players[socket.nickname];
    if (!player || !player.buildings[buildingId]) return;
    const b = player.buildings[buildingId];
    if (b.upgrading) return;

    const cost = b.level * 100, energyCost = b.level * 10;
    if (player.credits < cost || player.energy < energyCost) return socket.emit('error', 'Не хватает ресурсов');

    player.credits -= cost; player.energy -= energyCost;
    b.upgrading = true; b.upgradeEnd = Date.now() + 30000;
    saveData(data); socket.emit('buildingUpdated', { id: buildingId, building: b });
  });

  socket.on('upgradeIncome', () => {
    const player = data.players[socket.nickname];
    const cost = player.incomeLevel * 500;
    if (player.credits < cost) return socket.emit('error', 'Не хватает кредитов');
    player.credits -= cost; player.incomeLevel += 1;
    saveData(data); socket.emit('incomeUpdated', player.incomeLevel);
  });

  socket.on('buyItem', (itemId) => {
    const player = data.players[socket.nickname];
    const prices = { energy: 5, credits: 10, instantBuild: 15 };
    const cost = prices[itemId];
    if (!cost || player.shards < cost) return socket.emit('error', 'Не хватает осколков!');
    
    player.shards -= cost;
    if (itemId === 'energy') player.energy = Math.min(player.maxEnergy, player.energy + 50);
    if (itemId === 'credits') player.credits += 1000;
    if (itemId === 'instantBuild') {
      for (let id in player.buildings) {
        if (player.buildings[id].upgrading) player.buildings[id].upgradeEnd = Date.now();
      }
    }
    saveData(data);
    socket.emit('shopSuccess', { itemId, newShards: player.shards, newCredits: player.credits, newEnergy: player.energy });
  });

  // Гильдии (упрощенно для стабильности)
  socket.on('createGuild', (guildName) => {
    const player = data.players[socket.nickname];
    if (!player || player.credits < 500) return socket.emit('error', 'Нужно 500 кредитов');
    if (player.guildId) return socket.emit('error', 'Вы уже в гильдии');
    
    const guildId = 'g_' + Date.now();
    data.guilds[guildId] = { id: guildId, name: guildName, leader: socket.nickname, members: { [socket.nickname]: 'leader' } };
    player.credits -= 500; player.guildId = guildId; player.guildRole = 'leader';
    saveData(data); socket.emit('guildUpdated', data.guilds[guildId]);
  });
});

// Доход и кристаллы
setInterval(() => {
  let changed = false;
  for (const nick in data.players) {
    const p = data.players[nick];
    const now = Date.now();
    const elapsed = (now - p.lastIncome) / 1000;
    
    if (elapsed >= 1) {
      const incomeRate = 1 + (p.incomeLevel - 1) * 0.5;
      p.credits += Math.floor(elapsed * incomeRate);
      p.lastIncome = now;
      changed = true;
      
      if (Math.random() < 0.015) { // 1.5% шанс
        p.shards += 1;
        io.to(nick).emit('shardFound');
      }
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