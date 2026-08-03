use std::{ffi::c_void, mem::MaybeUninit, os::raw::c_char};

use heron_vst3_host_sys::{
    Steinberg::{
        FUnknown, TUID,
        Vst::{IParamValueQueue, IParameterChanges, ParamID, ParamValue},
        int32, tresult, uint32,
    },
    abi::{FUnknownVTable, ParamValueQueueVTable, ParameterChangesVTable},
    iid,
};

const QUEUE_CAPACITY: usize = 64;
const POINT_CAPACITY: usize = 32;

#[derive(Clone, Copy)]
struct Point {
    sample_offset: int32,
    value: ParamValue,
}

#[repr(C)]
struct ParamQueue {
    vtable: *const ParamValueQueueVTable,
    id: ParamID,
    points: [MaybeUninit<Point>; POINT_CAPACITY],
    len: usize,
}

impl ParamQueue {
    fn new() -> Self {
        Self {
            vtable: &PARAM_VALUE_QUEUE_VTABLE,
            id: 0,
            points: [const { MaybeUninit::uninit() }; POINT_CAPACITY],
            len: 0,
        }
    }

    fn reset(&mut self, id: ParamID) {
        self.id = id;
        self.len = 0;
    }

    fn push(&mut self, point: Point) -> bool {
        let Some(slot) = self.points.get_mut(self.len) else {
            return false;
        };
        slot.write(point);
        self.len += 1;
        true
    }
}

#[repr(C)]
pub(crate) struct ParameterChanges {
    vtable: *const ParameterChangesVTable,
    queues: [ParamQueue; QUEUE_CAPACITY],
    len: usize,
}

impl ParameterChanges {
    pub(crate) fn new() -> Box<Self> {
        Box::new(Self {
            vtable: &PARAMETER_CHANGES_VTABLE,
            queues: std::array::from_fn(|_| ParamQueue::new()),
            len: 0,
        })
    }

    pub(crate) fn as_interface(&mut self) -> *mut IParameterChanges {
        std::ptr::from_mut(self).cast()
    }

    pub(crate) fn clear(&mut self) {
        self.len = 0;
    }

    pub(crate) fn add_value(
        &mut self,
        id: ParamID,
        sample_offset: int32,
        value: ParamValue,
    ) -> bool {
        let index = self.queues[..self.len]
            .iter()
            .position(|queue| queue.id == id)
            .unwrap_or(self.len);
        if index == self.len {
            let Some(queue) = self.queues.get_mut(index) else {
                return false;
            };
            queue.reset(id);
            self.len += 1;
        }
        self.queues[index].push(Point {
            sample_offset,
            value,
        })
    }

    pub(crate) fn for_each_last(&self, mut visit: impl FnMut(ParamID, ParamValue)) {
        for queue in &self.queues[..self.len] {
            let Some(point) = queue
                .len
                .checked_sub(1)
                .and_then(|index| queue.points.get(index))
            else {
                continue;
            };
            let point = unsafe {
                // SAFETY: a queue's entries below len are initialized before addPoint publishes
                // the incremented length, and this storage cannot be mutated after process returns.
                point.assume_init_ref()
            };
            visit(queue.id, point.value);
        }
    }
}

unsafe extern "system" fn changes_query_interface(
    this: *mut FUnknown,
    requested: *const c_char,
    output: *mut *mut c_void,
) -> tresult {
    unsafe {
        // SAFETY: forwards the exact queryInterface arguments to the shared validator.
        query_fixed_interface(this, requested, output, iid::IPARAMETER_CHANGES)
    }
}

unsafe extern "system" fn queue_query_interface(
    this: *mut FUnknown,
    requested: *const c_char,
    output: *mut *mut c_void,
) -> tresult {
    unsafe {
        // SAFETY: forwards the exact queryInterface arguments to the shared validator.
        query_fixed_interface(this, requested, output, iid::IPARAM_VALUE_QUEUE)
    }
}

unsafe fn query_fixed_interface(
    this: *mut FUnknown,
    requested: *const c_char,
    output: *mut *mut c_void,
    interface_id: TUID,
) -> tresult {
    if requested.is_null() || output.is_null() {
        return -2147024809;
    }
    let requested = unsafe {
        // SAFETY: VST3 queryInterface supplies a 16-byte TUID.
        std::slice::from_raw_parts(requested, 16)
    };
    if requested == iid::FUNKNOWN || requested == interface_id {
        unsafe {
            // SAFETY: output is valid and both fixed interface objects start with their vtable.
            output.write(this.cast());
        }
        0
    } else {
        unsafe {
            // SAFETY: output is writable as validated above.
            output.write(std::ptr::null_mut());
        }
        -2147467262
    }
}

unsafe extern "system" fn add_ref(_this: *mut FUnknown) -> uint32 {
    1
}

unsafe extern "system" fn release(_this: *mut FUnknown) -> uint32 {
    1
}

unsafe extern "system" fn parameter_count(this: *mut IParameterChanges) -> int32 {
    let changes = this.cast::<ParameterChanges>();
    unsafe {
        // SAFETY: this is the interface pointer of a live ParameterChanges.
        (*changes).len.min(i32::MAX as usize) as i32
    }
}

