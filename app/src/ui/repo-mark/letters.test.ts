import { describe, expect, test } from "bun:test";
import { letterScale, lettersFor, TWO_LETTERS_FROM } from "./letters";

describe("the letters a mark carries", () => {
  test("two letters where they read, one where they would not", () => {
    expect(lettersFor("ledger", TWO_LETTERS_FROM)).toBe("le");
    expect(lettersFor("ledger", 36)).toBe("le");
    expect(lettersFor("ledger", TWO_LETTERS_FROM - 1)).toBe("l");
    expect(lettersFor("ledger", 20)).toBe("l");
  });

  test("a dotted or dashed name is spelled by its letters, as the swatch spells it", () => {
    expect(lettersFor(".github", 30)).toBe("gi");
    expect(lettersFor("--", 30)).toBe("--");
    expect(lettersFor("--", 20)).toBe("-");
  });

  test("a name of one letter is one letter at any size", () => {
    expect(lettersFor("x", 40)).toBe("x");
  });

  test("an unnamed repo draws nothing rather than a placeholder", () => {
    expect(lettersFor("", 30)).toBe("");
  });

  test("one letter is set larger than each of two, and both stay inside the squircle's flat middle", () => {
    expect(letterScale(1)).toBeGreaterThan(letterScale(2));
    expect(letterScale(1)).toBeLessThan(0.6);
    // two letters at the smallest size that carries them are still 11 px or more
    expect(TWO_LETTERS_FROM * letterScale(2)).toBeGreaterThanOrEqual(11);
    expect(20 * letterScale(1)).toBeGreaterThanOrEqual(10);
  });
});
