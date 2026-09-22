import fs from 'fs';
import path from 'path';
import db from './db.js';
import pino from 'pino';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SESSION_ROOT = path.join(__dirname, 'data', 'whatsapp-sessions');
fs.mkdirSync(SESSION_ROOT, { recursive: true });

export const sockets = new Map();
const pairingLocks = new Map();
const pairingAttemptState = new Map();
// O WhatsApp/Baileys pode perder ou duplicar mensagens quando dois sendMessage
// rodam ao mesmo tempo no mesmo socket. Mantemos uma fila por socket para que
// o intervalo do usuário controle o ritmo sem criar corrida dentro do socket.
const sendQueues = new Map();

// Código personalizado do Projeto 3.0: exatamente 8 caracteres. A interface exibe como KXXX VAPO.
const CUSTOM_PAIRING_CODE = 'KXXXVAPO';

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  // Números brasileiros podem ser digitados sem DDI no formulário.
  // O WhatsApp exige o DDI no pedido de pareamento.
  if ((digits.length === 10 || digits.length === 11) && !digits.startsWith('55')) {
    digits = '55' + digits;
  }
  if (digits.length < 12 || digits.length > 15) return null;
  return digits;
}

export function key(accountId, numberId) {
  return `${Number(accountId)}:${Number(numberId)}`;
}

function sessionPath(accountId, numberId) {
  return path.join(SESSION_ROOT, `account-${Number(accountId)}`, `number-${Number(numberId)}`);
}

