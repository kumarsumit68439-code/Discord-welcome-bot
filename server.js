const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, EmbedBuilder, ChannelType, PermissionsBitField } = require('discord.js');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'config.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { admin: null, clientId: '', token: '', guilds: {} };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) }; } catch {}
const save = () => fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const sessions = new Set();

// ---------- Bot ----------
let client = null;
let botState = { status: 'offline', error: '' };

const DEFAULT_MSG = 'Welcome {user} to **{server}**! You are member #{count}.';
const fmt = (t, member) => t
  .replaceAll('{user}', `<@${member.id}>`)
  .replaceAll('{username}', member.user.username)
  .replaceAll('{server}', member.guild.name)
  .replaceAll('{count}', member.guild.memberCount);

async function sendWelcome(member, channelId, text) {
  const ch = await member.guild.channels.fetch(channelId).catch(() => null);
  if (!ch || !ch.isTextBased()) throw new Error('Welcome channel nahi mila');
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`Welcome to ${member.guild.name}!`)
    .setDescription(fmt(text || DEFAULT_MSG, member))
    .setThumbnail(member.displayAvatarURL({ size: 512 }))
    .setImage(member.displayAvatarURL({ size: 512 }))
    .setFooter({ text: `Member #${member.guild.memberCount}` })
    .setTimestamp();
  await ch.send({ content: `<@${member.id}>`, embeds: [embed] });
}

async function startBot() {
  if (client) { try { await client.destroy(); } catch {} client = null; }
  if (!db.token) return;
  botState = { status: 'connecting', error: '' };
  client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  client.once('ready', () => { botState = { status: 'online', error: '' }; console.log('Bot online:', client.user.tag); });
  client.on('guildMemberAdd', async (member) => {
    const cfg = db.guilds[member.guild.id];
    if (!cfg || !cfg.enabled || !cfg.channelId) return;
    try { await sendWelcome(member, cfg.channelId, cfg.message); }
    catch (e) { console.error('Welcome error:', e.message); }
  });
  client.on('error', (e) => console.error(e.message));
  try { await client.login(db.token); }
  catch (e) {
    botState = { status: 'error', error: e.message };
    client = null;
    throw e;
  }
}

// ---------- API ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const auth = (req, res, next) => {
  if (sessions.has(req.headers['x-auth'])) return next();
  res.status(401).json({ error: 'Login required' });
};

app.get('/api/state', (req, res) => res.json({
  hasAdmin: !!db.admin,
  hasToken: !!db.token,
  bot: botState,
  loggedIn: sessions.has(req.headers['x-auth']),
}));

// First time: sets admin password. After: normal login.
app.post('/api/login', (req, res) => {
  const pw = String(req.body.password || '');
  if (pw.length < 6) return res.status(400).json({ error: 'Password kam se kam 6 characters ka rakho' });
  if (!db.admin) {
    const salt = crypto.randomBytes(16).toString('hex');
    db.admin = { salt, hash: hash(pw, salt) };
    save();
  } else if (hash(pw, db.admin.salt) !== db.admin.hash) {
    return res.status(403).json({ error: 'Galat password' });
  }
  const t = crypto.randomBytes(24).toString('hex');
  sessions.add(t);
  res.json({ token: t });
});

app.post('/api/connect', auth, async (req, res) => {
  const { clientId, token } = req.body;
  if (!clientId || !token) return res.status(400).json({ error: 'Client ID aur Bot Token dono chahiye' });
  db.clientId = String(clientId).trim();
  db.token = String(token).trim();
  save();
  try { await startBot(); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: 'Connect fail: ' + e.message }); }
});

app.post('/api/disconnect', auth, async (req, res) => {
  db.token = ''; db.clientId = ''; save();
  if (client) { await client.destroy(); client = null; }
  botState = { status: 'offline', error: '' };
  res.json({ ok: true });
});

app.get('/api/invite', auth, (req, res) => {
  const perms = new PermissionsBitField([
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
  ]).bitfield;
  res.json({ url: `https://discord.com/oauth2/authorize?client_id=${db.clientId}&permissions=${perms}&scope=bot` });
});

app.get('/api/guilds', auth, async (req, res) => {
  if (!client || botState.status !== 'online') return res.json([]);
  const out = [];
  for (const g of client.guilds.cache.values()) {
    const chans = (await g.channels.fetch()).filter(c => c && c.type === ChannelType.GuildText)
      .map(c => ({ id: c.id, name: c.name }));
    out.push({
      id: g.id, name: g.name, members: g.memberCount,
      icon: g.iconURL({ size: 128 }),
      channels: chans,
      config: db.guilds[g.id] || { enabled: false, channelId: '', message: DEFAULT_MSG },
    });
  }
  res.json(out);
});

app.post('/api/guilds/:id', auth, (req, res) => {
  const { enabled, channelId, message } = req.body;
  db.guilds[req.params.id] = {
    enabled: !!enabled,
    channelId: String(channelId || ''),
    message: String(message || DEFAULT_MSG).slice(0, 1500),
  };
  save();
  res.json({ ok: true });
});

app.post('/api/guilds/:id/test', auth, async (req, res) => {
  try {
    const g = await client.guilds.fetch(req.params.id);
    const cfg = db.guilds[g.id];
    if (!cfg || !cfg.channelId) return res.status(400).json({ error: 'Pehle welcome channel chuno aur save karo' });
    const me = await g.members.fetch(client.user.id);
    await sendWelcome(me, cfg.channelId, cfg.message);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Dashboard running on port', PORT);
  startBot().catch(e => console.error('Start fail:', e.message));
});
