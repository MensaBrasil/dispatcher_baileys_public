export type GroupType = "MB" | "MJB" | "RJB" | "AJB" | "JB";

export interface DBGroupRequest {
  request_id: number;
  registration_id: number;
  group_id: string;
  no_of_attempts: number;
  last_attempt: Date | null;
}
