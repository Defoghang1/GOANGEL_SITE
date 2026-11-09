// 🤖 Assistant IA — appelle l'API (FastAPI + Ollama) via l'URL ABSOLUE du tunnel Cloudflare
const AI_API_URL = "https://api.goangel.dpdns.org/api/chat";

function initUI() {
  if (document.getElementById('ai-widget')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="ai-widget" class="ai-closed">
      <div class="ai-header"><span>🤖 GOANGEL Assistant</span><button id="ai-close" aria-label="Fermer">×</button></div>
      <div id="ai-messages" class="ai-messages" aria-live="polite"><div class="ai-msg ai-bot">Bonjour ! Je suis l'assistant IA de GOANGEL. Posez-moi une question sur nos modèles ou nos packs.</div></div>
      <div class="ai-input-area"><input type="text" id="ai-input" placeholder="Écrivez votre question..." autocomplete="off" maxlength="500"><button id="ai-send">Envoyer</button></div>
      <div class="ai-loading" id="ai-loading" style="display:none;">L'IA réfléchit...</div>
    </div>
    <button id="ai-toggle" aria-label="Ouvrir l'assistant IA">🤖</button>
  `);

  const widget = document.getElementById('ai-widget');
  const toggle = document.getElementById('ai-toggle');
  const close = document.getElementById('ai-close');
  const input = document.getElementById('ai-input');
  const send = document.getElementById('ai-send');
  const messages = document.getElementById('ai-messages');
  const loading = document.getElementById('ai-loading');
  let busy = false;

  function appendMessage(role, text) {
    const div = document.createElement('div');
    div.className = `ai-msg ai-${role}`;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function setLoading(active, text = '') {
    loading.style.display = active ? 'block' : 'none';
    if (text) loading.textContent = text;
  }

  toggle.addEventListener('click', () => {
    widget.classList.remove('ai-closed');
    toggle.style.display = 'none';
    input.focus();
  });

  close.addEventListener('click', () => {
    widget.classList.add('ai-closed');
    toggle.style.display = 'block';
  });

  send.addEventListener('click', async () => {
    const question = input.value.trim();
    if (!question || busy) return;
    busy = true; send.disabled = true;
    appendMessage('user', question);
    input.value = '';
    setLoading(true, "L'IA rédige...");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 130000);
    try {
      const response = await fetch(AI_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: question }),
        signal: ctrl.signal
      });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      appendMessage('bot', data.response || "Désolé, je n'ai pas pu générer de réponse.");
    } catch (e) {
      const msg = e.name === 'AbortError' || e.message === '504'
        ? "L'IA met trop de temps à répondre. Réessayez dans un instant."
        : "Désolé, le serveur IA est momentanément indisponible. Réessayez dans quelques minutes.";
      appendMessage('bot', msg);
    } finally {
      clearTimeout(timer);
      busy = false; send.disabled = false;
      setLoading(false);
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); send.click(); }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUI);
} else {
  initUI();
}
