const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Erro na operação.');
  return data;
}

function displayPairingCode(value){ const c=String(value || '').toUpperCase().replace(/-/g,'').replace(/[^A-Z0-9]/g,'').slice(0,8); return c.length===8 ? c.slice(0,4)+'-'+c.slice(4) : c; }

function showNotice(message, type = 'info') {
  const el = $('#actionNotice');
  if (!el) return;
  el.textContent = message;
  el.className = 'notice';
  el.style.borderColor = type === 'error' ? '#ff304b' : type === 'ok' ? '#15c77b' : '#0c9edb';
  el.hidden = false;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => { el.classList.add('hidden'); }, 5000);
}

function switchTab(name) {
  const allowed = new Set(['home','accounts','whatsapp','send','history']);
  if (!allowed.has(name)) name = 'home';
  $$('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === `tab-${name}`));
  $$('.tab-btn,.nav-tab,.bottom-nav button').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === name));
  history.replaceState(null, '', `#${name}`);
  if (name === 'whatsapp') loadWhatsAppNumbers().catch(e => showNotice(e.message, 'error'));
}

$$('[data-tab]').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
$('#goConnect').addEventListener('click', () => switchTab('whatsapp'));
$('#goSend').addEventListener('click', () => switchTab('send'));

function formatDate(iso) {
  if (!iso) return 'Permanente';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('pt-BR');
}

function accountInputs(suffix='') {
  return {
    userName: $(`#userName${suffix}`),
    userLogin: $(`#userLogin${suffix}`),
    userPassword: $(`#userPassword${suffix}`),
    userDays: $(`#userDays${suffix}`),
    adminName: $(`#adminName${suffix}`),
    adminLogin: $(`#adminLogin${suffix}`),
    adminPassword: $(`#adminPassword${suffix}`),
    adminDays: $(`#adminDays${suffix}`)
  };
}

async function renderAccounts(me) {
  const accounts = await api('/api/accounts');
  $('#accountCount').textContent = accounts.length;
  $('#accountCount2').textContent = accounts.length;
  const users = accounts.filter(a => a.role === 'user');
  $('#usersActive').textContent = users.filter(a => !a.blocked && (!a.expires_at || new Date(a.expires_at) > new Date())).length;

  for (const listId of ['#accountList','#accountList2']) {
    const list = $(listId); list.innerHTML = '';
    for (const a of accounts) {
      const row = document.createElement('div'); row.className = 'account-row';
      const info = document.createElement('div');
      const roleLabel = a.role === 'owner' ? 'ADM PRINCIPAL' : a.role === 'admin' ? 'ADM SECUNDÁRIO' : 'USUÁRIO';
      const status = a.blocked ? 'Bloqueado' : (a.expires_at && new Date(a.expires_at) <= new Date() ? 'Expirado' : 'Ativo');
      info.innerHTML = `<strong>${escapeHtml(a.name)}</strong><span>${roleLabel}</span><small>Login: ${escapeHtml(a.login)} • Vencimento: ${formatDate(a.expires_at)} • ${status}</small>`;
      const actions = document.createElement('div'); actions.className = 'account-actions';
      if (a.role !== 'owner' && me.role === 'owner') {
        const renew = document.createElement('button'); renew.className = 'btn secondary'; renew.textContent = '+30 dias';
        renew.addEventListener('click', async () => { try { await api(`/api/accounts/${a.id}`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({add_days:30})}); await renderAccounts(me);} catch(e){showNotice(e.message,'error');} });
        const block = document.createElement('button'); block.className = a.blocked ? 'btn secondary' : 'btn danger'; block.textContent = a.blocked ? 'Desbloquear' : 'Bloquear';
        block.addEventListener('click', async () => { try { await api(`/api/accounts/${a.id}`, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({blocked:!Boolean(a.blocked)})}); await renderAccounts(me);} catch(e){showNotice(e.message,'error');} });
        const remove = document.createElement('button'); remove.className = 'btn danger'; remove.textContent = 'Excluir';
        remove.addEventListener('click', async () => { if(!confirm(`Excluir ${a.login}?`)) return; try{await api(`/api/accounts/${a.id}`,{method:'DELETE'});await renderAccounts(me);}catch(e){showNotice(e.message,'error');} });
        actions.append(renew, block, remove);
      }
      row.append(info, actions); list.appendChild(row);
    }
  }
}

