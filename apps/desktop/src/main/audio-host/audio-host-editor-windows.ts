import { BaseWindow, screen, WebContentsView } from "electron"
import type {
  AudioHostRuntime,
  NativeEditorHostSnapshot,
  NativeEditorToolbarState
} from "@heron/dsp-node"
import type { PluginEditorMode, PluginParameterInfo } from "@heron/contracts"

const TOOLBAR_HEIGHT = 60
const NARROW_TOOLBAR_HEIGHT = 96
const NARROW_BREAKPOINT = 520
const ACTION_SCHEME = "heron-editor-action:"

export type PluginEditorToolbarAction =
  | { type: "mode"; mode: PluginEditorMode }
  | { type: "compare"; slot: "a" | "b" }
  | { type: "copy" }
  | { type: "paste" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "zoom"; zoom_percent: number }
  | { type: "sidechain-route"; input_bus_index: number; source_channel_id: string | null }

type ParameterGesture = "begin" | "perform" | "end"

export interface PluginEditorOpenResult {
  editorMode: PluginEditorMode
  open: boolean
}

export interface AudioHostEditorWindows {
  open(
    client: AudioHostRuntime,
    instanceId: string,
    context: PluginEditorWindowContext,
    openNative: () => Promise<PluginEditorOpenResult>,
    applyAction: (action: PluginEditorToolbarAction) => Promise<NativeEditorToolbarState>,
    loadParameters: () => Promise<PluginParameterInfo[]>,
    setParameter: (
      parameterId: number,
      normalized: number,
      gesture: ParameterGesture
    ) => Promise<void>,
    closeNative: () => Promise<void>
  ): Promise<PluginEditorOpenResult>
  close(instanceId: string): Promise<boolean>
  closeAll(): Promise<void>
  drain(client: AudioHostRuntime): void
  hostClosed(instanceId: string): void
}

export interface PluginEditorWindowContext {
  channelName: string
  channelColor: string
  pluginName: string
  theme: "light" | "dark"
  locale: "en-US" | "zh-cmn-Hans-CN"
}

interface EditorWindowEntry {
  window: BaseWindow
  toolbarWindow: BaseWindow
  toolbar: WebContentsView
  client: AudioHostRuntime
  closeNative: () => Promise<void>
  applyAction: (action: PluginEditorToolbarAction) => Promise<NativeEditorToolbarState>
  loadParameters: () => Promise<PluginParameterInfo[]>
  setParameter: (
    parameterId: number,
    normalized: number,
    gesture: ParameterGesture
  ) => Promise<void>
  closing: boolean
  applyingPluginSize: boolean
  context: PluginEditorWindowContext
  toolbarState: NativeEditorToolbarState | null
  parameters: PluginParameterInfo[]
  loadingParameters: boolean
  toolbarKey: string
  minimumNativeWidth: number
  minimumNativeHeight: number
}

export class ElectronPluginEditorWindows implements AudioHostEditorWindows {
  private readonly entries = new Map<string, EditorWindowEntry>()
  private readonly parent: BaseWindow

  constructor(parent: BaseWindow) {
    this.parent = parent
  }

