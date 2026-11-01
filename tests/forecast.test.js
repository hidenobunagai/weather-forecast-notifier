import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require.extensions[".gs"] = require.extensions[".js"];
const { evaluateUmbrellaNeed, buildForecastMessage, jmaWeatherEmoji } = require("../src/main.gs");

describe("evaluateUmbrellaNeed", () => {
  test("降水確率 70% の地点が含まれる場合、要傘（☔）と判定され該当地点名と降水確率が含まれること", () => {
    const reports = [
      {
        label: "東京",
        area: "東京地方",
        weatherCode: "100",
        weatherText: "晴れ",
        popMax: 70,
      },
      {
        label: "横浜",
        area: "東部",
        weatherCode: "100",
        weatherText: "晴れ",
        popMax: 20,
      },
    ];

    const result = evaluateUmbrellaNeed(reports);
    expect(result).not.toBeNull();
    expect(result.level).toBe("rain");
    expect(result.icon).toBe("☔");
    expect(result.text).toContain("☔");
    expect(result.text).toContain("明日は傘をお持ちください");
    expect(result.text).toContain("東京");
    expect(result.text).toContain("70%");
  });

  test("降水確率は 20% だが weatherText に「雨」が含まれる場合、要傘（☔）と判定されること", () => {
    const reports = [
      {
        label: "横浜",
        area: "東部",
        weatherCode: "100",
        weatherText: "くもりのち一時雨",
        popMax: 20,
      },
    ];

    const result = evaluateUmbrellaNeed(reports);
    expect(result).not.toBeNull();
    expect(result.level).toBe("rain");
    expect(result.icon).toBe("☔");
    expect(result.text).toContain("☔");
    expect(result.text).toContain("明日は傘をお持ちください");
    expect(result.text).toContain("横浜");
    expect(result.text).toContain("20%");
  });

  test("weatherCode が 300 系（雨）または 400 系（雪）の場合に要傘（☔）と判定されること", () => {
    const rainReport = [
      {
        label: "札幌",
        area: "石狩地方",
        weatherCode: "300",
        weatherText: "雨",
        popMax: 30,
      },
    ];
    const snowReport = [
      {
        label: "青森",
        area: "津軽地方",
        weatherCode: "400",
        weatherText: "雪",
        popMax: 30,
      },
    ];

    const rainResult = evaluateUmbrellaNeed(rainReport);
    expect(rainResult).not.toBeNull();
    expect(rainResult.level).toBe("rain");

    const snowResult = evaluateUmbrellaNeed(snowReport);
    expect(snowResult).not.toBeNull();
    expect(snowResult.level).toBe("rain");
  });

  test("降水確率が 40% で雨コードがない場合、折りたたみ傘推奨（🌂）と判定されること", () => {
    const reports = [
      {
        label: "千葉",
        area: "北西部",
        weatherCode: "200",
        weatherText: "くもり",
        popMax: 40,
      },
      {
        label: "埼玉",
        area: "南部",
        weatherCode: "100",
        weatherText: "晴れ",
        popMax: 20,
      },
    ];

    const result = evaluateUmbrellaNeed(reports);
    expect(result).not.toBeNull();
    expect(result.level).toBe("fold");
    expect(result.icon).toBe("🌂");
    expect(result.text).toContain("🌂");
    expect(result.text).toContain("折りたたみ傘があると安心です");
    expect(result.text).toContain("千葉");
    expect(result.text).toContain("40%");
  });

  test("全地点が晴れ・曇りで降水確率 10% の場合、傘不要（☀）と判定されること", () => {
    const reports = [
      {
        label: "東京",
        area: "東京地方",
        weatherCode: "100",
        weatherText: "晴れ",
        popMax: 10,
      },
      {
        label: "横浜",
        area: "東部",
        weatherCode: "200",
        weatherText: "くもり",
        popMax: 0,
      },
    ];

    const result = evaluateUmbrellaNeed(reports);
    expect(result).not.toBeNull();
    expect(result.level).toBe("none");
    expect(result.icon).toBe("☀");
    expect(result.text).toBe("☀ 傘は不要です");
  });

  test("境界値テスト: popMax が 50% ちょうどで要傘、30% ちょうどで折りたたみ傘推奨、29% で傘不要", () => {
    const report50 = [{ label: "地点A", popMax: 50, weatherCode: 100, weatherText: "晴れ" }];
    const report30 = [{ label: "地点B", popMax: 30, weatherCode: 100, weatherText: "晴れ" }];
    const report29 = [{ label: "地点C", popMax: 29, weatherCode: 100, weatherText: "晴れ" }];

    expect(evaluateUmbrellaNeed(report50).level).toBe("rain");
    expect(evaluateUmbrellaNeed(report30).level).toBe("fold");
    expect(evaluateUmbrellaNeed(report29).level).toBe("none");
  });

  test("複数地点で最も降水確率が高い要傘地点が代表地点として選ばれること", () => {
    const reports = [
      { label: "千葉", popMax: 55, weatherCode: 100, weatherText: "晴れ" },
      { label: "東京", popMax: 80, weatherCode: 100, weatherText: "晴れ" },
      { label: "横浜", popMax: 60, weatherCode: 100, weatherText: "晴れ" },
    ];
    const result = evaluateUmbrellaNeed(reports);
    expect(result.level).toBe("rain");
    expect(result.text).toContain("東京");
    expect(result.text).toContain("80%");
  });

  test("空配列や不正データが渡された場合に例外を投げず安全に null を返すこと", () => {
    expect(evaluateUmbrellaNeed([])).toBeNull();
    expect(evaluateUmbrellaNeed(null)).toBeNull();
    expect(evaluateUmbrellaNeed(undefined)).toBeNull();
    expect(evaluateUmbrellaNeed("invalid")).toBeNull();
    expect(evaluateUmbrellaNeed([null, undefined])).toBeNull();
    expect(evaluateUmbrellaNeed([{}])).toBeNull();
    expect(
      evaluateUmbrellaNeed([
        {
          label: "無効地点",
          area: "無効地域",
          weatherCode: null,
          weatherText: null,
          popMax: null,
        },
      ])
    ).toBeNull();
  });
});

