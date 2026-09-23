import 'dotenv/config';
import path from 'path';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import db from './db.js';
import { normalizePhone, connectNumber, requestPairingCode, disconnectNumber, cancelPairing, sendTextMessage, restoreAllSessions } from './whatsapp.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { sockets, key } from './whatsapp.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 3000);

function mensagemErroPortugues(error, fallback = 'Não foi possível concluir a operação.') {
  const raw = String(error?.message || error || '').trim();
  if (!raw) return fallback;
  const text = raw.toLowerCase();
  if (text.includes('custom pairing code') || (text.includes('pairing code') && text.includes('8 chars'))) return 'O código de pareamento precisa ter exatamente 8 caracteres.';
  if (text.includes('connection closed') || text.includes('connection was closed')) return 'A conexão com o WhatsApp foi encerrada. O erro aconteceu durante a comunicação com a sessão do dispositivo.';
  if (text.includes('timed out') || text.includes('timeout')) return 'O tempo de conexão terminou. Tente novamente.';
  if (text.includes('logged out')) return 'O dispositivo foi desconectado do WhatsApp.';
  if (text.includes('unauthorized') || text.includes('not-authorized')) return 'O WhatsApp recusou a conexão. Confira o número e tente novamente.';
  if (text.includes('bad mac') || text.includes('decryption error')) return 'Não foi possível validar a sessão do WhatsApp. Tente conectar novamente.';
  if (/^[\x00-\x7F]*$/.test(raw) && /\b(the|must|should|failed|error|invalid|cannot|unable|closed|socket|connection|request|code|phone|number)\b/i.test(raw)) return fallback;
  return raw;
}

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'kx-ice-crash-local-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 8 * 60 * 60 * 1000 }
}));
function pageGuard(req, res, next) {
  if (!req.session.account) return res.redirect('/login.html');
  const a = db.prepare('SELECT id,role,blocked,expires_at FROM accounts WHERE id = ?').get(req.session.account.id);
  if (!a || a.blocked || expired(a)) {
    req.session.destroy(() => res.redirect('/login.html'));
    return;
  }
  if (req.path === '/user.html' && a.role !== 'user') return res.redirect('/admin.html');
  if (req.path === '/admin.html' && !['owner','admin'].includes(a.role)) return res.redirect('/user.html');
  next();
}
app.get('/', (req, res) => res.redirect('/login.html'));
app.get('/user.html', pageGuard, (req, res) => res.sendFile(path.join(__dirname, 'public', 'user.html')));
app.get('/admin.html', pageGuard, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

function expired(a) {
  return Boolean(a?.expires_at) && new Date(a.expires_at).getTime() <= Date.now();
}
function loginRequired(req, res, next) {
  if (!req.session.account) return res.status(401).json({ error: 'Não autenticado.' });
  next();
}
function adminRequired(req, res, next) {
  if (!req.session.account || !['owner', 'admin'].includes(req.session.account.role)) {
    return res.status(403).json({ error: 'Acesso restrito.' });
  }
  next();
}
function ownerRequired(req, res, next) {
  if (!req.session.account || req.session.account.role !== 'owner') {
    return res.status(403).json({ error: 'Somente o ADM principal.' });
  }
  next();
}

app.post('/login', (req, res) => {
  const { login, password } = req.body;
  const fail = (message) => res.redirect(`/login.html?error=${encodeURIComponent(message)}`);
  if (!login || !password) return fail('Informe login e senha.');

  const a = db.prepare('SELECT * FROM accounts WHERE login = ?').get(String(login).trim());
  if (!a) return fail('Login ou senha inválidos.');
  if (a.blocked) return fail('Conta bloqueada.');
  if (expired(a)) return fail('Acesso expirado.');
  if (!bcrypt.compareSync(String(password), a.password_hash)) {
    return fail('Login ou senha inválidos.');
  }

  req.session.account = { id: a.id, name: a.name, login: a.login, role: a.role };
  req.session.save((saveErr) => {
    if (saveErr) {
      console.error('Erro ao salvar sessão de login:', saveErr);
      return res.status(500).send('Não foi possível concluir o login.');
    }
    const target = a.role === 'user' ? '/user.html' : '/admin.html';
    return res.redirect(303, target);
  });
});

app.post('/api/login', (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Informe login e senha.' });

  const a = db.prepare('SELECT * FROM accounts WHERE login = ?').get(String(login).trim());
  if (!a) return res.status(401).json({ error: 'Login ou senha inválidos.' });
  if (a.blocked) return res.status(403).json({ error: 'Conta bloqueada.' });
  if (expired(a)) return res.status(403).json({ error: 'Acesso expirado.' });
  if (!bcrypt.compareSync(String(password), a.password_hash)) {
    return res.status(401).json({ error: 'Login ou senha inválidos.' });
  }

  req.session.account = { id: a.id, name: a.name, login: a.login, role: a.role };
  res.json({ ok: true, role: a.role, redirect: a.role === 'user' ? '/user.html' : '/admin.html' });
});

app.post('/api/logout', loginRequired, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', loginRequired, (req, res) => {
  const a = db.prepare('SELECT id,name,login,role,expires_at,blocked FROM accounts WHERE id = ?').get(req.session.account.id);
  if (!a || a.blocked || expired(a)) return res.status(403).json({ error: 'Acesso expirado ou bloqueado.' });
  res.json(a);
});

