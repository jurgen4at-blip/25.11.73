const $ = (s) => document.querySelector(s);
const USER_SEND_LIMIT = 1500;
const AUTOMATION_INTERVAL_SECONDS = 4;
let sendCancelRequested = false;
let activeSendController = null;
let sendIntervalSeconds = AUTOMATION_INTERVAL_SECONDS;
let selectedCommandV30 = '';
let commandMessagesV30 = { android: '', ios: '' };

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error('ERRO DA API:', response.status, data);
    throw new Error(data.error || `Erro na operação (${response.status}).`);
  }

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
  const el = $('#pairingCode');
  const box = $('#pairingBox');
  if (el) el.textContent = displayPairingCode(code || '--------');
  if (box) box.hidden = !code;
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
  const textEl = $('#sendUsageText');
  if (textEl) textEl.textContent = `${sent.toLocaleString('pt-BR')} / ${max.toLocaleString('pt-BR')}`;
  const btn = $('#sendButton');
  if (btn && sent >= max) {
    btn.disabled = true;
    btn.textContent = 'Limites atingidos';
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

async function getScriptFromFolder(commandName) {
  try {
    const cmd = String(commandName || '').toLowerCase().trim();
    let filename = 'android.txt';
    if (cmd.includes('ios')) filename = 'ios.txt';
    else if (cmd.includes('android')) filename = 'android.txt';

    const response = await fetch(`/scripts/${filename}`);
    if (!response.ok) throw new Error(`Script ${filename} não encontrada.`);
    return await response.text();
  } catch (err) {
    console.warn('Falha ao carregar arquivo de script:', err);
    return '';
  }
}

async function runAutomaticSend(targets, btn, targetInput) {
  if (!targets.length) return;
  sendCancelRequested = false;
  btn.disabled = true;
  btn.textContent = 'Enviando...';

  const scriptContent = await getScriptFromFolder(selectedCommandV30);

  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < targets.length; i++) {
    if (sendCancelRequested) break;
    const target = targets[i];
    setSendState('sending', 'ENVIANDO...', `Destino ${i + 1} de ${targets.length}: ${target}`, ((i + 1) / targets.length) * 100);

    const res = await sendSingleTarget(target, null, `job-${Date.now()}`, scriptContent);
    if (res.ok) {
      successCount++;
    } else {
      failureCount++;
    }

    if (i < targets.length - 1) {
      await new Promise(r => setTimeout(r, sendIntervalSeconds * 1000));
    }
  }

  setSendState('success', 'ENVIO FINALIZADO', `Concluídos: ${successCount} • Falhas: ${failureCount}`, 100);
  btn.disabled = false;
  btn.textContent = 'Enviar';
}

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
        const saveBtn = $('#saveConnect');
        if (saveBtn) {
          saveBtn.disabled = true;
          saveBtn.textContent = 'Aguardando confirmação';
        }
      } else if (row.status === 'error') {
        stopPairingPoll();
        setConnectModalState('error', `❌ ${row.last_error || 'Não foi possível gerar o código.'}`, phone);
        return;
      }

      if (row.status === 'connected') {
        stopPairingPoll();
        const modal = $('#connectModal');
        if (modal) modal.hidden = true;
        showNotice('WhatsApp conectado com sucesso.', 'ok');
        await loadWhatsAppNumbers();
      }
    } catch (error) {
      console.error('Erro ao verificar conexão:', error);
    }
  };

  tick();
  pairingPollTimer = setInterval(tick, 3000);
}

