/**
 * Мост на домене сайта.
 *
 * Зачем он нужен: сессия сайта живёт в httpOnly cookie `honglong_session`
 * с SameSite=Lax. Запрос из service worker расширения — cross-site, куку
 * туда не положат, а `document.cookie` её вообще не видит. Поэтому все
 * обращения к ручкам идут ОТСЮДА: эта страница загружена первой стороной,
 * и для неё `fetch("/api/…")` — обычный same-origin запрос с куками,
 * гейтом «аккаунт обязателен» и суточными квотами.
 *
 * Так же устроен «红龙 Слушатель» (см. web/src/components/listening/
 * use-listening-agent.ts) — приём не новый, а проверенный на этом же сайте.
 *
 * Протокол (service worker ⇄ мост):
 *   → { type: "ct:ping" }                     ← { ok, origin, href }
 *   → { type: "ct:api", path, method, body }  ← { ok, status, data | binary }
 *
 * Ответ на аудио отдаётся base64: runtime-messaging гоняет только JSON
 * и не клонирует ArrayBuffer.
 */

(() => {
  if (window.__ctBridgeLoaded) return;
  window.__ctBridgeLoaded = true;

  const ALLOWED_PREFIX = "/api/";

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return undefined;

    if (msg.type === "ct:ping") {
      sendResponse({ ok: true, origin: location.origin, href: location.href });
      return undefined;
    }

    if (msg.type === "ct:api") {
      // Возврат true обязателен: ответ уйдёт асинхронно, иначе канал закроется.
      callApi(msg).then(sendResponse, (err) => {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      });
      return true;
    }

    if (msg.type === "ct:api-stream") {
      streamApi(msg).then(sendResponse, (err) => {
        sendResponse({ ok: false, code: "BRIDGE", message: String(err && err.message ? err.message : err) });
      });
      return true;
    }

    return undefined;
  });

  /** Сообщить воркеру, что мост жив: избавляет от опроса при старте. */
  try {
    chrome.runtime.sendMessage({ type: "ct:bridge-ready", origin: location.origin });
  } catch {
    // Воркер спит или расширение перезагружено — не беда, пинг разбудит.
  }

  async function callApi({ path, method, body }) {
    if (typeof path !== "string" || !path.startsWith(ALLOWED_PREFIX)) {
      throw new Error("мост ходит только в /api/");
    }

    const res = await fetch(path, {
      method: method === "POST" ? "POST" : "GET",
      credentials: "include",
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    const type = res.headers.get("content-type") || "";

    if (type.includes("application/json")) {
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      // ok — это успех HTTP, а не «тело разобралось». Раньше здесь стояло
      // безусловное true, и любая ошибка сервера (502 от модели, 500, 413)
      // приезжала в карточку как «Сайт вернул пустой перевод»: статус
      // терялся, разбор ошибки в воркере не срабатывал.
      return { ok: res.ok, status: res.status, data };
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, binary: toBase64(buf) };
  }

  function toBase64(bytes) {
    // Кусочками: String.fromCharCode(...bytes) на большом WAV переполняет стек.
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  /**
   * Потоковая ручка: ответ приходит кусками (text/plain), а не JSON.
   *
   * Нужна для Евы: развёрнутое объяснение генерируется 10–20 секунд, и держать
   * человека перед пустой карточкой всё это время нельзя. Кусок сразу уходит
   * в service worker, тот переправляет его во вкладку, которая спросила.
   *
   * targetTabId приходит от воркера и едет обратно в каждом сообщении: так
   * воркер не хранит состояние и переживает собственный перезапуск.
   *
   * Отвечаем сразу `{ ok: true }` — дальше только сообщения, не sendResponse:
   * канал сообщения закрывается после первого ответа.
   */
  async function streamApi({ reqId, targetTabId, path, body }) {
    if (typeof path !== "string" || !path.startsWith(ALLOWED_PREFIX)) {
      throw new Error("мост ходит только в /api/");
    }

    const res = await fetch(path, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });

    const type = res.headers.get("content-type") || "";

    // Ошибку сервер отдаёт обычным JSON — разбираем её здесь, чтобы воркеру
    // и карточке достался готовый код (AUTH / LIMIT), а не голый статус.
    if (!res.ok || !res.body || !type.includes("text/plain")) {
      let message = `Сайт ответил ${res.status}.`;
      let code = "UPSTREAM";
      try {
        const data = await res.json();
        message = (data && (data.error?.message || data.error || data.message)) || message;
      } catch {
        /* не JSON — остаётся статус */
      }
      if (res.status === 401) code = "AUTH";
      if (res.status === 429 || res.status === 403) code = "LIMIT";
      return { ok: false, code, message };
    }

    void (async () => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk) {
            chrome.runtime.sendMessage({ type: "ct:eva-chunk", reqId, targetTabId, chunk });
          }
        }
        chrome.runtime.sendMessage({ type: "ct:eva-done", reqId, targetTabId });
      } catch (err) {
        chrome.runtime.sendMessage({
          type: "ct:eva-error",
          reqId,
          targetTabId,
          message: "Связь прервалась на середине ответа.",
        });
      }
    })();

    return { ok: true, started: true };
  }
})();
