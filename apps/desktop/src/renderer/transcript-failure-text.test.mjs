import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import i18n from "./i18n";
import { localizedTurnFailureReason } from "./transcript-failure-text";

const ko = JSON.parse(readFileSync(new URL("./locales/ko.json", import.meta.url), "utf8"));
i18n.addResourceBundle("ko", "translation", ko);

test("fixed runtime failure sentences are localized and keep their diagnostic code", async () => {
  await i18n.changeLanguage("ko");
  assert.equal(
    localizedTurnFailureReason("Connection to the provider was lost (UND_ERR_SOCKET)."),
    "프로바이더 연결이 끊어졌습니다 (UND_ERR_SOCKET)",
  );
  assert.equal(localizedTurnFailureReason("Provider is temporarily unavailable (503)."), "프로바이더를 일시적으로 사용할 수 없습니다 (503)");
  assert.equal(localizedTurnFailureReason("Context too large."), "컨텍스트가 너무 큽니다");
  await i18n.changeLanguage("en");
  assert.equal(localizedTurnFailureReason("Could not reach the provider."), "Could not reach the provider");
});

test("free-form reasons pass through verbatim", async () => {
  await i18n.changeLanguage("ko");
  assert.equal(localizedTurnFailureReason("agent compact failed (stage=pre_send)"), "agent compact failed (stage=pre_send)");
  assert.equal(localizedTurnFailureReason(""), "");
});
