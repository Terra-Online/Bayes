const delimiters = ["***", "___", "**", "__", "~~", "||", "`", "*"];

const isEscaped = (source: string, index: number): boolean => {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
};

const findClosingDelimiter = (source: string, token: string, start: number): number => {
  for (let cursor = start; cursor <= source.length - token.length; cursor += 1) {
    if (!source.startsWith(token, cursor) || isEscaped(source, cursor)) continue;
    if (token === "**" && source.startsWith("***", cursor)) {
      let singleStarCount = 0;
      for (let index = start; index < cursor; index += 1) {
        if (source[index] === "*" && !isEscaped(source, index)
          && source[index - 1] !== "*" && source[index + 1] !== "*") singleStarCount += 1;
      }
      return singleStarCount % 2 === 1 ? cursor + 1 : cursor;
    }
    if (token.startsWith("*")
      && (source[cursor - 1] === "*" || source[cursor + token.length] === "*")) continue;
    return cursor;
  }
  return -1;
};

const isSafeLink = (href: string): boolean => {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(href, "https://oem.re").protocol);
  } catch {
    return false;
  }
};

// Match Atlos's comment source parser: only rendered sns_001..038 emojis cost
// two UTF-16 units. Escapes, code, link destinations and Markdown markers retain
// their source length, including the parser's nesting limit.
const countSource = (source: string, depth: number): number => {
  if (depth > 16) return source.length;
  let length = 0;
  for (let cursor = 0; cursor < source.length;) {
    const character = source[cursor];
    if (character === "\\" && cursor + 1 < source.length) {
      length += 2;
      cursor += 2;
      continue;
    }
    if (character === ":") {
      const emoji = /^:sns_(\d{3}):/.exec(source.slice(cursor));
      if (emoji && Number(emoji[1]) >= 1 && Number(emoji[1]) <= 38) {
        length += 2;
        cursor += emoji[0].length;
        continue;
      }
    }
    if (character === "[") {
      const labelEnd = source.indexOf("](", cursor + 1);
      const urlEnd = labelEnd < 0 ? -1 : source.indexOf(")", labelEnd + 2);
      if (labelEnd > cursor + 1 && urlEnd > labelEnd + 2) {
        const rawHref = source.slice(labelEnd + 2, urlEnd);
        if (rawHref.trim() && isSafeLink(rawHref.trim())) {
          length += 1 + countSource(source.slice(cursor + 1, labelEnd), depth + 1)
            + 3 + rawHref.length;
          cursor = urlEnd + 1;
          continue;
        }
      }
    }
    let matchedFormat = false;
    for (const token of delimiters) {
      if (!source.startsWith(token, cursor) || isEscaped(source, cursor)) continue;
      if (token.startsWith("*") && (source[cursor - 1] === "*"
        || source[cursor + token.length] === "*")) continue;
      const closing = findClosingDelimiter(source, token, cursor + token.length);
      if (closing <= cursor + token.length) continue;
      const inner = source.slice(cursor + token.length, closing);
      length += token.length * 2 + (token === "`" ? inner.length : countSource(inner, depth + 1));
      cursor = closing + token.length;
      matchedFormat = true;
      break;
    }
    if (matchedFormat) continue;
    length += 1;
    cursor += 1;
  }
  return length;
};

export const getCommentLength = (content: string): number => countSource(content, 0);
