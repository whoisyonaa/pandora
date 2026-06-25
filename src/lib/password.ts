export type PasswordOptions = {
  length: number;
  uppercase: boolean;
  lowercase: boolean;
  numbers: boolean;
  symbols: boolean;
  readable: boolean;
};

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const NUMBERS = "23456789";
const SYMBOLS = "!@#$%^&*_-+=?";
const WORDS = ["signal", "matrix", "cipher", "orbit", "vector", "delta", "vault", "pixel", "lunar", "ghost"];

function randomInt(max: number) {
  const value = crypto.getRandomValues(new Uint32Array(1))[0];
  return value % max;
}

export function generatePassword(options: PasswordOptions) {
  if (options.readable) {
    const parts = Array.from({ length: 4 }, () => WORDS[randomInt(WORDS.length)]);
    return `${parts.join("-")}-${randomInt(90) + 10}`;
  }

  let alphabet = "";
  if (options.lowercase) alphabet += LOWER;
  if (options.uppercase) alphabet += UPPER;
  if (options.numbers) alphabet += NUMBERS;
  if (options.symbols) alphabet += SYMBOLS;
  if (!alphabet) alphabet = LOWER + NUMBERS;

  return Array.from({ length: Math.max(8, options.length) }, () => alphabet[randomInt(alphabet.length)]).join("");
}
