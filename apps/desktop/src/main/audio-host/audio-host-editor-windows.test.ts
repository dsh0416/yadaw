import { beforeEach, describe, expect, it, vi } from "vitest"

const electron = vi.hoisted(() => {
  class FakeBaseWindow {
    static instances: FakeBaseWindow[] = []
    readonly listeners = new Map<string, (...args: never[]) => void>()
    readonly contentView = { addChildView: vi.fn(), removeChildView: vi.fn() }
    readonly show = vi.fn(() => {
      return undefined
    })
    readonly showInactive = vi.fn(() => {
      return undefined
    })
    readonly hide = vi.fn(() => {
      return undefined
    })
    readonly focus = vi.fn(() => {
      this.focused = true
    })
    readonly destroy = vi.fn(() => {
      this.destroyed = true
    })
    readonly setBounds = vi.fn(
      (bounds: { x: number; y: number; width: number; height: number }) => {
        this.bounds = bounds
      }
    )
    readonly setResizable = vi.fn()
    readonly setMinimumSize = vi.fn()
    readonly options: Record<string, unknown>
    private destroyed = false
    private focused = false
    private bounds = { x: 10, y: 20, width: 800, height: 660 }
    private contentSize: [number, number]

    constructor(options: Record<string, unknown> = {}) {
      this.options = options
      this.contentSize = [Number(options.width ?? 800), Number(options.height ?? 660)]
      FakeBaseWindow.instances.push(this)
    }

    on(name: string, listener: (...args: never[]) => void): void {
      this.listeners.set(name, listener)
    }

    emit(name: string, ...args: never[]): void {
      this.listeners.get(name)?.(...args)
    }

    isDestroyed(): boolean {
      return this.destroyed
    }

    isFocused(): boolean {
      return this.focused
    }

    getContentSize(): [number, number] {
      return this.contentSize
    }

    setContentSize(width: number, height: number): void {
      this.contentSize = [width, height]
    }

    getBounds(): { x: number; y: number; width: number; height: number } {
      return this.bounds
    }

    getContentBounds(): { x: number; y: number; width: number; height: number } {
      return { ...this.bounds, y: 49 }
    }

    getNativeWindowHandle(): Buffer {
      return Buffer.from([1])
    }
  }

  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = []
    readonly listeners = new Map<string, (...args: never[]) => void>()
    readonly setBounds = vi.fn()
    readonly webContents = {
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
      loadURL: vi.fn(async () => undefined),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((name: string, listener: (...args: never[]) => void) => {
        this.listeners.set(name, listener)
      })
    }

    constructor() {
      FakeWebContentsView.instances.push(this)
    }
  }

  return { FakeBaseWindow, FakeWebContentsView }
})

vi.mock("electron", () => ({
  BaseWindow: electron.FakeBaseWindow,
  WebContentsView: electron.FakeWebContentsView,
  screen: {
    getDisplayMatching: () => ({ scaleFactor: 1 })
  }
}))

import {
  ElectronPluginEditorWindows,
  mapParentBeforeNativeAttach,
  nativeExtent
} from "./audio-host-editor-windows"