app.get('/api/settings', adminRequired, (req, res) => {
  res.json(db.prepare('SELECT global_message,command_android_message,command_ios_message,send_interval_seconds FROM settings WHERE id = 1').get());
});

app.get('/api/user-send-config', loginRequired, (req, res) => {
  const row = db.prepare('SELECT command_android_message,command_ios_message,send_interval_seconds FROM settings WHERE id = 1').get();
  res.json({
    command_android_message: String(row?.command_android_message || ''),
    command_ios_message: String(row?.command_ios_message || ''),
    send_interval_seconds: Math.max(1, Number(row?.send_interval_seconds || 3))
  });
});

app.put('/api/settings', adminRequired, (req, res) => {
  const seconds = Number(req.body.send_interval_seconds);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
    return res.status(400).json({ error: 'Intervalo inválido.' });
  }
  const message = String(req.body.global_message ?? '').trim();
  const commandAndroid = String(req.body.command_android_message ?? '').trim();
  const commandIos = String(req.body.command_ios_message ?? '').trim();
  if (!message && !commandAndroid && !commandIos) {
    return res.status(400).json({ error: 'Digite pelo menos uma mensagem para salvar.' });
  }
  db.prepare(`UPDATE settings
    SET global_message=?, command_android_message=?, command_ios_message=?, send_interval_seconds=?
    WHERE id=1`).run(message, commandAndroid, commandIos, seconds);
  const saved = db.prepare('SELECT global_message,command_android_message,command_ios_message,send_interval_seconds FROM settings WHERE id=1').get();
  res.json({ ok: true, ...saved });
});

