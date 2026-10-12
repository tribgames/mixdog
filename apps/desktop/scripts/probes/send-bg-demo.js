// Demo state for the composer island: asks the model to start a long background
// shell job, then waits for the turn to complete (the job keeps running).
(() => {
  window.__probeText =
    '셸 도구로 `ping -n 90 127.0.0.1` 을 백그라운드 작업으로 실행만 하고, 결과를 기다리지 말고 바로 "시작했어요" 한 줄로 답해줘.';
  return true;
})();
