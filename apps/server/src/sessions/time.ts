export function formatBeijingTime(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(/\//g, "-");
}

export function buildCurrentTimeInstruction(now: Date): string {
  return `\u524d\u7f6e\u4fe1\u606f\uff1a\u6b64\u6d88\u606f\u662f\u7528\u6237\u5728\u3010\u5317\u4eac\u65f6\u95f4 ${formatBeijingTime(now)}\u3011\u548c\u4f60\u5bf9\u8bdd\u7684\uff1a`;
}
