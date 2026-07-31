const TRACK_PREFIX = "track:"

export function legacyTrackId(channelId: string): string {
  return `${TRACK_PREFIX}${channelId}`
}

export function legacyChannelId(trackId: string): string {
  if (!trackId.startsWith(TRACK_PREFIX)) {
    throw new Error(`Project track '${trackId}' does not use the legacy channel mapping`)
  }
  return trackId.slice(TRACK_PREFIX.length)
}
