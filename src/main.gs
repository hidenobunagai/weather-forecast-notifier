/**
 * 明日の天気が「雨」なら Discord に通知する（JST 前日21時に実行される想定）。
 */
function checkAndNotify() {
  const tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
  const tomorrow = getTomorrowDateString(tz); // 'YYYY-MM-DD'

  const webhookUrl = (getEnv('DISCORD_WEBHOOK_URL', '') || '').trim();
  if (!webhookUrl) {
    console.warn('Script Property DISCORD_WEBHOOK_URL が未設定です。');
    return;
  }

  const locations = getLocations();
  const rainyReports = [];

  for (const loc of locations) {
    try {
      const daily = fetchOpenMeteoDaily(loc.lat, loc.lon, tomorrow);
      if (!daily) continue;

      const isRain = isRainy(daily);
      if (isRain) {
        rainyReports.push({
          label: loc.label,
          area: loc.area,
          date: tomorrow,
          probabilityMax: numOrNull(daily.precipitation_probability_max?.[0]),
          precipitationSum: numOrNull(daily.precipitation_sum?.[0]),
          rainSum: numOrNull(daily.rain_sum?.[0]),
          weathercode: daily.weathercode?.[0],
        });
      }
    } catch (e) {
      console.error(`Failed to fetch/parse for ${loc.label}:`, e);
    }
  }

  if (rainyReports.length === 0) {
    console.log('明日の雨予報はありません。通知をスキップします。');
    return;
  }

  const content = buildDiscordMessage(tomorrow, rainyReports);
  postToDiscord(webhookUrl, content);
}

/**
 * （初回だけ実行）JST 21:00 に checkAndNotify を毎日実行するトリガーを作成。
 */
function createDailyTrigger() {
  // 重複防止: 既存の同名トリガーを削除してから作成
  deleteTriggers('checkAndNotify');
  ScriptApp.newTrigger('checkAndNotify')
    .timeBased()
    .atHour(21)       // JSTとして動作（manifest の timeZone を使用）
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
  const raw = getEnv('LOCATIONS_JSON', '');
  if (!raw) {
    console.warn('Script Property LOCATIONS_JSON が未設定です。');
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((o) => o && typeof o.lat === 'number' && typeof o.lon === 'number')
        .map((o) => ({
          label: o.label || '',
          area: o.area || '',
          lat: o.lat,
          lon: o.lon,
        }));
    }
  } catch (e) {
    console.warn('LOCATIONS_JSON の JSON 解析に失敗しました。', e);
  }
  return [];
}

/** 明日の日付（YYYY-MM-DD）をスクリプトのタイムゾーンで返す。 */
function getTomorrowDateString(tz) {
  const now = new Date();
  const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return Utilities.formatDate(tomorrowDate, tz, 'yyyy-MM-dd');
}

/** Open-Meteo から対象日の日次データを取得。 */
function fetchOpenMeteoDaily(lat, lon, ymd) {
  const params = {
    latitude: lat,
    longitude: lon,
    daily: 'weathercode,precipitation_sum,precipitation_probability_max,rain_sum',
    timezone: 'Asia/Tokyo',
    start_date: ymd,
    end_date: ymd,
  };
  const url = 'https://api.open-meteo.com/v1/forecast' + toQuery(params);
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, method: 'get' });
  if (res.getResponseCode() !== 200) {
    console.warn('Open-Meteo API 非200:', res.getResponseCode(), res.getContentText());
    return null;
  }
  const json = JSON.parse(res.getContentText());
  return json.daily || null;
}

/** 日次データから「雨」と判定。 */
function isRainy(daily) {
  const pSum = numOrNull(daily.precipitation_sum?.[0]); // mm
  const rSum = numOrNull(daily.rain_sum?.[0]); // mm
  const code = daily.weathercode?.[0];
  const prob = numOrNull(daily.precipitation_probability_max?.[0]); // %

  // 基本は降水量 > 0 で雨
  if ((pSum || 0) > 0 || (rSum || 0) > 0) return true;

  // 補助: 降水確率が高く、かつ該当 weathercode が雨系
  if ((prob || 0) >= 60 && isRainyWeatherCode(code)) return true;

  return false;
}

/** WMO weathercode のうち雨系なら true。 */
function isRainyWeatherCode(code) {
  // 51–67: 霧雨・雨、80–82: にわか雨
  if (code == null) return false;
  return (
    (code >= 51 && code <= 67) ||
    (code >= 80 && code <= 82)
  );
}

/** Discord 送信本文を構築。 */
function buildDiscordMessage(ymd, reports) {
  const lines = [];
  lines.push(`明日（${ymd}）は雨の予報があります。☔`);
  lines.push('');
  for (const r of reports) {
    const prob = r.probabilityMax != null ? `${r.probabilityMax}%` : 'N/A';
    const psum = r.precipitationSum != null ? `${r.precipitationSum}mm` : 'N/A';
    const rsum = r.rainSum != null ? `${r.rainSum}mm` : 'N/A';
    lines.push(`・${r.label}（${r.area}）: 降水確率 最大 ${prob} / 降水量合計 ${psum} / 雨量合計 ${rsum}`);
  }
  lines.push('');
  lines.push('雨具のご準備をお忘れなく！');
  return lines.join('\n');
}

/** Discord Webhook に POST。 */
function postToDiscord(webhookUrl, content) {
  const payload = { content: content };
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  const res = UrlFetchApp.fetch(webhookUrl, options);
  if (res.getResponseCode() >= 300) {
    console.warn('Discord Webhook エラー:', res.getResponseCode(), res.getContentText());
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
    .join('&');
  return `?${q}`;
}
