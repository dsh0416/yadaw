export type KernelResult<Value, Error> = { ok: true; value: Value } | { ok: false; error: Error }

export function kernelSuccess<Value>(value: Value): KernelResult<Value, never> {
  return { ok: true, value }
}

export function kernelFailure<Error>(error: Error): KernelResult<never, Error> {
  return { ok: false, error }
}
