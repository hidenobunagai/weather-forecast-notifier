const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const LINE_MAX_RETRIES = 3;
const LINE_MAX_TEXT_LENGTH = 5000;
const LINE_MAX_MESSAGES_PER_PUSH = 5;
const LINE_CHUNK_INTERVAL_MS = 1000;

// 毎朝 fetchAndCacheWeather が取得した予報を保存するキー（ScriptProperties 値上限 9KB）
const WEATHER_CACHE_KEY = "WEATHER_CACHE";

/**
 * 明日の天気予報を Discord / LINE に通知する（JST 前日21時に実行される想定）。
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
    console.warn("Script Properties LOCATIONS_JSON に監視対象地点が設定されていません。");
    return;
  }

  // キャッシュ（毎朝 09:05 JST に取得）を優先。無ければ直接取得を試みる。
  let reports = readCachedWeather(tomorrow);
  if (!reports) {
    const dailyList = fetchOpenMeteoDailyMulti(locations, tomorrow);
    reports = buildReports(locations, dailyList, tomorrow);
  }

  if (!reports || reports.length === 0) {
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
    postToLineInChunks(lineChannelAccessToken, lineTargetId, [content]);
  }
}

/**
 * （初回だけ実行）毎朝に予報をキャッシュ取得し、毎晩 21:00 JST に通知するトリガーを作成。
 *
 * Open-Meteo の無料枠は IP 単位の日次上限（UTC 00:00 リセット）があり、Apps Script は
 * 共有 IP からアクセスするため夜間（JST 21時 = UTC 12時）の取得は他ユーザーの利用で
 * 429 になりやすい。そのため UTC リセット直後（09:05 JST）に取得してキャッシュし、
 * 夜の通知はキャッシュから送信する。取得失敗に備え 10:05 / 11:05 も取得トリガーを登録する。
 */
function createDailyTrigger() {
  // 重複防止: 既存の同名トリガーを削除してから作成
  deleteTriggers("checkAndNotify");
  deleteTriggers("fetchAndCacheWeather");
  for (const hour of [9, 10, 11]) {
    ScriptApp.newTrigger("fetchAndCacheWeather")
      .timeBased()
      .atHour(hour) // JSTとして動作（manifest の timeZone を使用）
      .nearMinute(5)
      .everyDays(1)
      .create();
  }
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

/**
 * 明日の予報を Open-Meteo から取得して ScriptProperties にキャッシュする。
 * 毎朝 09:05 JST（Open-Meteo の日次上限が UTC 00:00 にリセットされる直後）に
 * トリガーから実行される。当日取得済みの場合は何もしない。
 */
function fetchAndCacheWeather() {
  const tz = Session.getScriptTimeZone() || "Asia/Tokyo";
  const today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  const fetchOkKey = "FETCH_OK_" + today;
  if (getEnv(fetchOkKey, "") === "1") {
    console.log("本日は既に取得済みのためスキップします。");
    return;
  }

  const locations = getLocations();
  if (locations.length === 0) return;

  const tomorrow = getTomorrowDateString(tz);
  const dailyList = fetchOpenMeteoDailyMulti(locations, tomorrow);
  const reports = buildReports(locations, dailyList, tomorrow);
  if (!reports || reports.length === 0) return;

  // ponytail: ScriptProperties の値上限 9KB。地点が数十を超えるなら分割保存が必要。
  PropertiesService.getScriptProperties().setProperty(WEATHER_CACHE_KEY, JSON.stringify(reports));
  PropertiesService.getScriptProperties().setProperty(fetchOkKey, "1");
  console.log(`天気予報をキャッシュしました（${tomorrow}、${reports.length} 地点）。`);
}

/** キャッシュ済みの予報を返す。未キャッシュまたは予報日が一致しない場合は null。 */
function readCachedWeather(tomorrow) {
  const raw = getEnv(WEATHER_CACHE_KEY, "");
  if (!raw) return null;
  try {
    const reports = JSON.parse(raw);
    if (!Array.isArray(reports) || reports.length === 0) return null;
    if (reports[0].date !== tomorrow) return null; // 前日以前のキャッシュは使わない
    return reports;
  } catch (e) {
    console.warn("天気予報キャッシュの解析に失敗しました。", e);
    return null;
  }
}

/** Open-Meteo レスポンスを通知用レポート配列に変換。失敗時は null。 */
function buildReports(locations, dailyList, ymd) {
  if (!dailyList) return null;
  const reports = [];
  for (let i = 0; i < locations.length; i++) {
    const daily = dailyList[i];
    if (!daily) continue;
    reports.push({
      label: locations[i].label,
      area: locations[i].area,
      date: ymd,
      probabilityMax: numOrNull(daily.precipitation_probability_max),
      precipitationSum: numOrNull(daily.precipitation_sum),
      rainSum: numOrNull(daily.rain_sum),
      weathercode: daily.weather_code,
    });
  }
  return reports;
}

// ========= 実装詳細 =========

/**
 * 監視対象地点。
 * lat/lon は近傍代表点（Open-Meteoはグリッド補間）。
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
      return parsed
        .filter((o) => o && typeof o.lat === "number" && typeof o.lon === "number")
        .map((o) => ({
          label: o.label || "",
          area: o.area || "",
          lat: o.lat,
          lon: o.lon,
        }));
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

/** Open-Meteo から全地点の日次データを1リクエストに統合して取得。 */
function fetchOpenMeteoDailyMulti(locations, ymd) {
  if (locations.length === 0) return null;

  const lats = locations.map((l) => l.lat).join(",");
  const lons = locations.map((l) => l.lon).join(",");
  const params = {
    latitude: lats,
    longitude: lons,
    daily: "weather_code,precipitation_sum,precipitation_probability_max,rain_sum",
    timezone: "Asia/Tokyo",
    start_date: ymd,
    end_date: ymd,
  };
  const baseUrl = "https://api.open-meteo.com/v1/forecast";
  const url = baseUrl + toQuery(params);

  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, method: "get" });

  if (res.getResponseCode() === 200) {
    try {
      const json = JSON.parse(res.getContentText());
      // 複数地点のときは JSON Array、1地点のときは JSON Object
      const entries = Array.isArray(json) ? json : [json];
      return entries.map((entry) => {
        const daily = entry && entry.daily;
        if (!daily) return null;
        return {
          precipitation_probability_max: daily.precipitation_probability_max?.[0] ?? null,
          precipitation_sum: daily.precipitation_sum?.[0] ?? null,
          rain_sum: daily.rain_sum?.[0] ?? null,
          weather_code: daily.weather_code?.[0] ?? null,
        };
      });
    } catch (e) {
      console.warn("Open-Meteo API レスポンス解析エラー:", e);
      return null;
    }
  }

  // 429: レスポンスボディから理由をログに出力し、リトライせず即座に諦める
  if (res.getResponseCode() === 429) {
    try {
      const body = JSON.parse(res.getContentText());
      console.warn("Open-Meteo API 429:", body.reason || "unknown");
    } catch (_) {
      console.warn("Open-Meteo API 429 (parse error)");
    }
    return null;
  }

  console.warn("Open-Meteo API 非200:", res.getResponseCode(), res.getContentText());
  return null;
}

