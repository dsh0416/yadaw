import { describe, expect, it } from "vitest"
import {
  MAJOR_KEY_SIGNATURE_CHOICES,
  MINOR_KEY_SIGNATURE_CHOICES,
  keySignatureLabel,
  parseKeySignatureValue
} from "./keySignatures"

describe("key signatures", () => {
  it("orders major and minor keys by fifths with enharmonic spelling preserved", () => {
    expect(MAJOR_KEY_SIGNATURE_CHOICES).toHaveLength(15)
    expect(MAJOR_KEY_SIGNATURE_CHOICES[0]?.label).toBe("C♯ Major")
    expect(MAJOR_KEY_SIGNATURE_CHOICES.at(-1)?.label).toBe("C♭ Major")
    expect(MINOR_KEY_SIGNATURE_CHOICES).toHaveLength(15)
    expect(MINOR_KEY_SIGNATURE_CHOICES[0]?.label).toBe("A♯ minor")
    expect(MINOR_KEY_SIGNATURE_CHOICES.at(-1)?.label).toBe("A♭ minor")
  })

  it("round-trips choices and formats the exact theoretical key name", () => {
    expect(parseKeySignatureValue("major:-5")).toEqual({ fifths: -5, mode: "major" })
    expect(keySignatureLabel(-5, "major")).toBe("D♭ Major")
    expect(keySignatureLabel(7, "minor")).toBe("A♯ minor")
    expect(parseKeySignatureValue("major:8")).toBeNull()
  })
})
