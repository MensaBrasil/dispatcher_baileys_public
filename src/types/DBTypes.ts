export type GroupType = "MB" | "RJB";

export interface DBGroupRequest {
  request_id: number;
  registration_id: number;
  group_id: string;
  no_of_attempts: number;
  last_attempt: Date | null;
}

export interface WhatsAppWorker {
  id: number;
  worker_phone: string;
}
