import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import MidiRecordingPreview from "./MidiRecordingPreview.vue"

describe("MidiRecordingPreview", () => {
  it("draws released and active notes inside a growing recording region", () => {
    const wrapper = mount(MidiRecordingPreview, {
      props: {
        take: {
          clipId: "clip-live",
          trackId: "track-instrument",
          notes: [
            {
              id: 0,
              startTick: 1_200,
              endTick: 1_680,
              channel: 0,
              key: 60,
              velocity: 96,
              active: false
            },
            {
              id: 1,
              startTick: 1_920,
              endTick: 2_400,
              channel: 0,
              key: 67,
              velocity: 127,
              active: true
            }
          ]
        },
        startTick: 960,
        positionTick: 2_880,
        tempoMap: {
          ticksPerQuarter: 960,
          tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
          timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
        },
        pixelsPerQuarter: 120,
        trackColor: "#73D6A2"
      }
    })

    expect(wrapper.get<HTMLElement>(".midi-recording-preview").element.style.left).toBe("120px")
    expect(wrapper.get<HTMLElement>(".midi-recording-preview").element.style.width).toBe("240px")
    const notes = wrapper.findAll<HTMLElement>(".preview-note")
    expect(notes).toHaveLength(2)
    expect(notes[0]?.element.style.left).toBe("30px")
    expect(notes[0]?.element.style.width).toBe("60px")
    expect(notes[1]?.classes()).toContain("active")
  })
})