function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }

async function createAccount(role, suffix='') {
  const ids = accountInputs(suffix);
  const prefix = role === 'user' ? 'user' : 'admin';
  const name = ids[`${prefix}Name`]?.value.trim();
  const login = ids[`${prefix}Login`]?.value.trim();
  const password = ids[`${prefix}Password`]?.value;
  const days = Number(ids[`${prefix}Days`]?.value);
  try {
    await api('/api/accounts', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,login,password,role,access_days:days})});
    ['Name','Login','Password'].forEach(k => { if (ids[`${prefix}${k}`]) ids[`${prefix}${k}`].value=''; });
    const me = await api('/api/me');
    await renderAccounts(me);
    showNotice(role === 'admin' ? 'Administrador adicionado.' : 'Usuário adicionado.', 'ok');
  } catch(e) { showNotice(e.message,'error'); }
}

function showPairingCode(code) {
  const box = $('#pairingBox');
  const value = $('#pairingCode');
  if (!box || !value) return;
  value.textContent = code || '--------';
  box.hidden = !code;
}

function statusLabel(status) {
  return ({
    connected: '● Conectado',
    pairing: '● Aguardando código',
    connecting: '● Conectando...',
    starting: '● Preparando...',
    reconnecting: '● Reconectando...',
    disconnected: '● Desconectado',
    error: '● Erro'
  })[status] || '● Aguardando';
}

async function loadWhatsAppNumbers() {
  const rows = await api('/api/whatsapp/numbers');
  $('#waCount').textContent = rows.length;
  $('#waCountPanel').textContent = rows.length;
  const list = $('#connectedList');
  const sender = $('#sender');
  list.innerHTML = ''; sender.innerHTML = '';
  if (!rows.length) {
    list.innerHTML = '<div class="empty">Nenhum WhatsApp conectado neste administrador.</div>';
    sender.innerHTML = '<option value="">Conecte um WhatsApp primeiro</option>';
    return rows;
  }
  rows.forEach(row => {
    const item = document.createElement('div'); item.className='wa-row';
    const tone = row.status === 'connected' ? 'green' : (row.status === 'error' ? 'red' : 'muted');
    item.innerHTML = `<span>◔</span><div><strong>${escapeHtml(row.label)}</strong><small>${escapeHtml(row.display_phone_number || row.pairing_phone || '')}</small></div><span class="wa-status ${tone}">${escapeHtml(statusLabel(row.status))}</span>`;
    list.appendChild(item);
    if (row.status === 'connected') {
      const opt=document.createElement('option'); opt.value=String(row.id); opt.textContent=`${row.label} — ${row.display_phone_number || row.pairing_phone}`; sender.appendChild(opt);
    }
  });
  if (!sender.options.length) sender.innerHTML = '<option value="">Aguardando conexão do WhatsApp</option>';
  const pairing = rows.find(r => r.status === 'pairing' && r.last_pairing_code);
  if (pairing) showPairingCode(displayPairingCode(pairing.last_pairing_code));
  return rows;
}

async function startPairing() {
  const btn = $('#saveConnect');
  btn.disabled = true;
  btn.textContent = 'Conectando...';
  try {
    const result = await api('/api/whatsapp/connect', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ phone: $('#pairingPhone').value.trim() })
    });
    showPairingCode(displayPairingCode(result.code));
    await loadWhatsAppNumbers();
    showNotice('Código gerado. Siga as instruções abaixo.', 'ok');
  } catch(e) {
    showNotice(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Conectar';
  }
}

$('#connectForm').addEventListener('submit', async e => {
  e.preventDefault();
  await startPairing();
});

$('#refreshNumbers').addEventListener('click', () => loadWhatsAppNumbers().then(()=>showNotice('Lista atualizada.','ok')).catch(e=>showNotice(e.message,'error')));

