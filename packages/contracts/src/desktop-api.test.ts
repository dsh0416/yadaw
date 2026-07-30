import { describe, expect, it } from "vitest"

import { APPLICATION_COMMAND_IDS, APPLICATION_WINDOW_COMMAND_IDS } from "./application"
import { AUDIO_BACKENDS, AUDIO_BUFFER_SIZES, DEFAULT_AUDIO_PREFERENCES } from "./audio"
import { IPC_CHANNELS } from "./desktop-api"
import { MIXER_BUS_COUNT } from "./mixer"
import {
  MIDI_CLOCKS_PER_QUARTER,
  MUSICAL_TICKS_PER_MIDI_CLOCK,
  MUSICAL_TICKS_PER_QUARTER,
  MUSICAL_TICKS_PER_SONG_POSITION,
  MUSICAL_TICKS_PER_WHOLE_NOTE
} from "./midi"
import { PROJECT_SAMPLE_RATES } from "./project"

describe("IPC_CHANNELS", () => {
  const entries = Object.entries(IPC_CHANNELS)

  it("maps every key to a distinct channel string", () => {
    const channels = entries.map(([, channel]) => channel)

    expect(new Set(channels).size).toBe(channels.length)
  })

  it("namespaces every channel as `namespace:action`", () => {
    for (const [key, channel] of entries) {
      expect(channel, `channel for ${key}`).toMatch(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/)
    }
  })

  it("keeps renderer-facing keys in camelCase so the preload surface stays typo-proof", () => {
    for (const [key] of entries) {
      expect(key).toMatch(/^[a-z][A-Za-z0-9]*$/)
    }
  })
})

describe("application command ids", () => {
  it("lists each command once", () => {
    expect(new Set(APPLICATION_COMMAND_IDS).size).toBe(APPLICATION_COMMAND_IDS.length)
    expect(new Set(APPLICATION_WINDOW_COMMAND_IDS).size).toBe(APPLICATION_WINDOW_COMMAND_IDS.length)
  })

  it("names every command `group.action`", () => {
    for (const id of [...APPLICATION_COMMAND_IDS, ...APPLICATION_WINDOW_COMMAND_IDS]) {
      expect(id).toMatch(/^[a-z]+\.[a-z][a-z-]*$/)
    }
  })

  it("only exposes window commands the menu can also dispatch, apart from window chrome", () => {
    const menuOnlyToWindow = APPLICATION_WINDOW_COMMAND_IDS.filter(
      (id) => !APPLICATION_COMMAND_IDS.includes(id as (typeof APPLICATION_COMMAND_IDS)[number])
    )

    expect(menuOnlyToWindow).toEqual(["window.minimize", "window.toggle-maximize"])
  })
})

describe("audio constants", () => {
  it("offers only power-of-two buffer sizes in ascending order", () => {
    for (const size of AUDIO_BUFFER_SIZES) {
      expect(Number.isInteger(Math.log2(size))).toBe(true)
    }

    expect([...AUDIO_BUFFER_SIZES]).toEqual([...AUDIO_BUFFER_SIZES].sort((a, b) => a - b))
  })

  it("defaults to a backend and buffer size the UI can actually offer", () => {
    expect(AUDIO_BACKENDS).toContain(DEFAULT_AUDIO_PREFERENCES.backend)
    expect(AUDIO_BUFFER_SIZES).toContain(
      DEFAULT_AUDIO_PREFERENCES.bufferSize as (typeof AUDIO_BUFFER_SIZES)[number]
    )
  })

  it("starts with no device selected so the first launch adopts the system default", () => {
    expect(DEFAULT_AUDIO_PREFERENCES.inputDeviceId).toBe("")
    expect(DEFAULT_AUDIO_PREFERENCES.outputDeviceId).toBe("")
  })
})

describe("mixer bus count", () => {
  it("stays a power of two so bus masks can be packed", () => {
    expect(Number.isInteger(Math.log2(MIXER_BUS_COUNT))).toBe(true)
  })
})

describe("project sample rates", () => {
  it("lists the supported rates once each, ascending", () => {
    expect(new Set(PROJECT_SAMPLE_RATES).size).toBe(PROJECT_SAMPLE_RATES.length)
    expect([...PROJECT_SAMPLE_RATES]).toEqual([...PROJECT_SAMPLE_RATES].sort((a, b) => a - b))
  })

  it("covers both the 44.1 kHz and 48 kHz families", () => {
    expect(PROJECT_SAMPLE_RATES).toContain(44_100)
    expect(PROJECT_SAMPLE_RATES).toContain(48_000)
  })
})

describe("musical tick constants", () => {
  it("keeps every derived resolution a whole number of ticks", () => {
    expect(MUSICAL_TICKS_PER_WHOLE_NOTE).toBe(MUSICAL_TICKS_PER_QUARTER * 4)
    expect(Number.isInteger(MUSICAL_TICKS_PER_MIDI_CLOCK)).toBe(true)
    expect(Number.isInteger(MUSICAL_TICKS_PER_SONG_POSITION)).toBe(true)
  })

  it("aligns MIDI clock ticks with the quarter-note grid", () => {
    expect(MUSICAL_TICKS_PER_MIDI_CLOCK * MIDI_CLOCKS_PER_QUARTER).toBe(MUSICAL_TICKS_PER_QUARTER)
  })

  it("advances a song-position pointer by a sixteenth note", () => {
    expect(MUSICAL_TICKS_PER_SONG_POSITION).toBe(MUSICAL_TICKS_PER_QUARTER / 4)
  })

  it("divides evenly into common note values", () => {
    for (const division of [2, 3, 4, 6, 8, 12, 16]) {
      expect(MUSICAL_TICKS_PER_QUARTER % division).toBe(0)
    }
  })
})
