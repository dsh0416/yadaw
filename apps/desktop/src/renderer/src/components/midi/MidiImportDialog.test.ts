import { createPinia, setActivePinia } from "pinia"
import { flushPromises, mount } from "@vue/test-utils"
import { nextTick } from "vue"
import { describe, expect, it } from "vitest"
import type { MidiImportPreview } from "@heron/contracts"
import { useMidiImportStore } from "../../stores/midiImport"
import MidiImportDialog from "./MidiImportDialog.vue"

const preview: MidiImportPreview = {
  token: "preview",
  path: "tempo-song.mid",
  format: 1,
  sourceTiming: "PPQ 480",
  tracks: [],
  tempoMap: {
    ticksPerQuarter: 960,
    tempoEvents: [{ tick: 0, beatsPerMinute: 128 }],
    timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
  },
  warnings: []
}

describe("MidiImportDialog", () => {
  it("asks explicitly whether to keep the project Tempo Track or import MIDI tempo", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const store = useMidiImportStore()
    store.preview = preview

    mount(MidiImportDialog, {
      attachTo: document.body,
      global: { plugins: [pinia] }
    })
    await flushPromises()

    const dialog = document.body.querySelector<HTMLElement>("[role=dialog]")
    expect(dialog?.querySelector(".ui-dialog__eyebrow")?.textContent?.trim()).toBe("MIDI import")
    expect(dialog?.querySelector(".ui-dialog__title")?.textContent).toBe("Import MIDI")
    expect(dialog?.querySelector(".ui-dialog__description")?.textContent).toContain(
      "tempo-song.mid · PPQ 480 · Format 1"
    )
    expect(dialog?.querySelector(".ui-dialog__title")?.textContent).not.toContain("tempo-song.mid")
    expect(document.body.textContent).toContain("Keep the project Tempo Track")
    expect(document.body.textContent).toContain("Import MIDI tempo into project")
    const radios = document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')
    expect(radios).toHaveLength(2)
    expect(radios[0]?.checked).toBe(true)

    const midiTempo = radios[1]!
    midiTempo.checked = true
    midiTempo.dispatchEvent(new Event("change", { bubbles: true }))
    await nextTick()
    expect(store.tempoMode).toBe("midi")
  })
})
