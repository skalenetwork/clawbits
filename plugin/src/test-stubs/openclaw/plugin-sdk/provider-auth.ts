export interface UpsertedAuthProfile {
  profileId: string;
  credential: Record<string, unknown>;
  agentDir?: string;
}

export const upsertedAuthProfiles: UpsertedAuthProfile[] = [];

export async function upsertAuthProfileAsync(params: UpsertedAuthProfile): Promise<void> {
  upsertedAuthProfiles.push(params);
}

export function upsertAuthProfile(params: UpsertedAuthProfile): void {
  upsertedAuthProfiles.push(params);
}