let adminSendRunning = false;
let adminSendCancel = false;

function parseAdminTargets(value) {
  return [...new Set(String(value || '').split(/[\s,;]+/)
    .map(v => v.replace(/[^0-9+]/g, ''))
    .filter(v => v.replace(/\D/g, '').length >= 10))];
}

function sleepSeconds(seconds) {
  const ms = Math.max(1000, Number(seconds || 1) * 1000);
  return new Promise(resolve => setTimeout(resolve, ms));
}

function addSessionRow(target, messageId = null, jobId = '', status = 'Aguardando') {
  const list = $('#sessionList');
  if (!list) return { row: { title: '' }, status: { textContent: status }, send_row: { status: '' } };
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();

  const sendRow = document.createElement('div');
  sendRow.className = 'session-row';

  const targetEl = document.createElement('span');
  targetEl.textContent = target;

  const statusEl = document.createElement('i');
  statusEl.textContent = status;
  if (status === 'Enviando') statusEl.className = 'pause';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'cancel';
  cancelBtn.textContent = 'Cancelar';
  cancelBtn.addEventListener('click', async () => {
    if (!jobId) return;
    try {
      await api('/api/whatsapp/send-cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId })
      });
      statusEl.textContent = 'Cancelado';
      cancelBtn.disabled = true;
    } catch (e) {
      showNotice(e.message, 'error');
    }
  });

  sendRow.append(targetEl, statusEl, cancelBtn);
  list.prepend(sendRow);

  const count = $('#sendCountPanel');
  if (count) count.textContent = String(list.querySelectorAll('.session-row').length);

  return {
    row: sendRow,
    status: statusEl,
    send_row: sendRow
  };
}

async function runAdminAutomaticSend(targets, btn) {
  if (adminSendRunning) return;
  adminSendRunning = true;
  adminSendCancel = false;
  let sent = 0;
  let failed = 0;

  try {
    const sender = $('#sender');
    const connectionId = Number(sender?.value || 0);
    const savedMessage = String($('#globalMessage')?.value || $('#message')?.value || '').trim();
    const interval = Number($('#interval')?.value || 3);

    if (!connectionId) throw new Error('Selecione um WhatsApp conectado.');
    if (!savedMessage) throw new Error('Digite a mensagem antes de iniciar o envio.');
    if (!Number.isInteger(interval) || interval < 1 || interval > 3600) {
      throw new Error('Intervalo inválido. Use de 1 a 3600 segundos.');
    }
    if (!targets.length) throw new Error('Informe pelo menos um número de destino.');

    for (let i = 0; i < targets.length; i++) {
      if (adminSendCancel) break;

      const target = targets[i];
      const jobId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const row = addSessionRow(target, null, jobId, 'Aguardando');
      row.status.textContent = 'Enviando';
      row.status.className = 'pause';

      try {
        const result = await api('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            connection_id: connectionId,
            target,
            message: savedMessage,
            job_id: jobId
          })
        });

        if (result && result.message_id) {
          row.row.title = `ID: ${result.message_id}`;
          row.status.textContent = 'Enviado';
          row.status.className = '';
          sent++;
        } else {
          row.status.textContent = 'Erro';
          row.status.className = 'pause';
          failed++;
        }
      } catch (e) {
        row.status.textContent = 'Erro';
        row.status.className = 'pause';
        failed++;
        showNotice(`Falha no envio para ${target}: ${e.message}`, 'error');
      }

      if (i < targets.length - 1 && !adminSendCancel) {
        await sleepSeconds(interval);
      }
    }

    const sendCount = $('#sendCount');
    if (sendCount) sendCount.textContent = String(sent);
    showNotice(adminSendCancel
      ? `Envio cancelado. Enviados: ${sent}. Falhas: ${failed}.`
      : `Envio concluído. Enviados: ${sent}. Falhas: ${failed}.`, adminSendCancel ? 'info' : 'ok');
  } finally {
    adminSendRunning = false;
    adminSendCancel = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '➤ Iniciar envio automático';
    }
  }
}

function cancelAdminAutomaticSend() {
  adminSendCancel = true;
}