/** Discord 送信本文を構築。 */
function buildDiscordMessage(ymd, reports) {
  const lines = [];
  lines.push(`📅 明日（${ymd}）の天気予報`);
  for (const r of reports) {
    const weather = weatherCodeToText(r.weathercode);
    const prob = r.probabilityMax != null ? `${r.probabilityMax}%` : "N/A";
    const psum = r.precipitationSum != null ? `${r.precipitationSum}mm` : "N/A";
    const rsum = r.rainSum != null ? `${r.rainSum}mm` : "N/A";
    lines.push("");
    lines.push(`━ ${r.label}（${r.area}）━`);
    lines.push(`  天気: ${weather}`);
    lines.push(`  降水確率: ${prob}`);
    lines.push(`  降水量: ${psum}`);
    lines.push(`  雨量: ${rsum}`);
  }
  return lines.join("\n");
}

/** WMO weather_code を日本語の天気表現に変換。 */
function weatherCodeToText(code) {
  if (code == null) return "不明";
  if (code === 0) return "☀ 快晴";
  if (code === 1) return "🌤 晴れ";
  if (code === 2) return "⛅ 曇り時々晴れ";
  if (code === 3) return "☁ 曇り";
  if (code >= 45 && code <= 48) return "🌫 霧";
  if (code >= 51 && code <= 57) return "🌦 霧雨";
  if (code >= 61 && code <= 67) return "🌧 雨";
  if (code >= 71 && code <= 77) return "🌨 雪";
  if (code >= 80 && code <= 82) return "🌦 にわか雨";
  if (code >= 85 && code <= 86) return "🌨 にわか雪";
  if (code >= 95 && code <= 99) return "⛈ 雷雨";
  return "🌈 その他";
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

    if (code === 401 || code === 400) {
      const body = res.getContentText();
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

    const body = res.getContentText();
    throw new Error(`LINE 送信エラー (${code}): ${body}`);
  }
}

// ========= ユーティリティ =========

function numOrNull(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function toQuery(obj) {
  const esc = encodeURIComponent;
  const q = Object.keys(obj)
    .map((k) => `${esc(k)}=${esc(String(obj[k]))}`)
    .join("&");
  return `?${q}`;
}