unsafe extern "system" fn parameter_data(
    this: *mut IParameterChanges,
    index: int32,
) -> *mut IParamValueQueue {
    if index < 0 {
        return std::ptr::null_mut();
    }
    let changes = this.cast::<ParameterChanges>();
    let changes = unsafe {
        // SAFETY: this is the interface pointer of a live ParameterChanges.
        &mut *changes
    };
    if index as usize >= changes.len {
        return std::ptr::null_mut();
    }
    std::ptr::from_mut(&mut changes.queues[index as usize]).cast()
}

unsafe extern "system" fn add_parameter_data(
    this: *mut IParameterChanges,
    id: *const ParamID,
    index: *mut int32,
) -> *mut IParamValueQueue {
    if id.is_null() {
        return std::ptr::null_mut();
    }
    let changes = this.cast::<ParameterChanges>();
    let changes = unsafe {
        // SAFETY: this is the interface pointer of a live ParameterChanges.
        &mut *changes
    };
    let id = unsafe {
        // SAFETY: id was validated non-null and points to one ParamID.
        id.read()
    };
    let queue_index = changes.queues[..changes.len]
        .iter()
        .position(|queue| queue.id == id)
        .unwrap_or(changes.len);
    if queue_index == changes.len {
        let Some(queue) = changes.queues.get_mut(queue_index) else {
            return std::ptr::null_mut();
        };
        queue.reset(id);
        changes.len += 1;
    }
    if !index.is_null() {
        unsafe {
            // SAFETY: the optional output index is non-null.
            index.write(queue_index as int32);
        }
    }
    std::ptr::from_mut(&mut changes.queues[queue_index]).cast()
}

unsafe extern "system" fn parameter_id(this: *mut IParamValueQueue) -> ParamID {
    unsafe {
        // SAFETY: this is the interface pointer of a live ParamQueue.
        (*this.cast::<ParamQueue>()).id
    }
}

unsafe extern "system" fn point_count(this: *mut IParamValueQueue) -> int32 {
    unsafe {
        // SAFETY: this is the interface pointer of a live ParamQueue.
        (*this.cast::<ParamQueue>()).len as int32
    }
}

unsafe extern "system" fn point(
    this: *mut IParamValueQueue,
    index: int32,
    sample_offset: *mut int32,
    value: *mut ParamValue,
) -> tresult {
    if index < 0 || sample_offset.is_null() || value.is_null() {
        return -2147024809;
    }
    let queue = unsafe {
        // SAFETY: this is the interface pointer of a live ParamQueue.
        &*this.cast::<ParamQueue>()
    };
    if index as usize >= queue.len {
        return 1;
    }
    let point = unsafe {
        // SAFETY: entries below len were initialized by push/add_point.
        queue.points[index as usize].assume_init()
    };
    unsafe {
        // SAFETY: both outputs were validated non-null.
        sample_offset.write(point.sample_offset);
        value.write(point.value);
    }
    0
}

unsafe extern "system" fn add_point(
    this: *mut IParamValueQueue,
    sample_offset: int32,
    value: ParamValue,
    index: *mut int32,
) -> tresult {
    let queue = unsafe {
        // SAFETY: this is the interface pointer of a live ParamQueue.
        &mut *this.cast::<ParamQueue>()
    };
    let next = queue.len;
    if !queue.push(Point {
        sample_offset,
        value,
    }) {
        return 1;
    }
    if !index.is_null() {
        unsafe {
            // SAFETY: the optional index output is non-null.
            index.write(next as int32);
        }
    }
    0
}

static PARAMETER_CHANGES_VTABLE: ParameterChangesVTable = ParameterChangesVTable {
    base: FUnknownVTable {
        query_interface: changes_query_interface,
        add_ref,
        release,
    },
    parameter_count,
    parameter_data,
    add_parameter_data,
};

static PARAM_VALUE_QUEUE_VTABLE: ParamValueQueueVTable = ParamValueQueueVTable {
    base: FUnknownVTable {
        query_interface: queue_query_interface,
        add_ref,
        release,
    },
    parameter_id,
    point_count,
    point,
    add_point,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_parameter_storage_reuses_queues_and_enforces_capacity() {
        let mut changes = ParameterChanges::new();
        assert!(changes.add_value(7, 0, 0.25));
        assert!(changes.add_value(7, 1, 0.5));
        assert_eq!(changes.len, 1);
        assert_eq!(changes.queues[0].len, 2);

        changes.clear();
        for id in 0..QUEUE_CAPACITY as u32 {
            assert!(changes.add_value(id, 0, 1.0));
        }
        assert!(!changes.add_value(QUEUE_CAPACITY as u32, 0, 1.0));
    }

    #[test]
    fn last_values_select_the_terminal_point_from_each_queue() {
        let mut changes = ParameterChanges::new();
        assert!(changes.add_value(7, 0, 0.25));
        assert!(changes.add_value(7, 15, 0.75));
        assert!(changes.add_value(9, 3, 0.5));

        let mut values = Vec::new();
        changes.for_each_last(|id, value| values.push((id, value)));
        assert_eq!(values, [(7, 0.75), (9, 0.5)]);
    }
}
