import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({
  BaseWindow: class {},
  WebContentsView: class {},
  screen: {
    getDisplayMatching: () => ({ scaleFactor: 1 })
  }
}))

import { ElectronPluginEditorWindows, nativeExtent } from "./audio-host-editor-windows"

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
})
