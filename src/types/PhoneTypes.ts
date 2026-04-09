export type Gender = "Masculino" | "Feminino";

export interface PhoneNumberStatusRow {
  phone_number: string;
  registration_id: number;
  status: "Active" | "Inactive";
  phone_role: "member" | "legal_rep";
  member_age_years: number;
  is_legal_representative: boolean;
  is_managed_mb_eligible: boolean;
  is_managed_rjb_eligible: boolean;
}

export interface PhoneCheckResult {
  found: boolean;
  status?: "Active" | "Inactive";
  mb?: number;
  has_member_phone?: boolean;
  has_legal_rep_phone?: boolean;
  has_member_adult_phone?: boolean;
  has_member_minor_phone?: boolean;
  has_legal_rep_for_minor?: boolean;
  has_legal_rep_for_adult?: boolean;
  is_legal_representative?: boolean;
  has_active_mb?: boolean;
  has_active_rjb?: boolean;
  has_inactive_mb?: boolean;
  has_inactive_rjb?: boolean;
}
