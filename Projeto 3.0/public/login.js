const form = document.getElementById('loginForm');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('loginError');
  const button = form.querySelector('button[type=submit]');
  err.textContent = '';
  button.disabled = true;
  button.textContent = 'ENTRANDO...';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        login: document.getElementById('login').value.trim(),
        password: document.getElementById('password').value
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      err.textContent = d.error || `Erro ${r.status}`;
      return;
    }
    window.location.href = d.redirect;
  } catch (error) {
    err.textContent = 'Não foi possível conectar ao servidor. Verifique se o Projeto 3.0 está aberto no computador e se o celular está na mesma Wi-Fi.';
  } finally {
    button.disabled = false;
    button.textContent = 'ENTRAR';
  }
});
