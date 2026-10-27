const UID_SUFFIX_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function randomUpperLetters(count: 1 | 2): string {
  const bytes = crypto.getRandomValues(new Uint8Array(count));
  let output = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const mapped = bytes[index]! % UID_SUFFIX_ALPHABET.length;
    output += UID_SUFFIX_ALPHABET[mapped]!;
  }
  return output;
}

export function buildUidSuffixFromNickname(nickname: string): string {
  const letters = nickname.replace(/[^A-Za-z]/g, "").toUpperCase();

  if (letters.length >= 2) {
    return letters.slice(-2);
  }
  if (letters.length === 1) {
    return `${letters}${randomUpperLetters(1)}`;
  }
  return randomUpperLetters(2);
}