// Lógica para alternar as abas do menu inferior
function bindTabsNavigation() {
  const links = document.querySelectorAll('.bottom-nav-v22 a');
  const panels = document.querySelectorAll('.user-tab-panel');

  links.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();

      const tabName = link.getAttribute('data-tab');
      if (!tabName) return;

      // Remove a classe ativa dos links do menu e aplica no clicado
      links.forEach(l => l.classList.remove('active'));
      link.classList.add('active');

      // Oculta todos os painéis de abas e exibe o correspondente ao link
      panels.forEach(panel => panel.classList.remove('active-tab'));
      const targetPanel = document.getElementById(`tab-${tabName}`);
      if (targetPanel) {
        targetPanel.classList.add('active-tab');
      }
    });
  });
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

      const command = option.dataset.command || option.textContent.trim();
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
  if (connectButton) {
    connectButton.addEventListener('click', () => {
      stopPairingPoll();
      const modal = $('#connectModal');
      const box = $('#pairingBox');
      const phoneInput = $('#pairingPhone');
      const saveBtn = $('#saveConnect');
      if (modal) modal.hidden = false;
      if (box) box.hidden = true;
      if (phoneInput) {
        phoneInput.value = '';
        phoneInput.focus();
      }
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Conectar';
      }
      setConnectModalState('idle', 'Digite seu número do WhatsApp.');
    });
  }

  const closeConnectionModal = async () => {
    const id = activePairingId;
    stopPairingPoll();
    const modal = $('#connectModal');
    if (modal) modal.hidden = true;
    if (id) {
      try { await api(`/api/whatsapp/cancel-pairing/${id}`, { method: 'POST' }); } catch (_) {}
      await loadWhatsAppNumbers().catch(() => {});
    }
  };

  const closeModalBtn = $('#closeModal');
  const cancelConnectBtn = $('#cancelConnect');
  if (closeModalBtn) closeModalBtn.addEventListener('click', closeConnectionModal);
  if (cancelConnectBtn) cancelConnectBtn.addEventListener('click', closeConnectionModal);

  const connectForm = $('#connectForm');
  if (connectForm) {
    connectForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const btn = $('#saveConnect');
      const phone = $('#pairingPhone')?.value.trim() || '';
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Conectando...';
      }
      const box = $('#pairingBox');
      if (box) box.hidden = true;
      setConnectModalState('working', '⏳ Abrindo conexão...', phone.replace(/\D/g, ''));
      try {
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
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Tentar novamente';
        }
      }
    });
  }

  const sendForm = $('#sendForm');
  if (sendForm) {
    sendForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const btn = $('#sendButton');
      const targetInput = $('#target');
      if (!targetInput) return;
      const targets = parseTargets(targetInput.value);
      if (!targets.length) {
        setSendState('error', '❌ INFORME O NÚMERO', 'Digite pelo menos um número de destino.', 0);
        targetInput.focus();
        return;
      }
      await runAutomaticSend(targets, btn, targetInput);
    });
  }
}

async function loadSendConfig() {
  try {
    const cfg = await api('/api/user-send-config');
    sendIntervalSeconds = Math.max(1, Number(cfg.send_interval_seconds) || 3);
  } catch (_) {
    sendIntervalSeconds = 3;
  }
}

async function initUser() {
  try {
    bindTabsNavigation();
    bindCommandSelectorV30();
    bindUserActions();
    const me = await api('/api/me');
    if (me.role !== 'user') {
      location.href = '/admin.html';
      return;
    }
    const nameEl = $('#userName');
    if (nameEl) nameEl.textContent = me.name || me.login || 'Usuário';
    const expiry = $('#expiryText');
    if (expiry) expiry.textContent = formatExpiry(me.expires_at);
    await cleanupPendingPairingOnRefresh();
    await Promise.all([loadWhatsAppNumbers(), loadUsage(), loadSendConfig()]);
  } catch (error) {
    console.error(error);
  }
}

let isFetching = false;
const whatsappRefreshTimer = window.setInterval(async () => {
  if (isFetching) return;
  isFetching = true;
  try {
    await loadWhatsAppNumbers();
    await loadUsage();
  } catch (e) {
    console.error(e);
  } finally {
    isFetching = false;
  }
}, 5000);

window.addEventListener('beforeunload', () => {
  if (whatsappRefreshTimer) clearInterval(whatsappRefreshTimer);
  stopPairingPoll();
});

document.addEventListener('DOMContentLoaded', initUser);