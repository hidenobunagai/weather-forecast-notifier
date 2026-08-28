const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const LINE_MAX_RETRIES = 3;
const LINE_MAX_TEXT_LENGTH = 5000;
const LINE_MAX_MESSAGES_PER_PUSH = 5;
const LINE_CHUNK_INTERVAL_MS = 1000;

const JMA_FORECAST_BASE = "https://www.jma.go.jp/bosai/forecast/data/forecast";
const JMA_AREA_URL = "https://www.jma.go.jp/bosai/common/const/area.json";

/**
 * 明日の天気予報を Discord / LINE に通知する（JST 21時に実行される想定）。
 * データは気象庁（JMA）の府県天気予報 JSON を使用（無料・APIキー不要・レート制限なし）。
 */
function checkAndNotify() {
  const tz = Session.getScriptTimeZone() || "Asia/Tokyo";
  const tomorrow = getTomorrowDateString(tz); // 'YYYY-MM-DD'

  // 重複実行防止: 当日の成功実行フラグがあればスキップ
  const today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  const dedupKey = "RUN_OK_" + today;
  if (PropertiesService.getScriptProperties().getProperty(dedupKey)) {
    console.log("本日は既に実行済みのためスキップします。");
    return;
  }

  const webhookUrl = (getEnv("DISCORD_WEBHOOK_URL", "") || "").trim();
  const lineChannelAccessToken = (getEnv("LINE_CHANNEL_ACCESS_TOKEN", "") || "").trim();
  const lineTargetId = (getEnv("LINE_TARGET_ID", "") || "").trim();

  const hasDiscord = !!webhookUrl;
  const hasLine = !!lineChannelAccessToken && !!lineTargetId;

  if (!hasDiscord && !hasLine) {
    console.warn("Script Properties に通知先が未設定です。DISCORD_WEBHOOK_URL または LINE_CHANNEL_ACCESS_TOKEN + LINE_TARGET_ID を設定してください。");
    return;
  }

  const locations = getLocations();
  if (locations.length === 0) {
    console.warn("Script Properties LOCATIONS_JSON に気象庁の予報区域コード(code)を持つ地点が設定されていません。");
    return;
  }

  const reports = fetchJmaDailyMulti(locations, tomorrow);
  if (reports.length === 0) {
    console.log("天気予報データが取得できませんでした。通知をスキップします。");
    return;
  }

  // 成功したら重複防止フラグを保存（当日中は再実行しない）
  PropertiesService.getScriptProperties().setProperty(dedupKey, "1");

  const content = buildDiscordMessage(tomorrow, reports);

  if (hasDiscord) {
    postToDiscord(webhookUrl, content);
  }
  if (hasLine) {
    // 月間上限到達済みなら今月はLINE送信をスキップ（翌月自動再開）
    const monthKey = Utilities.formatDate(new Date(), tz, "yyyy-MM");
    const limitKey = "LINE_MONTHLY_LIMIT_" + monthKey;
    if (PropertiesService.getScriptProperties().getProperty(limitKey)) {
      console.warn("LINEは今月の月間上限到達のためスキップします。翌月自動再開。Discord通知は継続します。");
    } else {
      try {
        postToLineInChunks(lineChannelAccessToken, lineTargetId, [content]);
      } catch (e) {
        const msg = String(e && e.message || e);
        if (/monthly limit/i.test(msg)) {
          PropertiesService.getScriptProperties().setProperty(limitKey, "1");
          console.warn("LINE月間上限を検出。今月のLINE送信を停止します。LINE Developersコンソールで利用状況を確認してください。Discord通知は継続します。エラー: " + msg);
        } else {
          throw e;
        }
      }
    }
  }
}

/**
 * （初回だけ実行）JST 21:00 に checkAndNotify を毎日実行するトリガーを作成。
 */
function createDailyTrigger() {
  // 重複防止: 既存の同名トリガーを削除してから作成
  deleteTriggers("checkAndNotify");
  deleteTriggers("fetchAndCacheWeather"); // 旧構成（Open-Meteo キャッシュ）の残骸があれば削除
  ScriptApp.newTrigger("checkAndNotify")
    .timeBased()
    .atHour(21) // JSTとして動作（manifest の timeZone を使用）
    .nearMinute(0)
    .everyDays(1)
    .create();
}