app.get('/api/accounts', adminRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT id,name,login,role,expires_at,blocked,created_at
    FROM accounts
    ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, id DESC
  `).all();
  res.json(rows);
});

function makeExpiryFromDays(days) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 3650) return null;
  return new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
}

app.post('/api/accounts', ownerRequired, (req, res) => {
  const { name, login, password, role, access_days } = req.body;
  if (!name || !login || !password || !['admin', 'user'].includes(role)) {
    return res.status(400).json({ error: 'Preencha nome, login, senha e tipo de conta.' });
  }

  const expiresAt = makeExpiryFromDays(access_days);
  if (!expiresAt) {
    return res.status(400).json({ error: 'Informe um prazo válido em dias (1 a 3650).' });
  }

  try {
    const result = db.prepare(`
      INSERT INTO accounts(name,login,password_hash,role,expires_at,blocked)
      VALUES(?,?,?,?,?,0)
    `).run(
      String(name).trim(),
      String(login).trim(),
      bcrypt.hashSync(String(password), 12),
      role,
      expiresAt
    );
    res.status(201).json({ ok: true, id: result.lastInsertRowid, expires_at: expiresAt });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Esse login já está em uso.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Não foi possível criar a conta.' });
  }
});

app.patch('/api/accounts/:id', ownerRequired, (req, res) => {
  const id = Number(req.params.id);
  const a = db.prepare('SELECT * FROM accounts WHERE id=?').get(id);
  if (!a || a.role === 'owner') return res.status(400).json({ error: 'Conta não pode ser alterada.' });

  const fields = [];
  const values = [];

  if (typeof req.body.blocked === 'boolean') {
    fields.push('blocked=?');
    values.push(req.body.blocked ? 1 : 0);
  }

  if (req.body.add_days !== undefined) {
    const days = Number(req.body.add_days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      return res.status(400).json({ error: 'Dias de renovação inválidos.' });
    }
    const current = a.expires_at && !expired(a) ? new Date(a.expires_at).getTime() : Date.now();
    const expiresAt = new Date(current + days * 24 * 60 * 60 * 1000).toISOString();
    fields.push('expires_at=?');
    values.push(expiresAt);
  }

  if (req.body.password) {
    fields.push('password_hash=?');
    values.push(bcrypt.hashSync(String(req.body.password), 12));
  }

  if (!fields.length) return res.status(400).json({ error: 'Nenhuma alteração.' });
  values.push(id);
  db.prepare(`UPDATE accounts SET ${fields.join(',')} WHERE id=?`).run(...values);
  res.json({ ok: true });
});

app.delete('/api/accounts/:id', ownerRequired, (req, res) => {
  const id = Number(req.params.id);
  const a = db.prepare('SELECT role FROM accounts WHERE id=?').get(id);
  if (!a || a.role === 'owner') return res.status(400).json({ error: 'Conta não pode ser removida.' });
  db.prepare('DELETE FROM accounts WHERE id=?').run(id);
  res.json({ ok: true });
});



function whatsappRequired(req, res, next) {
  if (!req.session.account || !['owner', 'admin', 'user'].includes(req.session.account.role)) {
    return res.status(403).json({ error: 'Faça login para usar o WhatsApp.' });
  }
  next();
}

app.get('/api/whatsapp/numbers', whatsappRequired, (req, res) => {
  const rows = db.prepare(`
    SELECT id,label,pairing_phone,display_phone_number,verified_name,status,last_error,last_pairing_code,created_at
    FROM whatsapp_numbers WHERE account_id=? ORDER BY id DESC
  `).all(req.session.account.id);
  res.json(rows);
});

app.post('/api/whatsapp/connect', whatsappRequired, async (req, res) => {
  try {
    const label = String(req.body.label || 'WhatsApp').trim() || 'WhatsApp';
    const phone = normalizePhone(req.body.phone || req.body.pairing_phone);
    const numberId = Number(req.body.connection_id || 0) || null;
    if (!phone) return res.status(400).json({ error: 'Digite o número com DDI, somente dígitos. Ex.: 5511999999999' });
    const result = await connectNumber({ accountId: req.session.account.id, numberId, label, phone });
    res.status(201).json(result);
  } catch (e) {
    console.error('Erro ao preparar conexão do WhatsApp:', e);
    res.status(500).json({ error: mensagemErroPortugues(e, 'Não foi possível gerar o código de pareamento.') });
  }
});

app.post('/api/whatsapp/cancel-pairing/:id', whatsappRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT id, status FROM whatsapp_numbers WHERE id=? AND account_id=?').get(id, req.session.account.id);
    if (!row) return res.status(404).json({ error: 'Número não encontrado.' });
    if (row.status === 'connected') return res.status(400).json({ error: 'O WhatsApp já está conectado.' });
    await cancelPairing({ accountId: req.session.account.id, numberId: id });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro ao cancelar pareamento:', e);
    res.status(500).json({ error: 'Não foi possível cancelar a tentativa de conexão.' });
  }
});
app.post('/api/whatsapp/cleanup-pairing', whatsappRequired, async (req, res) => {
  try {
    const accountId = req.session.account.id;

    const pending = db.prepare(
      "SELECT id FROM whatsapp_numbers WHERE account_id=? AND status='pairing'"
    ).all(accountId);

    for (const row of pending) {
      await cancelPairing({
        accountId,
        numberId: row.id
      });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('Erro ao limpar pareamentos pendentes:', e);
    res.status(500).json({
      error: 'Não foi possível limpar os pareamentos pendentes.'
    });
  }
});
app.post('/api/whatsapp/pair/:id', whatsappRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT id FROM whatsapp_numbers WHERE id=? AND account_id=?').get(id, req.session.account.id);
    if (!row) return res.status(404).json({ error: 'Número não encontrado.' });
    const code = await requestPairingCode({ accountId: req.session.account.id, numberId: id });
    res.json({ ok: true, id, code, status: 'pairing' });
  } catch (e) {
    console.error('Erro ao gerar novo código:', e);
    res.status(500).json({ error: mensagemErroPortugues(e, 'Não foi possível gerar um novo código.') });
  }
});

app.delete('/api/whatsapp/numbers/:id', whatsappRequired, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = db.prepare('SELECT id FROM whatsapp_numbers WHERE id=? AND account_id=?').get(id, req.session.account.id);
    if (!row) return res.status(404).json({ error: 'Número não encontrado.' });
    await disconnectNumber({ accountId: req.session.account.id, numberId: id });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro ao desconectar WhatsApp:', e);
    res.status(500).json({ error: mensagemErroPortugues(e, 'Não foi possível desconectar o WhatsApp.') });
  }
});

const USER_SEND_LIMIT = 1500;
let lastAdminSendAt = 0;
const cancelledSendJobs = new Set();

app.get('/api/whatsapp/usage', whatsappRequired, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO send_usage(account_id,sent_count) VALUES(?,0)').run(req.session.account.id);
  const usage = db.prepare('SELECT sent_count,updated_at FROM send_usage WHERE account_id=?').get(req.session.account.id);
  res.json({ sent_count: Number(usage?.sent_count || 0), limit: USER_SEND_LIMIT, updated_at: usage?.updated_at || null });
});

app.post('/api/whatsapp/send-cancel', whatsappRequired, (req, res) => {
  const jobId = String(req.body.job_id || '').trim();
  if (!jobId) return res.status(400).json({ error: 'Identificador do envio não informado.' });
  cancelledSendJobs.add(jobId);
  if (cancelledSendJobs.size > 5000) {
    const first = cancelledSendJobs.values().next().value;
    if (first) cancelledSendJobs.delete(first);
  }
  res.json({ ok: true });
});

app.post('/api/whatsapp/send', whatsappRequired, async (req, res) => {
  const accountId = req.session.account.id;
  const jobId = String(req.body.job_id || '').trim();
  if (jobId && cancelledSendJobs.has(jobId)) {
    cancelledSendJobs.delete(jobId);
    return res.status(409).json({ error: 'Envio cancelado antes de ser entregue ao WhatsApp.' });
  }
  const isUser = req.session.account.role === 'user';
  const settings = db.prepare('SELECT global_message,command_android_message,command_ios_message,send_interval_seconds FROM settings WHERE id = 1').get();

  // O intervalo do ADM continua valendo para disparos manuais.
  // A fila do usuário é controlada pelo navegador, um destinatário por vez.
  if (!isUser) {
    const now = Date.now();
    const minInterval = Math.max(1, Number(settings?.send_interval_seconds || 3)) * 1000;
    if (now - lastAdminSendAt < minInterval) {
      const wait = Math.ceil((minInterval - (now - lastAdminSendAt)) / 1000);
      return res.status(429).json({ error: `Aguarde ${wait}s antes de enviar outra mensagem.` });
    }
  }

  let reservedSlot = false;
  try {
    const target = normalizePhone(req.body.target);
    if (!target) return res.status(400).json({ error: 'Informe o número de destino.' });

    let connectionId;
    let message;

    if (isUser) {
      db.prepare('INSERT OR IGNORE INTO send_usage(account_id,sent_count) VALUES(?,0)').run(accountId);
      const active = db.prepare(`SELECT id FROM whatsapp_numbers WHERE account_id=? AND status='connected' ORDER BY id ASC LIMIT 1`).get(accountId);
      if (!active) {
        return res.status(409).json({ error: 'Nenhum WhatsApp ativo para envio. Conecte um WhatsApp primeiro.' });
      }
      connectionId = active.id;
      const command = String(req.body.command || '').trim().toLowerCase();
      if (command === 'crash android') message = String(settings?.command_android_message || '').trim();
      else if (command === 'crash ios') message = String(settings?.command_ios_message || '').trim();
      else message = String(req.body.message || settings?.global_message || '').trim();
      if (!message) {
        return res.status(409).json({ error: command ? `A mensagem do comando ${command} ainda não foi configurada pelo administrador.` : 'Informe a mensagem antes de iniciar o envio.' });
      }

      // Reserva atomicamente uma vaga do limite, sem alterar a conexão do WhatsApp.
      const reserved = db.prepare(`
        UPDATE send_usage
           SET sent_count=sent_count+1, updated_at=CURRENT_TIMESTAMP
         WHERE account_id=? AND sent_count < ?
      `).run(accountId, USER_SEND_LIMIT);
      if (!reserved.changes) {
        const usage = db.prepare('SELECT sent_count FROM send_usage WHERE account_id=?').get(accountId);
        return res.status(429).json({ error: `Limite de ${USER_SEND_LIMIT.toLocaleString('pt-BR')} envios atingido.`, sent_count: Number(usage?.sent_count || USER_SEND_LIMIT), limit: USER_SEND_LIMIT });
      }
      reservedSlot = true;
    } else {
      connectionId = Number(req.body.connection_id);
      message = String(req.body.message || '').trim();
      if (!connectionId || !message) {
        return res.status(400).json({ error: 'Selecione um WhatsApp, informe o alvo e digite a mensagem.' });
      }
    }

    if (jobId && cancelledSendJobs.has(jobId)) {
      cancelledSendJobs.delete(jobId);
      if (isUser && reservedSlot) {
        db.prepare(`UPDATE send_usage SET sent_count=CASE WHEN sent_count>0 THEN sent_count-1 ELSE 0 END, updated_at=CURRENT_TIMESTAMP WHERE account_id=?`).run(accountId);
        reservedSlot = false;
      }
      return res.status(409).json({ error: 'Envio cancelado antes de ser entregue ao WhatsApp.' });
    }
   const sock = getSocket(accountId, connectionId);

if (!sock) {
  return res.status(409).json({
    error: 'WhatsApp não está conectado.'
  });
}
await sock.sendMessage(target, {
interactiveMessage: {
body: {
text: message
},
footer: {
text: "Seu rodapé aqui"
},
header: {
hasMediaAttachment: false
},
nativeFlowMessage: {
buttons: [{
name: "quick_reply",
buttonParamsJson: JSON.stringify({
display_text: "Texto do Botão",
id: "id do botao"
})
}],
messageParamsJson: ""
}
}
});

   console.log('sockets:', sockets);
    await sendTextMessage(sockets.get(key(req.body.account_id, connectionId)), target);
   res.json({ ok: true, message_id: result?.key?.id || null });
    
  } catch (e) {
    if (e?.code === 'SEND_CANCELLED') {
      if (jobId) cancelledSendJobs.delete(jobId);
      if (isUser && reservedSlot) {
        try {
          db.prepare(`UPDATE send_usage SET sent_count=CASE WHEN sent_count>0 THEN sent_count-1 ELSE 0 END, updated_at=CURRENT_TIMESTAMP WHERE account_id=?`).run(accountId);
        } catch (_) {}
      }
      return res.status(409).json({ error: 'Envio cancelado antes de ser entregue ao WhatsApp.' });
    }
    if (jobId) cancelledSendJobs.delete(jobId);
    if (isUser && reservedSlot) {
      try {
        db.prepare(`UPDATE send_usage SET sent_count=CASE WHEN sent_count>0 THEN sent_count-1 ELSE 0 END, updated_at=CURRENT_TIMESTAMP WHERE account_id=?`).run(accountId);
      } catch (_) {}
    }
    console.error('Erro ao enviar WhatsApp:', e);
    res.status(500).json({ error: mensagemErroPortugues(e, 'Não foi possível enviar a mensagem.') });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Projeto 3.0 rodando em http://localhost:${PORT}`);
  try { await restoreAllSessions(); } catch (e) { console.error('Falha ao restaurar sessões do WhatsApp:', e); }
});
