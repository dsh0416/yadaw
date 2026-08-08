# Renderer UI audit

This checklist records the source-wide audit introduced with `@heron/ui` and extended as the
renderer grew. The inventory is now collected dynamically rather than frozen at the original 61
Vue files. On the 2026-07-30 expansion pass, `lint:design` covered 234 renderer sources, 45 UI
sources, and 8 design-system sources. “Reviewed” means the file is covered by the automated
raw-color, typography, token-reference, z-index, overlay, dependency-boundary, and Storybook-only
checks; it does not mean every product-specific DAW control was replaced with a generic primitive.

Product-specific controls were retained where their interaction is intrinsically musical or
two-dimensional. Their colors now come from the domain palette or runtime CSS variables, and
their focus/keyboard semantics remain part of desktop tests.

## Application and views

- [x] `App.vue` — `UiProvider`; application lifecycle remains in stores.
- [x] `views/WelcomeView.vue` — composition surface.
- [x] `views/StudioView.vue` — composition surface; renderer/store/preload boundary unchanged.
- [x] `views/SystemSettingsView.vue` — composition surface.
- [x] `views/ProjectSettingsView.vue` — composition surface.

## Overlays, feedback, and workflows

- [x] `components/dialog/GlobalDialogHost.vue` — queue controller + `UiAlertDialog`.
- [x] `components/operations/GlobalOperationHost.vue` — controller + `UiDialog`.
- [x] `components/operations/OperationProgressDialog.vue` — `UiProgress`, notice, and action.
- [x] `components/benchmark/AudioBenchmarkHost.vue` — controller + `UiDialog`.
- [x] `components/benchmark/AudioBenchmarkDialog.vue` — pure benchmark presenter.
- [x] `components/midi/MidiImportDialog.vue` — shared dialog and feedback behavior.
- [x] `components/recording/PendingRecordingHost.vue` — controller + shared dialog/actions.
- [x] `components/performance/PerformanceMonitorPopover.vue` — shared popover boundary.

## Welcome and settings

- [x] `components/project/ProjectWelcome.vue`.
- [x] `components/settings/SettingsContainer.vue`.
- [x] `components/settings/SettingsPage.vue`.
- [x] `components/settings/SettingsSection.vue`.
- [x] `components/project-settings/ProjectGeneralSettings.vue`.
- [x] `components/project-settings/ProjectSettingsPage.vue`.
- [x] `components/system-settings/AudioDeviceSettings.vue` — shared select/radio controls.
- [x] `components/system-settings/AudioRuntimeSettings.vue`.
- [x] `components/system-settings/DisplaySettings.vue`.
- [x] `components/system-settings/MixerDisplaySettings.vue`.
- [x] `components/system-settings/RecordingSettings.vue`.
- [x] `components/system-settings/SystemSettingsPage.vue`.

## Mixer and plug-ins

- [x] `components/mixer/MixerConsole.vue`.
- [x] `components/mixer/MixerChannelStrip.vue` — domain strip retained; sections audited.
- [x] `components/mixer/MixerChannelMenu.vue` — shared popover.
- [x] `components/mixer/MixerInputSection.vue` — shared popover.
- [x] `components/mixer/MixerOutputSection.vue` — shared popover.
- [x] `components/mixer/MixerSendSection.vue` — shared popovers; gesture controls retained.
- [x] `components/mixer/MixerPluginPicker.vue` — shared popover.
- [x] `components/mixer/MixerPluginSection.vue`.
- [x] `components/mixer/MixerPanKnob.vue` — keyboard-capable domain knob retained.
- [x] `components/mixer/MixerDbScale.vue`.
- [x] `components/mixer/MixerSectionLabels.vue`.
- [x] `components/plugins/InstrumentSlot.vue`.
- [x] `components/plugins/PluginRack.vue`.
- [x] `components/plugins/PluginSlot.vue`.

## Studio and arrangement

- [x] `components/studio/StudioWorkspace.vue` — local two-dimensional workspace.
- [x] `components/studio/StudioTopbar.vue` — shared tooltips.
- [x] `components/studio/StudioStatusbar.vue`.
- [x] `components/studio/StudioPlaceholderPanel.vue`.
- [x] `components/media-browser/MediaBrowserPanel.vue` and
      `components/studio/RightPanelHost.vue` — project asset filtering, local scrolling,
      mutually exclusive right-panel ownership, and keyboard resizing.
- [x] `components/studio/EngineInspector.vue` — shared slider/action.
- [x] `components/studio/ArrangementWorkspace.vue` — local two-dimensional scrolling retained.
- [x] `components/studio/ArrangementTrack.vue`.
- [x] `components/studio/MidiArrangementTrack.vue`.
- [x] `components/studio/AudioClipCard.vue`.
- [x] `components/studio/ArrangementZoomControls.vue`.
- [x] `components/studio/TimelineRuler.vue`.
- [x] `components/studio/WaveformCanvas.vue`.
- [x] `components/studio/TrackGainControl.vue` — domain gesture control.
- [x] `components/studio/TrackPanControl.vue` — domain gesture control.
- [x] `components/studio/TrackQuickControls.vue`.
- [x] `components/studio/TrackHeightResizeHandle.vue`.
- [x] `components/studio/ChannelFormatIcon.vue`.
- [x] `components/studio/global-lanes/GlobalLaneHeader.vue`.
- [x] `components/studio/global-lanes/GlobalValueLane.vue`.
- [x] `components/studio/global-lanes/TempoTrackLane.vue`.

## Editors and expanded workflows

- [x] `components/piano-roll/PianoRollDock.vue` — editor composition and focus boundary.
- [x] `components/piano-roll/PianoRollToolbar.vue` — shared toolbar, exclusive tool group, and
      signal-rail clip choices.
- [x] `components/piano-roll/PianoRollInspector.vue` — shared inline fields and bounded numeric
      inputs.
- [x] `components/piano-roll/PianoRollGrid.vue` — domain grid retained; shared recording signal
      token.
- [x] `components/piano-roll/PianoRollKeyboard.vue`.
- [x] `components/piano-roll/PianoRollNote.vue`.
- [x] `components/piano-roll/PianoRollVelocityLane.vue`.
- [x] `components/effect-graph/CompiledEffectGraphHost.vue` — product controller.
- [x] `components/effect-graph/CompiledEffectGraphPanel.vue` — domain graph surface retained.

## Shared editing

- [x] `components/InlineTrackNameEditor.vue`.

## Automated gates

- No renderer import from `reka-ui`.
- No manual renderer `Teleport` overlay.
- No Histoire dependency or script.
- No raw renderer color.
- No numeric renderer z-index.
- No undefined shared token reference; the `--ui-` namespace resolves only through shared token
  sources.
- UI package cannot import product state, routing, contracts, Electron, or preload APIs.
- Ordinary UI elevation uses shared tokens; dynamic signal glows are restricted to documented DAW
  domain directories.
