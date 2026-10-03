/** 解析 Range 头 → {offset, length}，无效返回 null */
export function parseRange(header: string | null, size: number): { offset: number; length: number } | null {
  if (!header || !Number.isSafeInteger(size) || size < 0) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let offset: number, length: number;
  if (m[1] === "") {
    // 后缀范围: bytes=-N
    const n = Math.min(Number(m[2]), size);
    offset = size - n;
    length = n;
  } else {
    offset = Number(m[1]);
    const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    length = end - offset + 1;
  }
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || offset >= size || length <= 0) return null;
  return { offset, length };
}

