# weather-forecast-notifier

A script that monitors weather forecasts with Google Apps Script and notifies LINE.
Forecast data comes from the Japan Meteorological Agency (JMA) prefectural weather forecast JSON (free, no API key, no rate limits).

## Publishing and setup

- No confidential information is committed when publishing this repository.
  - `.clasp.json` is in `.gitignore` (`.clasp.example.json` is committed instead)
  - Operational values such as the locations to monitor are stored in Script Properties.

### 1) Preparing clasp

1. `bun add -g @google/clasp`
2. `clasp login`

### 2) Creating .clasp.json

- This repository ships `.clasp.example.json` as a template.
- Copy it to create `.clasp.json`, then set the Apps Script `scriptId`.

```bash
cp .clasp.example.json .clasp.json
# Replace YOUR_SCRIPT_ID_HERE with the real ID in your editor
```

### 3) First push/pull

```bash
clasp push   # local -> Apps Script
# or
clasp pull   # Apps Script -> local
```

## Configuring via Script Properties

The locations to monitor are stored as JSON in the Apps Script Script Properties.

- Apps Script editor > Project Settings > Script properties
- Key: `LOCATIONS_JSON`
- Value: an array of objects like the following (label / area / code)

```json
[
  { "label": "東京駅", "area": "千代田区", "code": "130010" },
  { "label": "大阪駅", "area": "北区", "code": "270000" },
  { "label": "札幌駅", "area": "北区", "code": "016010" }
]
```

`code` is the JMA **forecast area code** (a 6-digit number). Typical values:

| Place | Forecast area | code |
| --- | --- | --- |
| 札幌 (Sapporo) | 石狩地方 (Ishikari) | 016010 |
| 仙台 (Sendai) | 宮城県東部 (eastern Miyagi) | 040010 |
| さいたま (Saitama) | 埼玉県南部 (southern Saitama) | 110010 |
| 千葉 (Chiba) | 千葉県北西部 (northwestern Chiba) | 120010 |
| 東京 (Tokyo) | 東京地方 (Tokyo) | 130010 |
| 横浜 (Yokohama) | 神奈川県東部 (eastern Kanagawa) | 140010 |
| 新潟 (Niigata) | 下越 (Kaetsu) | 150010 |
| 金沢 (Kanazawa) | 加賀 (Kaga) | 170010 |
| 静岡 (Shizuoka) | 中部 (central Shizuoka) | 220010 |
| 名古屋 (Nagoya) | 愛知県西部 (western Aichi) | 230010 |
| 京都 (Kyoto) | 京都府南部 (southern Kyoto) | 260010 |
| 大阪 (Osaka) | 大阪府 (Osaka) | 270000 |
| 神戸 (Kobe) | 兵庫県南部 (southern Hyogo) | 280010 |
| 広島 (Hiroshima) | 広島県南部 (southern Hiroshima) | 340010 |
| 高松 (Takamatsu) | 香川県 (Kagawa) | 370000 |
| 松山 (Matsuyama) | 愛媛県中予 (Chuyo, Ehime) | 380010 |
| 福岡 (Fukuoka) | 福岡地方 (Fukuoka) | 400010 |
| 熊本 (Kumamoto) | 熊本地方 (Kumamoto) | 430010 |
| 鹿児島 (Kagoshima) | 薩摩地方 (Satsuma) | 460010 |
| 那覇 (Naha) | 沖縄本島中南部 (central-southern Okinawa main island) | 471010 |

For other regions, select the region on the JMA [weather forecast page](https://www.jma.go.jp/bosai/forecast/)
and check `area.code` in the JSON you get back (`forecast/<prefecture forecast area code>.json`).

Note that `code` does not have to be a 6-digit forecast area code; a finer-grained code such as a
**municipality code (7 digits, e.g. 三郷市 (Misato City) = `1123700`)** is also converted to the forecast area automatically.

For privacy, the public examples use generic places (such as train stations). Replace them with your own locations in real use.

On the code side, `getLocations()` reads `LOCATIONS_JSON` and returns the array.
Other secrets (tokens, API keys, etc.) can be moved into properties the same way.

```js
function getEnv(name, defaultValue) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  return v != null ? v : defaultValue;
}
// e.g. const LINE_CHANNEL_ACCESS_TOKEN = getEnv('LINE_CHANNEL_ACCESS_TOKEN');
```

## Setup (GAS)

This project runs on Google Apps Script (GAS) and notifies the LINE Messaging API when the conditions are met. Create the daily 21:00 (JST) trigger once, on first setup.

- Prerequisites

  - You already have a LINE Messaging API channel access token and destination ID
  - You have a Google account and access to the Apps Script editor

- Steps overview

  1. Create a new GAS project, paste the code from `src/main.gs`, and save it
  2. Set the required values in Script Properties
  3. Set the project time zone to `Asia/Tokyo`
  4. Run `createDailyTrigger` once to create the trigger (this also grants permissions)
  5. Run a manual test if needed

- Script Properties (required)

  - `LINE_CHANNEL_ACCESS_TOKEN`: channel access token for the LINE Messaging API
  - `LINE_TARGET_ID`: LINE destination ID (user / group / talk room)
  - `LOCATIONS_JSON`: array of locations to monitor (JSON string)
    - Example format:
      ```json
      [
        { "label": "渋谷", "area": "東京都", "code": "130010" },
        { "label": "梅田", "area": "大阪府", "code": "270000" }
      ]
      ```
    - Each object has `code` (JMA forecast area code, required), `label` (optional), and `area` (optional).

- Time zone

  - In the GAS editor, set Project Settings > Time zone to `Asia/Tokyo`.
  - `createDailyTrigger()` in the code uses `atHour(21)` to run `checkAndNotify` every day at 21:00 (project time zone).

- Creating the trigger the first time

  1. Select `createDailyTrigger` from the function dropdown at the top of the editor
  2. Press the run button; an authorization dialog appears, so allow it
  3. From then on `checkAndNotify` runs automatically every day at 21:00 (JST) (delete it as described below when you no longer need it)

  > About the data: this uses the JMA prefectural weather forecast JSON (`www.jma.go.jp/bosai/...`).
  > It is free and requires no API key, and unlike Open-Meteo there is no daily limit (429).
  > Forecasts are updated every day at 05:00 / 11:00 / 17:00 (JST), so the 21:00 run uses the latest 17:00 update.
  > Notifications contain the weather, precipitation probability (next-day maximum), and temperature (min/max at the prefectural representative station)
  > (precipitation amount is not included in the JMA forecast JSON, which is why this replaced the Open-Meteo version).

- Manual test (optional)

  - Select and run `manualTest` (which runs `checkAndNotify` immediately) and it decides whether to notify based on the "tomorrow" forecast at that moment.
  - If the forecast cannot be fetched, nothing is sent (the skip reason is printed to the console).

- Trigger management (delete / recreate)

  - To delete the existing trigger, run `deleteTriggers('checkAndNotify')`.
  - To recreate it, run `createDailyTrigger` again (it deletes any trigger with the same name first to avoid duplicates).

- Main permissions granted

  - Connecting to external services (`UrlFetchApp` HTTP access to JMA and LINE)
  - Reading script properties (`PropertiesService`)
  - Managing triggers (`ScriptApp`)

- Notes
  - The function that runs is `checkAndNotify`, and the trigger is created by `createDailyTrigger`.
  - If the JMA API response is not 200, a warning is logged and the run is skipped.