  async open(
    client: AudioHostRuntime,
    instanceId: string,
    context: PluginEditorWindowContext,
    openNative: () => Promise<PluginEditorOpenResult>,
    applyAction: (action: PluginEditorToolbarAction) => Promise<NativeEditorToolbarState>,
    loadParameters: () => Promise<PluginParameterInfo[]>,
    setParameter: (
      parameterId: number,
      normalized: number,
      gesture: ParameterGesture
    ) => Promise<void>,
    closeNative: () => Promise<void>
  ): Promise<PluginEditorOpenResult> {
    const existing = this.entries.get(instanceId)
    if (existing) {
      existing.window.show()
      this.resizeNativeHost(instanceId, existing)
      existing.toolbarWindow.showInactive()
      existing.window.focus()
      return openNative()
    }

    const window = new BaseWindow({
      parent: this.parent,
      title: [context.channelName, context.pluginName].filter(Boolean).join(" — "),
      show: false,
      width: 800,
      height: 600 + TOOLBAR_HEIGHT,
      useContentSize: true,
      backgroundColor: "#111318",
      acceptFirstMouse: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false
    })
    const toolbar = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    })
    const toolbarWindow = new BaseWindow({
      parent: window,
      frame: false,
      show: false,
      width: 800,
      height: TOOLBAR_HEIGHT,
      useContentSize: true,
      backgroundColor: "#15181e",
      acceptFirstMouse: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      skipTaskbar: true
    })
    toolbarWindow.contentView.addChildView(toolbar)
    const entry: EditorWindowEntry = {
      window,
      toolbarWindow,
      toolbar,
      client,
      closeNative,
      applyAction,
      loadParameters,
      setParameter,
      closing: false,
      applyingPluginSize: false,
      context,
      toolbarState: null,
      parameters: [],
      loadingParameters: false,
      toolbarKey: "",
      minimumNativeWidth: 1,
      minimumNativeHeight: 1
    }
    this.entries.set(instanceId, entry)

    toolbar.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    toolbar.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith(ACTION_SCHEME)) return
      event.preventDefault()
      const actionName = url.slice(ACTION_SCHEME.length)
      const parameter = parameterAction(actionName)
      if (parameter) {
        void entry
          .setParameter(parameter.parameterId, parameter.normalized, parameter.gesture)
          .then(async () => {
            if (parameter.gesture !== "end" || this.entries.get(instanceId) !== entry) return
            entry.parameters = await entry.loadParameters()
            this.renderToolbar(entry)
          })
          .catch((error: unknown) => {
            console.error(`Could not set plug-in parameter ${parameter.parameterId}`, error)
          })
        return
      }
      const action = toolbarAction(actionName)
      if (!action) return
      void entry
        .applyAction(action)
        .then(async (state) => {
          if (this.entries.get(instanceId) !== entry || entry.closing) return
          await this.applyToolbarState(instanceId, entry, state)
        })
        .catch((error: unknown) => {
          entry.toolbarKey = ""
          this.renderToolbar(entry)
          console.error(`Could not apply native editor action ${actionName}`, error)
        })
    })
    this.renderToolbar(entry)

    window.on("resize", () => {
      if (!entry.closing && !entry.applyingPluginSize) {
        this.resizeNativeHost(instanceId, entry)
      }
    })
    window.on("move", () => {
      if (!entry.closing) this.resizeNativeHost(instanceId, entry)
    })
    window.on("focus", () => {
      if (!entry.closing && entry.toolbarState?.activeMode === "native") {
        client.focusEditorHost(instanceId)
      }
    })
    window.on("close", (event) => {
      if (entry.closing) return
      event.preventDefault()
      void this.close(instanceId).catch((error: unknown) => {
        console.error(`Could not close native plug-in editor ${instanceId}`, error)
      })
    })

    const scaleFactor = this.scaleFactor(window)
    const [width = 1, height = 1] = window.getContentSize()
    const toolbarHeight = toolbarHeightFor(width)
    this.layoutToolbar(entry, width, toolbarHeight)
    const native = nativeExtent(width, Math.max(1, height - toolbarHeight), scaleFactor)
    const topInset = nativeDimension(toolbarHeight, scaleFactor)
    try {
      client.registerEditorHost({
        instanceId,
        parentWindowHandle: window.getNativeWindowHandle(),
        width: native.width,
        height: native.height,
        topInset,
        displayScale: scaleFactor
      })
      const result = await openNative()
      entry.toolbarState = client.editorToolbarState(instanceId)
      if (entry.toolbarState) await this.applyToolbarState(instanceId, entry, entry.toolbarState)
      const snapshot = client.editorHostSnapshot(instanceId)
      if (snapshot?.attached) this.applySnapshot(entry, snapshot)
      if (!window.isDestroyed()) {
        window.show()
        // Hidden macOS windows can report a provisional content origin. Reflow
        // both child windows after the native title bar has its final geometry.
        this.resizeNativeHost(instanceId, entry)
        if (!toolbarWindow.isDestroyed()) toolbarWindow.showInactive()
        window.focus()
        client.focusEditorHost(instanceId)
      }
      return result
    } catch (error) {
      this.cleanup(instanceId, entry)
      throw error
    }
  }

  async close(instanceId: string): Promise<boolean> {
    const entry = this.entries.get(instanceId)
    if (!entry || entry.closing) return false
    entry.closing = true
    if (!entry.toolbarWindow.isDestroyed()) entry.toolbarWindow.hide()
    if (!entry.window.isDestroyed()) entry.window.hide()
    try {
      await entry.closeNative()
    } finally {
      this.cleanup(instanceId, entry)
    }
    return true
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map((instanceId) => this.close(instanceId)))
  }

  drain(client: AudioHostRuntime): void {
    for (const event of client.drainEditorHostEvents()) {
      const entry = this.entries.get(event.instanceId)
      if (!entry || entry.client !== client || entry.closing) continue
      this.applySnapshot(entry, {
        instanceId: event.instanceId,
        width: event.width,
        height: event.height,
        displayScale: this.scaleFactor(entry.window),
        resizable: event.resizable,
        attached: true
      })
    }
    for (const [instanceId, entry] of this.entries) {
      if (entry.client !== client || entry.closing) continue
      const state = client.editorToolbarState(instanceId)
      if (state) {
        void this.applyToolbarState(instanceId, entry, state)
      }
    }
  }

  hostClosed(instanceId: string): void {
    const entry = this.entries.get(instanceId)
    if (!entry) return
    entry.closing = true
    this.cleanup(instanceId, entry)
  }

  private applySnapshot(entry: EditorWindowEntry, snapshot: NativeEditorHostSnapshot): void {
    if (entry.window.isDestroyed() || entry.toolbarState?.activeMode === "parameters") return
    entry.applyingPluginSize = true
    try {
      entry.window.setResizable(snapshot.resizable)
      const toolbarHeight = toolbarHeightFor(snapshot.width)
      const [currentWidth = 1, currentHeight = 1] = entry.window.getContentSize()
      const totalHeight = snapshot.height + toolbarHeight
      if (currentWidth !== snapshot.width || currentHeight !== totalHeight) {
        entry.window.setContentSize(snapshot.width, totalHeight)
      }
      this.layoutToolbar(entry, snapshot.width, toolbarHeight)
      this.resizeNativeHost(snapshot.instanceId, entry)
    } finally {
      entry.applyingPluginSize = false
    }
  }

  private async applyToolbarState(
    instanceId: string,
    entry: EditorWindowEntry,
    state: NativeEditorToolbarState
  ): Promise<void> {
    const modeChanged = entry.toolbarState?.activeMode !== state.activeMode
    const zoomChanged = entry.toolbarState?.zoomPercent !== state.zoomPercent
    const sidechainWasPending = entry.toolbarState?.sidechainPending === true
    entry.toolbarState = state
    if (
      state.activeMode === "parameters" &&
      !entry.loadingParameters &&
      (modeChanged || entry.parameters.length === 0)
    ) {
      entry.loadingParameters = true
      try {
        entry.parameters = await entry.loadParameters()
      } finally {
        entry.loadingParameters = false
      }
      if (this.entries.get(instanceId) !== entry || entry.closing) return
      if (entry.toolbarState?.activeMode !== state.activeMode) return
    }
    if (entry.window.isDestroyed()) return
    const [width = 1, height = 1] = entry.window.getContentSize()
    const toolbarHeight = toolbarHeightFor(width)
    if (state.activeMode === "parameters") {
      entry.minimumNativeWidth = 1
      entry.minimumNativeHeight = 1
      entry.window.setMinimumSize(480, 240 + toolbarHeight)
      entry.window.setResizable(true)
      if (modeChanged && (width < 720 || height < 640 + toolbarHeight)) {
        entry.window.setContentSize(Math.max(width, 720), Math.max(height, 640 + toolbarHeight))
      }
      this.layoutToolbar(entry, width, toolbarHeight)
    } else {
      if (modeChanged || zoomChanged) {
        entry.minimumNativeWidth = 1
        entry.minimumNativeHeight = 1
        entry.window.setMinimumSize(1, toolbarHeight + 1)
      }
      this.layoutToolbar(entry, width, toolbarHeight)
      entry.client.focusEditorHost(instanceId)
    }
    // The route select updates and disables itself optimistically. Rendering
    // the intermediate pending state would reload the data URL with the old
    // committed route and make the control visibly jump before commit.
    if (!state.sidechainPending) {
      if (sidechainWasPending) entry.toolbarKey = ""
      this.renderToolbar(entry)
    }
  }

  private resizeNativeHost(instanceId: string, entry: EditorWindowEntry): void {
    if (entry.window.isDestroyed()) return
    const scaleFactor = this.scaleFactor(entry.window)
    const [width = 1, height = 1] = entry.window.getContentSize()
    const toolbarHeight = toolbarHeightFor(width)
    const requestedHeight = Math.max(1, height - toolbarHeight)
    this.layoutToolbar(entry, width, toolbarHeight)
    if (entry.toolbarState?.activeMode === "parameters") return
    const native = nativeExtent(width, requestedHeight, scaleFactor)
    entry.client.resizeEditorHost({
      instanceId,
      width: native.width,
      height: native.height,
      topInset: nativeDimension(toolbarHeight, scaleFactor),
      displayScale: scaleFactor
    })
    const accepted = entry.client.editorHostSnapshot(instanceId)
    if (
      !accepted?.attached ||
      (accepted.width === width && accepted.height === requestedHeight)
    ) {
      return
    }
    if (accepted.width > width) {
      entry.minimumNativeWidth = Math.max(entry.minimumNativeWidth, accepted.width)
    }
    if (accepted.height > requestedHeight) {
      entry.minimumNativeHeight = Math.max(entry.minimumNativeHeight, accepted.height)
    }
    entry.window.setMinimumSize(
      entry.minimumNativeWidth,
      entry.minimumNativeHeight + toolbarHeightFor(accepted.width)
    )
    this.applySnapshot(entry, accepted)
  }

  private cleanup(instanceId: string, entry: EditorWindowEntry): void {
    if (this.entries.get(instanceId) !== entry) return
    this.entries.delete(instanceId)
    entry.client.unregisterEditorHost(instanceId)
    if (!entry.toolbarWindow.isDestroyed()) {
      entry.toolbarWindow.contentView.removeChildView(entry.toolbar)
    }
    if (!entry.toolbar.webContents.isDestroyed()) entry.toolbar.webContents.close()
    if (!entry.toolbarWindow.isDestroyed()) entry.toolbarWindow.destroy()
    if (!entry.window.isDestroyed()) entry.window.destroy()
  }

  private layoutToolbar(entry: EditorWindowEntry, width: number, height: number): void {
    if (entry.window.isDestroyed() || entry.toolbarWindow.isDestroyed()) return
    const viewHeight =
      entry.toolbarState?.activeMode === "parameters"
        ? (entry.window.getContentSize()[1] ?? height)
        : height
    const contentBounds = entry.window.getContentBounds()
    entry.toolbarWindow.setBounds({
      x: contentBounds.x,
      y: contentBounds.y,
      width: Math.max(1, width),
      height: viewHeight
    })
    entry.toolbar.setBounds({ x: 0, y: 0, width: Math.max(1, width), height: viewHeight })
  }

  private renderToolbar(entry: EditorWindowEntry): void {
    const html = toolbarHtml(entry.context, entry.toolbarState, entry.parameters)
    const key = html
    if (entry.toolbarKey === key || entry.toolbar.webContents.isDestroyed()) return
    entry.toolbarKey = key
    void entry.toolbar.webContents.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    )
  }

  private scaleFactor(window: BaseWindow): number {
    return screen.getDisplayMatching(window.getBounds()).scaleFactor
  }
}

