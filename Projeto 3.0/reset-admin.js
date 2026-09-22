const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'kx-ice-crash.db');
const db = new Database(dbPath);

const login = 'kxx1';
const password = 'adm123';

const owner = db.prepare("SELECT id FROM accounts WHERE role='owner' LIMIT 1").get();

if (!owner) {
  db.prepare("INSERT INTO accounts(name, login, password_hash, role, blocked) VALUES (?, ?, ?, 'owner', 0)")
    .run('Administrador Principal', login, bcrypt.hashSync(password, 12));
} else {
  db.prepare("UPDATE accounts SET login=?, password_hash=?, blocked=0 WHERE id=?")
    .run(login, bcrypt.hashSync(password, 12), owner.id);
}

db.close();

console.log('========================================');
console.log('ADM ATUALIZADO COM SUCESSO');
console.log('Login : kxx1');
console.log('Senha : adm123');
console.log('Banco : ' + dbPath);
console.log('========================================');