async function saveSettings() {
  const message = String($('#globalMessage')?.value ?? $('#message')?.value ?? '').trim();
  const commandAndroidMessage = String($('#commandAndroidMessage')?.value || '').trim();
  const commandIosMessage = String($('#commandIosMessage')?.value || '').trim();
  const interval = Number($('#interval')?.value || 3);

  if (!message) throw new Error('Digite a mensagem antes de salvar.');
  if (!Number.isInteger(interval) || interval < 1 || interval > 3600) {
    throw new Error('Intervalo inválido. Use de 1 a 3600 segundos.');
  }

  const saved = await api('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ global_message: message, command_android_message: commandAndroidMessage, command_ios_message: commandIosMessage, send_interval_seconds: interval })
  });

  const savedMessage = String(saved.global_message || message);
  $('#message').value = savedMessage;
  $('#globalMessage').value = savedMessage;
  $('#commandAndroidMessage').value = String(saved.command_android_message || commandAndroidMessage);
  $('#commandIosMessage').value = String(saved.command_ios_message || commandIosMessage);
  const savedEl = $('#messageSaved');
  if (savedEl) savedEl.textContent = `✅ Mensagem salva às ${new Date().toLocaleTimeString('pt-BR')}`;
  showNotice('Mensagem e configuração salvas com sucesso.', 'ok');
}

$('#sendForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#sendButton');
  const targets = parseAdminTargets($('#target')?.value || '');
  btn.disabled = true;
  btn.textContent = 'Enviando...';
  try {
    await runAdminAutomaticSend(targets, btn);
  } catch (e) {
    showNotice(e.message, 'error');
    btn.disabled = false;
    btn.textContent = '➤ Iniciar envio automático';
  }
});

$('#saveSettings').addEventListener('click',()=>saveSettings().catch(e=>showNotice(e.message,'error')));
$('#saveSettingsHome').addEventListener('click',()=>saveSettings().catch(e=>showNotice(e.message,'error')));
$('#globalMessage').addEventListener('input',e=>$('#message').value=e.target.value);
$('#message').addEventListener('input',e=>$('#globalMessage').value=e.target.value);
$('#logout').addEventListener('click',async()=>{await fetch('/api/logout',{method:'POST'});location.href='/login.html';});

(async()=>{
  try{
    const me=await api('/api/me');
    if(!['owner','admin'].includes(me.role)){location.href='/user.html';return;}
    $('#who').textContent=`${me.login} • ${me.role==='owner'?'ADM principal':'ADM secundário'}`;
    const st=await api('/api/settings');
    $('#message').value=st.global_message || '';
    $('#globalMessage').value=st.global_message || '';
    $('#commandAndroidMessage').value=st.command_android_message || '';
    $('#commandIosMessage').value=st.command_ios_message || '';
    $('#interval').value=String(st.send_interval_seconds || 3);
    await renderAccounts(me);
    await loadWhatsAppNumbers();
    $('#today').textContent=new Date().toLocaleDateString('pt-BR');
    const hash=location.hash.replace('#',''); switchTab(hash || 'home');
    if(me.role!=='owner'){ ['#addUser','#addAdmin','#addUser2','#addAdmin2'].forEach(id=>{const el=$(id); if(el){el.disabled=true;el.title='Somente o ADM principal pode criar contas.';}}) }
  }catch(e){
    console.error('Falha ao abrir o painel ADM:', e);
    if (String(e.message || '').toLowerCase().includes('não autenticado') || String(e.message || '').toLowerCase().includes('autenticado')) {
      location.href='/login.html';
    } else {
      showNotice(`Não foi possível carregar o painel: ${e.message || 'erro inesperado'}`, 'error');
    }
  }
})();

$('#addUser').addEventListener('click',()=>createAccount('user',''));
$('#addAdmin').addEventListener('click',()=>createAccount('admin',''));
$('#addUser2').addEventListener('click',()=>createAccount('user','2'));
$('#addAdmin2').addEventListener('click',()=>createAccount('admin','2'));
window.addEventListener('hashchange',()=>switchTab(location.hash.replace('#','')));
