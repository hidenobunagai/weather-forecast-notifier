/**
 * 任意のスクリプトプロパティを取得するユーティリティ。
 */
function getEnv(name, defaultValue) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  return v != null ? v : defaultValue;
}