function updateRow(numberId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const values = keys.map(k => fields[k]);
  values.push(numberId);
  db.prepare(`UPDATE whatsapp_numbers SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...values);
}

function getSocket(accountId, numberId) {
  return sockets.get(key(accountId, numberId))?.sock || null;
}

async function baileysModule() {
  return import('@whiskeysockets/baileys');
}

function disconnectStatusCode(error) {
  return error?.output?.statusCode || error?.statusCode || null;
}

function friendlyConnectionError(error, context = '') {
  const code = disconnectStatusCode(error);
  const raw = String(error?.message || error || '').trim();
  const text = raw.toLowerCase();
  const data = error?.data || error?.output?.payload || error?.output?.data || {};
  const reason = String(data?.reason || data?.message || error?.reason || '').trim();
  let message = 'Não foi possível conectar o WhatsApp.';
  if (code === 500 || text === '500' || text.includes('internal server error')) message = 'O servidor do WhatsApp recusou a solicitação de pareamento.';
  else if (code === 428 && text.includes('connection closed')) message = 'A conexão foi encerrada antes de o WhatsApp aceitar o pedido de pareamento. O socket ainda não estava pronto para solicitar o código.';
  else if (code === 515 || text.includes('restart required')) message = 'O WhatsApp aceitou o pareamento e pediu a reinicialização da sessão.';
  else if (code === 428) message = 'O WhatsApp recusou a identidade do dispositivo durante o pareamento.';
  else if (code === 429 || text.includes('rate-overlimit')) message = 'O WhatsApp bloqueou temporariamente novas tentativas por excesso de pedidos. Aguarde antes de tentar novamente.';
  else if (code === 408 || text.includes('timed out') || text.includes('timeout')) message = 'O pedido de pareamento expirou antes de o WhatsApp confirmar o vínculo.';
  else if (code === 400 || text.includes('bad-request') || text.includes('bad request')) message = 'O WhatsApp recusou os dados enviados para o pareamento. Confira o número e tente novamente.';
  else if (text.includes('custom pairing code') || (text.includes('pairing code') && text.includes('8 chars'))) message = 'O código de pareamento precisa ter exatamente 8 caracteres.';
  else if (text.includes('connection closed') || text.includes('connection was closed')) message = 'A conexão foi encerrada antes de o pareamento terminar.';
  else if (text.includes('logged out')) message = 'O dispositivo foi desconectado do WhatsApp.';
  else if (text.includes('bad mac') || text.includes('decryption error')) message = 'A sessão do WhatsApp não pôde validar as chaves de segurança. Será necessário iniciar um novo pareamento.';
  else if (text.includes('not-authorized') || text.includes('unauthorized')) message = 'O WhatsApp recusou a autorização do dispositivo.';
  else if (text.includes('conflict')) message = 'O WhatsApp detectou conflito com outra sessão deste dispositivo.';
  const details = [];
  if (context) details.push(context);
  if (code) details.push(`código técnico ${code}`);
  if (reason && !/stream|error|unknown/i.test(reason)) details.push(`motivo informado pelo servidor: ${reason}`);
  return details.length ? `${message} ${details.join(' — ')}.` : message;
}

async function startSession({ accountId, numberId, requestPairingCode = false }) {
  const row = db.prepare('SELECT * FROM whatsapp_numbers WHERE id=? AND account_id=?').get(numberId, accountId);
  if (!row) throw new Error('Número do WhatsApp não encontrado.');

  const mapKey = key(accountId, numberId);
  if (sockets.has(mapKey)) return sockets.get(mapKey);

  const mod = await baileysModule();
  const makeWASocket = mod.default || mod.makeWASocket;
  const useMultiFileAuthState = mod.useMultiFileAuthState;
  const DisconnectReason = mod.DisconnectReason || {};
  const Browsers = mod.Browsers;

  if (!makeWASocket || !useMultiFileAuthState) {
    throw new Error('A biblioteca do WhatsApp não carregou corretamente.');
  }

  const folder = sessionPath(accountId, numberId);
  fs.mkdirSync(folder, { recursive: true });
  updateRow(numberId, { session_path: folder, status: 'connecting', last_error: '' });

  const { state, saveCreds } = await useMultiFileAuthState(folder);
  const logger = pino({ level: 'silent' });

  // Para pairing code, use um identificador de navegador canônico do Windows.
  // Isso evita rejeições de compatibilidade observadas com descrições customizadas.
  const browser = Browsers && typeof Browsers.windows === 'function'
    ? Browsers.windows('Chrome')
    : (Browsers && typeof Browsers.macOS === 'function' ? Browsers.macOS('Desktop') : ['Windows', 'Chrome', '120.0.0']);

  const sockOptions = {
    auth: state, printQRInTerminal: false, logger, browser,
    markOnlineOnConnect: false, syncFullHistory: false,
    connectTimeoutMs: 30000, keepAliveIntervalMs: 25000, countryCode: 'BR'
  };
  try {
    // O helper fetchLatestBaileysVersion pode retornar uma versão do WhatsApp Web
    // desatualizada e isso pode fazer o celular recusar o pareamento.
    // Preferimos a versão real do WhatsApp Web.
    if (typeof mod.fetchLatestWaWebVersion === 'function') {
      const latest = await mod.fetchLatestWaWebVersion({});
      if (Array.isArray(latest?.version) && latest.version.length >= 3) {
        sockOptions.version = latest.version;
      }
    } else if (typeof mod.fetchLatestBaileysVersion === 'function') {
      const latest = await mod.fetchLatestBaileysVersion();
      if (Array.isArray(latest?.version) && latest.version.length >= 3) {
        sockOptions.version = latest.version;
      }
    }
  } catch (err) {
    console.warn('Não foi possível consultar a versão atual do WhatsApp Web; usando a versão padrão da biblioteca.');
  }

  const sock = makeWASocket(sockOptions);

  let resolvePairing;
  let rejectPairing;
  const entry = {
    sock,
    codePromise: null,
    pairingStarted: false,
    newLogin: false,
    reconnectTimer: null,
    resolvePairing: null,
    rejectPairing: null
  };

  if (requestPairingCode && !state.creds.registered) {
    entry.codePromise = new Promise((resolve, reject) => {
      resolvePairing = resolve;
      rejectPairing = reject;
    });
    entry.resolvePairing = resolvePairing;
    entry.rejectPairing = rejectPairing;
  }

  sockets.set(mapKey, entry);
  sock.ev.on('creds.update', saveCreds);

  const generatePairingCode = async () => {
    if (!requestPairingCode || state.creds.registered || entry.pairingStarted) return null;
    entry.pairingStarted = true;
    pairingAttemptState.set(mapKey, 'solicitando código ao WhatsApp');
    try {
      const phone = normalizePhone(row.pairing_phone);
      if (!phone) throw new Error('Número inválido. Use DDI + número, somente dígitos.');

      updateRow(numberId, { status: 'pairing', last_error: '' });

        // O código customizado precisa ter exatamente 8 caracteres.
      // A biblioteca atual aguarda a confirmação do servidor antes de considerar o pedido aceito.
      const code = await sock.requestPairingCode(phone, CUSTOM_PAIRING_CODE);
      pairingAttemptState.set(mapKey, 'código aceito pelo servidor; aguardando confirmação no celular');
      updateRow(numberId, { status: 'pairing', last_pairing_code: code, last_error: '' });
      entry.resolvePairing?.(code);
      return code;
    } catch (err) {
      const friendly = friendlyConnectionError(err, pairingAttemptState.get(mapKey) || 'falha durante a solicitação do código');
      pairingAttemptState.delete(mapKey);
      updateRow(numberId, { status: 'error', last_error: friendly });
      entry.rejectPairing?.(new Error(friendly));
      return null;
    }
  };
entry.tryPairing = generatePairingCode;
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, isNewLogin, qr } = update;

    // O QR/ref interno é o primeiro sinal confiável de que o socket já recebeu
    // a referência necessária para o fluxo de pareamento. Nunca mostramos o QR.
    if (requestPairingCode && !state.creds.registered && !entry.pairingStarted && qr) {
      try { await entry.tryPairing?.(); } catch (_) {}
    }

    // O Baileys informa isNewLogin após o pareamento e espera uma nova sessão.
    if (isNewLogin) {
      entry.newLogin = true;
      updateRow(numberId, { status: 'reconnecting', last_error: '' });
      return;
    }

    if (connection === 'open') {
      if (requestPairingCode && !state.creds.registered && !entry.pairingStarted) {
        try { await entry.tryPairing?.(); } catch (_) {}
      }
      updateRow(numberId, {
        status: 'connected',
        display_phone_number: row.pairing_phone || '',
        verified_name: 'WhatsApp conectado',
        last_pairing_code: '',
        last_error: ''
      });
    }

    if (connection === 'close') {
      const code = disconnectStatusCode(lastDisconnect?.error);
      const loggedOut = code === DisconnectReason.loggedOut;
      const pairingDiagnostic = pairingAttemptState.get(mapKey);

      
      sockets.delete(mapKey);

      if (requestPairingCode && !state.creds.registered) {
        const diagnostic = pairingDiagnostic || 'o WhatsApp encerrou o socket durante o pareamento';
        const message = friendlyConnectionError(lastDisconnect?.error || new Error('A conexão foi encerrada antes do pareamento.'), diagnostic);
        updateRow(numberId, { status: 'error', last_error: message, last_pairing_code: '', display_phone_number: '' });
        entry.rejectPairing?.(new Error(message));
        pairingAttemptState.delete(mapKey);
        return;
      }

      updateRow(numberId, {
        status: loggedOut ? 'disconnected' : 'reconnecting',
        last_error: loggedOut ? 'Dispositivo desconectado.' : (code ? `WhatsApp desconectado (código ${code}).` : ''),
        display_phone_number: ''
      });

      if (!loggedOut) {
        if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
        entry.reconnectTimer = setTimeout(() => {
          startSession({ accountId, numberId, requestPairingCode: true }).catch(err => {
            updateRow(numberId, { status: 'error', last_error: friendlyConnectionError(err) });
          });
        }, 2000);
      }
    }
  });

  // O pedido de código é iniciado somente quando chegar o evento `qr`, que
  // indica que o fluxo de pareamento já recebeu uma referência do WhatsApp.
  // Isso evita chamar requestPairingCode cedo demais e receber 428 (Connection Closed).
  

return entry;
}

async function restartPairingSession(accountId, numberId) {
  const mapKey = key(accountId, numberId);
  const entry = sockets.get(mapKey);
  if (entry) {
    try { entry.sock.ws?.close?.(); } catch (_) {}
    sockets.delete(mapKey);
  }
  const row = db.prepare('SELECT session_path,status FROM whatsapp_numbers WHERE id=? AND account_id=?').get(numberId, accountId);
  if (row?.status !== 'connected' && row?.session_path) {
    try { fs.rmSync(row.session_path, { recursive: true, force: true }); } catch (_) {}
  }
  updateRow(numberId, { status: 'starting', last_error: '', last_pairing_code: '' });
}

async function requestPairingCode({ accountId, numberId }) {
  const lockKey = key(accountId, numberId);
  if (pairingLocks.has(lockKey)) return pairingLocks.get(lockKey);

  const promise = (async () => {
    const row = db.prepare('SELECT status FROM whatsapp_numbers WHERE id=? AND account_id=?').get(numberId, accountId);
    if (row?.status === 'connected') throw new Error('O WhatsApp já está conectado.');
    await restartPairingSession(accountId, numberId);
    const entry = await startSession({ accountId, numberId, requestPairingCode: true });
    if (!entry.codePromise) throw new Error('Não foi possível iniciar o pedido de pareamento.');
    return entry.codePromise;
  })();

  pairingLocks.set(lockKey, promise);
  try {
    return await promise;
  } finally {
    pairingLocks.delete(lockKey);
  }
}

async function connectNumber({ accountId, numberId, label = 'WhatsApp', phone }) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('Número inválido. Digite DDI + número, somente dígitos.');

  if (numberId) {
    const row = db.prepare('SELECT id FROM whatsapp_numbers WHERE id=? AND account_id=?').get(numberId, accountId);
    if (!row) throw new Error('Número não encontrado.');
    updateRow(numberId, {
      label: String(label || 'WhatsApp').trim() || 'WhatsApp',
      pairing_phone: normalized,
      status: 'starting',
      last_error: '',
      last_pairing_code: ''
    });
  } else {
    const existing = db.prepare('SELECT id FROM whatsapp_numbers WHERE account_id=? AND pairing_phone=?').get(accountId, normalized);
    if (existing) {
      numberId = existing.id;
      updateRow(numberId, {
        label: String(label || 'WhatsApp').trim() || 'WhatsApp',
        status: 'starting',
        last_error: '',
        last_pairing_code: ''
      });
    } else {
      const result = db.prepare(`
        INSERT INTO whatsapp_numbers(
          account_id,label,phone_number_id,display_phone_number,verified_name,
          access_token_enc,pairing_phone,status,last_error,last_pairing_code,session_path
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        accountId,
        String(label || 'WhatsApp').trim() || 'WhatsApp',
        normalized,
        normalized,
        'WhatsApp',
        '',
        normalized,
        'starting',
        '',
        '',
        sessionPath(accountId, 0)
      );
      numberId = result.lastInsertRowid;
      updateRow(numberId, { session_path: sessionPath(accountId, numberId) });
    }
  }

  await restartPairingSession(accountId, numberId);
  const entry = await startSession({ accountId, numberId, requestPairingCode: true });
  if (!entry.codePromise) throw new Error('Não foi possível iniciar o pareamento.');
  const code = await entry.codePromise;
  return { id: numberId, code, status: 'pairing' };
}