/** 既存トリガー削除（同名関数のみ）。 */
function deleteTriggers(functionName) {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(t);
    }
  }
}

/** 手動テスト用（今すぐ実行）。 */
function manualTest() {
  checkAndNotify();
}

// ========= 実装詳細 =========

/**
 * 監視対象地点。code は気象庁の予報区域コード（例: 東京地方=130010）。
 */
function getLocations() {
  const raw = getEnv("LOCATIONS_JSON", "");
  if (!raw) {
    console.warn("Script Property LOCATIONS_JSON が未設定です。");
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const locations = parsed
        // 6桁=予報区域コード / 7桁=市町村コード（どちらも resolver が処理）
        .filter((o) => o && typeof o.code === "string" && /^\d{6,7}$/.test(o.code))
        .map((o) => ({ label: o.label || "", area: o.area || "", code: o.code }));
      if (locations.length !== parsed.length) {
        console.warn("予報区域コード(code: 6〜7桁の数字)が無い地点を除外しました。");
      }
      return locations;
    }
  } catch (e) {
    console.warn("LOCATIONS_JSON の JSON 解析に失敗しました。", e);
  }
  return [];
}

/** 明日の日付（YYYY-MM-DD）をスクリプトのタイムゾーンで返す。 */
function getTomorrowDateString(tz) {
  const now = new Date();
  const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return Utilities.formatDate(tomorrowDate, tz, "yyyy-MM-dd");
}

/**
 * 気象庁の府県天気予報 JSON から全地点の明日の予報を取得する。
 * 地点コード（府県予報区/予報区域/市町村コードのいずれでも可）から府県予報区コードを
 * area.json で解決し、同一府県は1リクエストにまとめる。
 */
function fetchJmaDailyMulti(locations, ymd) {
  const officeByArea = resolveJmaOffices(locations.map((l) => l.code));
  if (!officeByArea) return [];

  const byOffice = {};
  for (const loc of locations) {
    const resolved = officeByArea[loc.code];
    if (!resolved) {
      console.warn(`予報区域コードの解決に失敗しました: ${loc.code}（${loc.label}）`);
      continue;
    }
    // 予報JSONの areas に現れる区域コード（class10 または office）に置き換えて渡す
    const areaLoc = { label: loc.label, area: loc.area, code: resolved.areaCode };
    (byOffice[resolved.office] = byOffice[resolved.office] || []).push(areaLoc);
  }

  const reports = [];
  for (const office of Object.keys(byOffice)) {
    const url = `${JMA_FORECAST_BASE}/${office}.json`;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, method: "get" });
    if (res.getResponseCode() !== 200) {
      console.warn("気象庁 API 非200:", url, res.getResponseCode());
      continue;
    }
    reports.push(...parseJmaForecast(res.getContentText(), byOffice[office], ymd));
  }
  return reports;
}

/**
 * 地点コードから府県予報区コードと予報区域コードを area.json の親子関係で解決する。
 * 入力は府県予報区（270000）/予報区域（130010 東京地方）/二次細分区域（110012）/市町村（1123700）の
 * どの階層でも可。例: 130010 → { office: "130000", areaCode: "130010" }、
 * 1123700（三郷市）→ { office: "110000", areaCode: "110010" }。
 * area.json の取得に失敗した場合は null。
 */
function resolveJmaOffices(areaCodes) {
  const res = UrlFetchApp.fetch(JMA_AREA_URL, { muteHttpExceptions: true, method: "get" });
  if (res.getResponseCode() !== 200) {
    console.warn("気象庁 area.json の取得に失敗:", res.getResponseCode());
    return null;
  }
  let area;
  try {
    area = JSON.parse(res.getContentText());
  } catch (e) {
    console.warn("気象庁 area.json の解析エラー:", e);
    return null;
  }

  const result = {};
  for (const code of areaCodes) {
    let c = code;
    let office = null;
    let areaCode = null;
    for (let i = 0; i < 5; i++) {
      if (area.offices[c]) {
        office = c;
        areaCode = areaCode || c;
        break;
      }
      if (area.class10s[c]) areaCode = c; // 予報JSONの areas は class10（または office）コード
      const node = area.class10s[c] || area.class15s[c] || area.class20s[c];
      if (!node || !node.parent) break;
      c = node.parent;
    }
    result[code] = office ? { office: office, areaCode: areaCode || office } : null;
  }
  return result;
}

