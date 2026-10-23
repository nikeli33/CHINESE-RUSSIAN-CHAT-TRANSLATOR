/**
 * Service worker 红龙 Переводчика.
 *
 * Три обязанности: держать мост на домене сайта, ходить через него в ручки
 * и кэшировать ответы. UI живёт в content script — здесь только транспорт.
 *
 * Почему мост, а не прямой fetch: см. content/bridge.js. Коротко — кука
 * сессии httpOnly + SameSite=Lax, из воркера она cross-site и не поедет.
 */

const SITE_ORIGINS = ["https://honglong.nexusbots.ru", "http://localhost:3000"];

/** Лёгкая страница для моста: JSON-документ, грузится мгновенно. */
const BRIDGE_PROBE = "/api/auth/me";
/** Запасной вариант, если в JSON-документ content script не встал. */
const BRIDGE_FALLBACK = "/";

const CACHE_MAX = 300;
const AUTH_TTL_MS = 60_000;

/* ── Меню ────────────────────────────────────────────────────────────────── */

function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "ct-ru-zh",
      title: "Перевести: русский → 中文",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "ct-zh-ru",
      title: "Перевести: 中文 → русский",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "ct-auto",
      title: "Перевести (язык определить)",
      contexts: ["selection"],
    });
  });
}

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || typeof tab.id !== "number") return;
  const direction =
    info.menuItemId === "ct-zh-ru"
      ? "zh-ru"
      : info.menuItemId === "ct-ru-zh"
        ? "ru-zh"
        : "auto";
  // Текст читает сам content script: info.selectionText теряет переносы
  // и обрезается на длинных выделениях.
  chrome.tabs
    .sendMessage(tab.id, { type: "ct:menu-translate", direction }, { frameId: info.frameId ?? 0 })
    .catch(() => {});
});

/* ── Настройки ───────────────────────────────────────────────────────────── */

async function settings() {
  const { ctSettings } = await chrome.storage.local.get("ctSettings");
  const origin =
    ctSettings && SITE_ORIGINS.includes(ctSettings.origin) ? ctSettings.origin : SITE_ORIGINS[0];
  return {
    origin,
    tts: ctSettings?.tts !== false,
    autoSeal: ctSettings?.autoSeal !== false,
  };
}

/* ── Мост ────────────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout:${label}`)), ms)),
  ]);
}

async function pingTab(tabId) {
  try {
    const res = await withTimeout(chrome.tabs.sendMessage(tabId, { type: "ct:ping" }), 1200, "ping");
    return res && res.ok ? res : null;
  } catch {
    return null;
  }
}

async function findReadyBridge(origin) {
  const { ctBridgeTab } = await chrome.storage.session.get("ctBridgeTab");
  if (typeof ctBridgeTab === "number") {
    const alive = await pingTab(ctBridgeTab);
    if (alive) return ctBridgeTab;
    await chrome.storage.session.remove("ctBridgeTab");
  }

  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  for (const tab of tabs) {
    if (typeof tab.id !== "number") continue;
    if (await pingTab(tab.id)) {
      await chrome.storage.session.set({ ctBridgeTab: tab.id });
      return tab.id;
    }
    // Вкладка открыта до установки расширения — моста в ней ещё нет.
    // Досылаем его, вместо того чтобы открывать вторую вкладку сайта.
    if (await injectBridge(tab.id)) {
      await chrome.storage.session.set({ ctBridgeTab: tab.id });
      return tab.id;
    }
  }
  return null;
}

async function injectBridge(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content/bridge.js"] });
    return (await pingTab(tabId)) != null;
  } catch {
    return false;
  }
}

async function waitForBridge(tabId, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    if (await pingTab(tabId)) return true;
    await sleep(250);
  }
  return false;
}

async function openBridgeTab(origin, path) {
  const tab = await chrome.tabs.create({ url: origin + path, active: false, pinned: true });
  if (typeof tab.id !== "number") return null;
  const ready = await waitForBridge(tab.id);
  if (!ready) return { tabId: tab.id, ready: false };
  return { tabId: tab.id, ready: true };
}

let ensuring = null;

/**
 * Найти живой мост или поднять его. Одна попытка на всех параллельных
 * вызовов: иначе три одновременных перевода откроют три вкладки.
 */
