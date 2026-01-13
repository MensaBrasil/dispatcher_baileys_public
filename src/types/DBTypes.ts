export type GroupType = "MB" | "RJB" | "AJB" | "JB" | "OrgMB";

export interface DBGroupRequest {
  request_id: number;
  registration_id: number;
  group_id: string;
  no_of_attempts: number;
  last_attempt: Date | null;
}

export interface WhatsappMessageRow {
  message_id: string;
  group_id: string;
  registration_id: number | null;
  timestamp: Date;
  phone: string | null;
  message_type: string;
  device_type: string;
  content: string | null;
}

export interface WhatsAppWorker {
  id: number;
  worker_phone: string;
}
