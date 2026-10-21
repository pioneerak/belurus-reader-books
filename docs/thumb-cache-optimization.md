# Оптимизация кэша обложек

Статус: **применён к невыпущенной версии 1.0.1.** Изменения внесены в
неминифицированную копию и в `main.js` (1 094 165 байт, SHA-256
`4517E3D6C9C49F6ECD9FE76DEA08C3F9AE1CBC4335380AAE6C3E207F340E0F06`).
Синтаксис, загрузка с mock-модулем `obsidian` и тесты ленивого кэша проходят;
проверка в живом Obsidian на EPUB/PDF и на мобильном ещё не выполнена.
Мобильная полировка iPhone (safe-area, ландшафт, размеры кнопок, клавиатура,
плеер) описана в `docs/mobile-iphone.md`.

## Что даёт

1. `thumb-cache.json` (в текущем vault — ~14 МБ, 153 обложки) больше не читается
   и не парсится при каждом запуске плагина. Загрузка происходит при первом
   открытии библиотеки или вкладки настроек.
2. Обложки EPUB пережимаются в JPEG шириной ~520 px — так уже делается для PDF.
   До патча в кэш попадала оригинальная обложка, поэтому средняя запись была
   ~90 КБ, максимум ~275 КБ.

## Важно

- Ниже описан состав уже применённых изменений. Если понадобится повторить их,
  правьте исходники (`main.ts`) или резервную неминифицированную копию, а не
  минифицированный `main.js`.
- Резервная копия исходной версии:
  `C:\Users\semen\AppData\Local\Temp\opencode\reader-audit\main.original.js`.
- Патченная неминифицированная копия и тест лежат рядом:
  `main.thumb.js`, `test-thumb-cache.cjs`.
- Сборка и минификация выполнены; при повторных правках повторить их.
- Версия кэша поднята с 2 до 3, иначе старые тяжёлые обложки остались бы.

## 1. Ленивая загрузка кэша

### 1.1. Конструктор

Найти:

```js
this.thumbCache = {};
```

Заменить на:

```js
this.thumbCache = {};
this._thumbCacheLoaded = false;
this._thumbCacheLoading = null;
```

### 1.2. `loadAll()`

После строки:

```js
const d = await this.loadData();
```

добавить:

```js
this._rawData = d;
```

Имя `_rawData` выбрано, чтобы не пересекаться с `_data`, который используют
внутренние библиотеки (JSZip, PDF.js).

Удалить (или закомментировать) строку:

```js
await this._loadThumbCache(d);
```

Остальные строки `loadAll()` не меняются.

### 1.3. Новый метод рядом с `_loadThumbCache`

```js
async _ensureThumbCache() {
  if (this._thumbCacheLoaded) return this.thumbCache;
  if (!this._thumbCacheLoading) {
    this._thumbCacheLoading = this._loadThumbCache(this._rawData || {})
      .then(() => { this._thumbCacheLoaded = true; })
      .finally(() => { this._thumbCacheLoading = null; });
  }
  await this._thumbCacheLoading;
  return this.thumbCache;
}
```

### 1.4. `loadThumb()`

В начало метода добавить одну строку:

```js
async loadThumb(file, coverEl, ph) {
  await this.plugin._ensureThumbCache();
  // ...
```

### 1.5. Вкладка настроек

В начале `SettingsTab.display()`:

```js
if (!this.plugin._thumbCacheLoaded && !this.plugin._thumbCacheLoading) {
  this.plugin._ensureThumbCache().then(() => {
    if (this.containerEl.isConnected) this.display();
  });
}
```

Кнопка «Очистить»:

```js
.onClick(async () => {
  await this.plugin._ensureThumbCache();
  this.plugin.thumbCache = {};
  await this.plugin._saveThumbCache();
  new import_obsidian.Notice(__ertr("\u041A\u044D\u0448 \u043E\u0447\u0438\u0449\u0435\u043D"));
  this.display();
})
```

`await _ensureThumbCache()` важен: иначе фоновое чтение может вернуть старый
кэш уже после очистки.

### 1.6. `onClose()` / `saveAll()`

`saveAll()` не пишет `thumb-cache.json`, поэтому пустой `{}` при закрытии не
затрёт файл на диске. Но в `LibraryModal.onClose()` была ошибка: таймер
отложенного сохранения отменялся, а вместо `_saveThumbCache()` вызывался
`saveAll()`, который кэш обложек не сохраняет. В результате обложки, созданные
за последние 800 мс перед закрытием, терялись. Заменить:

