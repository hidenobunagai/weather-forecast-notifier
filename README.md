# weather-forecast-discord

Google Apps Script で天気予報を監視し、Discord / LINE へ通知するスクリプト。
予報データは気象庁（JMA）の府県天気予報 JSON を使用します（無料・APIキー不要・レート制限なし）。

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
- 値: 以下のようなオブジェクト配列（label/area/code）

```json
[
  { "label": "東京駅", "area": "千代田区", "code": "130010" },
  { "label": "大阪駅", "area": "北区", "code": "270000" },
  { "label": "札幌駅", "area": "北区", "code": "016010" }
]
```

`code` は気象庁の**予報区域コード**（6桁数字）です。代表的なもの:

| 地点 | 予報区域 | code |
| --- | --- | --- |
| 札幌 | 石狩地方 | 016010 |
| 仙台 | 宮城県東部 | 040010 |
| さいたま | 埼玉県南部 | 110010 |
| 千葉 | 千葉県北西部 | 120010 |
| 東京 | 東京地方 | 130010 |
| 横浜 | 神奈川県東部 | 140010 |
| 新潟 | 下越 | 150010 |
| 金沢 | 加賀 | 170010 |
| 静岡 | 中部 | 220010 |
| 名古屋 | 愛知県西部 | 230010 |
| 京都 | 京都府南部 | 260010 |
| 大阪 | 大阪府 | 270000 |
| 神戸 | 兵庫県南部 | 280010 |
| 広島 | 広島県南部 | 340010 |
| 高松 | 香川県 | 370000 |
| 松山 | 愛媛県中予 | 380010 |
| 福岡 | 福岡地方 | 400010 |
| 熊本 | 熊本地方 | 430010 |
| 鹿児島 | 薩摩地方 | 460010 |
| 那覇 | 沖縄本島中南部 | 471010 |

他の地域は、気象庁の[天気予報ページ](https://www.jma.go.jp/bosai/forecast/)で地域を選択し、
取得される JSON（`forecast/<府県予報区コード>.json`）内の `area.code` を確認してください。

なお、`code` は予報区域コード（6桁）のほか、**市町村コード（7桁、例: 三郷市=`1123700`）** など
より細かい階層のコードでも自動的に予報区域へ変換されます。

プライバシー保護の観点から、公開用の例には一般的な地点（駅など）を記載しています。実運用ではご自身の地点に置き換えてください。

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
        { "label": "渋谷", "area": "東京都", "code": "130010" },
        { "label": "梅田", "area": "大阪府", "code": "270000" }
      ]
      ```
    - 各オブジェクトは `code`（気象庁の予報区域コード・必須）, `label`（任意）, `area`（任意）を持ちます。

- タイムゾーン設定

  - GAS エディタ右上の「プロジェクトの設定」→「タイムゾーン」を `Asia/Tokyo` に設定してください。
  - コード内の `createDailyTrigger()` は `atHour(21)` で毎日 21:00（プロジェクトのタイムゾーン）に `checkAndNotify` を実行します。

- 初回のトリガー作成

  1. エディタ上部の関数プルダウンから `createDailyTrigger` を選択
  2. 実行ボタンを押すと権限承認ダイアログが表示されるので許可
  3. 以後、毎日 21:00（JST）に `checkAndNotify` が自動実行されます（不要になったら後述の方法で削除）

  > データについて: 気象庁の府県天気予報 JSON（`www.jma.go.jp/bosai/...`）を使用します。
  > 無料・APIキー不要で、Open-Meteo のような日次上限（429）はありません。
  > 予報は毎日 05時/11時/17時（JST）に更新され、21時の実行時点で最新の17時更新分が使われます。
  > 通知内容は「天気・降水確率（翌日最大）・気温（府県代表地点の最低/最高）」です
  > （降水量/雨量は気象庁の予報 JSON に含まれないため、Open-Meteo 版から置き換えました）。

- 手動テスト（任意）

  - `manualTest`（= `checkAndNotify` を即時実行）を選択して実行すると、その時点の「明日」の予報に基づき通知判定を行います。
  - 予報が取得できない場合は送信しません（コンソールにスキップ理由を出力）。

- トリガー管理（削除/再作成）

  - 既存トリガーを削除したい場合は、`deleteTriggers('checkAndNotify')` を実行してください。
  - 再作成は `createDailyTrigger` を再実行します（内部で重複回避のため同名トリガーを削除してから作成します）。

- 付与される主な権限

  - 外部サービスへの接続（`UrlFetchApp` による気象庁と Discord への HTTP アクセス）
  - スクリプトのプロパティの読み取り（`PropertiesService`）
  - トリガーの管理（`ScriptApp`）

- 補足
  - 実行関数は `checkAndNotify` で、トリガーは `createDailyTrigger` で作成します。
  - 気象庁 API の応答が 200 でない場合はログに警告を出してスキップします。
