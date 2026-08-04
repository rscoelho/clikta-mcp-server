interface RecordingSessionState {
  recordingId: string | null;
  eventCount: number;
}

export const recordingSession: RecordingSessionState = {
  recordingId: null,
  eventCount: 0,
};

export function requireActiveRecording(): string {
  if (!recordingSession.recordingId) {
    throw new Error("No recording in progress. Call clikta_start_recording first.");
  }
  return recordingSession.recordingId;
}

export function resetRecordingSession(): void {
  recordingSession.recordingId = null;
  recordingSession.eventCount = 0;
}