/**
 * 府県天気予報 JSON（1府県分）をパースし、指定地点の明日の予報を返す。
 * timeSeries[0]=天気（日単位）/ [1]=降水確率（6時間単位）/ [2]=気温（最低・最高、府県により無し）。
 */
function parseJmaForecast(text, locs, ymd) {
  const reports = [];
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    console.warn("気象庁 JSON 解析エラー:", e);
    return reports;
  }
  const main = Array.isArray(json) ? json[0] : null;
  if (!main || !Array.isArray(main.timeSeries) || main.timeSeries.length < 2) {
    console.warn("気象庁 JSON 形式が想定と異なります。");
    return reports;
  }
  const weatherTS = main.timeSeries[0];
  const popTS = main.timeSeries[1];
  const tempTS = main.timeSeries.length > 2 ? main.timeSeries[2] : null;

  const weatherIdx = indicesByDate(weatherTS.timeDefines, ymd);
  const popIdx = indicesByDate(popTS.timeDefines, ymd);
  const tempIdx = indicesByDate(tempTS && tempTS.timeDefines, ymd);

  for (const loc of locs) {
    const areaW = findJmaArea(weatherTS, loc.code);
    if (!areaW) {
      console.warn(`予報区域が見つかりません: ${loc.code}（${loc.label}）`);
      continue;
    }
    const areaP = findJmaArea(popTS, loc.code);
    // ponytail: 気温は府県の代表観測地点（temps 先頭）を使用。離島など別地点が必要なら
    // 地点コード指定の拡張（config に station フィールド）を追加する。
    const areaT = tempTS && Array.isArray(tempTS.areas) ? tempTS.areas[0] : null;

    const iW = weatherIdx[0];
    reports.push({
      label: loc.label,
      area: loc.area || (areaW.area && areaW.area.name) || "",
      date: ymd,
      weatherCode: iW != null && areaW.weatherCodes ? areaW.weatherCodes[iW] : null,
      // 全角スペース（U+3000）は表示用に半角へ
      weatherText: iW != null && areaW.weathers ? String(areaW.weathers[iW]).replace(/\u3000/g, " ") : null,
      popMax: maxAt(areaP && areaP.pops, popIdx),
      tempMin: firstAt(areaT && areaT.temps, tempIdx),
      tempMax: lastAt(areaT && areaT.temps, tempIdx),
    });
  }
  return reports;
}

/** timeDefines のうち ymd（YYYY-MM-DD）に一致するインデックス一覧。 */
function indicesByDate(timeDefines, ymd) {
  const idx = [];
  if (!Array.isArray(timeDefines)) return idx;
  for (let i = 0; i < timeDefines.length; i++) {
    if (String(timeDefines[i]).slice(0, 10) === ymd) idx.push(i);
  }
  return idx;
}

/** timeSeries.areas から code に一致する区域を探す。 */
function findJmaArea(timeSeries, code) {
  if (!timeSeries || !Array.isArray(timeSeries.areas)) return null;
  for (const a of timeSeries.areas) {
    if (a.area && a.area.code === code) return a;
  }
  return null;
}

/** values の指定インデックス群の最大値（数値化できない場合は null）。 */
function maxAt(values, idx) {
  if (!Array.isArray(values)) return null;
  let max = null;
  for (const i of idx) {
    const v = numOrNull(values[i]);
    if (v != null && (max == null || v > max)) max = v;
  }
  return max;
}

/** values の指定インデックス群の最初の値。 */
function firstAt(values, idx) {
  if (!Array.isArray(values) || idx.length === 0) return null;
  return numOrNull(values[idx[0]]);
}

/** values の指定インデックス群の最後の値。 */
function lastAt(values, idx) {
  if (!Array.isArray(values) || idx.length === 0) return null;
  return numOrNull(values[idx[idx.length - 1]]);
}

