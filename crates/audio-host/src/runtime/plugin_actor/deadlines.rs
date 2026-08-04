use super::ControlCommand;

pub(in crate::runtime) fn is_vst3_command(command: &ControlCommand) -> bool {
    matches!(
        command,
        ControlCommand::Ping
            | ControlCommand::UpdateGraph { .. }
            | ControlCommand::PrepareGraph { .. }
            | ControlCommand::ActivateGraph { .. }
            | ControlCommand::AbortGraph { .. }
            | ControlCommand::GraphDeploymentSnapshot { .. }
            | ControlCommand::LoadPlugin { .. }
            | ControlCommand::UnloadPlugin { .. }
            | ControlCommand::PluginParameters { .. }
            | ControlCommand::SetPluginParameter { .. }
            | ControlCommand::SavePluginState { .. }
            | ControlCommand::OpenPluginEditor { .. }
            | ControlCommand::ConfigurePluginEditorAppearance { .. }
            | ControlCommand::ResolvePluginSidechainRoute { .. }
            | ControlCommand::ClosePluginEditor { .. }
            | ControlCommand::RunAudioBenchmark { .. }
    )
}

pub(in crate::runtime) fn is_background_io_command(command: &ControlCommand) -> bool {
    matches!(
        command,
        ControlCommand::ListAudioBackends | ControlCommand::ListAudioDevices { .. }
    )
}

pub(in crate::runtime) fn protocol_deadline(command: &ControlCommand) -> std::time::Duration {
    // The audio benchmark builds three dense mixer graphs around up to 64 live
    // VST3 instances; on slow machines that legitimately exceeds the extended
    // 15 s command deadline, so give it its own generous budget.
    if matches!(command, ControlCommand::RunAudioBenchmark { .. }) {
        std::time::Duration::from_secs(60)
    } else if matches!(
        command,
        ControlCommand::UpdateGraph { .. }
            | ControlCommand::PrepareGraph { .. }
            | ControlCommand::ActivateGraph { .. }
            | ControlCommand::AbortGraph { .. }
            | ControlCommand::LoadPlugin { .. }
            | ControlCommand::UnloadPlugin { .. }
            | ControlCommand::SavePluginState { .. }
            | ControlCommand::OpenPluginEditor { .. }
            | ControlCommand::ConfigurePluginEditorAppearance { .. }
            | ControlCommand::ResolvePluginSidechainRoute { .. }
            | ControlCommand::ClosePluginEditor { .. }
            | ControlCommand::BenchmarkEcho { .. }
    ) {
        std::time::Duration::from_secs(15)
    } else {
        std::time::Duration::from_secs(2)
    }
}