describe("buildForecastMessage", () => {
  test("日付ヘッダーの直後に傘要否サマリーが挿入され、既存の地点別フォーマットを壊さないこと", () => {
    const reports = [
      {
        label: "東京",
        area: "東京地方",
        weatherCode: "100",
        weatherText: "晴れ",
        popMax: 70,
        tempMin: 15,
        tempMax: 22,
      },
    ];

    const message = buildForecastMessage("2026-11-03", reports);
    const lines = message.split("\n");

    expect(lines[0]).toBe("📅 明日（2026-11-03）の天気予報");
    expect(lines[1]).toBe("☔ 明日は傘をお持ちください（東京: 降水確率 70%）");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("━ 東京（東京地方）━");
    expect(lines[4]).toBe("  天気: ☀ 晴れ");
    expect(lines[5]).toBe("  降水確率: 70%");
    expect(lines[6]).toBe("  気温: 15℃ / 22℃");
  });

  test("傘不要の場合に傘不要サマリーが日付ヘッダー直後に挿入されること", () => {
    const reports = [
      {
        label: "東京",
        area: "東京地方",
        weatherCode: "100",
        weatherText: "晴れ",
        popMax: 10,
        tempMin: 15,
        tempMax: 22,
      },
    ];

    const message = buildForecastMessage("2026-11-03", reports);
    const lines = message.split("\n");

    expect(lines[0]).toBe("📅 明日（2026-11-03）の天気予報");
    expect(lines[1]).toBe("☀ 傘は不要です");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("━ 東京（東京地方）━");
  });

  test("レポートが空またはサマリー判定不能時はサマリー行が挿入されないこと", () => {
    const message = buildForecastMessage("2026-11-03", []);
    expect(message).toBe("📅 明日（2026-11-03）の天気予報");
  });
});

describe("jmaWeatherEmoji", () => {
  test("1xx (晴), 2xx (曇), 3xx (雨), 4xx (雪), 未知コードで想定通りの絵文字が返ること", () => {
    expect(jmaWeatherEmoji("100")).toBe("☀");
    expect(jmaWeatherEmoji(101)).toBe("☀");
    expect(jmaWeatherEmoji("200")).toBe("☁");
    expect(jmaWeatherEmoji(202)).toBe("☁");
    expect(jmaWeatherEmoji("300")).toBe("🌧");
    expect(jmaWeatherEmoji(311)).toBe("🌧");
    expect(jmaWeatherEmoji("400")).toBe("🌨");
    expect(jmaWeatherEmoji(411)).toBe("🌨");
    expect(jmaWeatherEmoji("999")).toBe("🌈");
    expect(jmaWeatherEmoji("unknown")).toBe("🌈");
    expect(jmaWeatherEmoji(null)).toBe("");
    expect(jmaWeatherEmoji(undefined)).toBe("");
  });
});