/** Discord 送信本文を構築。 */
function buildDiscordMessage(ymd, reports) {
  const lines = [];
  lines.push(`📅 明日（${ymd}）の天気予報`);
  for (const r of reports) {
    const weather = r.weatherText ? `${jmaWeatherEmoji(r.weatherCode)} ${r.weatherText}` : "不明";
    const prob = r.popMax != null ? `${r.popMax}%` : "N/A";
    const temp =
      r.tempMin != null || r.tempMax != null
        ? `${r.tempMin != null ? r.tempMin + "℃" : "?"} / ${r.tempMax != null ? r.tempMax + "℃" : "?"}`
        : "N/A";
    lines.push("");
    lines.push(`━ ${r.label}（${r.area}）━`);
    lines.push(`  天気: ${weather}`);
    lines.push(`  降水確率: ${prob}`);
    lines.push(`  気温: ${temp}`);
  }
  return lines.join("\n");
}

/** 気象庁の天気コード先頭桁から絵文字を返す（1=晴系, 2=曇系, 3=雨系, 4=雪系）。 */
function jmaWeatherEmoji(code) {
  if (code == null) return "";
  const c = String(code)[0];
  if (c === "1") return "☀";
  if (c === "2") return "☁";
  if (c === "3") return "🌧";
  if (c === "4") return "🌨";
  return "🌈";
}

/** Discord Webhook に POST。 */
function postToDiscord(webhookUrl, content) {
  const MAX_CHARS = 2000;
  const safeContent =
    content.length > MAX_CHARS ? content.slice(0, MAX_CHARS - 3) + "..." : content;
  const payload = { content: safeContent };
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  const res = UrlFetchApp.fetch(webhookUrl, options);
  const code = res.getResponseCode();
  if (code >= 300) {
    console.warn("Discord Webhook エラー:", code, res.getContentText());
  } else {
    console.log("Discord 通知完了 (HTTP", code, ")");
  }
}

// ========= LINE 通知 =========

/**
 * LINE Messaging API へのメッセージ送信 (push) をチャンク分割で実行
 * @param {string} channelAccessToken LINE_CHANNEL_ACCESS_TOKEN
 * @param {string} targetId LINE_TARGET_ID (ユーザー/グループ/トークルーム ID)
 * @param {string[]} messages 通知メッセージ配列
 */
function postToLineInChunks(channelAccessToken, targetId, messages) {
  const sep = "\n\n";
  const chunks = [];
  let buffer = "";
  for (const rawMsg of messages) {
    const msg = normalizeLineMessage(rawMsg, LINE_MAX_TEXT_LENGTH);
    if (!msg) continue;
    const joined = buffer ? buffer + sep + msg : msg;
    if (joined.length > LINE_MAX_TEXT_LENGTH) {
      if (buffer) chunks.push(buffer);
      buffer = msg;
    } else {
      buffer = joined;
    }
  }
  if (buffer) chunks.push(buffer);

  for (let i = 0; i < chunks.length; i += LINE_MAX_MESSAGES_PER_PUSH) {
    if (i > 0) Utilities.sleep(LINE_CHUNK_INTERVAL_MS);
    const batch = chunks.slice(i, i + LINE_MAX_MESSAGES_PER_PUSH);
    postToLine(channelAccessToken, targetId, batch);
  }
}

function normalizeLineMessage(message, maxLen) {
  if (!message) return "";
  if (message.length <= maxLen) return message;
  const ellipsis = "…";
  const limit = Math.max(maxLen - ellipsis.length, 0);
  return `${message.slice(0, limit)}${ellipsis}`;
}

/**
 * LINE Messaging API の push エンドポイントへ送信
 * @param {string} channelAccessToken
 * @param {string} targetId
 * @param {string[]} messageTexts 1 push に含めるテキストメッセージ配列 (最大 LINE_MAX_MESSAGES_PER_PUSH)
 */