```js
if (this._thumbDirty) { this._thumbDirty = false; this.plugin._saveThumbCache(); }
```

Это особенно важно после перехода на `ver: 3`: иначе часть заново
сгенерированных обложек не попадала бы в файл.

## 2. Пережатие обложек EPUB

Заменить `makeEpubThumb` целиком:

```js
async makeEpubThumb(file) {
  const buf = await this.app.vault.readBinary(file);
  const book = src_default(buf);
  await book.ready;
  const coverUrl = await book.coverUrl();
  book.destroy();
  if (!coverUrl) throw new Error("no cover");
  const resp = await fetch(coverUrl);
  const blob = await resp.blob();
  const dataUrl = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
  // EPUB covers are often 1-3 MB originals; the library only needs ~520 px.
  // Redraw onto a white canvas and cache a compact JPEG. If the browser cannot
  // decode the image (SVG with external refs, exotic formats), keep the original.
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = dataUrl;
    });
    const maxW = 520;
    const srcW = img.naturalWidth || 0;
    const srcH = img.naturalHeight || 0;
    const scale = srcW > 0 ? Math.min(1, maxW / srcW) : 1;
    const w = Math.max(1, Math.round((srcW || maxW) * scale));
    const h = Math.max(1, Math.round((srcH || Math.round(maxW * 1.5)) * scale));
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    return cv.toDataURL("image/jpeg", 0.82);
  } catch (e) {
    return dataUrl;
  }
}
```

## 3. Версия кэша

В `_loadThumbCache`:

```js
this.thumbCache = (j && j.ver === 3 && j.cache) ? j.cache : {};
```

и

```js
this.thumbCache = ((d == null ? void 0 : d.thumbCacheVer) === 3 && (d == null ? void 0 : d.thumbCache)) ? d.thumbCache : {};
```

В `_saveThumbCache`:

```js
JSON.stringify({ ver: 3, cache: this.thumbCache })
```

Старый файл с `ver: 2` будет проигнорирован, обложки один раз
сгенерируются заново и сохранятся уже в новом формате. Поэтому первое открытие
библиотеки после обновления может быть заметно медленнее: обложки создаются по
одной и постепенно появляются. Это разовая операция.

## 4. Сборка

Если правится `main.original.js` (в нём ещё есть inline source map):

```powershell
node strip-map.cjs main.original.js main.nomap.js
npx --yes esbuild@0.25.5 main.nomap.js --minify --target=es2018 --outfile=main.js
node --check main.js
```

`strip-map.cjs` лежит рядом с резервной копией во временной папке. Если
исходник собирается из `main.ts`, используйте обычную сборку проекта.

## 5. Проверка

Уже сделано:

- `node --check` для неминифицированной копии и для `main.js`.
- Загрузка обоих файлов с mock-модулем `obsidian`: экспортируется
  `BelurusReader`, набор методов совпадает с базовой версией плюс
  `_ensureThumbCache` (38 методов).
- 11 тестов `test-thumb-cache.cjs`: `onload()` не читает `thumb-cache.json`,
  ленивая загрузка, один общий запрос при параллельных вызовах, чтение
  `ver: 3`, игнорирование `ver: 2`, миграция из `data.json` и отсутствие лишних
  записей.
- `LibraryModal.onClose()` теперь сохраняет кэш через `_saveThumbCache()`, а не
  теряет последние обложки при вызове `saveAll()`.
- Размер `main.js`: 1 092 065 → 1 094 165 байт (кэш обложек + мобильная
  полировка).

Осталось проверить в живом Obsidian:

- Открыть библиотеку: обложки на месте, старые генерируются заново.
- Настройки → «Кэш обложек»: счётчик появляется после загрузки, «Очистить» не
  возвращает старые обложки.
- EPUB с PNG/JPEG/SVG-обложкой; PDF.
- Перезапуск Obsidian: библиотека не тормозит на старте; `thumb-cache.json`
  имеет `ver: 3` и заметно меньший размер.
- Мобильный Obsidian.
- Если SVG-обложка не рисуется в canvas, должен сработать fallback на исходный
  data URL.

## 6. Что осталось за рамками патча

- Переход на отдельные файлы или IndexedDB для обложек — это уберёт парсинг
  большого JSON при каждом открытии библиотеки.
- Оптимизация `saveProgress()`: сейчас каждое перелистывание пишет
  `reading-progress.json`, полный `data.json` и rescue-копии. Это отдельный
  патч, его лучше делать вместе с тестами синхронизации.