async function ensureBridge(force = false) {
  if (ensuring) return ensuring;

  ensuring = (async () => {
    const { origin } = await settings();

    if (!force) {
      const ready = await findReadyBridge(origin);
      if (ready != null) return ready;
    }

    // Быстрый путь: JSON-документ ручки. Если content script в него не встал —
    // тот же таб уводим на обычную HTML-страницу сайта.
    let opened = await openBridgeTab(origin, BRIDGE_PROBE);
    if (opened && !opened.ready) {
      await chrome.tabs.update(opened.tabId, { url: origin + BRIDGE_FALLBACK });
      if (await waitForBridge(opened.tabId)) opened = { tabId: opened.tabId, ready: true };
    }

    if (!opened || !opened.ready) return null;

    await chrome.storage.session.set({ ctBridgeTab: opened.tabId });
    return opened.tabId;
  })().finally(() => {
    ensuring = null;
  });

  return ensuring;
}

/** Вызов ручки сайта из контекста сайта. */
async function callApi(path, method = "GET", body) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const tabId = await ensureBridge(attempt > 0);
    if (tabId == null) return { ok: false, status: 0, code: "BRIDGE" };

    try {
      const res = await withTimeout(
        chrome.tabs.sendMessage(tabId, { type: "ct:api", path, method, body }),
        30_000,
        "api",
      );
      if (res && res.ok) return res;
      // Сервер ответил — пусть и отказом. Статус и тело нужны вызывающему:
      // по ним `describe()` отличит «нужен вход» от «квота» и «сбой модели».
      if (res && typeof res.status === "number" && res.status > 0) return res;
      return { ok: false, status: 0, code: "BRIDGE", error: res && res.error };
    } catch {
      // Таб закрыли или мост не ответил — со второй попытки поднимаем заново.
      await chrome.storage.session.remove("ctBridgeTab");
    }
  }
  return { ok: false, status: 0, code: "BRIDGE" };
}

/* ── Кэш переводов ───────────────────────────────────────────────────────── */

async function cacheGet(key) {
  const { ctCache } = await chrome.storage.session.get("ctCache");
  if (!ctCache || typeof ctCache !== "object") return null;
  const hit = ctCache[key];
  return hit ? hit.value : null;
}

async function cacheSet(key, value) {
  const { ctCache } = await chrome.storage.session.get("ctCache");
  const next = ctCache && typeof ctCache === "object" ? { ...ctCache } : {};
  next[key] = { value, at: Date.now() };

  const keys = Object.keys(next);
  if (keys.length > CACHE_MAX) {
    keys
      .sort((a, b) => next[a].at - next[b].at)
      .slice(0, keys.length - CACHE_MAX)
      .forEach((k) => delete next[k]);
  }
  await chrome.storage.session.set({ ctCache: next });
}

/* ── Ошибки ──────────────────────────────────────────────────────────────── */

function fail(code, message) {
  return { ok: false, code, message };
}

/** Превратить ответ ручки в человеческую строку. */
function describe(res) {
  if (res.code === "BRIDGE") {
    return fail(
      "BRIDGE",
      "Не удалось открыть вкладку honglong.nexusbots.ru. Проверьте, что сайт доступен, и повторите.",
    );
  }
  const status = res.status ?? 0;
  const detail =
    (res.data && (res.data.error?.message || res.data.error || res.data.message)) || "";

  if (status === 401) {
    return fail("AUTH", "Нужен вход на сайте HONGLONG — перевод доступен только аккаунтам.");
  }
  if (status === 429) {
    return fail("LIMIT", detail || "Дневной лимит переводов исчерпан. Попробуйте завтра.");
  }
  if (status === 403) {
    return fail("LIMIT", detail || "Доступ закрыт.");
  }
  // Формат ответа модели развалился — почти всегда это обрезанный по
  // max_tokens JSON. Код важен вызывающему: по нему он делит текст и
  // повторяет, вместо того чтобы сдаться.
  if (res.data && res.data.code === "BAD_FORMAT") {
    return fail("BAD_FORMAT", detail || "Модель вернула неожиданный формат.");
  }
  return fail("UPSTREAM", detail || `Сайт ответил ${status || "без ответа"}.`);
}

