import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createPinia, type Pinia } from "pinia"
import { UiCascadingSelect } from "@heron/ui"
import { useApplicationCaptureStore } from "../../stores/applicationCapture"
import MixerInputCapsule from "./MixerInputCapsule.vue"

let pinia: Pinia

beforeEach(() => {
  pinia = createPinia()
})

afterEach(() => {
  document.body.innerHTML = ""
})

describe("MixerInputCapsule", () => {
  it("pairs an even mono input with its preceding neighbor when stereo is enabled", async () => {
    const wrapper = mount(MixerInputCapsule, {
      attachTo: document.body,
      props: {
        channelName: "Audio 1",
        inputSource: "hardware",
        inputFormat: "mono",
        inputChannels: [2]
      },
      global: { plugins: [pinia] }
    })

    const select = wrapper.get('button[aria-label="Audio 1 input channel"]')
    expect(select.text()).toBe("IN 2")
    const routeMenu = wrapper.getComponent(UiCascadingSelect)
    expect(routeMenu.props("hoverTreatment")).toBe("host-tint")
    expect(routeMenu.props("groups")?.map((group) => group.options.length)).toEqual([32, 256, 0])

    const stereoButton = wrapper.get(
      'button[aria-label="Link adjacent input as stereo for Audio 1"]'
    )
    expect(stereoButton.attributes("aria-pressed")).toBe("false")
    expect(stereoButton.get('[role="img"]').attributes("aria-label")).toBe("1 channel audio")
    expect(stereoButton.findAll("path")).toHaveLength(1)
    await stereoButton.trigger("click")

    expect(wrapper.emitted("update")).toEqual([
      [{ inputSource: "hardware", inputFormat: "stereo", inputChannels: [1, 2] }]
    ])
  })

  it("offers canonical stereo pairs and emits both routed channels", async () => {
    const wrapper = mount(MixerInputCapsule, {
      attachTo: document.body,
      props: {
        channelName: "Audio 2",
        inputSource: "hardware",
        inputFormat: "stereo",
        inputChannels: [3, 4]
      },
      global: { plugins: [pinia] }
    })

    const select = wrapper.get('button[aria-label="Audio 2 input channel"]')
    expect(select.text()).toBe("IN 3–4")
    const formatButton = wrapper.get('button[aria-label="Use mono input for Audio 2"]')
    expect(formatButton.get('[role="img"]').attributes("aria-label")).toBe("2 channels audio")
    expect(formatButton.findAll("path")).toHaveLength(2)
    const routeMenu = wrapper.getComponent(UiCascadingSelect)
    expect(routeMenu.props("hoverTreatment")).toBe("host-tint")
    expect(routeMenu.props("groups")?.map((group) => group.options.length)).toEqual([16, 128, 0])
    routeMenu.vm.$emit("update:modelValue", "hardware:5")
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted("update")).toEqual([
      [{ inputSource: "hardware", inputFormat: "stereo", inputChannels: [5, 6] }]
    ])
  })

  it("switches an audio channel from hardware input to a fixed BUS slot", async () => {
    const wrapper = mount(MixerInputCapsule, {
      props: {
        channelName: "Audio 3",
        inputSource: "hardware",
        inputFormat: "mono",
        inputChannels: [1]
      },
      global: { plugins: [pinia] }
    })

    wrapper.getComponent(UiCascadingSelect).vm.$emit("update:modelValue", "bus:256")
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted("update")).toEqual([
      [{ inputSource: "bus", inputFormat: "mono", inputChannels: [256] }]
    ])
  })

  it("selects an application target from the parallel application group", async () => {
    const applicationStore = useApplicationCaptureStore(pinia)
    applicationStore.targets = [
      {
        runtimeId: "windows-process-42",
        processId: 42,
        displayName: "Player",
        executablePath: "C:\\Program Files\\Player\\player.exe",
        logicalTarget: {
          platform: "windows",
          executablePath: "C:\\Program Files\\Player\\player.exe",
          executableName: "player.exe",
          includeProcessTree: true
        },
        channelCount: 2,
        status: "inactive"
      }
    ]
    const wrapper = mount(MixerInputCapsule, {
      props: {
        channelName: "Audio 4",
        inputSource: "hardware",
        inputFormat: "stereo",
        inputChannels: [1, 2]
      },
      global: { plugins: [pinia] }
    })

    wrapper
      .getComponent(UiCascadingSelect)
      .vm.$emit("update:modelValue", "application:windows-process-42")
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted("update")).toEqual([
      [
        {
          inputSource: "application",
          inputFormat: "stereo",
          inputChannels: [1, 2],
          applicationCapture: {
            platform: "windows",
            executablePath: "C:\\Program Files\\Player\\player.exe",
            executableName: "player.exe",
            includeProcessTree: true
          }
        }
      ]
    ])
  })

  it("selects a macOS multi-process application by runtime id and persists its bundle id", async () => {
    const applicationStore = useApplicationCaptureStore(pinia)
    applicationStore.targets = [
      {
        runtimeId: "macos-process-314",
        processId: 314,
        displayName: "Browser",
        executablePath: "/Applications/Browser.app/Contents/MacOS/Browser",
        logicalTarget: {
          platform: "macos",
          bundleIdentifier: "com.example.browser",
          executablePath: "/Applications/Browser.app/Contents/MacOS/Browser",
          executableName: "Browser",
          includeProcessTree: true
        },
        channelCount: 2,
        status: "inactive"
      }
    ]
    const wrapper = mount(MixerInputCapsule, {
      props: {
        channelName: "Audio 6",
        inputSource: "hardware",
        inputFormat: "stereo",
        inputChannels: [1, 2]
      },
      global: { plugins: [pinia] }
    })

    wrapper
      .getComponent(UiCascadingSelect)
      .vm.$emit("update:modelValue", "application:macos-process-314")
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted("update")?.[0]?.[0]).toMatchObject({
      inputSource: "application",
      applicationCapture: {
        platform: "macos",
        bundleIdentifier: "com.example.browser",
        includeProcessTree: true
      }
    })
  })

  it("keeps a missing macOS target selected and shows the permission recovery message", async () => {
    const applicationStore = useApplicationCaptureStore(pinia)
    const logicalTarget = {
      platform: "macos" as const,
      bundleIdentifier: "com.example.player",
      executablePath: "/Applications/Player.app/Contents/MacOS/Player",
      executableName: "Player",
      includeProcessTree: true
    }
    applicationStore.snapshots = [
      {
        runtimeId: "macos-process-90",
        processId: 90,
        displayName: "Player",
        executablePath: logicalTarget.executablePath,
        logicalTarget,
        channelCount: 2,
        status: "permission-denied",
        dropoutFrames: 0,
        overflowFrames: 0,
        underflowFrames: 0
      }
    ]
    const wrapper = mount(MixerInputCapsule, {
      props: {
        channelName: "Audio 7",
        inputSource: "application",
        inputFormat: "stereo",
        inputChannels: [1, 2],
        applicationCapture: logicalTarget
      },
      global: { plugins: [pinia] }
    })

    expect(wrapper.get('[role="status"]').text()).toContain("System Audio Recording")
    const applicationOptions = wrapper
      .getComponent(UiCascadingSelect)
      .props("groups")
      ?.find((group) => group.label === "Applications")?.options
    expect(applicationOptions).toEqual([
      { value: "application:missing", label: "Player (target missing)" }
    ])
  })

  it.each([
    ["target-exited", "has exited"],
    ["target-missing", "is unavailable"],
    ["ambiguous-target", "more than one application"],
    ["no-stream", "not currently producing audio"],
    ["unsupported", "not supported"],
    ["error", "encountered an error"]
  ] as const)("shows the %s application capture recovery state", (status, message) => {
    const applicationStore = useApplicationCaptureStore(pinia)
    const logicalTarget = {
      platform: "windows" as const,
      executablePath: "C:\\Player\\player.exe",
      executableName: "player.exe",
      includeProcessTree: true
    }
    applicationStore.snapshots = [
      {
        runtimeId: "windows-process-42",
        processId: 42,
        displayName: "Player",
        executablePath: logicalTarget.executablePath,
        logicalTarget,
        channelCount: 2,
        status,
        dropoutFrames: 0,
        overflowFrames: 0,
        underflowFrames: 0
      }
    ]

    const wrapper = mount(MixerInputCapsule, {
      props: {
        channelName: "Audio 8",
        inputSource: "application",
        inputFormat: "stereo",
        inputChannels: [1, 2],
        applicationCapture: logicalTarget
      },
      global: { plugins: [pinia] }
    })

    expect(wrapper.get('[role="status"]').text().toLocaleLowerCase()).toContain(message)
  })

  it("does not emit when a stale application menu option is selected", async () => {
    const wrapper = mount(MixerInputCapsule, {
      props: {
        channelName: "Audio 9",
        inputSource: "hardware",
        inputFormat: "mono",
        inputChannels: [1]
      },
      global: { plugins: [pinia] }
    })

    wrapper.getComponent(UiCascadingSelect).vm.$emit("update:modelValue", "application:missing")
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted("update")).toBeUndefined()
  })

  it("clears an application target when switching back to a hardware microphone", async () => {
    const applicationCapture = {
      platform: "windows" as const,
      executablePath: "C:\\Program Files\\Player\\player.exe",
      executableName: "player.exe",
      includeProcessTree: true
    }
    const wrapper = mount(MixerInputCapsule, {
      props: {
        channelName: "Audio 5",
        inputSource: "application",
        inputFormat: "stereo",
        inputChannels: [1, 2],
        applicationCapture
      },
      global: { plugins: [pinia] }
    })

    wrapper.getComponent(UiCascadingSelect).vm.$emit("update:modelValue", "hardware:3")
    await wrapper.vm.$nextTick()

    expect(wrapper.emitted("update")).toEqual([
      [
        {
          inputSource: "hardware",
          inputFormat: "stereo",
          inputChannels: [3, 4],
          applicationCapture: null
        }
      ]
    ])
  })
})
