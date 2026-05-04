export function renderLoginPage(params: {
  loginId: string;
  role: string;
  status: string;
}): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>微信扫码登录</title>
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        margin: 0;
        padding: 32px 20px;
        background: #f5f7fb;
        color: #1f2937;
      }
      .wrap {
        max-width: 480px;
        margin: 0 auto;
        background: #ffffff;
        border-radius: 12px;
        padding: 24px;
        box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 22px;
      }
      p {
        line-height: 1.6;
        margin: 8px 0;
      }
      img {
        display: block;
        width: 320px;
        max-width: 100%;
        margin: 20px auto;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        background: #fff;
      }
      code {
        font-size: 13px;
        background: #f3f4f6;
        padding: 2px 6px;
        border-radius: 6px;
      }
      .status {
        font-weight: 600;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>微信扫码登录</h1>
      <p>登录任务：<code>${params.loginId}</code></p>
      <p>角色：<span id="role">${params.role}</span></p>
      <p>状态：<span class="status" id="status">${params.status}</span></p>
      <img id="qrcode" src="/api/logins/${encodeURIComponent(params.loginId)}/qrcode.png?ts=${Date.now()}" alt="微信登录二维码" />
      <p id="hint">如果二维码过期，这个页面会自动刷新。</p>
    </div>
    <script>
      const loginId = ${JSON.stringify(params.loginId)};
      const statusEl = document.getElementById("status");
      const hintEl = document.getElementById("hint");
      const imageEl = document.getElementById("qrcode");

      async function refreshStatus() {
        try {
          const response = await fetch("/api/logins/" + encodeURIComponent(loginId), { cache: "no-store" });
          const payload = await response.json();
          const login = payload.login || {};
          statusEl.textContent = login.status || "unknown";
          if (login.error) {
            hintEl.textContent = login.error;
          }
          if (login.status === "waiting" || login.status === "scanned") {
            imageEl.src = "/api/logins/" + encodeURIComponent(loginId) + "/qrcode.png?ts=" + Date.now();
          }
          if (login.status === "confirmed") {
            hintEl.textContent = "登录成功，可以回到终端继续下一步。";
          }
        } catch (error) {
          hintEl.textContent = "状态刷新失败，请稍后手动刷新页面。";
        }
      }

      setInterval(refreshStatus, 3000);
      refreshStatus();
    </script>
  </body>
</html>`;
}