function toolbarAction(action: string): PluginEditorToolbarAction | null {
  switch (action) {
    case "mode-native":
      return { type: "mode", mode: "native" }
    case "mode-parameters":
      return { type: "mode", mode: "parameters" }
    case "compare-a":
      return { type: "compare", slot: "a" }
    case "compare-b":
      return { type: "compare", slot: "b" }
    case "copy":
    case "paste":
    case "undo":
    case "redo":
      return { type: action }
    default: {
      const sidechain = /^sidechain-(\d+)-(.+)$/.exec(action)
      if (sidechain?.[1] && sidechain[2]) {
        const inputBusIndex = Number.parseInt(sidechain[1], 10)
        const encodedSource = sidechain[2]
        return {
          type: "sidechain-route",
          input_bus_index: inputBusIndex,
          source_channel_id: encodedSource === "_" ? null : decodeURIComponent(encodedSource)
        }
      }
      const zoom = /^zoom-(\d+)$/.exec(action)?.[1]
      if (!zoom) return null
      const zoomPercent = Number.parseInt(zoom, 10)
      return zoomPercent >= 50 && zoomPercent <= 400
        ? { type: "zoom", zoom_percent: zoomPercent }
        : null
    }
  }
}

function parameterAction(action: string): {
  parameterId: number
  normalized: number
  gesture: ParameterGesture
} | null {
  const match = /^parameter-(begin|perform|end)-(\d+)-(\d+(?:\.\d+)?)$/.exec(action)
  if (!match?.[1] || !match[2] || !match[3]) return null
  const normalized = Number.parseFloat(match[3])
  if (!Number.isFinite(normalized)) return null
  return {
    parameterId: Number.parseInt(match[2], 10),
    normalized: Math.max(0, Math.min(1, normalized)),
    gesture: match[1] as ParameterGesture
  }
}