/* ── Перевод ─────────────────────────────────────────────────────────────── */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function detectDirection(text) {
  return CJK.test(text) ? "zh-ru" : "ru-zh";
}

/**
 * Размер порции одного запроса, в символах исходника.
 *
 * Это не «сколько человеку позволено выделить», а размер куска. Ручка просит
 * у модели JSON из пиньиня, перевода и разбора по словам, а бюджет ответа
 * режется по max_tokens. На абзаце в 200+ иероглифов пиньинь съедает весь
 * бюджет, JSON приходит обрезанным — и перевода нет вовсе. Поэтому длинный
 * текст едет несколькими порциями.
 */
const CHUNK_MAX = 100;

/**
 * Порезать текст на порции по границам предложений.
 *
 * Режем там, где разрыв ничего не ломает: 。！？； и перевод строки. Если само
 * предложение длиннее порции (частое дело в русском), добиваем по запятой или
 * пробелу, а в крайнем случае — по символу.
 */
function splitForTranslation(text, limit = CHUNK_MAX) {
  const parts = [];
  let buf = "";

  const sentences = text.match(/[^。！？；!?;\n]+[。！？；!?;\n]*/g) || [text];

  for (const sentence of sentences) {
    if (buf && (buf + sentence).length > limit) {
      parts.push(buf);
      buf = "";
    }
    buf += sentence;

    while (buf.length > limit) {
      let cut = Math.max(
        buf.lastIndexOf("，", limit),
        buf.lastIndexOf("、", limit),
        buf.lastIndexOf(",", limit),
        buf.lastIndexOf(" — ", limit),
        buf.lastIndexOf(" ", limit),
      );
      if (cut < limit * 0.4) cut = limit - 1;
      parts.push(buf.slice(0, cut + 1));
      buf = buf.slice(cut + 1);
    }
  }

  if (buf.trim()) parts.push(buf);
  // Краевые пробелы убираем: иначе на стыке порций выйдет двойной пробел.
  return parts.map((part) => part.trim()).filter(Boolean);
}

async function translate(rawText, direction) {
  const text = String(rawText ?? "").trim();
  if (!text) return fail("EMPTY", "Пустой текст.");
  if (text.length > 800) return fail("LONG", "Слишком длинный фрагмент — выделите короче.");

  const dir = direction === "auto" || !direction ? detectDirection(text) : direction;
  const key = `${dir}|${text}`;

  const cached = await cacheGet(key);
  if (cached) return { ok: true, result: cached, cached: true };

  const chunks = splitForTranslation(text);
  if (chunks.length <= 1) {
    const one = await translatePiece(text, dir);
    if (!one.ok) return one;
    await cacheSet(key, one.result);
    return { ok: true, result: one.result, cached: false };
  }

  // Порции идут по очереди, а не веером: параллель — это всплеск запросов к
  // модели, а он упирается в лимит частоты, и часть порций падает.
  const pieces = [];
  for (const chunk of chunks) {
    const one = await translatePiece(chunk, dir);
    if (!one.ok) return one;
    pieces.push(one.result.dst);
  }

  const result = {
    direction: dir,
    src: text,
    // Китайский склеиваем вплотную, русский — через пробел: там пробел значим.
    dst: pieces.join(dir === "ru-zh" ? "" : " "),
  };
  await cacheSet(key, result);
  return { ok: true, result, cached: false };
}

