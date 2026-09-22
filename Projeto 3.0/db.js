import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = path.join(__dirname, 'kx-ice-crash.db');
// Quando esta versão é instalada em outra pasta, aproveita automaticamente
// o banco da versão anterior para não perder usuários, validade e configurações.
if (!fs.existsSync(DB_PATH)) {
  try {
    const parent = path.dirname(__dirname);
    const siblings = fs.readdirSync(parent)
      .filter(name => /^kx-ice-crash-v\d+(?:\.\d+)?$/.test(name))
      .map(name => path.join(parent, name))
      .filter(dir => fs.existsSync(path.join(dir, 'kx-ice-crash.db')))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (siblings.length) {
      fs.copyFileSync(path.join(siblings[0], 'kx-ice-crash.db'), DB_PATH);
      console.log(`Banco anterior reaproveitado: ${siblings[0]}`);
    }
  } catch (err) {
    console.warn('Não foi possível reaproveitar o banco anterior:', err.message);
  }
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 login TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('owner','admin','user')),
 expires_at TEXT,
 blocked INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 global_message TEXT NOT NULL DEFAULT '',
 command_android_message TEXT NOT NULL DEFAULT '',
 command_ios_message TEXT NOT NULL DEFAULT '',
 send_interval_seconds INTEGER NOT NULL DEFAULT 3
);
CREATE TABLE IF NOT EXISTS whatsapp_numbers (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 account_id INTEGER NOT NULL,
 label TEXT NOT NULL DEFAULT 'WhatsApp',
 phone_number_id TEXT NOT NULL,
 display_phone_number TEXT NOT NULL DEFAULT '',
 verified_name TEXT NOT NULL DEFAULT '',
 access_token_enc TEXT NOT NULL DEFAULT '',
 pairing_phone TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'disconnected',
 last_error TEXT NOT NULL DEFAULT '',
 last_pairing_code TEXT NOT NULL DEFAULT '',
 session_path TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_numbers_account ON whatsapp_numbers(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_numbers_account_phone ON whatsapp_numbers(account_id, phone_number_id);
CREATE TABLE IF NOT EXISTS send_usage (
 account_id INTEGER PRIMARY KEY,
 sent_count INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO settings(id, global_message, command_android_message, command_ios_message, send_interval_seconds) VALUES(1,'','','',3);
`);

for (const migration of [
  `ALTER TABLE settings ADD COLUMN command_android_message TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE settings ADD COLUMN command_ios_message TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE whatsapp_numbers ADD COLUMN pairing_phone TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE whatsapp_numbers ADD COLUMN status TEXT NOT NULL DEFAULT 'disconnected'`,
  `ALTER TABLE whatsapp_numbers ADD COLUMN last_error TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE whatsapp_numbers ADD COLUMN last_pairing_code TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE whatsapp_numbers ADD COLUMN session_path TEXT NOT NULL DEFAULT ''`
]) {
  try { db.exec(migration); } catch (e) {
    if (!String(e.message).includes('duplicate column name')) throw e;
  }
}
const adminLogin = process.env.ADMIN_LOGIN || 'kxx1';
const adminPassword = process.env.ADMIN_PASSWORD || 'adm123';
const owner = db.prepare("SELECT id FROM accounts WHERE role='owner' LIMIT 1").get();
if (!owner) {
  db.prepare("INSERT INTO accounts(name,login,password_hash,role,blocked) VALUES(?,?,?,'owner',0)")
    .run('Administrador Principal', adminLogin, bcrypt.hashSync(adminPassword, 12));
  console.log(`ADM principal criado: ${adminLogin}`);
} else {
  // Mantém o ADM principal utilizável sem precisar rodar RESET-ADM.bat a cada instalação/início.
  db.prepare("UPDATE accounts SET login=?, password_hash=?, blocked=0 WHERE id=?")
    .run(adminLogin, bcrypt.hashSync(adminPassword, 12), owner.id);
}
export default db;
