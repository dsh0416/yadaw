#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bootstrap_rejects_a_stale_native_build() {
        assert!(validate_native_build_fingerprint(NATIVE_BUILD_FINGERPRINT).is_ok());
        assert!(validate_native_build_fingerprint("stale-build").is_err());
    }

    #[test]
    fn editor_owner_window_rejects_null_and_invalid_handles() {
        assert_eq!(parse_editor_owner_window("4660"), Ok(4660));
        assert!(parse_editor_owner_window("0").is_err());
        assert!(parse_editor_owner_window("not-a-handle").is_err());
    }

    #[test]
    fn ui_mailbox_always_services_one_request_but_respects_fairness_limits() {
        assert!(should_drain_ui_request(
            0,
            WinitHost::UI_BUDGET.saturating_mul(10)
        ));
        assert!(should_drain_ui_request(
            WinitHost::UI_BATCH - 1,
            WinitHost::UI_BUDGET.saturating_sub(std::time::Duration::from_nanos(1))
        ));
        assert!(!should_drain_ui_request(1, WinitHost::UI_BUDGET));
        assert!(!should_drain_ui_request(
            WinitHost::UI_BATCH,
            std::time::Duration::ZERO
        ));
    }
}
