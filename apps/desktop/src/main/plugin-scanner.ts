export class PluginScanner<TRequest, TResult> {
  private pending: Promise<TResult> | null = null

  run(request: TRequest, scan: (request: TRequest) => Promise<TResult>): Promise<TResult> {
    this.pending ??= scan(request).finally(() => {
      this.pending = null
    })
    return this.pending
  }
}
