# Renderer UI audit

This checklist records the source-wide audit performed while introducing `@yadaw/ui`. All 61 Vue
files were included. “Reviewed” means the file is covered by the automated raw-color, z-index,
overlay, dependency-boundary, and Histoire checks; it does not mean every product-specific DAW
control was replaced with a generic primitive.

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
- [x] `components/studio/SoundBrowser.vue` — native accessible tabs and local scrolling.
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

## Shared editing

- [x] `components/InlineTrackNameEditor.vue`.

## Automated gates

- No renderer import from `reka-ui`.
- No manual renderer `Teleport` overlay.
- No Histoire dependency or script.
- No raw renderer color.
- No numeric renderer z-index.
- UI package cannot import product state, routing, contracts, Electron, or preload APIs.
- Ordinary UI elevation uses shared tokens; dynamic signal glows are restricted to documented DAW
  domain directories.