async function cancelPairing({ accountId, numberId }) {
  const mapKey = key(accountId, numberId);
  const entry = sockets.get(mapKey);
  if (entry) {
    try { entry.reconnectTimer && clearTimeout(entry.reconnectTimer); } catch (_) {}
    try { entry.sock.end?.(new Error('Pareamento cancelado pelo usuário.')); } catch (_) {}
    try { entry.sock.ws?.close?.(); } catch (_) {}
    sockets.delete(mapKey);
    try { entry.rejectPairing?.(new Error('Pareamento cancelado pelo usuário.')); } catch (_) {}
  }
  pairingLocks.delete(mapKey);
  pairingAttemptState.delete(mapKey);
  const row = db.prepare('SELECT session_path,status FROM whatsapp_numbers WHERE id=? AND account_id=?').get(numberId, accountId);
  if (row?.status !== 'connected') {
    db.prepare('DELETE FROM whatsapp_numbers WHERE id=? AND account_id=?').run(numberId, accountId);
    if (row?.session_path) {
      try { fs.rmSync(row.session_path, { recursive: true, force: true }); } catch (_) {}
    }
  }
}

async function disconnectNumber({ accountId, numberId }) {
  const mapKey = key(accountId, numberId);
  const entry = sockets.get(mapKey);
  if (entry) {
    try { entry.sock.ws?.close?.(); } catch (_) {}
    sockets.delete(mapKey);
  }
  const row = db.prepare('SELECT session_path FROM whatsapp_numbers WHERE id=? AND account_id=?').get(numberId, accountId);
  db.prepare('DELETE FROM whatsapp_numbers WHERE id=? AND account_id=?').run(numberId, accountId);
  if (row?.session_path) fs.rm(row.session_path, { recursive: true, force: true }, () => {});
}

