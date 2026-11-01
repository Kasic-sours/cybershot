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

// Загрузка данных
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
    if (!socket.nickname) return;
    const player = data.players[socket.nickname];
    const guildName = player?.guildId ? data.guilds[player.guildId]?.name : null;
    io.emit('chatMessage', { from: socket.nickname, guild: guildName, text: msg, time: Date.now() });
  });

  socket.on('createGuild', (guildName) => {
    const player = data.players[socket.nickname];
    if (!player || player.credits < 500) return socket.emit('error', 'Нужно 500 кредитов');
    if (player.guildId) return socket.emit('error', 'Вы уже в гильдии');
    if (Object.values(data.guilds).some(g => g.name === guildName)) return socket.emit('error', 'Имя занято');

    const guildId = 'g_' + Date.now();
    data.guilds[guildId] = { id: guildId, name: guildName, leader: socket.nickname, members: { [socket.nickname]: 'leader' }, createdAt: Date.now() };
    player.credits -= 500; player.guildId = guildId; player.guildRole = 'leader';
    saveData(data);
    socket.emit('guildUpdated', data.guilds[guildId]);
  });

  socket.on('promoteMember', ({ guildId, targetNick }) => {
    const guild = data.guilds[guildId];
    const player = data.players[socket.nickname];
    if (guild && player && player.guildRole === 'leader' && guild.members[targetNick]) {
      const roles = ['leader', 'general', 'officer', 'private'];
      const idx = roles.indexOf(guild.members[targetNick]);
      if (idx > 0) { guild.members[targetNick] = roles[idx - 1]; saveData(data); io.to(guildId).emit('guildUpdated', guild); }
    }
  });

  socket.on('demoteMember', ({ guildId, targetNick }) => {
    const guild = data.guilds[guildId];
    const player = data.players[socket.nickname];
    if (guild && player && player.guildRole === 'leader' && guild.members[targetNick]) {
      const roles = ['leader', 'general', 'officer', 'private'];
      const idx = roles.indexOf(guild.members[targetNick]);
      if (idx < roles.length - 1) { guild.members[targetNick] = roles[idx + 1]; saveData(data); io.to(guildId).emit('guildUpdated', guild); }
    }
  });

  socket.on('kickMember', ({ guildId, targetNick }) => {
    const guild = data.guilds[guildId];
    const player = data.players[socket.nickname];
    if (guild && player && player.guildRole === 'leader' && guild.members[targetNick] && targetNick !== socket.nickname) {
      delete guild.members[targetNick];
      if (data.players[targetNick]) { data.players[targetNick].guildId = null; data.players[targetNick].guildRole = null; }
      saveData(data); io.to(guildId).emit('guildUpdated', guild);
    }
  });

  socket.on('getProfile', (nickname) => {
    const p = data.players[nickname];
    if (!p) return;
    const guild = p.guildId ? data.guilds[p.guildId] : null;
    socket.emit('profileData', { nickname: p.nickname, level: p.level, guild: guild ? guild.name : 'Нет', buildings: p.buildings, credits: p.credits, shards: p.shards });
  });

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
});

setInterval(() => {
  let changed = false;
  for (const nick in data.players) {
    const p = data.players[nick];
    const now = Date.now();
    const elapsed = (now - p.lastIncome) / 1000;
    if (elapsed >= 1) { p.credits += Math.floor(elapsed * 1); p.lastIncome = now; changed = true; }
    
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