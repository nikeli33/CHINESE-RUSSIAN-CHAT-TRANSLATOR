/**
 * 红龙 Переводчик — интерфейс в странице.
 *
 * Что делает: замечает выделение, показывает у него печать «译», по клику
 * (или по правому клику из меню) просит перевод у service worker, рисует
 * карточку в shadow root и умеет вставить результат обратно в то поле,
 * откуда текст был взят.
 *
 * Почему shadow root: страница чата приносит свои стили, сбросы и z-index.
 * В изолированном дереве карточка выглядит одинаково везде, а `all: initial`
 * на хосте отсекает наследование. В разметку страницы мы не пишем ничего,
 * кроме одного пустого div с нулевым размером.
 *
 * Вставка — самое хрупкое место. Порядок: execCommand("insertText") →
 * замена содержимого Range вручную → нативный сеттер value для input/textarea.
 * Первый способ даёт настоящий beforeinput, который понимают Lexical,
 * ProseMirror, Draft и редактор Telegram Web, и сохраняет нативный undo.
 *
 * Shadow DOM: часть сайтов (bilibili — комментарии) строит текст в web
 * component'ах. Там document.getSelection().toString() текст отдаёт, но
 * getRangeAt(0) возвращает схлопнутый range в host'е — то есть нулевые
 * координаты. Прежняя проверка «rect пустой и поле не найдено» на этом
 * сдавалась, и печать не появлялась. Настоящий range живёт в shadow root'е,
 * и достаётся он через root.getSelection() (нестандартный, но живой метод
 * Chromium). Если root закрытый — берём хотя бы host, чтобы печать встала
 * у комментария, а не пропала совсем.
 */

