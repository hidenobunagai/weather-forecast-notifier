const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const LINE_MAX_RETRIES = 3;
const LINE_MAX_TEXT_LENGTH = 5000;
const LINE_MAX_MESSAGES_PER_PUSH = 5;
const LINE_CHUNK_INTERVAL_MS = 1000;

/**
 * 明日の天気予報を Discord / LINE に通知する（JST 前日21時に実行される想定）。
 */
function checkAndNotify() {
  const tz = Session.getScriptTimeZone() || "Asia/Tokyo";
  const tomorrow = getTomorrowDateString(tz); // 'YYYY-MM-DD'

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
  const reports = [];

  for (const loc of locations) {
    try {
      const daily = fetchOpenMeteoDaily(loc.lat, loc.lon, tomorrow);
      if (!daily) continue;

      reports.push({
        label: loc.label,
        area: loc.area,
        date: tomorrow,
        probabilityMax: numOrNull(daily.precipitation_probability_max?.[0]),
        precipitationSum: numOrNull(daily.precipitation_sum?.[0]),
        rainSum: numOrNull(daily.rain_sum?.[0]),
        weathercode: daily.weather_code?.[0],
      });
    } catch (e) {
      console.error(`Failed to fetch/parse for ${loc.label}:`, e);
    }
  }

  if (reports.length === 0) {
    console.log("天気予報データが取得できませんでした。通知をスキップします。");
    return;
  }

  const content = buildDiscordMessage(tomorrow, reports);

  if (hasDiscord) {
    postToDiscord(webhookUrl, content);
  }
  if (hasLine) {
    postToLineInChunks(lineChannelAccessToken, lineTargetId, [content]);
  }
}

/**
 * （初回だけ実行）JST 21:00 に checkAndNotify を毎日実行するトリガーを作成。
 */
function createDailyTrigger() {
  // 重複防止: 既存の同名トリガーを削除してから作成
  deleteTriggers("checkAndNotify");
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

/** Open-Meteo から対象日の日次データを取得。 */
function fetchOpenMeteoDaily(lat, lon, ymd) {
  const params = {
    latitude: lat,
    longitude: lon,
    daily: "weather_code,precipitation_sum,precipitation_probability_max,rain_sum",
    timezone: "Asia/Tokyo",
    start_date: ymd,
    end_date: ymd,
  };
  const url = "https://api.open-meteo.com/v1/forecast" + toQuery(params);
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, method: "get" });
  if (res.getResponseCode() !== 200) {
    console.warn("Open-Meteo API 非200:", res.getResponseCode(), res.getContentText());
    return null;
  }
  try {
    const json = JSON.parse(res.getContentText());
    return json.daily || null;
  } catch (e) {
    console.warn("Open-Meteo API レスポンス解析エラー:", e);
    return null;
  }
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
