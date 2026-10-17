/**
 * Попап: состояние аккаунта и моста.
 *
 * Ничего не решает сам — только показывает то, что знает service worker,
 * и открывает сайт, если человеку нужно войти. Гейт живёт на сервере:
 * здесь его нет и быть не может.
 */

const SITE = "https://honglong.nexusbots.ru";

const $ = (id) => document.getElementById(id);

function setDot(node, state) {
  if (node) node.dataset.state = state;
}

function makeButton(label, onClick, primary) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (primary) button.className = "primary";
  button.addEventListener("click", onClick);
  return button;
}

function openSite(path) {
  chrome.tabs.create({ url: SITE + path });
  window.close();
}

function renderAuth(auth) {
  const dot = $("auth-dot");
  const state = $("auth-state");
  const name = $("auth-name");
  const actions = $("auth-actions");
  actions.textContent = "";

  if (auth && auth.user) {
    setDot(dot, "ok");
    state.textContent = "вход выполнен";
    name.textContent = auth.user.name || auth.user.email || "аккаунт HONGLONG";
    actions.style.display = "none";
    return;
  }

  if (auth && auth.error) {
    setDot(dot, "bad");
    state.textContent = "сайт недоступен";
    name.textContent = "Не удалось проверить сессию. Откройте сайт в браузере.";
    actions.style.display = "flex";
    actions.appendChild(makeButton("Открыть сайт", () => openSite("/"), true));
    return;
  }

  setDot(dot, "wait");
  state.textContent = "не вошли";
  name.textContent = "Перевод работает только для аккаунтов HONGLONG.";
  actions.style.display = "flex";
  actions.appendChild(makeButton("Войти", () => openSite("/login"), true));
  actions.appendChild(makeButton("Регистрация", () => openSite("/register")));
}

function renderBridge(status) {
  const state = $("bridge-state");
  const note = $("bridge-note");

  if (!status) {
    state.textContent = "нет ответа";
    note.textContent = "Service worker не ответил. Перезагрузите расширение.";
    return;
  }

  if (status.auth && status.auth.error) {
    state.textContent = "не поднят";
    note.textContent =
      "Расширение открывает вкладку сайта, чтобы говорить с ним от первого лица. Не вышло — проверьте, что сайт открывается.";
    return;
  }

  state.textContent = "готов";
  note.textContent = "Вкладка сайта держится в фоне и закрывается сама, когда не нужна.";
}

async function refresh() {
  let status = null;
  try {
    status = await chrome.runtime.sendMessage({ type: "ct:status", force: true });
  } catch {
    status = null;
  }

  renderAuth(status && status.auth);
  renderBridge(status);
}

$("bridge-close").addEventListener("click", async () => {
  try {
    await chrome.runtime.sendMessage({ type: "ct:close-bridge" });
  } catch {
    /* нечего закрывать */
  }
  await refresh();
});

document.addEventListener("DOMContentLoaded", () => {
  void refresh();
});
