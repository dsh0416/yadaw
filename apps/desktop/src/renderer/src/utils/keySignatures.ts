import type { KeySignatureMode } from "@yadaw/contracts"

export interface KeySignatureChoice {
  fifths: number
  mode: KeySignatureMode
  label: string
  value: string
}

function choice(fifths: number, mode: KeySignatureMode, label: string): KeySignatureChoice {
  return { fifths, mode, label, value: `${mode}:${fifths}` }
}

export const MAJOR_KEY_SIGNATURE_CHOICES = [
  choice(7, "major", "C♯ Major"),
  choice(6, "major", "F♯ Major"),
  choice(5, "major", "B Major"),
  choice(4, "major", "E Major"),
  choice(3, "major", "A Major"),
  choice(2, "major", "D Major"),
  choice(1, "major", "G Major"),
  choice(0, "major", "C Major"),
  choice(-1, "major", "F Major"),
  choice(-2, "major", "B♭ Major"),
  choice(-3, "major", "E♭ Major"),
  choice(-4, "major", "A♭ Major"),
  choice(-5, "major", "D♭ Major"),
  choice(-6, "major", "G♭ Major"),
  choice(-7, "major", "C♭ Major")
] as const

export const MINOR_KEY_SIGNATURE_CHOICES = [
  choice(7, "minor", "A♯ minor"),
  choice(6, "minor", "D♯ minor"),
  choice(5, "minor", "G♯ minor"),
  choice(4, "minor", "C♯ minor"),
  choice(3, "minor", "F♯ minor"),
  choice(2, "minor", "B minor"),
  choice(1, "minor", "E minor"),
  choice(0, "minor", "A minor"),
  choice(-1, "minor", "D minor"),
  choice(-2, "minor", "G minor"),
  choice(-3, "minor", "C minor"),
  choice(-4, "minor", "F minor"),
  choice(-5, "minor", "B♭ minor"),
  choice(-6, "minor", "E♭ minor"),
  choice(-7, "minor", "A♭ minor")
] as const

const KEY_SIGNATURE_CHOICES: readonly KeySignatureChoice[] = [
  ...MAJOR_KEY_SIGNATURE_CHOICES,
  ...MINOR_KEY_SIGNATURE_CHOICES
]

export function keySignatureValue(fifths: number, mode: KeySignatureMode): string {
  return `${mode}:${fifths}`
}

export function parseKeySignatureValue(
  value: string
): Pick<KeySignatureChoice, "fifths" | "mode"> | null {
  const match = KEY_SIGNATURE_CHOICES.find((choice) => choice.value === value)
  return match ? { fifths: match.fifths, mode: match.mode } : null
}

export function keySignatureLabel(fifths: number, mode: KeySignatureMode): string {
  return (
    KEY_SIGNATURE_CHOICES.find((choice) => choice.fifths === fifths && choice.mode === mode)
      ?.label ?? (mode === "minor" ? "A minor" : "C Major")
  )
}