function sendErrorDetails(error) {
  const code = disconnectStatusCode(error);
  const raw = String(error?.message || error || '').trim();
  const text = raw.toLowerCase();
  if (text.includes('bad mac') || text.includes('sender key') || text.includes('sender-key') || text.includes('serialized is not iterable')) {
    return `O WhatsApp não conseguiu preparar as chaves de segurança para este envio${code ? ` (código técnico ${code})` : ''}. A conexão existe, mas a sessão de mensagens precisa ser sincronizada novamente.`;
  }
  if (text.includes('connection closed') || text.includes('connection was closed') || text.includes('socket')) {
    return `A conexão do WhatsApp foi encerrada durante o envio${code ? ` (código técnico ${code})` : ''}. O dispositivo precisa estar conectado e com a sessão estável.`;
  }
  if (text.includes('not found') || text.includes('not registered') || text.includes('recipient')) {
    return `O número de destino não foi aceito pelo WhatsApp${code ? ` (código técnico ${code})` : ''}. Confira o DDI, DDD e número.`;
  }
  if (text.includes('rate') || text.includes('429') || text.includes('too many')) {
    return `O WhatsApp limitou temporariamente o envio${code ? ` (código técnico ${code})` : ''}. Aguarde antes de tentar novamente.`;
  }
  return `O WhatsApp recusou o envio${code ? ` (código técnico ${code})` : ''}. Motivo técnico: ${raw || 'erro não informado'}`;
}

