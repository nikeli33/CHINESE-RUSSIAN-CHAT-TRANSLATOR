/**
 * Попап: состояние аккаунта и моста, настройки, личный словарь.
 *
 * Ничего не решает сам — только показывает то, что знает service worker,
 * и открывает сайт, если человеку нужно войти. Гейт живёт на сервере:
 * здесь его нет и быть не может. Настройки и словарь — в `chrome.storage`,
 * пишет их служба, попап только просит.
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

/* ── Аккаунт ─────────────────────────────────────────────────────────────── */

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

  /* Строка под «Мостом» нужна только когда что-то не так: в рабочем
     состоянии она занимала высоту, которой в попапе и без неё тесно. */
  const say = (text) => {
    note.textContent = text;
    note.hidden = !text;
  };

  if (!status) {
    state.textContent = "нет ответа";
    say("Service worker не ответил. Перезагрузите расширение.");
    return;
  }

  if (status.auth && status.auth.error) {
    state.textContent = "не поднят";
    say("Вкладка сайта не открылась — проверьте, что сайт доступен.");
    return;
  }

  state.textContent = "готов";
  say("");
}

/* ── Настройки ───────────────────────────────────────────────────────────── */

const settingsUi = {
  seal: $("set-seal"),
  tts: $("set-tts"),
  theme: $("set-theme"),
  direction: $("set-direction"),
};

function renderSettings(config) {
  if (!config) return;
  settingsUi.seal.checked = config.autoSeal !== false;
  settingsUi.tts.checked = config.tts !== false;
  settingsUi.theme.value = config.theme || "auto";
  settingsUi.direction.value = config.direction || "auto";
  // Строка состояния нужна только на время записи, а не постоянно.
  $("settings-state").textContent = "";
}

async function pushSettings(patch) {
  const state = $("settings-state");
  state.textContent = "сохраняю…";

  let next = null;
  try {
    next = await chrome.runtime.sendMessage({ type: "ct:settings-set", patch });
  } catch {
    next = null;
  }

  if (next && !next.error) {
    renderSettings(next);
    state.textContent = "сохранено";
    window.setTimeout(() => {
      if (state.textContent === "сохранено") state.textContent = "";
    }, 1600);
    return;
  }
  state.textContent = "не сохранилось";
}

settingsUi.seal.addEventListener("change", () =>
  pushSettings({ autoSeal: settingsUi.seal.checked }),
);
settingsUi.tts.addEventListener("change", () => pushSettings({ tts: settingsUi.tts.checked }));
settingsUi.theme.addEventListener("change", () => pushSettings({ theme: settingsUi.theme.value }));
settingsUi.direction.addEventListener("change", () =>
  pushSettings({ direction: settingsUi.direction.value }),
);

/* ── Словарь ─────────────────────────────────────────────────────────────── */

function plural(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function renderWords(words) {
  const list = $("words-list");
  const count = $("words-count");
  const note = $("words-note");
  const exportButton = $("words-export");
  const clearButton = $("words-clear");

  list.textContent = "";
  exportButton.disabled = words.length === 0;
  clearButton.disabled = words.length === 0;

  if (words.length === 0) {
    count.textContent = "пусто";
    list.hidden = true;
    note.hidden = false;
    return;
  }

  count.textContent = `${words.length} ${plural(words.length, "слово", "слова", "слов")}`;
  note.hidden = true;
  list.hidden = false;

  for (const word of words) {
    const row = document.createElement("div");
    row.className = "word";

    const hanzi = document.createElement("span");
    hanzi.className = "word-hanzi";
    hanzi.textContent = word.hanzi;
    row.appendChild(hanzi);

    if (word.pinyin) {
      const pinyin = document.createElement("span");
      pinyin.className = "word-py";
      pinyin.textContent = word.pinyin;
      row.appendChild(pinyin);
    }

    const ru = document.createElement("span");
    ru.className = "word-ru";
    ru.textContent = word.ru || "";
    row.appendChild(ru);

    const remove = document.createElement("button");
    remove.className = "word-del";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Убрать из словаря";
    remove.setAttribute("aria-label", `Убрать ${word.hanzi}`);
    remove.addEventListener("click", async () => {
      try {
        await chrome.runtime.sendMessage({ type: "ct:word-remove", hanzi: word.hanzi });
      } catch {
        /* служба перезапустилась — список обновится следующим открытием */
      }
      await loadWords();
    });
    row.appendChild(remove);

    list.appendChild(row);
  }
}

let wordsCache = [];
let clearArmed = false;

async function loadWords() {
  let response = null;
  try {
    response = await chrome.runtime.sendMessage({ type: "ct:words" });
  } catch {
    response = null;
  }
  wordsCache = response && response.ok && Array.isArray(response.words) ? response.words : [];
  renderWords(wordsCache);
}

function exportCsv() {
  if (wordsCache.length === 0) return;

  const rows = [["hanzi", "pinyin", "ru", "added"]];
  for (const word of wordsCache) {
    rows.push([
      word.hanzi,
      word.pinyin || "",
      word.ru || "",
      word.at ? new Date(word.at).toISOString().slice(0, 10) : "",
    ]);
  }

  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");

  // BOM нужен Excel: без него кириллица и иероглифы открываются кракозябрами.
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "honglong-words.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("words-export").addEventListener("click", exportCsv);

$("words-clear").addEventListener("click", async () => {
  const button = $("words-clear");

  // Очистка необратима, а слова копились неделями — второй клик вместо confirm.
  if (!clearArmed) {
    clearArmed = true;
    button.textContent = "Точно очистить?";
    window.setTimeout(() => {
      clearArmed = false;
      button.textContent = "Очистить";
    }, 4000);
    return;
  }

  clearArmed = false;
  button.textContent = "Очистить";
  try {
    await chrome.runtime.sendMessage({ type: "ct:words-clear" });
  } catch {
    /* ниже всё равно перечитаем список */
  }
  await loadWords();
});

/* ── Запуск ──────────────────────────────────────────────────────────────── */

async function refresh() {
  let status = null;
  try {
    status = await chrome.runtime.sendMessage({ type: "ct:status", force: true });
  } catch {
    status = null;
  }

  renderAuth(status && status.auth);
  renderBridge(status);

  if (status && status.settings) {
    renderSettings(status.settings);
  } else {
    // Служба не ответила — спросим настройки отдельно, чтобы чекбоксы
    // не показывали пустоту вместо реального состояния.
    try {
      renderSettings(await chrome.runtime.sendMessage({ type: "ct:settings-get" }));
    } catch {
      /* останутся как есть */
    }
  }
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
  // Версию берём из манифеста, а не из разметки: вписанная руками строка
  // отстаёт от релиза молча (в 0.2.2 попап показывал 0.1.0).
  const version = $("version");
  if (version) version.textContent = `v${chrome.runtime.getManifest().version}`;

  void refresh();
  void loadWords();
});
