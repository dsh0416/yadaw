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

pub(in crate::runtime) fn slow_request_threshold(command: &ControlCommand) -> std::time::Duration {
    // These thresholds are diagnostic only. A request that crosses one still
    // waits for its actor to produce a terminal result; timing out the waiter
    // would not cancel work that has already been queued or started.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_thresholds_are_observability_budgets() {
        assert_eq!(
            slow_request_threshold(&ControlCommand::Ping),
            std::time::Duration::from_secs(2)
        );
        assert_eq!(
            slow_request_threshold(&ControlCommand::BenchmarkEcho {
                payload: Default::default(),
            }),
            std::time::Duration::from_secs(15)
        );
    }
}
