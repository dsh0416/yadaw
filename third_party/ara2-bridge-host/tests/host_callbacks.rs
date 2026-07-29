use std::collections::BTreeSet;

#[test]
fn every_host_slot_has_a_dispatcher_and_contract_class() {
    let expected = ara2_bridge_sys::compatibility::RECORDS
        .iter()
        .filter(|record| {
            matches!(
                record.surface,
                "ARAAudioAccessControllerInterface"
                    | "ARAArchivingControllerInterface"
                    | "ARAContentAccessControllerInterface"
                    | "ARAModelUpdateControllerInterface"
                    | "ARAPlaybackControllerInterface"
            )
        })
        .flat_map(|record| record.callbacks.iter().copied())
        .collect::<BTreeSet<_>>();
    let actual = ara2_bridge_host::host_callback_manifest()
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    assert_eq!(expected.len(), 28);
    assert_eq!(actual, expected);
}