describe("native plug-in editor dimensions", () => {
  beforeEach(() => {
    electron.FakeBaseWindow.instances.length = 0
    electron.FakeWebContentsView.instances.length = 0
  })

  it("keeps AppKit dimensions in logical points", () => {
    expect(nativeExtent(640, 480, 2, "darwin")).toEqual({ width: 640, height: 480 })
  })

  it("converts Electron logical pixels to Win32 and X11 pixels", () => {
    expect(nativeExtent(640, 480, 1.5, "win32")).toEqual({ width: 960, height: 720 })
    expect(nativeExtent(640, 480, 2, "linux")).toEqual({ width: 1280, height: 960 })
  })

  it("never registers an empty native child surface", () => {
    expect(nativeExtent(0, 0, 0, "linux")).toEqual({ width: 1, height: 1 })
  })

  it("maps the X11 parent before attaching a native plug-in view", () => {
    expect(mapParentBeforeNativeAttach("linux")).toBe(true)
    expect(mapParentBeforeNativeAttach("darwin")).toBe(false)
    expect(mapParentBeforeNativeAttach("win32")).toBe(false)
  })

  it("does not recursively reconcile a constrained snapshot while applying it", () => {
    const windows = new ElectronPluginEditorWindows({} as never)
    const accepted = {
      instanceId: "plugin-1",
      width: 640,
      height: 480,
      displayScale: 1.5,
      resizable: true,
      attached: true
    }
    const editorHostSnapshot = vi.fn(() => accepted)
    const resizeEditorHost = vi.fn()
    const entry = {
      window: {
        isDestroyed: () => false,
        setResizable: vi.fn(),
        getContentSize: () => [800, 660],
        setContentSize: vi.fn(),
        getContentBounds: () => ({ x: 10, y: 20, width: 800, height: 660 }),
        getBounds: () => ({ x: 10, y: 20, width: 800, height: 660 })
      },
      toolbarWindow: {
        isDestroyed: () => false,
        setBounds: vi.fn()
      },
      toolbar: { setBounds: vi.fn() },
      client: { resizeEditorHost, editorHostSnapshot },
      applyingPluginSize: false,
      toolbarState: { activeMode: "native" },
      minimumNativeWidth: 1,
      minimumNativeHeight: 1
    }
    type SnapshotHarness = {
      applySnapshot(target: unknown, snapshot: typeof accepted): void
    }
    const harness = windows as unknown as SnapshotHarness

    harness.applySnapshot(entry, accepted)

    expect(resizeEditorHost).toHaveBeenCalledOnce()
    expect(editorHostSnapshot).not.toHaveBeenCalled()
    expect(entry.applyingPluginSize).toBe(false)
  })

  it("does not steal focus from an open toolbar control during state refresh", async () => {
    const windows = new ElectronPluginEditorWindows({} as never)
    const state = {
      activeMode: "native",
      zoomPercent: 100,
      compareSlot: "a",
      canCompare: true,
      canPaste: false,
      canUndo: false,
      canRedo: false,
      sidechainBuses: [],
      sidechainSources: [],
      sidechainPending: false
    }
    const focusEditorHost = vi.fn()
    const entry = {
      window: {
        isDestroyed: () => false,
        getContentSize: () => [800, 660],
        getContentBounds: () => ({ x: 10, y: 20, width: 800, height: 660 })
      },
      toolbarWindow: {
        isDestroyed: () => false,
        setBounds: vi.fn()
      },
      toolbar: {
        setBounds: vi.fn(),
        webContents: {
          isDestroyed: () => false,
          loadURL: vi.fn()
        }
      },
      client: { focusEditorHost },
      closing: false,
      context: {
        channelName: "Audio 1",
        channelColor: "#58c6c2",
        pluginName: "Compressor",
        theme: "dark",
        locale: "en-US"
      },
      toolbarState: state,
      parameters: [],
      loadingParameters: false,
      toolbarKey: "",
      minimumNativeWidth: 1,
      minimumNativeHeight: 1
    }
    type ToolbarHarness = {
      applyToolbarState(instanceId: string, target: unknown, next: typeof state): Promise<void>
    }
    const harness = windows as unknown as ToolbarHarness

    await harness.applyToolbarState("plugin-1", entry, state)

    expect(focusEditorHost).not.toHaveBeenCalled()
  })

  it("applies the native snapshot immediately after leaving parameter mode", async () => {
    vi.useFakeTimers()
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux")
    const windows = new ElectronPluginEditorWindows({} as never)
    const state = {
      activeMode: "native",
      zoomPercent: 100,
      compareSlot: "a",
      canCompare: true,
      canPaste: false,
      canUndo: false,
      canRedo: false,
      sidechainBuses: [],
      sidechainSources: [],
      sidechainPending: false
    }
    const snapshot = {
      instanceId: "plugin-1",
      width: 640,
      height: 480,
      displayScale: 1,
      resizable: false,
      attached: true
    }
    const setContentSize = vi.fn()
    const resizeEditorHost = vi.fn()
    const focusEditorHost = vi.fn()
    const entry = {
      window: {
        isDestroyed: () => false,
        getContentSize: () => [720, 700],
        setContentSize,
        setMinimumSize: vi.fn(),
        setResizable: vi.fn(),
        getContentBounds: () => ({ x: 10, y: 49, width: 720, height: 700 }),
        getBounds: () => ({ x: 10, y: 20, width: 720, height: 700 })
      },
      toolbarWindow: {
        isDestroyed: () => false,
        setBounds: vi.fn()
      },
      toolbar: {
        setBounds: vi.fn(),
        webContents: {
          isDestroyed: () => false,
          loadURL: vi.fn()
        }
      },
      client: {
        editorHostSnapshot: vi.fn(() => snapshot),
        resizeEditorHost,
        focusEditorHost
      },
      closing: false,
      applyingPluginSize: false,
      context: {
        channelName: "Audio 1",
        channelColor: "#58c6c2",
        pluginName: "Compressor",
        theme: "dark",
        locale: "en-US"
      },
      toolbarState: { ...state, activeMode: "parameters" },
      parameters: [],
      loadingParameters: false,
      toolbarKey: "",
      minimumNativeWidth: 1,
      minimumNativeHeight: 1
    }
    type ToolbarHarness = {
      entries: Map<string, unknown>
      applyToolbarState(instanceId: string, target: unknown, next: typeof state): Promise<void>
    }
    const harness = windows as unknown as ToolbarHarness
    harness.entries.set("plugin-1", entry)

    try {
      await harness.applyToolbarState("plugin-1", entry, state)

      expect(setContentSize).toHaveBeenCalledWith(640, 540)
      expect(resizeEditorHost).toHaveBeenCalledOnce()
      expect(resizeEditorHost).toHaveBeenCalledWith(expect.objectContaining({ topInset: 89 }))
      expect(focusEditorHost).toHaveBeenCalledWith("plugin-1")

      await vi.runAllTimersAsync()
      expect(resizeEditorHost).toHaveBeenCalledTimes(3)
    } finally {
      platform.mockRestore()
      vi.useRealTimers()
    }
  })

  it("owns a native editor through actions, refreshes, and cleanup", async () => {
    vi.useFakeTimers()
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux")
    const parent = new electron.FakeBaseWindow()
    const windows = new ElectronPluginEditorWindows(parent as never)
    const nativeState = {
      activeMode: "native" as const,
      zoomPercent: 100,
      compareSlot: "a" as const,
      canCompare: true,
      canPaste: true,
      canUndo: true,
      canRedo: false,
      sidechainBuses: [{ inputPortKey: "aux-1", name: "Side <1>", sourceChannelId: "source-1" }],
      sidechainSources: [
        { id: "source-1", name: "Audio & One", kind: "audio" as const },
        { id: "source-2", name: "Instrument", kind: "instrument" as const }
      ],
      sidechainPending: false
    }
    const parameterState = { ...nativeState, activeMode: "parameters" as const }
    let toolbarState: typeof nativeState | typeof parameterState = nativeState
    const snapshot = {
      instanceId: "plugin-1",
      width: 640,
      height: 480,
      displayScale: 1.5,
      resizable: true,
      attached: true
    }
    const client = {
      drainEditorHostEvents: vi.fn(() => []),
      editorHostSnapshot: vi.fn(() => snapshot),
      editorToolbarState: vi.fn(() => toolbarState),
      focusEditorHost: vi.fn(),
      registerEditorHost: vi.fn(),
      resizeEditorHost: vi.fn(),
      unregisterEditorHost: vi.fn()
    }
    const openNative = vi.fn(async () => ({ editorMode: "native" as const, open: true }))
    const applyAction = vi.fn(async (action: { type: string }) => {
      toolbarState = action.type === "mode" ? parameterState : nativeState
      return toolbarState
    })
    const loadParameters = vi.fn(async () => [
      {
        runtimeToken: 7,
        title: "Gain <Main>",
        units: "dB",
        stepCount: 10,
        normalized: 0.5,
        formatted: "-6",
        readOnly: false
      }
    ])
    const setParameter = vi.fn(async () => undefined)
    const closeNative = vi.fn(async () => undefined)

    try {
      await expect(
        windows.open(
          client as never,
          "plugin-1",
          {
            channelName: "Audio & 1",
            channelColor: "invalid",
            pluginName: "Compressor",
            theme: "light",
            locale: "zh-cmn-Hans-CN"
          },
          openNative,
          applyAction as never,
          loadParameters as never,
          setParameter,
          closeNative
        )
      ).resolves.toEqual({ editorMode: "native", open: true })

      const editorWindow = electron.FakeBaseWindow.instances[1]!
      const toolbarWindow = electron.FakeBaseWindow.instances[2]!
      const toolbar = electron.FakeWebContentsView.instances[0]!
      expect(client.registerEditorHost).toHaveBeenCalledWith(
        expect.objectContaining({ instanceId: "plugin-1", width: 800, displayScale: 1 })
      )
      expect(toolbar.webContents.loadURL).toHaveBeenCalledWith(
        expect.stringContaining("data:text/html")
      )
      expect(toolbarWindow.showInactive).toHaveBeenCalled()

      const navigate = toolbar.listeners.get("will-navigate")!
      const preventDefault = vi.fn()
      navigate({ preventDefault } as never, "https://example.test" as never)
      expect(preventDefault).not.toHaveBeenCalled()
      navigate({ preventDefault } as never, "heron-editor-action:mode-parameters" as never)
      await vi.runAllTimersAsync()
      expect(applyAction).toHaveBeenCalledWith({ type: "mode", mode: "parameters" })
      expect(loadParameters).toHaveBeenCalled()

      navigate({ preventDefault } as never, "heron-editor-action:parameter-perform-7-1.5" as never)
      navigate({ preventDefault } as never, "heron-editor-action:parameter-end-7-0.25" as never)
      await vi.runAllTimersAsync()
      expect(setParameter).toHaveBeenCalledWith(7, 1, "perform")
      expect(setParameter).toHaveBeenCalledWith(7, 0.25, "end")

      toolbarState = nativeState
      client.drainEditorHostEvents.mockReturnValueOnce([
        { instanceId: "plugin-1", width: 700, height: 500, resizable: false }
      ] as never)
      windows.drain(client as never)
      editorWindow.emit("resize")
      editorWindow.emit("move")
      editorWindow.emit("focus")
      await vi.runAllTimersAsync()
      expect(client.resizeEditorHost).toHaveBeenCalled()

      await expect(
        windows.open(
          client as never,
          "plugin-1",
          {
            channelName: "",
            channelColor: "#58c6c2",
            pluginName: "Compressor",
            theme: "dark",
            locale: "en-US"
          },
          openNative,
          applyAction as never,
          loadParameters as never,
          setParameter,
          closeNative
        )
      ).resolves.toEqual({ editorMode: "native", open: true })
      expect(editorWindow.show).toHaveBeenCalled()

      await expect(windows.close("missing")).resolves.toBe(false)
      await expect(windows.close("plugin-1")).resolves.toBe(true)
      expect(closeNative).toHaveBeenCalledOnce()
      expect(client.unregisterEditorHost).toHaveBeenCalledWith("plugin-1")
      expect(toolbarWindow.destroy).toHaveBeenCalled()
      expect(editorWindow.destroy).toHaveBeenCalled()
      expect(windows.close("plugin-1")).resolves.toBe(false)
    } finally {
      platform.mockRestore()
      vi.useRealTimers()
    }
  })

  it("cleans up failed opens and externally closed hosts", async () => {
    const parent = new electron.FakeBaseWindow()
    const windows = new ElectronPluginEditorWindows(parent as never)
    const client = {
      drainEditorHostEvents: vi.fn(() => []),
      editorHostSnapshot: vi.fn(() => null),
      editorToolbarState: vi.fn(() => null),
      focusEditorHost: vi.fn(),
      registerEditorHost: vi.fn(),
      resizeEditorHost: vi.fn(),
      unregisterEditorHost: vi.fn()
    }
    const context = {
      channelName: "Audio 1",
      channelColor: "#58c6c2",
      pluginName: "Broken",
      theme: "dark" as const,
      locale: "en-US" as const
    }
    const noAction = vi.fn()

    await expect(
      windows.open(
        client as never,
        "broken",
        context,
        async () => {
          throw new Error("attach failed")
        },
        noAction,
        async () => [],
        async () => undefined,
        async () => undefined
      )
    ).rejects.toThrow("attach failed")
    expect(client.unregisterEditorHost).toHaveBeenCalledWith("broken")

    await windows.open(
      client as never,
      "host-closed",
      context,
      async () => ({ editorMode: "parameters", open: true }),
      noAction,
      async () => [],
      async () => undefined,
      async () => undefined
    )
    windows.hostClosed("missing")
    windows.hostClosed("host-closed")
    expect(client.unregisterEditorHost).toHaveBeenCalledWith("host-closed")
    await expect(windows.closeAll()).resolves.toBeUndefined()
  })
})