function postToLine(channelAccessToken, targetId, messageTexts) {
  const payload = {
    to: targetId,
    messages: messageTexts.map((text) => ({ type: "text", text })),
  };
  const params = {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${channelAccessToken}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  for (let attempt = 1; attempt <= LINE_MAX_RETRIES; attempt++) {
    const res = UrlFetchApp.fetch(LINE_PUSH_URL, params);
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) return;

    const body = res.getContentText();
    // 月間上限はリトライしても回復しないのですぐ中断（翌月までスキップは呼び出し側で処理）
    if (/monthly limit/i.test(body)) {
      throw new Error(`LINE 送信エラー (${code}): ${body}`);
    }

    if (code === 401 || code === 400) {
      throw new Error(`LINE 送信エラー (${code}): ${body}`);
    }

    if (code === 429 && attempt < LINE_MAX_RETRIES) {
      let waitMs = LINE_CHUNK_INTERVAL_MS * attempt;
      const retryAfter = res.getHeaders()["Retry-After"];
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        if (!Number.isNaN(parsed)) waitMs = parsed * 1000;
      }
      console.warn(`LINE レート制限 (429)。${waitMs}ms 後にリトライ (${attempt}/${LINE_MAX_RETRIES})`);
      Utilities.sleep(waitMs);
      continue;
    }

    throw new Error(`LINE 送信エラー (${code}): ${body}`);
  }
}

// ========= ユーティリティ =========

function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// ===== 設定検証ユーティリティ =====
/**
 * 現在のセットアップ状態を検証し、結果を返します。
 * 家族が「なぜ通知が届かないのか」を診断するのに便利です。
 *
 * @returns {{ready: boolean, warnings: string[], config: object}}
 */
function validateSetup() {
  const warnings = [];
  const config = {};

  // 場所設定
  const locationsRaw = getEnv("LOCATIONS_JSON", "");
  let locations = [];
  try {
    if (locationsRaw) {
      locations = JSON.parse(locationsRaw);
      if (!Array.isArray(locations)) {
        locations = [];
        warnings.push("LOCATIONS_JSON は配列である必要があります。");
      }
    }
  } catch (e) {
    warnings.push("LOCATIONS_JSON の JSON 解析に失敗しました。");
  }
  config.locationsConfigured = locations.length > 0;
  config.locationsCount = locations.length;
  if (!locations.length) {
    warnings.push("LOCATIONS_JSON が未設定です。通知先の地点を設定してください。");
  }

  // Discord設定
  const discordWebhookUrl = (getEnv("DISCORD_WEBHOOK_URL", "") || "").trim();
  config.discordConfigured = !!discordWebhookUrl;

  // LINE設定
  const lineChannelAccessToken = (getEnv("LINE_CHANNEL_ACCESS_TOKEN", "") || "").trim();
  const lineTargetId = (getEnv("LINE_TARGET_ID", "") || "").trim();
  config.lineConfigured = !!(lineChannelAccessToken && lineTargetId);

  if (!config.discordConfigured && !config.lineConfigured) {
    warnings.push("通知先が未設定です。Discord または LINE のいずれかを設定してください。");
  }

  // LINE月間上限チェック
  if (config.lineConfigured) {
    const tz = Session.getScriptTimeZone() || "Asia/Tokyo";
    const now = new Date();
    const yearMonth = Utilities.formatDate(now, tz, "yyyy-MM");
    const monthKey = `LINE_MONTHLY_LIMIT_${yearMonth}`;
    const monthlyLimitReached = getEnv(monthKey, null);
    if (monthlyLimitReached === "1") {
      warnings.push(`LINE月間上限に達しています (${yearMonth})。来月までLINE通知は停止します。Discord通知は継続します。`);
    }
    config.lineMonthlyLimitReached = monthlyLimitReached === "1";
  }

  // 今日の実行状態
  const tz = Session.getScriptTimeZone() || "Asia/Tokyo";
  const today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  const dedupKey = `RUN_DATE_${today}`;
  const hasRunToday = getEnv(dedupKey, null);
  config.hasRunToday = hasRunToday === "1";
  if (config.hasRunToday) {
    // This is just informational, not a warning
    warnings.push(`今日はすでに実行済みです (${today})。`);
  }

  return {
    ready: warnings.length === 0,
    warnings: warnings,
    config: config,
  };
}
