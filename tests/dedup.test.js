const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Enable requiring .gs files directly in Node.js
require.extensions[".gs"] = function (module, filename) {
  const content = fs.readFileSync(filename, "utf8");
  module._compile(content, filename);
};

describe("Deduplication and Setup Validation Suite", () => {
  let mockPropertiesStore;
  let lineFetchCalls;
  let lineFetchHandler;
  let main;

  // Setup GAS globals before loading src/main.gs
  beforeEach(() => {
    mockPropertiesStore = new Map();
    lineFetchCalls = [];
    lineFetchHandler = null;

    global.PropertiesService = {
      getScriptProperties: () => ({
        getProperty: (k) => (mockPropertiesStore.has(k) ? mockPropertiesStore.get(k) : null),
        setProperty: (k, v) => mockPropertiesStore.set(k, String(v)),
        deleteProperty: (k) => mockPropertiesStore.delete(k),
        getProperties: () => Object.fromEntries(mockPropertiesStore),
      }),
    };

    global.getEnv = (name, defaultValue) => {
      const v = global.PropertiesService.getScriptProperties().getProperty(name);
      return v != null ? v : defaultValue;
    };

    global.Session = {
      getScriptTimeZone: () => "Asia/Tokyo",
    };

    global.Utilities = {
      formatDate: (date, tz, format) => {
        const d = new Date(date.toLocaleString("en-US", { timeZone: tz || "Asia/Tokyo" }));
        const yyyy = d.getFullYear();
        const MM = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        if (format === "yyyy-MM-dd") return `${yyyy}-${MM}-${dd}`;
        if (format === "yyyy-MM") return `${yyyy}-${MM}`;
        throw new Error(`Unsupported format in mock: ${format}`);
      },
      sleep: () => {},
    };

    global.ScriptApp = {
      getProjectTriggers: () => [],
      newTrigger: () => ({
        timeBased: () => ({
          atHour: () => ({
            nearMinute: () => ({
              everyDays: () => ({
                create: () => {},
              }),
            }),
          }),
        }),
      }),
      deleteTrigger: () => {},
    };

    global.UrlFetchApp = {
      fetch: (url, options = {}) => {
        // Mock JMA area.json
        if (url === "https://www.jma.go.jp/bosai/common/const/area.json") {
          return {
            getResponseCode: () => 200,
            getContentText: () =>
              JSON.stringify({
                offices: {
                  "130000": { name: "東京都", children: ["130010"] },
                },
                class10s: {
                  "130010": { name: "東京地方", parent: "130000" },
                },
                class15s: {},
                class20s: {},
              }),
          };
        }

        // Mock JMA forecast json
        if (url.startsWith("https://www.jma.go.jp/bosai/forecast/data/forecast/")) {
          const tz = "Asia/Tokyo";
          const tomorrow = main.getTomorrowDateString(tz);
          return {
            getResponseCode: () => 200,
            getContentText: () =>
              JSON.stringify([
                {
                  timeSeries: [
                    {
                      timeDefines: [`${tomorrow}T00:00:00+09:00`],
                      areas: [
                        {
                          area: { name: "東京地方", code: "130010" },
                          weatherCodes: ["100"],
                          weathers: ["晴れ"],
                        },
                      ],
                    },
                    {
                      timeDefines: [`${tomorrow}T00:00:00+09:00`],
                      areas: [
                        {
                          area: { name: "東京地方", code: "130010" },
                          pops: ["10"],
                        },
                      ],
                    },
                    {
                      timeDefines: [`${tomorrow}T00:00:00+09:00`],
                      areas: [
                        {
                          area: { name: "東京", code: "44132" },
                          temps: ["15", "22"],
                        },
                      ],
                    },
                  ],
                },
              ]),
          };
        }

        // Mock LINE push endpoint
        if (url === "https://api.line.me/v2/bot/message/push") {
          lineFetchCalls.push({ url, options });
          if (lineFetchHandler) {
            return lineFetchHandler(url, options);
          }
          return {
            getResponseCode: () => 200,
            getContentText: () => "{}",
            getHeaders: () => ({}),
          };
        }

        throw new Error(`Unhandled mock fetch URL: ${url}`);
      },
    };

    // Load or reload main module
    const mainPath = path.resolve(__dirname, "../src/main.gs");
    delete require.cache[require.resolve(mainPath)];
    main = require(mainPath);

    // Setup standard environment properties
    mockPropertiesStore.set("LINE_CHANNEL_ACCESS_TOKEN", "test_token");
    mockPropertiesStore.set("LINE_TARGET_ID", "test_target_id");
    mockPropertiesStore.set(
      "LOCATIONS_JSON",
      JSON.stringify([{ label: "東京", area: "東京地方", code: "130010" }])
    );
  });

  test("RUN_OK_PREFIX constant is defined and exported as RUN_OK_", () => {
    assert.equal(main.RUN_OK_PREFIX, "RUN_OK_");
  });

  test("(1) When LINE fails with 500, RUN_OK_<today> is NOT saved; subsequent retry succeeds and sets flag", () => {
    const tz = "Asia/Tokyo";
    const today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
    const dedupKey = main.RUN_OK_PREFIX + today;

    // Simulate LINE server error 500
    lineFetchHandler = () => ({
      getResponseCode: () => 500,
      getContentText: () => "Internal Server Error",
      getHeaders: () => ({}),
    });

    assert.throws(
      () => {
        main.checkAndNotify();
      },
      (err) => {
        assert.match(err.message, /LINE 送信エラー \(500\)/);
        return true;
      }
    );

    // Verify dedup flag is NOT set on failure
    assert.equal(mockPropertiesStore.get(dedupKey), undefined);
    assert.equal(lineFetchCalls.length, 1); // 500 throws immediately without retrying

    // Next retry: LINE recovers with 200 OK
    lineFetchHandler = () => ({
      getResponseCode: () => 200,
      getContentText: () => "{}",
      getHeaders: () => ({}),
    });

    assert.doesNotThrow(() => {
      main.checkAndNotify();
    });

    // Verify dedup flag is now set
    assert.equal(mockPropertiesStore.get(dedupKey), "1");
    assert.equal(lineFetchCalls.length, 2); // 1 failed call + 1 successful call
  });

  test("(2) Second execution on the same day skips sending LINE message", () => {
    const tz = "Asia/Tokyo";
    const today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
    const dedupKey = main.RUN_OK_PREFIX + today;

    // First execution succeeds
    main.checkAndNotify();
    assert.equal(mockPropertiesStore.get(dedupKey), "1");
    assert.equal(lineFetchCalls.length, 1);

    // Second execution on same day
    main.checkAndNotify();
    // LINE push call count should remain 1 (skipped)
    assert.equal(lineFetchCalls.length, 1);
  });

  test("(3) validateSetup().config.hasRunToday is false before execution, and true after successful execution", () => {
    // Before execution
    const beforeResult = main.validateSetup();
    assert.equal(beforeResult.config.hasRunToday, false);
    assert.ok(
      !beforeResult.warnings.some((w) => w.includes("今日はすでに実行済みです")),
      "Should not have run-today warning before execution"
    );

    // Run checkAndNotify successfully
    main.checkAndNotify();

    // After execution
    const afterResult = main.validateSetup();
    assert.equal(afterResult.config.hasRunToday, true);
    assert.ok(
      afterResult.warnings.some((w) => w.includes("今日はすでに実行済みです")),
      "Should have run-today warning after execution"
    );
  });

  test("(4) Monthly limit reached skip path completes without exception and sets RUN_OK flag", () => {
    const tz = "Asia/Tokyo";
    const today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
    const monthKey = Utilities.formatDate(new Date(), tz, "yyyy-MM");
    const limitKey = "LINE_MONTHLY_LIMIT_" + monthKey;
    const dedupKey = main.RUN_OK_PREFIX + today;

    // Pre-set monthly limit flag
    mockPropertiesStore.set(limitKey, "1");

    // Execute checkAndNotify
    assert.doesNotThrow(() => {
      main.checkAndNotify();
    });

    // LINE push should NOT have been called
    assert.equal(lineFetchCalls.length, 0);

    // RUN_OK flag should be set to prevent redundant work
    assert.equal(mockPropertiesStore.get(dedupKey), "1");

    // Next call skips because dedupKey is set
    main.checkAndNotify();
    assert.equal(lineFetchCalls.length, 0);
  });

  test("Handling monthly limit detected during LINE push sets limitKey and dedupKey without rethrowing", () => {
    const tz = "Asia/Tokyo";
    const today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
    const monthKey = Utilities.formatDate(new Date(), tz, "yyyy-MM");
    const limitKey = "LINE_MONTHLY_LIMIT_" + monthKey;
    const dedupKey = main.RUN_OK_PREFIX + today;

    // Simulate LINE returning 400 with monthly limit message
    lineFetchHandler = () => ({
      getResponseCode: () => 400,
      getContentText: () => JSON.stringify({ message: "You have reached your monthly limit." }),
      getHeaders: () => ({}),
    });

    assert.doesNotThrow(() => {
      main.checkAndNotify();
    });

    // Both monthly limit and dedup flags should be set
    assert.equal(mockPropertiesStore.get(limitKey), "1");
    assert.equal(mockPropertiesStore.get(dedupKey), "1");
  });

  test("Early returns on missing configuration, no locations, or empty forecast do not set dedup flag", () => {
    const tz = "Asia/Tokyo";
    const today = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
    const dedupKey = main.RUN_OK_PREFIX + today;

    // Case 1: Missing LINE credentials
    mockPropertiesStore.delete("LINE_CHANNEL_ACCESS_TOKEN");
    main.checkAndNotify();
    assert.equal(mockPropertiesStore.get(dedupKey), undefined);
    mockPropertiesStore.set("LINE_CHANNEL_ACCESS_TOKEN", "test_token");

    // Case 2: No locations
    mockPropertiesStore.set("LOCATIONS_JSON", "[]");
    main.checkAndNotify();
    assert.equal(mockPropertiesStore.get(dedupKey), undefined);
    mockPropertiesStore.set(
      "LOCATIONS_JSON",
      JSON.stringify([{ label: "東京", area: "東京地方", code: "130010" }])
    );

    // Case 3: JMA API failure (returns 500 so no reports)
    const originalFetch = global.UrlFetchApp.fetch;
    global.UrlFetchApp.fetch = (url, opts) => {
      if (url.includes("forecast")) {
        return { getResponseCode: () => 500, getContentText: () => "error" };
      }
      return originalFetch(url, opts);
    };
    main.checkAndNotify();
    assert.equal(mockPropertiesStore.get(dedupKey), undefined);
  });
});
