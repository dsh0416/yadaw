use super::*;

#[test]
fn ui_mailbox_budget_stops_at_both_time_and_batch_boundaries() {
    assert!(should_drain_ui_request(
        WinitHost::UI_BATCH - 1,
        WinitHost::UI_BUDGET - Duration::from_nanos(1),
    ));
    assert!(!should_drain_ui_request(
        WinitHost::UI_BATCH,
        Duration::ZERO,
    ));
    assert!(!should_drain_ui_request(1, WinitHost::UI_BUDGET));
}

#[test]
fn editor_popup_ownership_replaces_only_the_same_owner() {
    let mut owners = HashMap::new();

    assert_eq!(replace_owned_popup(&mut owners, 1_u8, 10), None);
    assert_eq!(replace_owned_popup(&mut owners, 2, 20), None);
    assert_eq!(replace_owned_popup(&mut owners, 1, 11), Some(10));
    assert_eq!(owners.get(&1), Some(&11));
    assert_eq!(owners.get(&2), Some(&20));
}

#[test]
fn editor_popup_owner_cleanup_is_isolated_and_idempotent() {
    let mut owners = HashMap::from([(1_u8, 10_u8), (2, 20)]);

    assert_eq!(remove_owned_popup(&mut owners, 1), Some(10));
    assert_eq!(remove_owned_popup(&mut owners, 1), None);
    assert_eq!(owners, HashMap::from([(2, 20)]));
}

#[test]
fn editor_owner_window_rejects_null_and_invalid_handles() {
    assert_eq!(parse_editor_owner_window("4660"), Ok(4660));
    assert!(parse_editor_owner_window("0").is_err());
    assert!(parse_editor_owner_window("not-a-handle").is_err());
}

#[test]
fn plugin_editor_is_created_hidden_until_native_attachment_is_ready() {
    let attributes = plugin_editor_window_attributes("Lead", "Pro-C", None);
    assert!(!attributes.visible);
    assert_eq!(attributes.title, "Lead — Pro-C — Heron");
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

#[test]
fn vst3_controller_requests_are_forwarded_as_typed_runtime_notifications() {
    assert_eq!(
        vst3_host_request_payload(&Vst3HostRequest::DirtyChanged(true)),
        Some(("dirty-changed", "true".to_owned()))
    );
    assert_eq!(
        vst3_host_request_payload(&Vst3HostRequest::OpenEditor {
            view_name: "editor".to_owned(),
        }),
        Some(("open-editor", "editor".to_owned()))
    );
    assert_eq!(
        vst3_host_request_payload(&Vst3HostRequest::ProgramListChanged {
            list_id: 7,
            program_index: 3,
        }),
        Some(("program-list-changed", "7:3".to_owned()))
    );
    assert_eq!(
        vst3_host_request_payload(&Vst3HostRequest::BusActivation {
            media_type: 0,
            direction: 1,
            index: 0,
            active: true,
        }),
        None
    );
}