/**
 * Порция с подстраховкой.
 *
 * Если модель всё равно не уложилась в бюджет ответа и вернула обрезанный
 * JSON (BAD_FORMAT), порция делится пополам и уходит двумя запросами. Так
 * предел длины перестаёт быть угаданным числом: он подстраивается под то,
 * что модель реально может выдать, и не ломается при смене модели.
 */
async function translatePiece(text, dir, depth = 0) {
  const one = await translateChunk(text, dir);
  if (one.ok) return one;

  if (one.code !== "BAD_FORMAT" || depth >= 2 || text.length < 40) return one;

  const halves = splitForTranslation(text, Math.ceil(text.length / 2));
  if (halves.length < 2) return one;

  const pieces = [];
  for (const half of halves) {
    const sub = await translatePiece(half, dir, depth + 1);
    if (!sub.ok) return sub;
    pieces.push(sub.result.dst);
  }
  return {
    ok: true,
    result: { direction: dir, src: text, dst: pieces.join(dir === "ru-zh" ? "" : " ") },
    cached: false,
  };
}

/** Одна порция: запрос к ручке и разбор её ответа. */
async function translateChunk(text, dir) {
  const key = `${dir}|${text}`;
  const cached = await cacheGet(key);
  if (cached) return { ok: true, result: cached, cached: true };

  const res =
    dir === "ru-zh"
      ? await callApi("/api/translate", "POST", { text, direction: "ru-zh", mode: "full" })
      : await callApi("/api/translate", "POST", { text, mode: "full" });

  if (!res.ok) return describe(res);

  if (dir === "ru-zh") {
    const zh = res.data && (res.data.zh || res.data.zhText);
    if (!zh) {
      // Сайт ещё не знает направления: ручка вернула разбор русского текста
      // как китайского. Подсказка конкретная — иначе человек ищет баг у себя.
      return fail(
        "NO_RU_ZH",
        "Сервер пока не умеет русский → 中文. Нужна правка /api/translate на сайте (см. site-patch).",
      );
    }
    const result = { direction: dir, src: text, dst: String(zh) };
    await cacheSet(key, result);
    return { ok: true, result, cached: false };
  }

  const ru = res.data && (res.data.ru || res.data.translation);
  if (!ru) return fail("UPSTREAM", "Сайт ответил без перевода.");

  const result = { direction: dir, src: text, dst: String(ru) };
  await cacheSet(key, result);
  return { ok: true, result, cached: false };
}

/* ── Озвучка ─────────────────────────────────────────────────────────────── */

async function speak(text) {
  const clean = String(text ?? "").trim();
  if (!clean) return fail("EMPTY", "Нечего озвучивать.");

  const res = await callApi("/api/tts", "POST", { text: clean.slice(0, 300), engine: "piper" });
  if (!res.ok) return describe(res);
  if (!res.binary) return fail("UPSTREAM", "Сайт не вернул аудио.");
  return { ok: true, audio: res.binary };
}

/* ── Ева ─────────────────────────────────────────────────────────────────── */

/**
 * Спросить Еву — режим «Лаоши» (teacher): развёрнутое объяснение по-русски,
 * с примерами. Это не перевод, а ответ на вопрос о языке: «почему тут 了»,
 * «чем 的 отличается от 得», «почему он написал именно так».
 *
 * Ответ приходит потоком, поэтому ручка отвечает только «поехали», а куски
 * едут отдельными сообщениями от моста. Воркер состояния не держит:
 * targetTabId приходит обратно в каждом сообщении, и его перезапуск посреди
 * ответа ничего не рвёт.
 */