function enqueueSocketSend(mapKey, task) {
  const previous = sendQueues.get(mapKey) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  sendQueues.set(mapKey, current);
  return current.finally(() => {
    if (sendQueues.get(mapKey) === current) sendQueues.delete(mapKey);
  });
}

async function sendTextMessage({ accountId, numberId, to, body, isCancelled = () => false }) {
  const recipient = normalizePhone(to);
  if (!recipient) throw new Error('Número de destino inválido. Use DDI + número, somente dígitos.');
  const text = String(body || '').trim();
  if (!text) throw new Error('Digite uma mensagem.');
  if (text.length > 4096) throw new Error('A mensagem é grande demais.');

  const mapKey = key(accountId, numberId);
  const sock = getSocket(accountId, numberId);
  if (!sock) throw new Error('Este WhatsApp não está conectado. Conecte o dispositivo primeiro.');
  const row = db.prepare('SELECT status FROM whatsapp_numbers WHERE id=? AND account_id=?').get(numberId, accountId);
  if (!row || row.status !== 'connected') throw new Error('Este WhatsApp ainda não está conectado.');

  // Importante: o relógio do painel continua lançando um novo trabalho a cada N
  // segundos, mas o socket do WhatsApp recebe apenas um sendMessage por vez.
  // Isso evita a corrida de chamadas concorrentes no mesmo socket, que pode causar
  // perda, duplicação ou ordem imprevisível. Não há retry automático.
  return enqueueSocketSend(mapKey, async () => {
    if (isCancelled()) {
      const err = new Error('Envio cancelado antes de ser entregue ao WhatsApp.');
      err.code = 'SEND_CANCELLED';
      throw err;
    }
    try {
      if (!sock.user) throw new Error('A sessão do WhatsApp ainda não confirmou o usuário conectado.');
      const jid = `${recipient}@s.whatsapp.net`;
      // O próprio sendMessage valida o destinatário; evitamos uma chamada onWhatsApp
      // separada para reduzir uma segunda operação concorrente/extra no socket.
      const result = await sock.sendMessage(jid, { text });
      if (isCancelled()) {
        // O WhatsApp já pode ter aceitado o envio. O cancelamento não desfaz mensagem
        // que já foi transmitida; apenas impede o próximo trabalho da fila.
      }
      return result;
    } catch (error) {
      throw new Error(sendErrorDetails(error));
    }
  });
}

async function restoreAllSessions() {
  const rows = db.prepare('SELECT id,account_id,session_path,pairing_phone FROM whatsapp_numbers').all();
  for (const row of rows) {
    if (!row.session_path || !row.pairing_phone) {
      updateRow(row.id, { status: 'disconnected' });
      continue;
    }
    startSession({ accountId: row.account_id, numberId: row.id, requestPairingCode: false }).catch(err => {
      updateRow(row.id, { status: 'error', last_error: friendlyConnectionError(err) });
    });
  }
}

export {
normalizePhone,
connectNumber,
requestPairingCode,
disconnectNumber,
cancelPairing,
sendTextMessage,
restoreAllSessions
};
