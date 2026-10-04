export const WECHAT_TEXT_MAX_CHARS = 1_800;
export const WECHAT_TEXT_MAX_UTF8_BYTES = 3_500;

function findHardCut(text: string): number {
  let chars = 0;
  let bytes = 0;
  let utf16Offset = 0;

  for (const symbol of text) {
    const nextBytes = bytes + Buffer.byteLength(symbol, "utf8");
    if (
      chars >= WECHAT_TEXT_MAX_CHARS ||
      nextBytes > WECHAT_TEXT_MAX_UTF8_BYTES
    ) {
      break;
    }

    chars += 1;
    bytes = nextBytes;
    utf16Offset += symbol.length;
  }

  return utf16Offset;
}

function findPreferredCut(text: string, hardCut: number): number {
  const prefix = text.slice(0, hardCut);
  const minimumCut = Math.floor(hardCut * 0.45);
  const patterns = [
    /\n\n/g,
    /\n/g,
    /[。！？!?；;][”’"')】\]]?(?=\s|$)/g,
    /\s+/g,
  ];

  for (const pattern of patterns) {
    let bestCut = 0;
    for (const match of prefix.matchAll(pattern)) {
      const candidate = (match.index ?? 0) + match[0].length;
      if (candidate >= minimumCut) {
        bestCut = candidate;
      }
    }
    if (bestCut > 0) {
      return bestCut;
    }
  }

  return hardCut;
}

export function splitWechatText(text: string): string[] {
  let remaining = text.trim();
  const chunks: string[] = [];

  while (remaining) {
    const hardCut = findHardCut(remaining);
    if (hardCut >= remaining.length) {
      chunks.push(remaining);
      break;
    }

    if (hardCut <= 0) {
      throw new Error("Unable to split WeChat text within configured limits");
    }

    const cut = findPreferredCut(remaining, hardCut);
    const chunk = remaining.slice(0, cut).trimEnd();
    if (chunk) {
      chunks.push(chunk);
    }
    remaining = remaining.slice(cut).trimStart();
  }

  return chunks;
}