async function askEva(reqId, messages, targetTabId) {
  const history = Array.isArray(messages) ? messages : [];
  if (history.length === 0) return fail("EMPTY", "Пустой вопрос.");
  if (typeof targetTabId !== "number") return fail("BRIDGE", "Не понял, куда отвечать.");

  const tabId = await ensureBridge();
  if (tabId == null) {
    return fail(
      "BRIDGE",
      "Не удалось открыть вкладку honglong.nexusbots.ru. Проверьте, что сайт доступен, и повторите.",
    );
  }

  try {
    const res = await withTimeout(
      chrome.tabs.sendMessage(tabId, {
        type: "ct:api-stream",
        reqId,
        targetTabId,
        path: "/api/eva",
        body: { mode: "teacher", messages: history.slice(-20) },
      }),
      15_000,
      "eva",
    );
    if (!res || !res.ok) {
      return fail((res && res.code) || "UPSTREAM", (res && res.message) || "Ева не ответила.");
    }
    return { ok: true };
  } catch {
    await chrome.storage.session.remove("ctBridgeTab");
    return fail("BRIDGE", "Мост не ответил — попробуйте ещё раз.");
  }
}

/** Кусок ответа Евы → во вкладку, которая спросила. */
function forwardEva(msg, extra) {
  if (typeof msg.targetTabId !== "number") return;
  try {
    chrome.tabs
      .sendMessage(msg.targetTabId, { type: msg.type, reqId: msg.reqId, ...(extra || {}) })
      .catch(() => {});
  } catch {
    /* вкладку закрыли — некому отвечать */
  }
}

/* ── Сессия ──────────────────────────────────────────────────────────────── */

async function getAuth(force = false) {
  const { ctAuth } = await chrome.storage.session.get("ctAuth");
  if (!force && ctAuth && Date.now() - ctAuth.at < AUTH_TTL_MS) return ctAuth;

  const res = await callApi("/api/auth/me");
  if (!res.ok) {
    const value = { user: null, at: Date.now(), status: res.status ?? 0, error: true };
    await chrome.storage.session.set({ ctAuth: value });
    return value;
  }

  const user = (res.data && res.data.user) || null;
  const value = { user, at: Date.now(), status: res.status };
  await chrome.storage.session.set({ ctAuth: value });
  return value;
}

/* ── Маршрутизация сообщений ─────────────────────────────────────────────── */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return undefined;

  switch (msg.type) {
    case "ct:bridge-ready": {
      if (sender.tab && typeof sender.tab.id === "number") {
        chrome.storage.session.set({ ctBridgeTab: sender.tab.id });
      }
      sendResponse({ ok: true });
      return undefined;
    }

    case "ct:translate": {
      translate(msg.text, msg.direction).then(sendResponse, (err) =>
        sendResponse(fail("UNKNOWN", String(err))),
      );
      return true;
    }

    case "ct:tts": {
      speak(msg.text).then(sendResponse, (err) => sendResponse(fail("UNKNOWN", String(err))));
      return true;
    }

    case "ct:auth": {
      getAuth(Boolean(msg.force)).then(sendResponse, (err) =>
        sendResponse({ user: null, error: String(err) }),
      );
      return true;
    }

    case "ct:status": {
      Promise.all([getAuth(Boolean(msg.force)), settings()]).then(
        ([auth, cfg]) => sendResponse({ ok: true, auth, settings: cfg }),
        (err) => sendResponse({ ok: false, error: String(err) }),
      );
      return true;
    }

    case "ct:eva-ask": {
      askEva(msg.reqId, msg.messages, sender.tab && sender.tab.id).then(sendResponse, (err) =>
        sendResponse(fail("UNKNOWN", String(err))),
      );
      return true;
    }

    case "ct:eva-chunk": {
      forwardEva(msg, { chunk: msg.chunk });
      sendResponse({ ok: true });
      return undefined;
    }

    case "ct:eva-done": {
      forwardEva(msg);
      sendResponse({ ok: true });
      return undefined;
    }

    case "ct:eva-error": {
      forwardEva(msg, { message: msg.message });
      sendResponse({ ok: true });
      return undefined;
    }

    case "ct:close-bridge": {
      (async () => {
        const { ctBridgeTab } = await chrome.storage.session.get("ctBridgeTab");
        if (typeof ctBridgeTab === "number") {
          await chrome.tabs.remove(ctBridgeTab).catch(() => {});
        }
        await chrome.storage.session.remove("ctBridgeTab");
        sendResponse({ ok: true });
      })();
      return true;
    }

    default:
      return undefined;
  }
});
