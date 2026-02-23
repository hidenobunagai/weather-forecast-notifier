# weather-forecast-discord

Google Apps Script で天気予報を監視し、Discord へ通知するスクリプト。

## 公開とセットアップ

- リポジトリ公開にあたり、機密情報はコミットしません。
  - `.clasp.json` は `.gitignore` 済みです（代わりに `.clasp.example.json` をコミット）
  - 監視対象地点などの運用値は「スクリプトプロパティ」に保存します。

### 1) clasp の準備

1. `bun add -g @google/clasp`
2. `clasp login`

### 2) .clasp.json の作成

- このリポジトリではテンプレートとして `.clasp.example.json` を同梱しています。
- これをコピーして `.clasp.json` を作成し、Apps Script の `scriptId` を設定してください。

```bash
cp .clasp.example.json .clasp.json
# エディタで YOUR_SCRIPT_ID_HERE を実IDに置換
```

### 3) 初回プッシュ/プル

```bash
clasp push   # ローカル → Apps Script
# または
clasp pull   # Apps Script → ローカル
```

## スクリプトプロパティでの設定

監視対象地点は、Apps Script の「スクリプトプロパティ」に JSON で保存します。

- Apps Script エディタ > プロジェクトの設定 > スクリプトプロパティ
- キー: `LOCATIONS_JSON`
- 値: 以下のようなオブジェクト配列（label/area/lat/lon）

```json
[
  { "label": "東京駅", "area": "千代田区", "lat": 35.6812, "lon": 139.7671 },
  { "label": "大阪駅", "area": "北区", "lat": 34.7025, "lon": 135.4959 },
  { "label": "札幌駅", "area": "北区", "lat": 43.0687, "lon": 141.3508 }
]
```

プライバシー保護の観点から、公開用の例には一般的な地点（駅など）を記載しています。実運用ではご自身の地点に置き換えてください（座標は近傍に丸めても機能します）。

コード側では `getLocations()` が `LOCATIONS_JSON` を読み取り、配列を返します。
他の機密値（Webhook URL, API キー等）も同様にプロパティ化できます。

```js
function getEnv(name, defaultValue) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  return v != null ? v : defaultValue;
}
// 例: const DISCORD_WEBHOOK_URL = getEnv('DISCORD_WEBHOOK_URL');
```

## セットアップ（GAS）

このプロジェクトは Google Apps Script（GAS）上で実行し、条件に合致した場合に Discord Webhook へ通知します。初回のみ、毎日 21:00（JST）に実行するトリガーを作成してください。

- 前提

  - Discord の Webhook URL を取得済み
  - Google アカウントと Apps Script エディタへアクセス可能

- 手順概要

  1. GAS プロジェクトを新規作成し、`src/main.gs` のコードを貼り付けて保存
  2. スクリプトプロパティに必須の値を設定
  3. プロジェクトのタイムゾーンを `Asia/Tokyo` に設定
  4. `createDailyTrigger` を 1 回実行してトリガー作成（権限付与）
  5. 必要に応じて手動実行テスト

- スクリプトプロパティ（必須）

  - `DISCORD_WEBHOOK_URL`: Discord の Webhook URL
  - `LOCATIONS_JSON`: 監視対象地点の配列（JSON 文字列）
    - 形式例:
      ```json
      [
        { "label": "渋谷", "area": "東京都", "lat": 35.659, "lon": 139.7 },
        { "label": "梅田", "area": "大阪府", "lat": 34.704, "lon": 135.498 }
      ]
      ```
    - 各オブジェクトは `lat`（数値）, `lon`（数値）, `label`（任意）, `area`（任意）を持ちます。

- タイムゾーン設定

  - GAS エディタ右上の「プロジェクトの設定」→「タイムゾーン」を `Asia/Tokyo` に設定してください。
  - コード内の `createDailyTrigger()` は `atHour(21)` で毎日 21:00（プロジェクトのタイムゾーン）に `checkAndNotify` を実行します。

- 初回のトリガー作成

  1. エディタ上部の関数プルダウンから `createDailyTrigger` を選択
  2. 実行ボタンを押すと権限承認ダイアログが表示されるので許可
  3. 以後、毎日 21:00 に自動実行されます（不要になったら後述の方法で削除）

- 手動テスト（任意）

  - `manualTest`（= `checkAndNotify` を即時実行）を選択して実行すると、その時点の「明日」の予報に基づき通知判定を行います。
  - 雨が見込まれない場合は送信しません（コンソールにスキップ理由を出力）。

- トリガー管理（削除/再作成）

  - 既存トリガーを削除したい場合は、`deleteTriggers('checkAndNotify')` を一度実行してください。
  - 再作成は `createDailyTrigger` を再実行します（内部で重複回避のため同名トリガーを削除してから作成します）。

- 付与される主な権限

  - 外部サービスへの接続（`UrlFetchApp` による Open‑Meteo と Discord への HTTP アクセス）
  - スクリプトのプロパティの読み取り（`PropertiesService`）
  - トリガーの管理（`ScriptApp`）

- 補足
  - 実行関数は `checkAndNotify`（自動実行対象）とし、トリガーは `createDailyTrigger` で作成します。
  - 1 日の予報取得には Open‑Meteo API を利用しています。API の応答が 200 でない場合はログに警告を出してスキップします。