function toolbarHeightFor(width: number): number {
  return width < NARROW_BREAKPOINT ? NARROW_TOOLBAR_HEIGHT : TOOLBAR_HEIGHT
}

function nativeDimension(
  value: number,
  scaleFactor: number,
  platform: NodeJS.Platform = process.platform
): number {
  const scale = platform === "darwin" ? 1 : Math.max(0.01, scaleFactor)
  return Math.max(1, Math.round(value * scale))
}

export function nativeExtent(
  width: number,
  height: number,
  scaleFactor: number,
  platform: NodeJS.Platform = process.platform
): { width: number; height: number } {
  const scale = platform === "darwin" ? 1 : Math.max(0.01, scaleFactor)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

function toolbarHtml(
  context: PluginEditorWindowContext,
  state: NativeEditorToolbarState | null,
  parameters: readonly PluginParameterInfo[]
): string {
  const isChinese = context.locale === "zh-cmn-Hans-CN"
  const labels = isChinese
    ? {
        editor: "编辑器",
        parameters: "参数",
        copy: "拷贝",
        paste: "粘贴",
        undo: "撤销",
        redo: "重做",
        sidechain: "侧链",
        none: "无",
        audio: "音频",
        instrument: "乐器",
        aux: "辅助"
      }
    : {
        editor: "Editor",
        parameters: "Parameters",
        copy: "Copy",
        paste: "Paste",
        undo: "Undo",
        redo: "Redo",
        sidechain: "Side-chain",
        none: "None",
        audio: "Audio",
        instrument: "Instrument",
        aux: "Aux"
      }
  const dark = context.theme === "dark"
  const background = dark ? "#15181e" : "#f2f3f5"
  const control = dark ? "#252a33" : "#ffffff"
  const border = dark ? "#3b424e" : "#c8cdd5"
  const text = dark ? "#f1f3f6" : "#20242b"
  const muted = dark ? "#9ca5b3" : "#687180"
  const active = dark ? "#3c7d78" : "#c9ebe7"
  const zoom = state?.zoomPercent ?? 100
  const parameterMode = state?.activeMode === "parameters"
  const button = (label: string, action: string, enabled: boolean, selected = false): string =>
    `<a class="button${selected ? " selected" : ""}${enabled ? "" : " disabled"}"${enabled ? ` href="${ACTION_SCHEME}${action}"` : ""}>${escapeHtml(label)}</a>`
  const options = [50, 75, 100, 125, 150, 175, 200, 250, 300, 400]
    .map(
      (value) => `<option value="${value}"${value === zoom ? " selected" : ""}>${value}%</option>`
    )
    .join("")
  const modeOptions = `<option value="native"${parameterMode ? "" : " selected"}>${labels.editor}</option><option value="parameters"${parameterMode ? " selected" : ""}>${labels.parameters}</option>`
  const sidechains = (state?.sidechainBuses ?? [])
    .map((bus) => {
      const grouped = (["audio", "instrument", "aux"] as const)
        .map((kind) => {
          const entries = (state?.sidechainSources ?? [])
            .filter((source) => source.kind === kind)
            .map(
              (source) =>
                `<option value="${escapeHtml(source.id)}"${bus.sourceChannelId === source.id ? " selected" : ""}>${escapeHtml(source.name)}</option>`
            )
            .join("")
          return entries ? `<optgroup label="${labels[kind]}">${entries}</optgroup>` : ""
        })
        .join("")
      return `<label class="sidechain"><span>${escapeHtml(bus.name || labels.sidechain)}</span><select ${state?.sidechainPending ? "disabled" : ""} onchange="routeSidechain(${bus.inputBusIndex},this.value,this)"><option value=""${bus.sourceChannelId ? "" : " selected"}>${labels.none}</option>${grouped}</select></label>`
    })
    .join("")
  const parameterRows = parameters
    .map((parameter) => {
      const readOnly = (parameter.flags & 2) !== 0
      const step = parameter.stepCount > 0 ? 1 / parameter.stepCount : 0.001
      const value = Math.max(0, Math.min(1, parameter.normalized))
      const display = parameter.formatted || `${Math.round(value * 1000) / 10}%`
      return `<label class="parameter"><span class="parameter-name">${escapeHtml(parameter.title)}</span><input type="range" min="0" max="1" step="${step}" value="${value}" data-id="${parameter.id}" ${readOnly ? "disabled" : ""} onpointerdown="parameterBegin(this)" oninput="parameterPerform(this)" onpointerup="parameterEnd(this)" onchange="parameterEnd(this)"><output>${escapeHtml(display)}${parameter.units && !display.includes(parameter.units) ? ` ${escapeHtml(parameter.units)}` : ""}</output></label>`
    })
    .join("")
  const parameterPane = parameterMode
    ? `<main class="parameter-pane">${parameterRows || `<p class="empty">${labels.parameters}</p>`}</main>`
    : ""
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:${text};background:${background};user-select:none}body{--toolbar:60px}.chrome{height:var(--toolbar);padding:6px 10px;border-bottom:1px solid ${border}}.title{height:20px;display:flex;align-items:center;gap:8px;white-space:nowrap}.rail{width:4px;height:18px;border-radius:2px;background:${safeColor(context.channelColor)}}.channel{font-weight:650}.plugin{color:${muted};font-size:11px}.commands{height:24px;display:flex;align-items:center;gap:4px}.spacer{flex:1}.group{display:flex;border:1px solid ${border};border-radius:4px;overflow:hidden}.button,select{height:24px;display:inline-flex;align-items:center;justify-content:center;padding:0 8px;border:1px solid ${border};border-radius:4px;background:${control};color:${text};text-decoration:none;line-height:22px}.group .button{border:0;border-radius:0;min-width:26px}.button:hover,select:hover{filter:brightness(1.12)}.button.selected{background:${active}}.button.disabled{opacity:.38;pointer-events:none}select{min-width:72px;outline:none}.mode{min-width:112px}.settings{display:flex;gap:4px}.sidechain{display:flex;gap:4px;align-items:center}.sidechain span{color:${muted}}.parameter-pane{height:calc(100vh - var(--toolbar));overflow:auto;padding:16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px 16px;align-content:start}.parameter{display:grid;grid-template-columns:minmax(100px,1fr) minmax(120px,2fr) 72px;gap:10px;align-items:center;min-height:32px;padding:4px 8px;border:1px solid ${border};border-radius:5px;background:${control}}.parameter-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.parameter input{width:100%;accent-color:${active}}.parameter output{text-align:right;color:${muted};font-variant-numeric:tabular-nums}.empty{color:${muted}}@media(max-width:519px){body{--toolbar:96px}.commands{height:60px;align-content:flex-start;flex-wrap:wrap}.spacer{flex-basis:100%;height:0;order:2}.settings{order:3}.parameter-pane{grid-template-columns:1fr}}
</style><script>const action=${JSON.stringify(ACTION_SCHEME)};function go(value){location.href=action+value}function routeSidechain(bus,source,select){document.querySelectorAll('.sidechain select').forEach(control=>control.disabled=true);select.disabled=true;go('sidechain-'+bus+'-'+(source?encodeURIComponent(source):'_'))}function parameterValue(input,gesture){go('parameter-'+gesture+'-'+input.dataset.id+'-'+input.value)}function parameterBegin(input){parameterValue(input,'begin')}function parameterPerform(input){parameterValue(input,'perform');input.nextElementSibling.value=(Math.round(Number(input.value)*1000)/10)+'%'}function parameterEnd(input){parameterValue(input,'end')}</script></head><body><header class="chrome"><div class="title"><span class="rail"></span><span class="channel">${escapeHtml(context.channelName)}</span><span class="plugin">${escapeHtml(context.pluginName)}</span></div><div class="commands"><span class="group">${button("A", "compare-a", state?.canCompare ?? false, state?.compareSlot === "a")}${button("B", "compare-b", state?.canCompare ?? false, state?.compareSlot === "b")}</span>${button(labels.copy, "copy", true)}${button(labels.paste, "paste", state?.canPaste ?? false)}${button(labels.undo, "undo", state?.canUndo ?? false)}${button(labels.redo, "redo", state?.canRedo ?? false)}<span class="spacer"></span><span class="settings"><select class="mode" aria-label="Mode" onchange="go('mode-'+this.value)">${modeOptions}</select><select aria-label="Zoom" onchange="go('zoom-'+this.value)">${options}</select>${sidechains}</span></div></header>${parameterPane}</body></html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function safeColor(value: string): string {
  return /^#[\da-f]{6}$/i.test(value) ? value : "#58c6c2"
}