(() => {
  if (window.__ctChatLoaded) return;
  window.__ctChatLoaded = true;
  if (!/^https?:$/.test(location.protocol)) return;

  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

  const state = {
    host: null,
    shadow: null,
    seal: null,
    card: null,
    // Панель кандидатов при наборе пиньинем.
    ime: null,
    saved: null,
    css: null,
    busy: false,
    lastRect: null,
    // Путь последнего события мыши. Нужен, чтобы найти shadow root, в котором
    // лежит выделение: снаружи видно только host, а composedPath знает, куда
    // именно пришёл клик.
    path: null,
    // Высота, под которую карточка уже поставлена: по ней понимаем, что она
    // выросла (ответ Евы) и место надо пересчитать.
    cardHeight: 0,
    // Разговор с Евой живёт ровно столько, сколько открыта карточка.
    evaMessages: [],
    evaLog: null,
    evaSink: null,
    evaBusy: false,
    // Настройки приезжают из службы при старте и обновляются на изменение
    // хранилища. Значения по умолчанию здесь — только до первого ответа.
    settings: { tts: true, autoSeal: true, theme: "auto", direction: "auto", pinyin: true },
  };

  /* ── Стили ─────────────────────────────────────────────────────────────── */

  function loadCss() {
    if (!state.css) {
      state.css = fetch(chrome.runtime.getURL("ui/card.css"))
        .then((r) => r.text())
        .then((text) => text.split("__EXT__").join(chrome.runtime.getURL("")))
        .catch(() => "");
    }
    return state.css;
  }

  /* ── Тема карточки ─────────────────────────────────────────────────────── */

  /**
   * Тёмная ли страница. Смотрим настоящий цвет фона body/html, а не
   * `prefers-color-scheme`: чаты сплошь и рядом тёмные при светлой системе
   * (и наоборот), а карточка должна совпадать со страницей, а не с ОС.
   * Системная тема — запасной вариант, когда фон прозрачный.
   */
  function pageIsDark() {
    const bg = (node) => {
      if (!node) return "";
      const color = getComputedStyle(node).backgroundColor || "";
      if (!color || color === "transparent") return "";
      if (/^rgba\([^)]*,\s*0(\.0+)?\s*\)$/.test(color)) return "";
      return color;
    };

    const color = bg(document.body) || bg(document.documentElement);
    const match = color.match(/rgba?\(([^)]+)\)/);
    if (match) {
      const [r, g, b, a = 1] = match[1].split(",").map((part) => parseFloat(part));
      if (a >= 0.5) {
        const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        return lum < 0.5;
      }
    }
    return Boolean(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function resolvedTheme() {
    const chosen = state.settings.theme;
    if (chosen === "dark" || chosen === "light") return chosen;
    return pageIsDark() ? "dark" : "light";
  }

  function applyTheme() {
    if (state.host) state.host.dataset.theme = resolvedTheme();
  }

  async function ensureHost() {
    if (state.host && state.host.isConnected) return state.shadow;

    const host = document.createElement("div");
    host.setAttribute("data-ct-root", "");
    // Нулевой фиксированный контейнер в углу вьюпорта: дети с position:absolute
    // считают координаты от него, то есть в координатах экрана. Сам он прозрачен
    // для мыши, кликабельны только печать и карточка.
    host.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none;";
    (document.body || document.documentElement).appendChild(host);
    host.dataset.theme = resolvedTheme();

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = await loadCss();
    shadow.appendChild(style);

    state.host = host;
    state.shadow = shadow;
    return shadow;
  }

  /* ── Что было выделено ─────────────────────────────────────────────────── */

  /** Родитель, который не спотыкается о границу shadow root. */
  function parentAcross(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode ? node.getRootNode() : null;
    return root && root.host ? root.host : null;
  }

  /** Ближайший (самый внешний) редактируемый предок узла. */
  function editableFrom(node) {
    let el = node && node.nodeType === 3 ? node.parentElement : node;
    let found = null;
    while (el && el !== document.documentElement) {
      if (el.isContentEditable) found = el;
      else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el;
      el = parentAcross(el);
    }
    return found;
  }

  /**
   * Настоящий фокус. document.activeElement для поля внутри web component'а
   * отдаёт host, а не поле, — спускаемся по цепочке shadowRoot.activeElement.
   */
  function deepActive() {
    let el = document.activeElement;
    for (let i = 0; i < 10; i += 1) {
      const inner = el && el.shadowRoot && el.shadowRoot.activeElement;
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  /** Цепочка shadow root'ов над узлом, от внутреннего к внешнему. */
  function rootsAbove(node, out, seen) {
    let el = node;
    while (el && el.getRootNode) {
      const root = el.getRootNode();
      if (!root || root === document || !root.host) return;
      if (!seen.has(root)) {
        seen.add(root);
        out.push(root);
      }
      el = root.host;
    }
  }

  /** Кандидаты, где искать выделение: путь события и фокус. */
  function candidateRoots() {
    const roots = [];
    const seen = new Set();
    for (const node of state.path || []) rootsAbove(node, roots, seen);
    rootsAbove(deepActive(), roots, seen);
    return roots;
  }

  /** Все открытые shadow root'ы страницы — крайняя мера, когда путь не помог. */
  function allOpenRoots() {
    const roots = [];
    for (const el of document.querySelectorAll("*")) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
    return roots;
  }

  /** Выделение внутри shadow root'а: текст, range и его координаты. */
  function selectionInRoot(root) {
    let sel = null;
    try {
      // Нестандартный метод Chromium, но именно он отдаёт range внутри
      // shadow tree. В других браузерах его нет — тогда просто пропускаем.
      sel = typeof root.getSelection === "function" ? root.getSelection() : null;
    } catch {
      return null;
    }
    if (!sel || !sel.rangeCount) return null;

    const range = sel.getRangeAt(0);
    if (range.collapsed) return null;

    const text = sel.toString().trim();
    if (!text) return null;

    const box = range.getBoundingClientRect();
    return { range, text, rect: box && box.width ? box : null };
  }

  /** Найти выделение в shadow DOM: сначала по известным root'ам, потом перебором. */
  function shadowSelection() {
    for (const root of candidateRoots()) {
      const hit = selectionInRoot(root);
      if (hit) return hit;
    }
    for (const root of allOpenRoots()) {
      const hit = selectionInRoot(root);
      if (hit) return hit;
    }
    return null;
  }

  function captureSelection() {
    const active = deepActive();

    // Поле ввода: window.getSelection() в input/textarea пуст, а позиции
    // выделения живут в selectionStart/End и переживают потерю фокуса.
    if (
      active &&
      (active.tagName === "INPUT" || active.tagName === "TEXTAREA") &&
      typeof active.selectionStart === "number" &&
      active.selectionStart !== active.selectionEnd
    ) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      const text = active.value.slice(start, end).trim();
      if (!text) return null;
      return {
        text,
        el: active,
        start,
        end,
        fromField: true,
        rect: active.getBoundingClientRect(),
      };
    }

    const sel = window.getSelection();
    if (!sel) return null;

    let range = null;
    let rect = null;
    if (sel.rangeCount) {
      const first = sel.getRangeAt(0);
      if (!first.collapsed) {
        range = first;
        rect = first.getBoundingClientRect();
      }
    }

    let text = sel.toString().trim();

    // Внутри shadow root'а Selection текст отдаёт, а Range — схлопнутый в
    // host'е. Значит range и координаты надо брать из самого shadow root'а.
    // Перебор root'ов затеваем только когда он осмыслен: текст есть или якорь
    // стоит на host'е web component'а. Иначе обычный клик без выделения
    // стоил бы полного обхода DOM.
    if (!range) {
      const anchor = sel.anchorNode;
      const hostEl = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
      if (text || (hostEl && hostEl.shadowRoot)) {
        const inner = shadowSelection();
        if (inner) {
          range = inner.range;
          rect = inner.rect || rect;
          if (!text) text = inner.text;
        }
      }
    }

    if (!text) return null;

    const el = range ? editableFrom(range.startContainer) : null;

    // Закрытый shadow root: range недоступен, но host виден — ставим печать
    // у него. Лучше приблизительное место, чем никакого.
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      const anchor = sel.anchorNode;
      const host = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
      const box = host ? host.getBoundingClientRect() : null;
      if (box && box.width) rect = box;
    }

    if ((!rect || (rect.width === 0 && rect.height === 0)) && !el) return null;

    return {
      text,
      el,
      range: range ? range.cloneRange() : null,
      fromField: false,
      rect: rect && rect.width ? rect : el ? el.getBoundingClientRect() : null,
    };
  }

  /* ── Печать у выделения ────────────────────────────────────────────────── */

  function hideSeal() {
    if (state.seal && state.seal.parentNode) state.seal.remove();
    state.seal = null;
  }

  /* ── Прогрев моста ─────────────────────────────────────────────────────── */

  /**
   * Поднять вкладку-мост заранее.
   *
   * Печать появляется в момент выделения, а нажимают на неё через секунду-
   * две — за это время вкладка сайта успевает загрузиться, и перевод приходит
   * без ожидания. Решение «прогревать или нет» принимает служба: она знает,
   * пользовались ли переводчиком раньше. Иначе первое выделение любого текста
   * открывало бы вкладку сайта без просьбы.
   *
   * Троттлинг нужен, чтобы не будить службу на каждое выделение: прогревать
   * чаще раза в полминуты бессмысленно — мост либо уже есть, либо грузится.
   */
  let warmedAt = 0;
  function warmBridge() {
    if (Date.now() - warmedAt < 30_000) return;
    warmedAt = Date.now();
    chrome.runtime.sendMessage({ type: "ct:bridge-warm" }).catch(() => {});
  }

  async function showSeal(saved) {
    if (!saved || !saved.rect) return;
    hideSeal();
    warmBridge();

    const shadow = await ensureHost();
    if (!state.host || !state.host.isConnected) return;

    const seal = document.createElement("button");
    seal.className = "ct-seal";
    seal.type = "button";
    seal.title = "Перевести выделенное";
    seal.setAttribute("aria-label", "Перевести выделенное");
    seal.textContent = "译";
    // mousedown гасим: иначе браузер снимет выделение раньше, чем случится клик.
    seal.addEventListener("mousedown", (e) => e.preventDefault());
    seal.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const keep = state.saved;
      hideSeal();
      if (keep) void runTranslate(keep, "auto");
    });

    const rect = saved.rect;
    const size = 26;
    let left;
    let top;

    if (saved.fromField) {
      left = Math.min(window.innerWidth - size - 8, Math.max(8, rect.right - size - 8));
      top = Math.max(8, rect.top + 6);
    } else {
      left = Math.min(
        window.innerWidth - size - 8,
        Math.max(8, rect.left + rect.width / 2 - size / 2),
      );
      top = Math.max(8, rect.top - size - 6);
    }

    seal.style.left = `${Math.round(left)}px`;
    seal.style.top = `${Math.round(top)}px`;
    shadow.appendChild(seal);
    state.seal = seal;
  }

  /* ── Карточка ──────────────────────────────────────────────────────────── */

  function hideCard() {
    if (state.card && state.card.parentNode) state.card.remove();
    state.card = null;
    // Разговор с Евой не переживает карточку: новый перевод — новый разговор.
    state.evaMessages = [];
    state.evaLog = null;
    state.evaSink = null;
    state.evaBusy = false;
    state.cardHeight = 0;
  }

  /** Пиньинь посимвольно, с классом тона на каждом слоге. */
  function pinyinNodes(text) {
    const pp = window.pinyinPro;
    if (!pp || typeof pp.pinyin !== "function") return null;

    let items;
    try {
      items = pp.pinyin(text, { type: "all" });
    } catch {
      return null;
    }
    if (!Array.isArray(items) || items.length === 0) return null;

    const frag = document.createDocumentFragment();
    let afterSyllable = false;
    for (const item of items) {
      if (!item) continue;
      if (!item.isZh) {
        // Пробел перед знаком препинания — «nǐ hǎo ,» — выглядит как ошибка.
        // Снимаем его, если предыдущим был слог, и только тогда.
        if (afterSyllable && frag.lastChild && frag.lastChild.nodeType === 3) {
          frag.lastChild.textContent = frag.lastChild.textContent.replace(/\s+$/, "");
        }
        frag.appendChild(document.createTextNode(item.origin || ""));
        afterSyllable = false;
        continue;
      }
      const span = document.createElement("span");
      span.className = `t${item.num || 5}`;
      span.textContent = item.pinyin || item.origin || "";
      frag.appendChild(span);
      frag.appendChild(document.createTextNode(" "));
      afterSyllable = true;
    }
    if (afterSyllable && frag.lastChild && frag.lastChild.nodeType === 3) {
      frag.lastChild.textContent = frag.lastChild.textContent.replace(/\s+$/, "");
    }
    return frag;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function positionCard(card, rect) {
    // Сначала примеряем над выделением, не влезает — под ним.
    const gap = 8;
    card.style.visibility = "hidden";
    card.style.left = "0px";
    card.style.top = "0px";

    const box = card.getBoundingClientRect();
    const width = box.width || 300;
    const height = box.height || 120;

    let left = rect ? rect.left : 40;
    let top = rect ? rect.top - height - gap : 80;

    if (top < 8) top = rect ? rect.bottom + gap : 80;
    left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - width - 8));
    top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - height - 8));

    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
    card.style.visibility = "visible";
    state.cardHeight = Math.round(height);
  }

  /**
   * Карточка выросла уже после расстановки — например, Ева дописала ответ.
   * Тогда прежний `top` оставляет её нижний край за экраном, поэтому место
   * пересчитываем. Дёргаем только при заметном изменении высоты, иначе
   * карточка прыгала бы на каждом куске текста.
   */
  let reflowQueued = false;
  function reflowCard() {
    if (reflowQueued) return;
    reflowQueued = true;
    requestAnimationFrame(() => {
      reflowQueued = false;
      const card = state.card;
      if (!card || !card.isConnected) return;
      const height = Math.round(card.getBoundingClientRect().height);
      if (Math.abs(height - state.cardHeight) < 4) return;
      positionCard(card, state.lastRect);
    });
  }

  async function mountCard(saved) {
    const shadow = await ensureHost();
    if (!state.host || !state.host.isConnected) return null;

    hideCard();
    const card = el("div", "ct-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Перевод");
    // Клики внутри карточки не должны уходить странице (чаты любят глобальные
    // обработчики, которые закрывают панели и сбрасывают фокус).
    card.addEventListener("mousedown", (e) => e.stopPropagation());
    card.addEventListener("click", (e) => e.stopPropagation());

    shadow.appendChild(card);
    state.card = card;
    state.lastRect = saved && saved.rect ? saved.rect : null;
    return card;
  }

  function head(card, label) {
    const headNode = el("div", "ct-head");
    headNode.appendChild(el("span", "ct-label", label));
    const close = el("button", "ct-close", "×");
    close.type = "button";
    close.title = "Закрыть";
    close.addEventListener("click", () => {
      hideCard();
      hideSeal();
    });
    headNode.appendChild(close);
    card.appendChild(headNode);
    return headNode;
  }

  function busyCard(card, label) {
    head(card, label);
    const body = el("div", "ct-note");
    const row = el("div", "ct-busy");
    row.appendChild(el("span", "ct-dot"));
    row.appendChild(el("span", null, "перевожу…"));
    body.appendChild(row);
    card.appendChild(body);
  }

  /**
   * Карточка-сообщение вместо перевода.
   *
   * `action` — либо ссылка (`href`), либо действие в самой карточке
   * (`onClick`): «Повторить» не должно уводить человека на сайт, ему нужно
   * повторить попытку здесь.
   */
  function noteCard(card, label, text, action) {
    // В карточке уже может висеть «перевожу…» — заменяем, а не дописываем.
    card.replaceChildren();
    head(card, label);
    const body = el("div", "ct-note");
    body.appendChild(el("div", null, text));
    if (action) {
      const a = el("div", "ct-link", action.label);
      a.style.marginTop = "8px";
      a.setAttribute("role", "button");
      a.tabIndex = 0;
      a.addEventListener("click", () => {
        if (typeof action.onClick === "function") action.onClick();
        else window.open(action.href, "_blank", "noopener");
      });
      a.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (typeof action.onClick === "function") action.onClick();
        else window.open(action.href, "_blank", "noopener");
      });
      body.appendChild(a);
    }
    card.appendChild(body);
  }

  /**
   * Короткое сообщение в карточке. Нужно там, где раньше не происходило
   * ровно ничего: правый клик по выделению, которое прочитать не вышло.
   * Молчание в таком случае выглядит как поломка расширения.
   */
  function showNotice(text) {
    void (async () => {
      const card = await mountCard({ rect: null });
      if (!card) return;
      noteCard(card, "перевод", text);
      positionCard(card, null);
      window.setTimeout(() => {
        if (state.card === card) hideCard();
      }, 6000);
    })();
  }

  /* ── Слова из разбора ──────────────────────────────────────────────────── */

  /**
   * Чип слова: иероглиф, пиньинь, перевод. Клик — сохранить в личный словарь.
   *
   * Словарь живёт в расширении, а не в SRS сайта: карточка там хранит только
   * иероглиф и ссылку на урок, а пиньинь с переводом сайт берёт из своего
   * индекса лексики. Слово из чужого чата в этот индекс не входит, и очередь
   * повторения (`/practice` фильтрует по индексу) молча его выбросила бы.
   */
  function wordChip(word) {
    const chip = el("button", "ct-word");
    chip.type = "button";
    chip.title = "Сохранить в словарь";
    chip.setAttribute("aria-label", `Сохранить в словарь: ${word.hanzi}`);

    chip.appendChild(el("span", "ct-word-hanzi", word.hanzi));
    if (word.pinyin) chip.appendChild(el("span", "ct-word-py", word.pinyin));
    if (word.ru) chip.appendChild(el("span", "ct-word-ru", word.ru));

    // mousedown гасим: иначе клик по чипу снимает выделение под карточкой.
    chip.addEventListener("mousedown", (e) => e.preventDefault());
    chip.addEventListener("click", () => void saveWord(word, chip));
    return chip;
  }

  async function saveWord(word, chip) {
    if (chip.dataset.saved === "1") return;

    let response = null;
    try {
      response = await chrome.runtime.sendMessage({ type: "ct:word-save", word });
    } catch {
      response = null;
    }

    if (response && response.ok) {
      chip.dataset.saved = "1";
      chip.title = response.duplicate ? "Уже в словаре" : "В словаре";
      chip.appendChild(el("span", "ct-word-mark", "✓"));
      return;
    }

    chip.title = (response && response.message) || "Не удалось сохранить";
    chip.dataset.failed = "1";
    window.setTimeout(() => {
      delete chip.dataset.failed;
    }, 1200);
  }

  function buildResult(card, saved, result) {
    const isZhTarget = result.direction === "ru-zh";
    const label = isZhTarget ? "русский → 中文" : "中文 → русский";

    // В карточке уже может висеть «перевожу…» — заменяем, а не дописываем.
    card.replaceChildren();
    head(card, label);

    const body = el("div", "ct-body");

    const primary = el("div", "ct-primary", result.dst);
    primary.dataset.lang = isZhTarget ? "zh" : "ru";
    body.appendChild(primary);

    // Пиньинь всегда от китайской стороны: для RU→ZH это перевод,
    // для ZH→RU — исходник. Считает библиотека, а не модель: она не врёт в тонах.
    const zhText = isZhTarget ? result.dst : result.src;
    if (CJK.test(zhText)) {
      const nodes = pinyinNodes(zhText);
      if (nodes) {
        const pinyin = el("div", "ct-pinyin");
        pinyin.appendChild(nodes);
        body.appendChild(pinyin);
      }
    }

    if (result.src && result.src !== result.dst) {
      const source = el("div", "ct-source", result.src);
      source.dataset.lang = CJK.test(result.src) ? "zh" : "ru";
      body.appendChild(source);
    }

    // Разбор по словам приходит вместе с переводом (сервер считает его в том
    // же ответе), поэтому показываем сразу и бесплатно — без второго запроса.
    if (Array.isArray(result.words) && result.words.length > 0) {
      const words = el("div", "ct-words");
      for (const word of result.words.slice(0, 6)) words.appendChild(wordChip(word));
      body.appendChild(words);
    }

    card.appendChild(body);

    const actions = el("div", "ct-actions");

    const canInsert = Boolean(saved && saved.el && saved.el.isConnected);
    if (canInsert) {
      const insert = el("button", "ct-btn ct-btn-primary", "Вставить");
      insert.type = "button";
      insert.addEventListener("mousedown", (e) => e.preventDefault());
      insert.addEventListener("click", () => {
        const done = insertText(result.dst, saved);
        if (done.ok) {
          insert.textContent = "Готово";
          insert.disabled = true;
          setTimeout(() => hideCard(), 700);
        } else {
          insert.textContent = "Не вышло";
          insert.disabled = true;
          copyText(result.dst);
          setTimeout(() => {
            insert.textContent = "Скопировано";
          }, 600);
        }
      });
      actions.appendChild(insert);
    }

    const copy = el("button", "ct-btn", "Копировать");
    copy.type = "button";
    copy.addEventListener("mousedown", (e) => e.preventDefault());
    copy.addEventListener("click", () => {
      copyText(result.dst);
      copy.textContent = "Скопировано";
      setTimeout(() => {
        copy.textContent = "Копировать";
      }, 1200);
    });
    actions.appendChild(copy);

    const speak = el("button", "ct-btn ct-btn-icon", "♪");
    speak.type = "button";
    speak.title = "Озвучить";
    speak.setAttribute("aria-label", "Озвучить");
    speak.addEventListener("mousedown", (e) => e.preventDefault());
    speak.addEventListener("click", () => {
      speak.disabled = true;
      speakText(zhText).finally(() => {
        speak.disabled = false;
      });
    });
    if (state.settings.tts) actions.appendChild(speak);

    card.appendChild(actions);
    evaBlock(card, saved);
    positionCard(card, saved && saved.rect);
  }

  /* ── Ева ───────────────────────────────────────────────────────────────── */

  /**
   * Блок Евы в карточке: аватарка, готовые вопросы и поле для своего.
   *
   * Вопрос уходит в `/api/eva` с `mode: "teacher"` — это «Лаоши»: развёрнутое
   * объяснение по-русски с примерами, а не перевод. Первый вопрос несёт сам
   * выделенный текст, дальше история копится в `state.evaMessages` и уезжает
   * на сервер целиком, поэтому Ева помнит, о чём уже говорили.
   */
  function evaBlock(card, saved) {
    const wrap = el("div", "ct-eva");

    const top = el("div", "ct-eva-top");
    const face = document.createElement("img");
    face.className = "ct-eva-face";
    face.src = chrome.runtime.getURL("eva/eva.jpg");
    face.alt = "Ева";
    face.draggable = false;
    top.appendChild(face);

    const who = el("div", "ct-eva-who");
    who.appendChild(el("span", "ct-eva-name", "Ева"));
    who.appendChild(el("span", "ct-eva-role", "учитель китайского"));
    top.appendChild(who);
    wrap.appendChild(top);

    const chips = el("div", "ct-eva-chips");
    for (const preset of ["Почему так написано?", "Разбери по словам", "Как это произносится?"]) {
      const chip = el("button", "ct-chip", preset);
      chip.type = "button";
      // mousedown гасим, иначе поле ввода теряет выделение и каретку.
      chip.addEventListener("mousedown", (e) => e.preventDefault());
      chip.addEventListener("click", () => evaAsk(saved, preset));
      chips.appendChild(chip);
    }
    wrap.appendChild(chips);

    const form = el("form", "ct-eva-form");
    const input = document.createElement("input");
    input.className = "ct-eva-input";
    input.type = "text";
    input.placeholder = "Свой вопрос про этот текст…";
    // У чатов свои горячие клавиши — из поля Евы они уезжать не должны.
    input.addEventListener("keydown", (e) => e.stopPropagation());
    form.appendChild(input);

    const send = el("button", "ct-eva-send", "→");
    send.type = "submit";
    send.title = "Спросить Еву";
    send.setAttribute("aria-label", "Спросить Еву");
    form.appendChild(send);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const question = input.value.trim();
      if (!question) return;
      input.value = "";
      evaAsk(saved, question);
    });
    wrap.appendChild(form);

    const log = el("div", "ct-eva-log");
    log.hidden = true;
    wrap.appendChild(log);

    state.evaLog = log;
    card.dataset.view = "eva";
    card.appendChild(wrap);
    reflowCard();
  }

  /** Задать вопрос: реплика в лог, запрос в службу, ответ приедет кусками. */
  function evaAsk(saved, question) {
    const log = state.evaLog;
    if (!log || state.evaBusy) return;

    const source = (saved && saved.text ? saved.text : "").trim();
    const first = state.evaMessages.length === 0;
    const content = first && source ? `Текст: «${source}»\n\nВопрос: ${question}` : question;
    state.evaMessages.push({ role: "user", content });

    log.hidden = false;
    const questionNode = el("div", "ct-eva-q", question);
    log.appendChild(questionNode);

    const answer = el("div", "ct-eva-a");
    const busy = el("div", "ct-busy");
    busy.appendChild(el("span", "ct-dot"));
    busy.appendChild(el("span", null, "Ева думает…"));
    answer.appendChild(busy);
    log.appendChild(answer);
    log.scrollTop = log.scrollHeight;
    reflowCard();

    const reqId = `eva-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    state.evaBusy = true;
    state.evaSink = { reqId, answer, busy, text: null, acc: "", log, question: questionNode };

    chrome.runtime
      .sendMessage({ type: "ct:eva-ask", reqId, messages: state.evaMessages })
      .then(
        (res) => {
          if (res && res.ok) return; // дальше только куски ответа
          evaFail((res && res.message) || "Ева не ответила.", res && res.code);
        },
        () => evaFail("Расширение перезагружено — обновите страницу.", "CONTEXT"),
      );
  }

  function evaAppend(chunk) {
    const sink = state.evaSink;
    if (!sink || !chunk) return;
    if (sink.busy && sink.busy.parentNode) sink.busy.remove();
    if (!sink.text) {
      sink.text = el("div", "ct-eva-a-text");
      sink.answer.appendChild(sink.text);
    }
    sink.acc += chunk;
    sink.text.textContent = sink.acc;
    sink.log.scrollTop = sink.log.scrollHeight;
    reflowCard();
  }

  function evaFinish() {
    const sink = state.evaSink;
    if (!sink) return;
    if (sink.busy && sink.busy.parentNode) sink.busy.remove();

    const answer = sink.acc.trim();
    if (answer) {
      state.evaMessages.push({ role: "assistant", content: answer });
    } else {
      state.evaMessages.pop();
      sink.answer.appendChild(el("div", "ct-eva-err", "Пустой ответ — попробуйте ещё раз."));
    }
    state.evaBusy = false;
    state.evaSink = null;

    // Пока текста не было, лог листался вниз вслед за ответом. Теперь ответ
    // дописан — возвращаемся к началу, иначе объяснение открывается с середины.
    if (sink.question && sink.log) {
      const offset = sink.question.offsetTop - sink.log.offsetTop;
      if (Number.isFinite(offset)) sink.log.scrollTop = Math.max(0, offset);
    }
    reflowCard();
  }

  function evaFail(message, code) {
    const sink = state.evaSink;
    if (!sink) return;
    if (sink.busy && sink.busy.parentNode) sink.busy.remove();

    // Оборвались на середине — часть ответа уже полезна, оставляем её.
    const partial = sink.acc.trim();
    if (partial) state.evaMessages.push({ role: "assistant", content: partial });
    else state.evaMessages.pop();

    sink.answer.appendChild(el("div", "ct-eva-err", message));
    if (code === "AUTH") {
      const link = el("div", "ct-eva-link", "Войти на honglong.nexusbots.ru");
      link.addEventListener("click", () => {
        window.open("https://honglong.nexusbots.ru/login", "_blank", "noopener");
      });
      sink.answer.appendChild(link);
    }
    sink.log.scrollTop = sink.log.scrollHeight;

    state.evaBusy = false;
    state.evaSink = null;
    reflowCard();
  }

  /* ── Перевод ───────────────────────────────────────────────────────────── */

  async function runTranslate(saved, direction) {
    if (!saved || state.busy) return;
    state.saved = saved;
    state.busy = true;

    const preferred = state.settings.direction;
    const dir =
      direction === "auto" || !direction
        ? preferred !== "auto"
          ? preferred
          : CJK.test(saved.text)
            ? "zh-ru"
            : "ru-zh"
        : direction;

    const card = await mountCard(saved);
    if (!card) {
      state.busy = false;
      return;
    }
    busyCard(card, dir === "ru-zh" ? "русский → 中文" : "中文 → русский");

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        type: "ct:translate",
        text: saved.text,
        direction: dir,
      });
    } catch (err) {
      response = { ok: false, code: "CONTEXT", message: "Расширение перезагружено — обновите страницу." };
    }

    state.busy = false;
    if (!state.card) return; // карточку успели закрыть

    if (!response || !response.ok) {
      const message = (response && response.message) || "Перевод недоступен.";
      const code = response && response.code;

      // «Повторить» — только для моста: остальные отказы (нужен вход, лимит,
      // пустой ответ) повтором не лечатся, и кнопка врала бы.
      let action = null;
      if (code === "BRIDGE") {
        action = { label: "Повторить", onClick: () => void runTranslate(saved, direction) };
      } else if (code === "AUTH") {
        action = { label: "Открыть honglong.nexusbots.ru", href: "https://honglong.nexusbots.ru/login" };
      }

      noteCard(
        state.card,
        dir === "ru-zh" ? "русский → 中文" : "中文 → русский",
        message,
        action,
      );
      positionCard(state.card, saved.rect);
      return;
    }

    buildResult(state.card, saved, response.result);
  }

  /* ── Вставка ───────────────────────────────────────────────────────────── */

  function insertText(text, saved) {
    const target = saved && saved.el;
    if (!target || !target.isConnected) return { ok: false, reason: "detached" };

    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      return insertIntoField(target, saved, text);
    }
    if (target.isContentEditable) {
      return insertIntoEditable(target, saved, text);
    }
    return { ok: false, reason: "not-editable" };
  }

  function insertIntoField(field, saved, text) {
    field.focus();

    const proto =
      field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

    const value = field.value;
    const start = typeof saved.start === "number" ? saved.start : value.length;
    const end = typeof saved.end === "number" ? saved.end : start;
    const next = value.slice(0, start) + text + value.slice(end);

    // Нативный сеттер обходит React-трекер значения: иначе onChange не увидит
    // подмены и поле «откатится» на следующем рендере.
    if (setter) setter.call(field, next);
    else field.value = next;

    const caret = start + text.length;
    try {
      field.selectionStart = caret;
      field.selectionEnd = caret;
    } catch {
      /* некоторые типы input не поддерживают выделение */
    }

    field.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: text }),
    );
    return { ok: true };
  }

  /**
   * Вернуть выделение на место. Если range живёт в shadow tree, кладём его
   * в селекшн самого root'а: документный Selection такой range принимает не
   * всегда, а removeAllRanges() до попытки addRange() оставил бы редактор
   * вообще без выделения.
   */
  function restoreRange(saved) {
    const range = saved && saved.range;
    if (!range) return;

    const root =
      range.startContainer && range.startContainer.getRootNode
        ? range.startContainer.getRootNode()
        : null;

    if (root && root !== document && typeof root.getSelection === "function") {
      try {
        const own = root.getSelection();
        own.removeAllRanges();
        own.addRange(range);
        return;
      } catch {
        /* ниже общий путь */
      }
    }

    const sel = window.getSelection();
    if (!sel) return;
    try {
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      /* Range мог устареть после перерисовки редактора */
    }
  }

  function insertIntoEditable(editor, saved, text) {
    editor.focus();
    restoreRange(saved);

    // Основной путь: настоящий insertText. Редакторы на contenteditable
    // (Telegram Web, Discord, WhatsApp) слушают beforeinput и применяют
    // изменение к своей модели, а браузер сохраняет нативный undo.
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch {
      ok = false;
    }
    if (ok) return { ok: true };

    // Запасной путь: правим Range руками и сообщаем об изменении событием.
    try {
      const range = saved.range ? saved.range.cloneRange() : null;
      if (!range) return { ok: false, reason: "no-range" };

      range.deleteContents();
      const node = document.createTextNode(text);
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);

      restoreRange({ range });
      editor.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
      );
      return { ok: true, fallback: true };
    } catch {
      return { ok: false, reason: "exec" };
    }
  }

  /* ── Ввод пиньинем ─────────────────────────────────────────────────────── */

  /**
   * Набрал «nihao» — получил 你好.
   *
   * Работает по слогам, как шаг «Скажите сами» на сайте: латинский хвост перед
   * курсором считается слогом, словарь отдаёт его иероглифы. После подстановки
   * курсор стоит за иероглифом, и следующий слог набирается заново — так
   * «ni» → 你, «hao» → 好 сами складываются в 你好, без всякой сегментации.
   *
   * Словарь лежит в расширении (`vendor/pinyin-dict.js`, 37 КБ). Это главное
   * отличие от сайта: там кандидатов спрашивают у `/api/pinyin-input`, а здесь
   * подсказка нужна на каждом нажатии клавиши. Ходить в сеть за ней — значит
   * дёргать вкладку-мост, тратить суточную квоту сайта и ждать ответа там,
   * где человек просто печатает. При наборе не уходит ни одного запроса.
   *
   * Тоны на вводе не учитываются: «zhe», «zhè» и «ZHE» — один слог. Один
   * иероглиф может читаться по-разному и попадает во все свои слоги.
   */

  /** Сколько кандидатов показывать: остальные всё равно не выбирают. */
  const IME_SHOWN = 12;

  /** Латинский хвост перед курсором, с диакритикой на случай «zhè». */
  const SYLLABLE_RE = /([a-zA-Zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]+)$/;

  /** Поля, у которых есть `selectionStart` и осмысленный текстовый ввод. */
  const TEXT_INPUTS = new Set(["text", "search", "url", "tel"]);

  function hideIme() {
    if (state.ime && state.ime.isConnected) state.ime.remove();
    state.ime = null;
  }

  /**
   * «Zhe» → «zhe», «lǜ» → «lv».
   *
   * `ü` заменяем ДО нормализации: NFD разлагает её на «u» + диэрезис, и после
   * снятия диакритики от неё осталось бы просто «u» — «lü» превратился бы
   * в «lu», а такого слога в словаре нет.
   */
  function normalizeSyllable(raw) {
    return String(raw)
      .toLowerCase()
      .replace(/ü/g, "v")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z]/g, "");
  }

  function imeCandidates(syllable) {
    const dict = window.__ctPinyinDict;
    if (!dict || typeof dict !== "object") return null;
    const list = dict[syllable];
    return Array.isArray(list) && list.length ? list : null;
  }

  /** Редактируемое поле по настоящему узлу события (после retargeting). */
  function editableFor(node) {
    if (!node || node.nodeType !== 1) return null;
    if (node.tagName === "INPUT") {
      return TEXT_INPUTS.has(String(node.type || "text").toLowerCase()) ? node : null;
    }
    if (node.tagName === "TEXTAREA") return node;
    if (node.isContentEditable) return node;
    return null;
  }

  /** Селекшн того дерева, где живёт поле: у поля в shadow root он свой. */
  function selectionOf(field) {
    const root = field.getRootNode ? field.getRootNode() : document;
    if (root && root !== document && typeof root.getSelection === "function") {
      return root.getSelection();
    }
    return window.getSelection();
  }

  /**
   * Слог непосредственно перед курсором.
   *
   * Для input/textarea — по значению и `selectionStart`. Для contenteditable —
   * по узлу и смещению каретки; если каретка стоит в элементе, а не в тексте
   * (пустой редактор), слога нет.
   */
  function syllableAtCaret(field) {
    if (field.tagName === "INPUT" || field.tagName === "TEXTAREA") {
      const start = field.selectionStart;
      const end = field.selectionEnd;
      if (typeof start !== "number" || start !== end) return null;
      const match = SYLLABLE_RE.exec(String(field.value).slice(0, start));
      if (!match) return null;
      return { token: match[1], start: start - match[1].length, end: start, node: null };
    }

    const sel = selectionOf(field);
    if (!sel || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null;
    const node = range.startContainer;
    if (!node || node.nodeType !== 3) return null;

    const offset = range.startOffset;
    const match = SYLLABLE_RE.exec(String(node.data).slice(0, offset));
    if (!match) return null;
    return { token: match[1], start: offset - match[1].length, end: offset, node };
  }

  /** Range, накрывающий набранный слог внутри текстового узла. */
  function tokenRange(token) {
    if (!token.node) return null;
    try {
      const range = document.createRange();
      range.setStart(token.node, token.start);
      range.setEnd(token.node, token.end);
      return range;
    } catch {
      return null;
    }
  }

  /** Заменить слог иероглифом — тем же путём, что и обычная вставка. */
  function replaceSyllable(field, token, char) {
    const saved = token.node
      ? { el: field, range: tokenRange(token) }
      : { el: field, start: token.start, end: token.end };
    return insertText(char, saved);
  }

  /** Где рисовать панель: у каретки, а если её не видно — под полем. */
  function caretRect(field, token) {
    if (token.node) {
      const range = tokenRange(token);
      const box = range ? range.getBoundingClientRect() : null;
      if (box && (box.top || box.height)) return box;
    }
    const box = field.getBoundingClientRect();
    return {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
    };
  }

  /**
   * Панель кандидатов под кареткой.
   *
   * Ставим вниз от каретки (так ведёт себя системный IME), а если не влезает —
   * над ней. Клик по панели гасим на mousedown: иначе поле теряет фокус
   * раньше, чем мы заменим выделение, и заменять будет нечего.
   */
  function positionIme(panel, rect) {
    panel.style.visibility = "hidden";
    panel.style.left = "0px";
    panel.style.top = "0px";

    const box = panel.getBoundingClientRect();
    const width = box.width || 260;
    const height = box.height || 80;
    const gap = 6;

    let left = rect ? rect.left : 40;
    let top = rect ? rect.bottom + gap : 80;
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, (rect ? rect.top : 80) - height - gap);
    }

    left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - width - 8));
    top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - height - 8));

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.visibility = "visible";
  }

  async function showIme(field, token, candidates, rect) {
    const shadow = await ensureHost();
    if (!shadow) return;
    // Пока ждали хост, человек мог стереть слог — тогда панель уже не нужна.
    if (!field.isConnected) return;
    hideIme();

    const panel = el("div", "ct-ime");
    panel.setAttribute("role", "listbox");
    panel.setAttribute("aria-label", "Кандидаты-иероглифы");
    panel.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    panel.addEventListener("click", (event) => event.stopPropagation());

    const head = el("div", "ct-ime-head");
    head.appendChild(el("span", "ct-ime-token", token.token));
    head.appendChild(el("span", "ct-ime-hint", "выберите иероглиф"));
    panel.appendChild(head);

    const grid = el("div", "ct-ime-grid");
    for (const char of candidates) {
      const item = el("button", "ct-ime-item", char);
      item.type = "button";
      item.setAttribute("role", "option");
      item.title = `${token.token} → ${char}`;
      item.addEventListener("click", () => {
        const done = replaceSyllable(field, token, char);
        hideIme();
        if (!done.ok) showNotice("Не удалось подставить иероглиф в это поле.");
      });
      grid.appendChild(item);
    }
    panel.appendChild(grid);

    shadow.appendChild(panel);
    state.ime = panel;
    positionIme(panel, rect);
  }

  /** Один обработчик на всё: ввод, удаление, вставка из буфера. */
  function onInput(event) {
    if (!state.settings.pinyin) return;
    const field = editableFor(event.composedPath ? event.composedPath()[0] : event.target);
    if (!field) {
      hideIme();
      return;
    }

    const token = syllableAtCaret(field);
    if (!token) {
      hideIme();
      return;
    }

    const syllable = normalizeSyllable(token.token);
    // Одна буква — это ещё не слог: «a» и «e» есть в словаре, но панель на
    // каждую первую букву слова только мешает.
    if (syllable.length < 2) {
      hideIme();
      return;
    }

    const candidates = imeCandidates(syllable);
    if (!candidates) {
      hideIme();
      return;
    }

    void showIme(field, token, candidates.slice(0, IME_SHOWN), caretRect(field, token));
  }

  /* ── Буфер и звук ──────────────────────────────────────────────────────── */

  function copyText(text) {
    const done = () => {};
    try {
      navigator.clipboard.writeText(text).then(done, () => legacyCopy(text));
    } catch {
      legacyCopy(text);
    }
  }

  function legacyCopy(text) {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;top:-1000px;left:-1000px;opacity:0;";
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand("copy");
    } catch {
      /* остаётся только ручное копирование */
    }
    area.remove();
  }

  async function speakText(text) {
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "ct:tts", text });
    } catch {
      return;
    }
    if (!response || !response.ok || !response.audio) return;

    try {
      const bin = atob(response.audio);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
      const audio = new Audio(url);
      audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
      await audio.play();
    } catch {
      /* автовоспроизведение могло быть запрещено — молчим */
    }
  }

  /* ── Слушатели ─────────────────────────────────────────────────────────── */

  let sealTimer = 0;

  /** Путь события мыши запоминаем всегда: по нему потом ищем shadow root. */
  function rememberPath(event) {
    if (event && typeof event.composedPath === "function") state.path = event.composedPath();
  }

  function onMouseUp(event) {
    rememberPath(event);
    if (state.host && event.composedPath && event.composedPath().includes(state.host)) return;
    // Печать можно выключить: часть людей читает с тачпада и задевает
    // выделение постоянно. Правый клик при этом работает как раньше.
    if (!state.settings.autoSeal) {
      hideSeal();
      return;
    }

    clearTimeout(sealTimer);
    // Даём браузеру дорисовать выделение: на mouseup getSelection() ещё
    // не всегда окончательный (двойной клик по слову).
    sealTimer = window.setTimeout(() => {
      const saved = captureSelection();
      if (!saved) {
        hideSeal();
        return;
      }
      state.saved = saved;
      void showSeal(saved);
    }, 10);
  }

  function onMouseDown(event) {
    rememberPath(event);
    if (state.host && event.composedPath && event.composedPath().includes(state.host)) return;
    hideSeal();
    hideCard();
    hideIme();
  }

  function onScroll(event) {
    // Прокрутка внутри нашей карточки (лог Евы) — не повод её закрывать.
    if (state.host && event && event.composedPath && event.composedPath().includes(state.host)) return;
    hideSeal();
    hideCard();
    // Панель пиньиня привязана к координатам экрана: после прокрутки она
    // оказалась бы не над полем, а где попало.
    hideIme();
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      hideSeal();
      hideCard();
      hideIme();
    }
  }

  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  // `input` всплывает и из shadow root (событие composed), поэтому слушаем
  // документ целиком, а настоящее поле достаём из composedPath.
  document.addEventListener("input", onInput, true);
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  window.addEventListener("resize", onScroll, { passive: true });

  /* ── Настройки ─────────────────────────────────────────────────────────── */

  /** Значения по умолчанию живут в службе: здесь только копия для работы. */
  async function loadSettings() {
    let next = null;
    try {
      next = await chrome.runtime.sendMessage({ type: "ct:settings-get" });
    } catch {
      next = null; // расширение перезагрузили — работаем на умолчаниях
    }
    if (next && typeof next === "object" && !next.error) {
      state.settings = {
        tts: next.tts !== false,
        autoSeal: next.autoSeal !== false,
        theme: next.theme === "dark" || next.theme === "light" ? next.theme : "auto",
        direction:
          next.direction === "zh-ru" || next.direction === "ru-zh" ? next.direction : "auto",
        pinyin: next.pinyin !== false,
      };
    }
    applyTheme();
    if (!state.settings.pinyin) hideIme();
  }

  void loadSettings();

  // Настройки меняются в попапе — вкладка узнаёт об этом без перезагрузки.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.ctSettings) return;
    void loadSettings();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return undefined;

    if (msg.type === "ct:eva-chunk" || msg.type === "ct:eva-done" || msg.type === "ct:eva-error") {
      if (!state.evaSink || msg.reqId !== state.evaSink.reqId) return undefined;
      if (msg.type === "ct:eva-chunk") evaAppend(String(msg.chunk || ""));
      else if (msg.type === "ct:eva-done") evaFinish();
      else evaFail(msg.message || "Ева не ответила.", "UPSTREAM");
      return undefined;
    }

    if (msg.type === "ct:menu-translate") {
      const saved = captureSelection();
      if (!saved) {
        // Раньше здесь стояла тишина: меню закрывалось, и ничего не
        // происходило. Хуже всего — что причину не видно.
        showNotice("Не удалось прочитать выделение на этой странице. Выделите текст ещё раз.");
        sendResponse({ ok: false, reason: "no-selection" });
        return undefined;
      }
      hideSeal();
      void runTranslate(saved, msg.direction || "auto");
      sendResponse({ ok: true });
      return undefined;
    }

    return undefined;
  });
})();
