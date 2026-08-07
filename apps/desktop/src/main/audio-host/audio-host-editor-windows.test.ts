import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  BaseWindow: class {},
  WebContentsView: class {},
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
      vi.useRealTimers()
    }
  })
})
