//! Raw, target-specific VST3 SDK bindings.
//!
//! The bindings are generated directly from the Steinberg C++ interface
//! headers. This crate deliberately exposes no safe constructors or ownership
//! semantics; use `yadaw-vst3-host` instead.

#![allow(
    clippy::missing_safety_doc,
    dead_code,
    improper_ctypes,
    non_camel_case_types,
    non_snake_case,
    non_upper_case_globals,
    unsafe_op_in_unsafe_fn
)]

include!(concat!(env!("OUT_DIR"), "/bindings.rs"));

pub use root::Steinberg;
pub use root::{
    YadawAraFactoryInfo, YadawAraMainFactory, YadawAraPluginEntry, yadaw_ara_main_factory_create,
    yadaw_ara_main_factory_destroy, yadaw_ara_main_factory_get, yadaw_ara_plugin_entry_bind,
    yadaw_ara_plugin_entry_create, yadaw_ara_plugin_entry_destroy,
    yadaw_ara_plugin_entry_get_factory, yadaw_ara_query_factory,
};

pub mod abi;
pub mod compat;
pub mod iid;
